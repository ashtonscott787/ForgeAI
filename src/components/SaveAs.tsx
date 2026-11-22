import { useState } from "react";
import { api } from "../lib/ipc";

const KINDS = [
  ["pdf", "PDF"],
  ["docx", "Word"],
  ["md", "Markdown"],
  ["txt", "Text"],
  ["html", "Web page"],
] as const;

/**
 * Saves a reply as a real file. The result says where it went and how large it
 * is, because "Saved" on its own is exactly the claim that should be checked —
 * a writer that produced an empty file would otherwise look like a success.
 */
export function SaveAs({ text, title }: { text: string; title: string }) {
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  async function save(kind: (typeof KINDS)[number][0]) {
    setBusy(kind);
    setNote("");
    try {
      const r = await api.saveDocument({ kind, title, text });
      if (r.cancelled) return;
      setNote(r.ok ? `Saved ${r.path} (${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB)` : `Not saved: ${r.error}`);
    } catch (e) {
      setNote(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  }

  // Five buttons and a label under every answer was a row of furniture on a
  // page that is mostly read. It is one quiet control now, and the formats
  // appear when it is asked for.
  return (
    <div className="saveas">
      {!open ? (
        <button type="button" className="linkbtn" onClick={() => setOpen(true)}>Save as…</button>
      ) : (
        <>
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" className="ghostbtn small" disabled={Boolean(busy)} onClick={() => void save(k)}>
              {busy === k ? "Saving…" : label}
            </button>
          ))}
          <button type="button" className="linkbtn" onClick={() => setOpen(false)}>Cancel</button>
        </>
      )}
      {note && <div className="hint saveas-note">{note}</div>}
    </div>
  );
}
