/**
 * Message formatting.
 *
 * Everything in a channel is written by people and agents, so this renders to
 * React elements and never to an HTML string — there is no
 * dangerouslySetInnerHTML here and no path that could grow one. That is the
 * whole security argument: markup someone typed cannot become markup the
 * browser executes, because it is never handed to the browser as markup.
 *
 * It covers the subset this product actually carries rather than all of
 * CommonMark. Agents post code, lists and links; nobody has yet posted a
 * reference-style footnote. Anything unrecognised stays visible as the
 * characters that were typed, which is the right failure: a message is worse
 * mangled than unformatted.
 */
import { type ReactNode } from "react";

/** Schemes a link may use. A markdown link is an href someone else chose, so
 *  javascript: and data: are not navigations we will offer. */
const SAFE_LINK = /^(https?:|mailto:)/i;

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+)/;

/** One line of text to nodes: code first, so a marker inside backticks stays
 *  literal rather than being read as emphasis. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;

  while (rest) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;

    if (tok.startsWith("`")) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={key}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      out.push(
        SAFE_LINK.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          // Shown as written. Quietly dropping it would hide what someone
          // actually sent, which matters more than tidiness here.
          tok
        ),
      );
    } else if (tok.startsWith("http")) {
      out.push(
        <a key={key} href={tok} target="_blank" rel="noreferrer noopener">
          {tok}
        </a>,
      );
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }

  if (rest) out.push(rest);
  return out;
}

/** A run of text lines, with newlines kept as line breaks. In a chat window a
 *  new line is a new line; collapsing them the way a document would is wrong
 *  for the medium. */
function lines(text: string, keyBase: string): ReactNode[] {
  return text.split("\n").flatMap((l, i) => (i === 0 ? inline(l, `${keyBase}-${i}`) : [<br key={`${keyBase}-br-${i}`} />, ...inline(l, `${keyBase}-${i}`)]));
}

export function Markdown({ text }: { text: string }) {
  const src = (text ?? "").replace(/\r\n?/g, "\n");
  const out: ReactNode[] = [];
  const rows = src.split("\n");
  let i = 0;
  let k = 0;

  while (i < rows.length) {
    const line = rows[i]!;

    // Fenced code. An unclosed fence runs to the end rather than swallowing
    // the message into nothing — an agent cut off mid-block is common.
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < rows.length && !/^\s*```\s*$/.test(rows[i]!)) body.push(rows[i++]!);
      i++; // the closing fence, if there was one
      out.push(
        <pre key={`k${k++}`} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6);
      const Tag = `h${level + 2 > 6 ? 6 : level + 2}` as "h3" | "h4" | "h5" | "h6";
      // Shifted down two: a message is not a document, and an <h1> inside a
      // channel would outrank the channel's own heading.
      out.push(
        <Tag key={`k${k++}`} className="md-h">
          {inline(heading[2]!, `h${k}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push(<hr key={`k${k++}`} className="md-hr" />);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < rows.length && /^\s*>\s?/.test(rows[i]!)) body.push(rows[i++]!.replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={`k${k++}`} className="md-quote">
          {lines(body.join("\n"), `q${k}`)}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      const match = ordered ? numbered : bullet;
      while (i < rows.length && match.test(rows[i]!)) items.push(rows[i++]!.replace(match, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={`k${k++}`} className="md-list">
          {items.map((it, n) => (
            <li key={n}>{inline(it, `li${k}-${n}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // A paragraph runs to the next blank line or block opener.
    const para: string[] = [];
    while (
      i < rows.length &&
      rows[i]!.trim() &&
      !/^\s*```/.test(rows[i]!) &&
      !/^\s*>/.test(rows[i]!) &&
      !/^#{1,6}\s/.test(rows[i]!) &&
      !bullet.test(rows[i]!) &&
      !numbered.test(rows[i]!)
    ) {
      para.push(rows[i++]!);
    }
    out.push(
      <p key={`k${k++}`} className="md-p">
        {lines(para.join("\n"), `p${k}`)}
      </p>,
    );
  }

  return <>{out}</>;
}
