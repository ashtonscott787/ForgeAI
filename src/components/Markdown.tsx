import { Fragment, type ReactNode } from "react";

/**
 * A small, deliberate subset of Markdown: headings, lists, quotes, bold,
 * italic, inline code and links. It builds React elements directly, so no
 * model output is ever handed to the DOM as HTML.
 */

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>)]+)/g;

function inline(text: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    last = at + tok.length;
    if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++} className="icode">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("*")) out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("[")) {
      const label = tok.slice(1, tok.indexOf("]"));
      const url = m[2] ?? "";
      out.push(
        <a key={k++} href={url} onClick={(e) => { e.preventDefault(); onLink?.(url); }}>
          {label}
        </a>,
      );
    } else {
      out.push(
        <a key={k++} href={tok} onClick={(e) => { e.preventDefault(); onLink?.(tok); }}>
          {tok}
        </a>,
      );
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = (["h3", "h4", "h5", "h5"] as const)[level - 1] ?? "h5";
      blocks.push(<Tag key={key++} className="mdh">{inline(heading[2] ?? "", onLink)}</Tag>);
      i += 1;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className="mdlist">
          {items.map((it, n) => (
            <li key={n}>{inline(it, onLink)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(<blockquote key={key++}>{inline(quote.join(" "), onLink)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,4}\s|\s*([-*•]|\d+[.)])\s|\s*>)/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(<p key={key++}>{inline(para.join("\n"), onLink)}</p>);
  }

  return <Fragment>{blocks}</Fragment>;
}
