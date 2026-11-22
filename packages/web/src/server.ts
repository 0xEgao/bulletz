import { activeAccount, beginAddWorkspace, clearLegacyToken, isAddingWorkspace } from "./accounts.ts";

const KEY = "bulletz.server";
export const LOCAL_SERVER = "http://localhost:4000";

/** Accepts what people actually type: "box.example.com", "box:4000", a full URL. */
export function normaliseServer(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  // A bare host gets https, except on the loopback names, where nobody is
  // running a certificate and http is what the dev server actually serves.
  if (!/^https?:\/\//i.test(v)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(v);
    return `${local ? "http" : "https"}://${v}`;
  }
  return v;
}

/** An empty choice explicitly resets the server and skips the launch argument. */
function serverChoice(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode, blocked storage — fall through to the defaults
  }
}

export function savedServer(): string | null {
  return serverChoice() || null;
}

export function resolveServer(): string {
  const saved = serverChoice();
  if (!isAddingWorkspace() || saved === null) {
    const account = activeAccount();
    if (account) return account.serverUrl;
  }
  if (saved) return saved;

  const desktop = (globalThis as unknown as {
    bulletz?: { initialServer?: string | null };
  }).bulletz;
  if (saved === null && desktop?.initialServer) return normaliseServer(desktop.initialServer);
  const pinned = import.meta.env.VITE_BULLETZ_URL as string | undefined;
  if (pinned) return normaliseServer(pinned);
  if (desktop) {
    const defaultServer = import.meta.env.VITE_BULLETZ_DEFAULT_SERVER as string | undefined;
    if (defaultServer) return normaliseServer(defaultServer);
  }
  if (import.meta.env.DEV || (desktop && import.meta.env.MODE === "desktop")) {
    return LOCAL_SERVER;
  }
  return /^https?:$/.test(location.protocol) ? location.origin : "";
}

export function setServer(url: string) {
  const target = normaliseServer(url);
  if (target !== resolveServer()) {
    // Keep an existing account available in the workspace switcher, but never
    // use its token or an unscoped legacy token to sign in to the new server.
    if (activeAccount()) beginAddWorkspace();
    clearLegacyToken();
  }
  try {
    localStorage.setItem(KEY, target);
  } catch {
    /* nothing we can do; the caller reloads either way */
  }
}

export function clearServer() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export type Probe =
  | { ok: true; url: string; needsSetup: boolean }
  | { ok: false; url: string; error: string };

/** Use the same setup endpoint for startup, retry, and the server picker. */
export async function probeServer(raw: string, signal?: AbortSignal): Promise<Probe> {
  const url = normaliseServer(raw);
  if (!url) return { ok: false, url, error: "Enter a server address." };
  // `new URL` alone is too permissive: it percent-encodes spaces and happily
  // accepts "https://not a url", which then fails later as a confusing
  // network error instead of the typo it actually is.
  if (/\s/.test(raw.trim())) return { ok: false, url, error: "An address cannot contain spaces." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) && !/^https?:\/\//i.test(raw.trim())) {
    return { ok: false, url, error: "Use an HTTP or HTTPS server address." };
  }
  try {
    const u = new URL(url);
    if (!u.hostname || !/^[a-z0-9.\-[\]:]+$/i.test(u.hostname) || u.username || u.password || u.search || u.hash) {
      return { ok: false, url, error: "That is not a valid address." };
    }
  } catch {
    return { ok: false, url, error: "That is not a valid address." };
  }

  const timeout = AbortSignal.timeout(6000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(`${url}/v1/bootstrap`, { signal: stop, cache: "no-store" });
    if (!response.ok) return { ok: false, url, error: `The server returned HTTP ${response.status}.` };
    const body = (await response.json()) as { needsSetup?: boolean } | null;
    if (typeof body?.needsSetup !== "boolean") {
      return { ok: false, url, error: "That address did not return a Bulletz setup response." };
    }
    return { ok: true, url, needsSetup: body.needsSetup };
  } catch (e) {
    if (timeout.aborted) return { ok: false, url, error: "The connection timed out. Try again." };
    if (e instanceof SyntaxError) {
      return { ok: false, url, error: "That address did not return a Bulletz setup response." };
    }
    return { ok: false, url, error: "Could not reach it. Check the address, port, and that it is running." };
  }
}
