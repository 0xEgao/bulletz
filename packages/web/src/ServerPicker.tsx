import { useState } from "react";
import { LOCAL_SERVER, probeServer, resolveServer, setServer, savedServer } from "./server.ts";
import { holdInvite, parseInvite } from "./invites.ts";
import { bridge } from "./Terminal.tsx";
import logoUrl from "../public/logo.svg";
import markUrl from "../public/mark.svg";

export function Startup({ children }: { children: React.ReactNode }) {
  return (
    <div className="startup" role="status">
      <img src={markUrl} alt="Bulletz" width="48" height="48" />
      <div className="startup-progress" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Where the app is pointed, shown on every sign-in screen.
 *
 * It has to work when the server is unreachable — that is the main reason
 * anyone opens it — so it never depends on a successful call to render.
 */
export function ServerPicker({ onChanged }: { onChanged: () => void }) {
  const current = resolveServer();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    const r = await probeServer(value);
    if (!r.ok) {
      setErr(r.error);
      setBusy(false);
      return;
    }
    setServer(r.url);
    await bridge()?.server?.set(r.url).catch(() => {});
    onChanged();
  };

  const reset = async () => {
    setBusy(true);
    setServer("");
    await bridge()?.server?.set(null).catch(() => {});
    onChanged();
  };

  if (!open) {
    return (
      <div className="server-bar">
        <span className="server-label">Server</span>
        <code className="server-url" title={current}>
          {pretty(current)}
        </code>
        <button type="button" className="server-change" onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="server-edit">
      <label htmlFor="srv">Server address</label>
      <div className="server-row">
        <input
          id="srv"
          value={value}
          autoFocus
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          // Pre-filled with the current server so you can see what you are
          // changing — but anyone opening this is replacing it, not appending
          // to it, so selecting the text makes the first keystroke do that.
          onFocus={(e) => e.currentTarget.select()}
          placeholder="bulletz.example.com"
          onChange={(e) => {
            setValue(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void apply();
            }
          }}
        />
        <button type="button" className="send" disabled={busy || !value.trim()} onClick={() => void apply()}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
      {err && <div className="server-err" role="alert">{err}</div>}
      <div className="server-hint">
        The machine running the Bulletz server. Plain hostnames get <code>https</code>;
        <code>localhost</code> gets <code>http</code>. Include a port if it is not the default.
      </div>
      <div className="server-actions">
        <button
          type="button"
          className="linklike"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setErr("");
            setValue(current);
          }}
        >
          Cancel
        </button>
        {savedServer() && (
          <button
            type="button"
            className="linklike"
            disabled={busy}
            onClick={() => void reset()}
          >
            {bridge() ? "Forget server" : "Reset to default"}
          </button>
        )}
      </div>
    </div>
  );
}

/** A full URL is noise on a sign-in card; the host is what identifies it. */
function pretty(url: string): string {
  try {
    const u = new URL(url);
    return u.port && u.port !== "443" ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

/**
 * Shown when the server cannot be reached at all. Previously this failure was
 * swallowed and the app rendered a sign-in form that could only ever fail,
 * with nothing on screen explaining why or offering a way out.
 */
export function Unreachable({
  server,
  error,
  onRetry,
  onCancel,
}: {
  server: string;
  error: string;
  onRetry: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="auth">
      <div className="auth-card">
        <h1>
          <img className="logo-mark" src={logoUrl} alt="bulletz.ai" />
        </h1>
        <p>Couldn’t connect to <strong>{pretty(server)}</strong>.</p>
        <div className="auth-err" role="alert">{error}</div>
        <button type="button" className="send" onClick={onRetry}>
          Try again
        </button>
        <ServerPicker onChanged={() => location.reload()} />
        {onCancel && (
          <button type="button" className="linklike auth-cancel" onClick={onCancel}>
            Back to your workspace
          </button>
        )}
      </div>
    </div>
  );
}


export function Connect({ onConnected, onCancel }: { onConnected: () => void; onCancel?: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async (raw = value) => {
    if (busy || !raw.trim()) return;
    setBusy(true);
    setErr("");

    // An invite link is a server address with the invitation attached, and
    // this is the screen an invited person actually reaches first: they were
    // sent one link, and being asked for a hostname they were never told is
    // where that journey ends. Take the link here and carry the code through.
    const invite = parseInvite(raw);
    const target = invite?.server ?? raw;

    const r = await probeServer(target);
    if (!r.ok) {
      setErr(r.error);
      setBusy(false);
      return;
    }
    setServer(r.url);
    if (invite?.server) holdInvite(invite.code);
    await bridge()?.server?.set(r.url).catch(() => {});
    onConnected();
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <h1>
          <img className="logo-mark" src={logoUrl} alt="bulletz.ai" />
        </h1>
        <p>Enter a server address or paste an invite link to join a workspace.</p>

        <label htmlFor="connect-srv">Server address</label>
        <input
          id="connect-srv"
          value={value}
          autoFocus
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="bulletz.your-team.com — or paste an invite link"
          onChange={(e) => {
            setValue(e.target.value);
            setErr("");
          }}
        />
        {err && <div className="auth-err" role="alert">{err}</div>}

        <button type="submit" className="send" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Connect"}
        </button>

        <div className="auth-note">
          <button type="button" className="linklike" disabled={busy} onClick={() => {
            setValue(LOCAL_SERVER);
            void go(LOCAL_SERVER);
          }}>
            Use local server
          </button>
        </div>
        {onCancel && (
          <button type="button" className="linklike auth-cancel" disabled={busy} onClick={onCancel}>
            Back to your workspace
          </button>
        )}
      </form>
    </div>
  );
}
