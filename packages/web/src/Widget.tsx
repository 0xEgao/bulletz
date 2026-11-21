import { useEffect, useRef, useState } from "react";
import type { Api } from "./api.ts";

export type ViewSpec = {
  type: "metric" | "bar" | "table" | "status_grid";
  title?: string;
  value_field?: string;
  label_field?: string;
  status_field?: string;
  detail_field?: string;
  unit?: string;
  columns?: string[];
  refresh_ms?: number;
};

export type WidgetRow = {
  id: string;
  name: string;
  description: string | null;
  kind: "view" | "html" | "embed";
  tool_id: string | null;
  tool_name: string | null;
  tool_status: string | null;
  view: ViewSpec | null;
  /** kind='embed': the site to frame. */
  url: string | null;
  status: "draft" | "active" | "disabled";
  pinned: boolean;
  created_by_handle: string | null;
};

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n);

/** Status is reserved and never carried by colour alone — each cell ships a
 *  glyph and a label beside the swatch. */
const STATUS = {
  ok: { color: "var(--status-good)", glyph: "●", label: "ok" },
  up: { color: "var(--status-good)", glyph: "●", label: "up" },
  passing: { color: "var(--status-good)", glyph: "●", label: "passing" },
  warn: { color: "var(--status-warning)", glyph: "▲", label: "warn" },
  degraded: { color: "var(--status-serious)", glyph: "▲", label: "degraded" },
  down: { color: "var(--status-critical)", glyph: "■", label: "down" },
  failing: { color: "var(--status-critical)", glyph: "■", label: "failing" },
} as const;

const statusOf = (v: unknown) => {
  const key = String(v ?? "").toLowerCase() as keyof typeof STATUS;
  return STATUS[key] ?? { color: "var(--fg-faint)", glyph: "○", label: String(v ?? "unknown") };
};

export function Widget({
  widget,
  api,
  visible = true,
}: {
  widget: WidgetRow;
  api: Api;
  visible?: boolean;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  const inFlight = useRef<ReturnType<Api["widgetData"]> | null>(null);

  useEffect(() => {
    if (!visible || widget.status !== "active" || widget.kind !== "view") return;
    if (!widget.tool_id) {
      setRows([]);
      setErr(null);
      setMs(null);
      return;
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = widget.view?.refresh_ms;
    const load = async () => {
      // An earlier effect may still have a request in flight after a
      // collapse, reopening, or configuration change.
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (!live) return;
      const request = api.widgetData(widget.id);
      inFlight.current = request;
      try {
        const result = await request;
        if (!live) return;
        setRows(result.rows as Row[]);
        setMs(result.ms);
        setErr(null);
      } catch (e) {
        if (live) setErr((e as Error).message);
      } finally {
        inFlight.current = null;
        if (live && every) timer = setTimeout(() => void load(), every);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, visible, widget.id, widget.kind, widget.status, widget.tool_id, widget.view?.refresh_ms]);

  return (
    <div className="widget">
      <div className="widget-head">
        <span className="widget-name">{widget.view?.title ?? widget.name}</span>
        {widget.status === "draft" && <span className="tag">draft</span>}
        <span className="widget-meta">
          {widget.created_by_handle}
          {widget.view?.refresh_ms ? ` · ${Math.round(widget.view.refresh_ms / 1000)}s` : ""}
          {ms !== null ? ` · ${ms}ms` : ""}
        </span>
      </div>

      {widget.status === "draft" ? (
        <div className="widget-gate">
          Draft — activate to run.{" "}
          {widget.tool_status && widget.tool_status !== "active" && (
            <>
              Its tool <code>{widget.tool_name}</code> is {widget.tool_status}.
            </>
          )}
        </div>
      ) : widget.status === "disabled" ? (
        <div className="widget-gate">Disabled</div>
      ) : err && widget.kind === "view" ? (
        <div className="widget-err">{err}</div>
      ) : widget.kind === "embed" ? (
        <EmbedWidget url={widget.url} />
      ) : widget.kind === "html" ? (
        <HtmlWidget id={widget.id} api={api} />
      ) : rows === null ? (
        <div className="widget-loading">loading…</div>
      ) : (
        <View spec={widget.view!} rows={rows} />
      )}
    </div>
  );
}

function View({ spec, rows }: { spec: ViewSpec; rows: Row[] }) {
  if (!rows.length) return <div className="widget-loading">no rows</div>;

  if (spec.type === "metric") {
    const field = spec.value_field ?? Object.keys(rows[0]!)[0]!;
    return (
      <div className="w-metric">
        <span className="w-metric-value">{fmt(num(rows[0]![field]))}</span>
        {spec.unit && <span className="w-metric-unit">{spec.unit}</span>}
      </div>
    );
  }

  if (spec.type === "bar") {
    const keys = Object.keys(rows[0]!);
    const lf = spec.label_field ?? keys[0]!;
    const vf = spec.value_field ?? keys[1] ?? keys[0]!;
    const max = Math.max(...rows.map((r) => num(r[vf])), 1);
    return (
      <div className="w-bars">
        {rows.slice(0, 12).map((r, i) => (
          <div className="w-bar-row" key={i}>
            <span className="w-bar-label">{String(r[lf] ?? "")}</span>
            <span className="w-bar-track">
              <span className="w-bar-fill" style={{ width: `${(num(r[vf]) / max) * 100}%` }} />
            </span>
            <span className="w-bar-value">{fmt(num(r[vf]))}</span>
          </div>
        ))}
      </div>
    );
  }

  if (spec.type === "status_grid") {
    const keys = Object.keys(rows[0]!);
    const lf = spec.label_field ?? keys[0]!;
    const sf = spec.status_field ?? keys[1] ?? keys[0]!;
    return (
      <div className="w-grid">
        {rows.slice(0, 24).map((r, i) => {
          const s = statusOf(r[sf]);
          return (
            <div className="w-cell" key={i}>
              <span className="w-cell-glyph" style={{ color: s.color }}>
                {s.glyph}
              </span>
              <span className="w-cell-label">{String(r[lf] ?? "")}</span>
              <span className="w-cell-status" style={{ color: s.color }}>
                {s.label}
              </span>
              {spec.detail_field && <span className="w-cell-detail">{String(r[spec.detail_field] ?? "")}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  const cols = spec.columns?.length ? spec.columns : Object.keys(rows[0]!);
  return (
    <div className="w-table-wrap">
      <table className="w-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{String(r[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tier 2: author-supplied HTML. srcdoc WITHOUT allow-same-origin gives the
 *  frame a null origin — no cookies, no storage, no reach into the host page.
 *  Its only channel is postMessage, and data arrives from us, so the widget
 *  holds exactly its tool's permissions and nothing more. */
/**
 * Tier 3: a framed website.
 *
 * This exists because it cannot be done with an html widget. That kind renders
 * inside a srcdoc frame sandboxed without allow-same-origin — on purpose, so a
 * widget has no reach into the host page — and sandbox flags only ever narrow
 * going down the frame tree. A site's own <iframe> nested in there inherits the
 * null origin however it is written, loads with no cookies and no storage, and
 * any page that reads localStorage while booting throws before it paints. The
 * symptom is a white rectangle and nothing in the UI to explain it.
 *
 * At the top level the frame is the site's own origin instead, so the page
 * behaves exactly as it does in a tab — and it is still cross-origin from the
 * workspace, which is what keeps it out of this page.
 */
function EmbedWidget({ url }: { url: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    // A cross-origin frame reports load and nothing else — not a 404, not a
    // refusal to be framed. Silence past this point is the only failure we can
    // honestly detect, so it is the only one claimed.
    const t = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(t);
  }, [url]);

  if (!url) return <div className="widget-err">This embed has no URL.</div>;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return <div className="widget-err">Not a usable address: {url}</div>;
  }
  if (!/^https?:$/.test(target.protocol)) {
    return <div className="widget-err">Only http and https can be framed.</div>;
  }

  // allow-same-origin means "the framed site's own origin" only while that
  // origin differs from this page's. Were they the same, the token would hand
  // the frame the workspace itself, so it is withheld — the site may not work
  // without storage, and that is the right way round.
  const crossOrigin = target.origin !== window.location.origin;
  const sandbox = [
    "allow-scripts",
    "allow-forms",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    ...(crossOrigin ? ["allow-same-origin"] : []),
  ].join(" ");

  return (
    <div className="w-embed">
      <iframe
        className="w-embed-frame"
        src={url}
        title={target.host}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <div className="w-embed-note">
          {slow ? `${target.host} has not responded.` : `Loading ${target.host}…`}
        </div>
      )}
      {!crossOrigin && (
        <div className="w-embed-note bottom">
          Same origin as the workspace, so this frame runs without storage.
        </div>
      )}
    </div>
  );
}

function HtmlWidget({ id, api }: { id: string; api: Api }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(180);

  useEffect(() => {
    void api.widgetHtml(id).then((r) => setHtml(r.html));
  }, [api, id]);

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data as { type?: string; height?: number };
      if (msg?.type === "resize" && typeof msg.height === "number") {
        setHeight(Math.max(60, Math.min(msg.height, 600)));
      }
      if (msg?.type === "data") {
        const r = await api.widgetData(id).catch(() => ({ rows: [] }));
        frame.current?.contentWindow?.postMessage({ type: "data", rows: r.rows }, "*");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [api, id]);

  if (html === null) return <div className="widget-loading">loading…</div>;

  // The bridge must be defined BEFORE the author's markup: their inline script
  // runs at parse time, so a bridge appended afterwards is undefined when called.
  const doc = `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:10px;background:transparent;color:#e4e8f1;
       font:12px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
  *{box-sizing:border-box}
</style>
<script>
  window.bulletz = { data: () => parent.postMessage({ type: "data" }, "*") };
<\/script>
<body>${html}
<script>
  const post = () => parent.postMessage({ type: "resize", height: document.body.scrollHeight + 12 }, "*");
  new ResizeObserver(post).observe(document.body); post();
<\/script>`;

  return (
    <iframe
      ref={frame}
      className="w-frame"
      style={{ height }}
      sandbox="allow-scripts"
      srcDoc={doc}
      title="widget"
    />
  );
}
