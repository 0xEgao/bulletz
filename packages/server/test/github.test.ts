import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Event, Notification } from "@bulletz/shared";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { pool, one, q } from "../src/db.js";
import { createSession } from "../src/identity.js";
import { addConn } from "../src/realtime.js";
import { apiRoutes } from "../src/routes/api.js";
import { githubRoutes, githubWebhookRoutes } from "../src/routes/github.js";

test("routes signed organization deliveries into Bulletz chat exactly once", async () => {
  const app = Fastify();
  await app.register(apiRoutes, { prefix: "/v1" });
  await app.register(githubRoutes, { prefix: "/v1" });
  await app.register(githubWebhookRoutes, { prefix: "/v1" });

  const spaces: string[] = [];
  const frames: { type: string; event?: Event; notification?: Notification; actor_id?: string }[] = [];
  let removeConnection: (() => void) | undefined;
  async function fixture() {
    const { id } = await one<{ id: string }>(
      "insert into workspaces (name, slug) values ('Test GitHub', $1) returning id", [randomUUID()],
    );
    spaces.push(id);
    const owner = await one<{ id: string }>(
      `insert into actors (workspace_id, kind, handle, display_name, role)
       values ($1, 'human', 'test-owner', 'Test owner', 'owner') returning id`, [id],
    );
    const member = await one<{ id: string }>(
      `insert into actors (workspace_id, kind, handle, display_name, role)
       values ($1, 'human', 'test-member', 'Test member', 'member') returning id`, [id],
    );
    const ownerSession = await createSession(owner.id, {});
    const memberSession = await createSession(member.id, {});
    return {
      workspace: id,
      owner: owner.id,
      headers: { authorization: `Bearer ${ownerSession.token}`, "x-forwarded-proto": "https" },
      memberHeaders: { authorization: `Bearer ${memberSession.token}` },
    };
  }

  try {
    const { workspace, owner, headers, memberHeaders } = await fixture();
    const otherWorkspace = await fixture();
    removeConnection = addConn({
      workspaceId: workspace,
      actorHandle: "test-owner",
      ws: { readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) } as unknown as WebSocket,
    });
    const config = "/v1/integrations/github";
    const denied = await app.inject({ method: "POST", url: config, headers: memberHeaders, payload: { organization: "octo" } });
    assert.equal(denied.statusCode, 403);
    const setup = await app.inject({ method: "POST", url: config, headers, payload: { organization: "Octo" } });
    assert.equal(setup.statusCode, 201, setup.body);
    assert.equal(setup.headers["cache-control"], "no-store");
    const { connection, channel } = setup.json();
    const webhook = new URL(connection.webhook_url).pathname;
    assert.equal(channel.title, "#github");
    assert.equal(connection.organization, "octo");
    assert.equal(connection.last_delivery_at, null);
    assert.equal(frames.filter((frame) => frame.type === "channel").length, 1);
    assert.equal((await app.inject({ url: config, headers: otherWorkspace.headers })).json().connection, null);
    assert.equal((await app.inject({ url: config, headers: memberHeaders })).statusCode, 403);

    const repository = { name: "bulletz", full_name: "octo/bulletz", html_url: "https://github.com/octo/bulletz" };
    function send(
      event: string,
      payload: Record<string, unknown>,
      options: { delivery?: string; secret?: string; organization?: string } = {},
    ) {
      // Keep leading space and Unicode to catch accidental JSON reserialization.
      const raw = ` \n${JSON.stringify({ organization: { login: options.organization ?? "octo" }, ...payload })}`;
      const signature = createHmac("sha256", options.secret ?? connection.secret).update(raw).digest("hex");
      return app.inject({
        method: "POST",
        url: webhook,
        payload: raw,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${signature}`,
          "x-github-delivery": options.delivery ?? randomUUID(),
          "x-github-event": event,
        },
      });
    }
    assert.equal((await send("ping", {}, { secret: "wrong" })).statusCode, 401);
    assert.equal((await send("ping", {}, { organization: "another-org" })).statusCode, 403);
    assert.equal((await send("ping", {})).json().posted, 0);
    assert.ok((await app.inject({ url: config, headers })).json().connection.last_delivery_at);

    assert.equal((await app.inject({
      method: "PATCH", url: "/v1/notify-prefs", headers, payload: { github: true },
    })).statusCode, 200);
    const delivery = randomUUID();
    const pull = {
      action: "closed", repository, sender: { login: "octocat" },
      pull_request: { number: 42, title: "Café @test-owner", merged: true, html_url: "https://github.com/octo/bulletz/pull/42" },
    };
    const duplicates = await Promise.all([send("pull_request", pull, { delivery }), send("pull_request", pull, { delivery })]);
    for (const response of duplicates) assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(duplicates.map((response) => response.json().posted).sort(), [0, 1]);
    assert.equal(duplicates.filter((response) => response.json().duplicate).length, 1);

    const history = async (channelId: string): Promise<Event[]> =>
      (await app.inject({ url: `/v1/channels/${channelId}/events`, headers: memberHeaders })).json().events;
    const [post] = await history(channel.id);
    assert.equal((await history(channel.id)).length, 1);
    assert.equal(post?.actor_kind, "integration");
    assert.match(post?.body ?? "", /merged — #42 Café/);
    assert.deepEqual(post?.refs.urls, ["https://github.com/octo/bulletz/pull/42"]);
    assert.equal(frames.filter((frame) => frame.event?.id === post?.id && frame.type === "event").length, 1);
    assert.equal(frames.filter((frame) => frame.notification?.event_id === post?.id && frame.actor_id === owner).length, 1);
    const unread = await app.inject({ url: "/v1/unread", headers });
    assert.deepEqual(unread.json().channels, [{ channel_id: channel.id, unread: 1, mentions: 0 }]);
    assert.equal((await app.inject({ url: "/v1/notifications", headers: memberHeaders })).json().unread, 0);

    const makeChannel = (auth: Record<string, string>, title: string) =>
      app.inject({ method: "POST", url: "/v1/channels", headers: auth, payload: { title } });
    const ci = (await makeChannel(headers, "ci")).json().channel;
    const foreign = (await makeChannel(otherWorkspace.headers, "other")).json().channel;
    const saveRoutes = (destinations: string[]) => app.inject({
      method: "PUT",
      url: `${config}/routes`,
      headers,
      payload: { routes: destinations.map((channel_id) => ({
        channel_id, events: ["ci_failures"], repositories: ["Bulletz"],
      })) },
    });
    assert.equal((await saveRoutes([foreign.id])).statusCode, 409);
    const saved = await saveRoutes([channel.id, ci.id]);
    assert.equal(saved.statusCode, 200, saved.body);
    await app.inject({ method: "POST", url: `/v1/channels/${ci.id}/mute`, headers, payload: { muted: true } });

    const run = {
      action: "completed", repository,
      workflow_run: { name: "Checks", conclusion: "failure", html_url: "https://github.com/octo/bulletz/actions/runs/1" },
    };
    assert.equal((await send("workflow_run", { ...run, repository: { name: "other" } })).json().posted, 0);
    assert.equal((await send("workflow_run", { ...run, workflow_run: { conclusion: "success" } })).json().posted, 0);
    const failure = await send("workflow_run", run);
    assert.equal(failure.statusCode, 200, failure.body);
    assert.equal(failure.json().posted, 2);
    const [ciPost] = await history(ci.id);
    assert.match(ciPost?.body ?? "", /Workflow failure — Checks/);
    assert.ok(!frames.some((frame) => frame.notification?.event_id === ciPost?.id));
    await app.inject({ method: "PATCH", url: `/v1/channels/${ci.id}`, headers, payload: { status: "archived" } });
    assert.equal((await send("workflow_run", run)).json().posted, 1);

    const rotated = await app.inject({ method: "POST", url: `${config}/rotate-secret`, headers });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const secret = rotated.json().connection.secret;
    assert.equal((await send("ping", {})).statusCode, 401);
    assert.equal((await send("ping", {}, { secret })).statusCode, 200);

    assert.equal((await app.inject({ method: "DELETE", url: config, headers })).statusCode, 204);
    assert.equal((await send("ping", {}, { secret })).statusCode, 404);
    assert.equal((await history(channel.id)).filter((event) => event.actor_kind === "integration").length, 3);
  } finally {
    removeConnection?.();
    await app.close();
    await q("delete from events where workspace_id = any($1::uuid[])", [spaces]);
    await q("delete from workspaces where id = any($1::uuid[])", [spaces]);
    await pool.end();
  }
});
