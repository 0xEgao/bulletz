import { randomBytes } from "node:crypto";
import {
  DEFAULT_GITHUB_EVENTS,
  GITHUB_BOT_HANDLE,
  GITHUB_EVENTS,
  MAX_GITHUB_ROUTES,
  isGitHubOrganization,
  type Channel,
  type GitHubCategory,
  type GitHubConnection,
  type GitHubRoute,
} from "@bulletz/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { allow, requireActor } from "../authHook.js";
import { maybeOne, one, q, tx } from "../db.js";
import { publicOrigin } from "../env.js";
import { formatGitHubEvent, payloadObject, verifyGitHubSignature } from "../github.js";
import { githubNotifications } from "../notify.js";
import { broadcast } from "../realtime.js";
import { appendEvent, createChannel } from "../repo.js";

const CONNECTION_COLUMNS = "id, organization, secret, routes, last_delivery_at, last_posted_at";
const newSecret = () => randomBytes(32).toString("hex");

type ConnectionRow = Omit<GitHubConnection, "webhook_url"> & { id: string };

function connectionView(req: FastifyRequest, row: ConnectionRow): GitHubConnection {
  const { id, ...connection } = row;
  return { ...connection, webhook_url: `${publicOrigin(req)}/v1/webhooks/github/${id}` };
}

const categories = Object.keys(GITHUB_EVENTS) as [GitHubCategory, ...GitHubCategory[]];
const Route = z.object({
  channel_id: z.string().uuid(),
  events: z.array(z.enum(categories)).min(1).max(categories.length),
  repositories: z.array(
    z.string().trim().toLowerCase().max(100).regex(/^[a-z0-9_.-]+$/, "Use repo names without the organization prefix"),
  ).max(100),
});
const Routing = z.array(Route).min(1).max(MAX_GITHUB_ROUTES).refine(
  (routes) => new Set(routes.map((route) => route.channel_id)).size === routes.length,
  "Choose each channel only once",
);

export async function githubRoutes(app: FastifyInstance) {
  requireActor(app);
  app.addHook("preHandler", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (req.actor.kind !== "human") return reply.code(403).send({ error: "Only people can manage GitHub connections" });
    if (!allow(req, reply, "activate")) return reply;
  });

  app.get("/integrations/github", async (req) => {
    const row = await maybeOne<ConnectionRow>(
      `select ${CONNECTION_COLUMNS} from github_connections where workspace_id = $1`,
      [req.actor.workspace_id],
    );
    return { connection: row ? connectionView(req, row) : null };
  });

  app.post("/integrations/github", async (req, reply) => {
    const { organization } = z.object({
      organization: z.string().trim().toLowerCase().refine(isGitHubOrganization, "Enter a GitHub organization name"),
    }).parse(req.body);
    const workspaceId = req.actor.workspace_id;
    const result = await tx(async (client) => {
      await one("select id from workspaces where id = $1 for update", [workspaceId], client);
      if (await maybeOne("select id from github_connections where workspace_id = $1", [workspaceId], client)) {
        return null;
      }

      let channel = await maybeOne<Channel>(
        `select id, workspace_id, title, status, created_at, last_event_at from channels
          where workspace_id = $1 and lower(title) in ('github', '#github') and status = 'open'
          order by created_at limit 1`,
        [workspaceId],
        client,
      );
      const created = channel === null;
      channel ??= await createChannel(workspaceId, "#github", req.actor.id, client);

      const bot = await one<{ id: string }>(
        `insert into actors (workspace_id, handle, display_name, kind, role)
         values ($1, $2, 'GitHub', 'integration', 'guest')
         on conflict (workspace_id, handle) do update set status = 'active'
         returning id`,
        [workspaceId, GITHUB_BOT_HANDLE],
        client,
      );
      const routes: GitHubRoute[] = [{
        channel_id: channel.id,
        events: [...DEFAULT_GITHUB_EVENTS],
        repositories: [],
      }];
      const row = await one<ConnectionRow>(
        `insert into github_connections (workspace_id, actor_id, organization, secret, routes)
         values ($1, $2, $3, $4, $5)
         returning ${CONNECTION_COLUMNS}`,
        [workspaceId, bot.id, organization, newSecret(), JSON.stringify(routes)],
        client,
      );
      return { row, channel, created };
    });
    if (!result) return reply.code(409).send({ error: "This workspace already has a GitHub connection" });
    if (result.created) broadcast(workspaceId, { type: "channel", channel: result.channel });
    return reply.code(201).send({ connection: connectionView(req, result.row), channel: result.channel });
  });

  app.put("/integrations/github/routes", async (req, reply) => {
    const { routes } = z.object({ routes: Routing }).parse(req.body);
    const row = await maybeOne<ConnectionRow>(
      `update github_connections set routes = $2
         where workspace_id = $1
           and $4 = (select count(*) from channels
             where workspace_id = $1 and status = 'open' and id = any($3::uuid[]))
         returning ${CONNECTION_COLUMNS}`,
      [req.actor.workspace_id, JSON.stringify(routes), routes.map((route) => route.channel_id), routes.length],
    );
    if (!row) return reply.code(409).send({ error: "Check that GitHub is connected and each channel is open in this workspace" });
    return { connection: connectionView(req, row) };
  });

  app.post("/integrations/github/rotate-secret", async (req, reply) => {
    const row = await maybeOne<ConnectionRow>(
      `update github_connections set secret = $2, last_delivery_at = null
        where workspace_id = $1 returning ${CONNECTION_COLUMNS}`,
      [req.actor.workspace_id, newSecret()],
    );
    if (!row) return reply.code(404).send({ error: "GitHub connection not found" });
    return { connection: connectionView(req, row) };
  });

  app.delete("/integrations/github", async (req, reply) => {
    await q("delete from github_connections where workspace_id = $1", [req.actor.workspace_id]);
    return reply.code(204).send();
  });
}

export async function githubWebhookRoutes(app: FastifyInstance) {
  // This parser is scoped to this plugin. Signatures cover the original bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/github/:id", { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const signature = req.headers["x-hub-signature-256"];
    const headers = z.object({
      "x-github-delivery": z.string().uuid(),
      "x-github-event": z.string().regex(/^[a-z0-9_]{1,80}$/),
    }).parse(req.headers);
    const delivery = headers["x-github-delivery"];
    const eventType = headers["x-github-event"];
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Set the webhook Content type to application/json" });

    const current = await maybeOne<{ secret: string }>("select secret from github_connections where id = $1", [id]);
    if (!current) return reply.code(404).send({ error: "GitHub connection not found" });
    if (!verifyGitHubSignature(current.secret, body, signature)) {
      return reply.code(401).send({ error: "Webhook signature does not match" });
    }

    let payload: Record<string, unknown>;
    try {
      payload = payloadObject(JSON.parse(body.toString("utf8")));
    } catch {
      return reply.code(400).send({ error: "Invalid GitHub payload" });
    }

    const result = await tx(async (client) => {
      const connection = await maybeOne<ConnectionRow & { workspace_id: string; actor_id: string }>(
        `select ${CONNECTION_COLUMNS}, workspace_id, actor_id from github_connections g
          where id = $1 and exists (select 1 from actors a where a.id = g.actor_id and a.status = 'active')
          for update`,
        [id],
        client,
      );
      if (!connection || connection.secret !== current.secret) return { status: 401, error: "GitHub connection changed" } as const;
      const organization = payloadObject(payload.organization).login;
      if (typeof organization !== "string" || organization.toLowerCase() !== connection.organization) {
        return { status: 403, error: "Delivery is from a different GitHub organization" } as const;
      }
      await q("update github_connections set last_delivery_at = now() where id = $1", [id], client);

      const activity = eventType === "ping" ? null : formatGitHubEvent(eventType, payload, connection.organization);
      if (!activity) return { status: 200, posted: 0 } as const;
      const routeIds = connection.routes.filter((route) =>
        route.events.includes(activity.category) &&
        (!route.repositories.length || route.repositories.includes(activity.repository))
      ).map((route) => route.channel_id);
      if (!routeIds.length) return { status: 200, posted: 0 } as const;

      const once = await maybeOne(
        `insert into github_deliveries (connection_id, delivery_id) values ($1, $2)
         on conflict do nothing returning delivery_id`,
        [id, delivery],
        client,
      );
      if (!once) return { status: 200, posted: 0, duplicate: true } as const;

      const channels = await q<{ id: string }>(
        `select id from channels where workspace_id = $1 and status = 'open' and id = any($2::uuid[])
         order by id for update`,
        [connection.workspace_id, routeIds],
        client,
      );
      const posts = [];
      for (const channel of channels) {
        const event = await appendEvent({
          workspaceId: connection.workspace_id,
          channelId: channel.id,
          actorId: connection.actor_id,
          kind: "message",
          body: activity.body,
          payload: { source: "github", event: eventType },
          refs: { urls: [activity.url] },
          labels: ["github", activity.category],
        }, client);
        const notifications = await githubNotifications(event, client);
        posts.push({ event, notifications });
      }
      if (posts.length) {
        await q("update github_connections set last_posted_at = now() where id = $1", [id], client);
      }
      return { status: 200, posted: posts.length, posts } as const;
    });

    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    for (const { event, notifications } of result.posts ?? []) {
      broadcast(event.workspace_id, { type: "event", event });
      for (const { actor_id, ...notification } of notifications) {
        broadcast(event.workspace_id, { type: "notification", actor_id, notification });
      }
    }
    return { ok: true, posted: result.posted, duplicate: result.duplicate ?? false };
  });
}
