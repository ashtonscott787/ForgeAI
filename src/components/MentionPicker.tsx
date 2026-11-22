import { useEffect, useMemo, useState } from "react";
import { matching, type Assistant } from "../lib/assistants";

/**
 * The list that appears when you type "@".
 *
 * Faces and names, narrowing as the handle is typed, because remembering
 * "@theo" is harder than recognising Theo. Enter or a click completes the
 * handle; Escape leaves what was typed alone.
 *
 * It reads the text and the caret rather than owning the input, so the
 * composer stays the one place that holds what is being written.
 */
export interface Mention {
  /** Where the "@" is, in the text. */
  at: number;
  /** What has been typed after it. */
  partial: string;
}

/** The mention being typed at the caret, if there is one. */
export function mentionAt(text: string, caret: number): Mention | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  // Only at the start of a word, so an email address is not a mention.
  if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
  const partial = upto.slice(at + 1);
  if (/[^a-z0-9_-]/i.test(partial)) return null;
  return { at, partial };
}

export function MentionPicker({
  mention,
  onPick,
  onDismiss,
}: {
  mention: Mention;
  onPick: (a: Assistant) => void;
  onDismiss: () => void;
}) {
  const found = useMemo(() => matching(mention.partial), [mention.partial]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => { setCursor(0); }, [mention.partial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!found.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % found.length); }
      if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + found.length) % found.length); }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); onPick(found[cursor]!); }
      if (e.key === "Escape") { e.preventDefault(); onDismiss(); }
    };
    // Captured, so the composer does not send on Enter while this is open.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [found, cursor, onPick, onDismiss]);

  if (!found.length) return null;

  return (
    <div className="mentions" role="listbox" aria-label="Assistants">
      {found.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === cursor}
          className={`mention${i === cursor ? " on" : ""}`}
          onMouseEnter={() => setCursor(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(a); }}
        >
          {a.portrait
            ? <img className="face sm" src={a.portrait} alt="" width={28} height={28} />
            : <span className="face sm initials" style={{ background: a.accent }} aria-hidden="true">{a.initials}</span>}
          <span className="mention-id">
            <b>{a.name}</b>
            <span className="mention-handle">{a.handle}</span>
          </span>
          <span className="mention-role">{a.role}</span>
        </button>
      ))}
    </div>
  );
}
