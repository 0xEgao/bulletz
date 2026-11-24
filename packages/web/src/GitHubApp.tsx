import { useEffect, useState } from "react";
import type { Channel } from "@bulletz/shared";
import {
  DEFAULT_GITHUB_EVENTS,
  GITHUB_EVENTS,
  MAX_GITHUB_ROUTES,
  isGitHubOrganization,
  type GitHubCategory,
  type GitHubConnection,
  type GitHubRoute,
} from "@bulletz/shared/github";
import type { Api } from "./api.ts";

type DraftRoute = { channel_id: string; events: GitHubCategory[]; repositories: string };
const EVENT_OPTIONS = Object.entries(GITHUB_EVENTS) as [GitHubCategory, string][];

function toDraft({ channel_id, events, repositories }: GitHubRoute): DraftRoute {
  return { channel_id, events, repositories: repositories.join(", ") };
}

export function GitHubApp({ api, channels, onChannelCreated, onOpenChannel }: {
  api: Api;
  channels: Channel[];
  onChannelCreated: (channel: Channel) => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [routes, setRoutes] = useState<DraftRoute[]>([]);
  const [organization, setOrganization] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "disconnect" | null>(null);

  function show(next: GitHubConnection | null) {
    setConnection(next);
    setRoutes(next?.routes.map(toDraft) ?? []);
    setDirty(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    void api.githubConnection(controller.signal).then(
      ({ connection: next }) => {
        show(next);
        setLoading(false);
      },
      (err: Error) => {
        if (controller.signal.aborted) return;
        setError(err.message);
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [api, loadAttempt]);

  const webhookUrl = connection?.webhook_url;
  const received = Boolean(connection?.last_delivery_at);
  useEffect(() => {
    if (!webhookUrl || received || busy) return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void api.githubConnection(controller.signal).then(({ connection: next }) => {
        setConnection((current) => current && next && current.secret === next.secret ? {
          ...current,
          last_delivery_at: next.last_delivery_at,
          last_posted_at: next.last_posted_at,
        } : current);
      }).catch(() => {});
    }, 3000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [api, webhookUrl, received, busy]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function changeRoutes(next: DraftRoute[]) {
    setRoutes(next);
    setDirty(true);
    setNotice("");
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError("");
      setNotice(`${label} copied`);
    } catch {
      setError(`Couldn’t copy the ${label.toLowerCase()}. Select the field to copy it manually.`);
      if (label === "Secret") setReveal(true);
    }
  }

  const openChannels = channels.filter((channel) => channel.status === "open");
  const unusedChannel = openChannels.find((channel) => !routes.some((route) => route.channel_id === channel.id));
  const invalidRoutes = routes.some((route) => !route.events.length ||
    !openChannels.some((channel) => channel.id === route.channel_id));

  return (
    <section className="github-app app-full">
      <header className="github-app-head">
        <div>
          <h2>GitHub</h2>
          <p className="muted">Send GitHub organization activity to your Bulletz channels.</p>
        </div>
        {connection && <span className={received ? "github-connected" : "muted"} role="status">
          {received ? "Connected" : "Waiting for GitHub"}
        </span>}
      </header>

      {error && <p className="github-error" role="alert">{error}</p>}
      {notice && <p className="github-connected" role="status">{notice}</p>}
      {loading ? <p className="muted" role="status">Loading GitHub settings…</p> : loadFailed ? (
        <button className="ghost" onClick={() => {
          setError("");
          setLoadFailed(false);
          setLoading(true);
          setLoadAttempt((attempt) => attempt + 1);
        }}>Try again</button>
      ) : !connection ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const name = organization.trim();
            if (!isGitHubOrganization(name)) throw new Error("Enter your GitHub organization name.");
            const result = await api.connectGitHub(name);
            onChannelCreated(result.channel);
            show(result.connection);
          });
        }}>
          <label className="field">
            <span>GitHub organization</span>
            <input required autoComplete="off" placeholder="your-org" value={organization}
              onChange={(event) => setOrganization(event.target.value)} />
            <em>Use the name from github.com/your-org. A GitHub organization owner adds the webhook.</em>
          </label>
          <button className="send" disabled={busy || !organization.trim()}>
            {busy ? "Preparing…" : "Set up GitHub"}
          </button>
        </form>
      ) : (
        <>
          <div className="github-card">
            <h3>Organization webhook</h3>
            <p className="muted">
              Paste these values into{" "}
              <a href={`https://github.com/organizations/${encodeURIComponent(connection.organization)}/settings/hooks/new`}
                target="_blank" rel="noreferrer">Add webhook for {connection.organization}</a>.
              Choose <code>application/json</code>, keep SSL verification on, and leave the webhook active.
            </p>
            {!/^https:\/\//i.test(connection.webhook_url) && <p className="github-error">
              GitHub needs a reachable HTTPS address. Ask your server admin to set <code>PUBLIC_URL</code>.
            </p>}
            <div className="github-copy">
              <label className="field">
                <span>Payload URL</span>
                <input readOnly value={connection.webhook_url} onFocus={(event) => event.target.select()} />
              </label>
              <button className="ghost" onClick={() => void copy(connection.webhook_url, "URL")}>Copy URL</button>
            </div>
            <div className="github-copy">
              <label className="field">
                <span>Secret</span>
                <input readOnly type={reveal ? "text" : "password"} value={connection.secret}
                  onFocus={(event) => event.target.select()} />
              </label>
              <button className="ghost" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
              <button className="ghost" onClick={() => void copy(connection.secret, "Secret")}>Copy secret</button>
            </div>
            <p className="muted">
              In GitHub, select the events you want to send. For the default feed, select Pull requests,
              Pull request reviews, Issues, Issue comments, Releases, and Workflow runs. You can also
              send everything and use the filters below.
            </p>
            <div className="github-actions">
              <span className="muted">
                {connection.last_posted_at ? `Last post ${new Date(connection.last_posted_at).toLocaleString()}` :
                  received ? "GitHub reached Bulletz. Matching activity will appear in chat." :
                    "GitHub sends a ping when you add the webhook."}
              </span>
              <button className="ghost" disabled={busy} onClick={() => void run(async () => {
                const { connection: next } = await api.githubConnection();
                if (!next || next.secret !== connection.secret) show(next);
                else setConnection((current) => current && {
                  ...current,
                  last_delivery_at: next.last_delivery_at,
                  last_posted_at: next.last_posted_at,
                });
              })}>Check status</button>
            </div>
          </div>

          <form className="github-card" onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const { connection: next } = await api.saveGitHubRoutes(routes.map((route) => ({
                ...route,
                repositories: route.repositories.split(/[\s,]+/).filter(Boolean),
              })));
              show(next);
              setNotice("Routing saved");
            });
          }}>
            <h3>Channel routing</h3>
            <p className="muted">Channel posts are visible to your workspace. Use repository filters to limit what gets shared.</p>
            {routes.map((route, index) => {
              const channel = openChannels.find((item) => item.id === route.channel_id);
              const change = (patch: Partial<DraftRoute>) =>
                changeRoutes(routes.map((item, at) => at === index ? { ...item, ...patch } : item));
              return (
                <div className="github-route" key={index}>
                  <div className="github-actions">
                    <label className="field">
                      <span>Destination channel</span>
                      <select value={route.channel_id} onChange={(event) => change({ channel_id: event.target.value })}>
                        {!channel && <option value={route.channel_id} disabled>Channel unavailable</option>}
                        {openChannels.filter((item) => item.id === route.channel_id ||
                          !routes.some((other) => other.channel_id === item.id)).map((item) => (
                          <option value={item.id} key={item.id}>{item.title.startsWith("#") ? item.title : `#${item.title}`}</option>
                        ))}
                      </select>
                    </label>
                    {channel && <button type="button" className="ghost" onClick={() => onOpenChannel(channel.id)}>
                      Open channel
                    </button>}
                    {routes.length > 1 && <button type="button" className="ghost"
                      onClick={() => changeRoutes(routes.filter((_, i) => i !== index))}>Remove</button>}
                  </div>
                  <label className="field">
                    <span>Repositories</span>
                    <input value={route.repositories} placeholder="All repositories"
                      onChange={(event) => change({ repositories: event.target.value })} />
                    <em>Enter comma-separated repository names, or leave blank for the whole organization.</em>
                  </label>
                  <fieldset className="github-events">
                    <legend>Events</legend>
                    {EVENT_OPTIONS.map(([key, label]) => (
                      <label key={key}>
                        <input type="checkbox" checked={route.events.includes(key)}
                          onChange={(event) => change({ events: event.target.checked ?
                            [...route.events, key] : route.events.filter((item) => item !== key) })} />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                </div>
              );
            })}
            <div className="github-actions">
              <button type="submit" className="send" disabled={!dirty || invalidRoutes || busy}>
                Save routing
              </button>
              <button type="button" className="ghost" disabled={!unusedChannel || busy || routes.length >= MAX_GITHUB_ROUTES}
                onClick={() => unusedChannel && changeRoutes([...routes, {
                  channel_id: unusedChannel.id, repositories: "", events: [...DEFAULT_GITHUB_EVENTS],
                }])}>
                Add destination
              </button>
            </div>
          </form>

          <div className="github-card github-actions">
            {confirm ? (
              <>
                <span className="muted">{confirm === "rotate" ?
                  "Update the secret in GitHub after rotating it to resume deliveries." :
                  "New deliveries will stop. Existing posts stay in chat."}</span>
                <button className="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
                <button className="danger solid" disabled={busy} onClick={() => void run(async () => {
                  if (confirm === "rotate") {
                    const { connection: next } = await api.rotateGitHubSecret();
                    setConnection(next);
                  } else {
                    await api.disconnectGitHub();
                    show(null);
                  }
                  setReveal(false);
                  setConfirm(null);
                })}>{confirm === "rotate" ? "Rotate secret" : "Disconnect GitHub"}</button>
              </>
            ) : (
              <>
                <button className="ghost" disabled={busy} onClick={() => setConfirm("rotate")}>Rotate secret</button>
                <button className="ghost danger" disabled={busy} onClick={() => setConfirm("disconnect")}>Disconnect GitHub</button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
