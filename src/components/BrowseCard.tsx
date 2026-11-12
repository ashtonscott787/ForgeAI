import { useState } from "react";
import { api } from "../lib/ipc";

/**
 * The model asking to look at a page.
 *
 * It does not fetch on its own. A reply is text, and text should not be able to
 * make the app reach out to an address the person never saw — so the address is
 * shown first and a person presses the button. Once read, the page's text goes
 * back to the model as a new turn, and the browser pane opens on the same page
 * so what the model is working from is visible rather than taken on trust.
 */
export function BrowseCard({
  url,
  disabled,
  onRead,
  onOpenPane,
}: {
  url: string;
  disabled?: boolean;
  /** The page's readable text, handed back to the model. */
  onRead?: (text: string) => void;
  onOpenPane?: (url: string) => void;
}) {
  const [state, setState] = useState<"idle" | "reading" | "done" | "failed">("idle");
  const [error, setError] = useState("");

  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  async function read() {
    setState("reading");
    setError("");
    onOpenPane?.(url);
    try {
      const r = await api.readUrl(url);
      if (!r.ok) { setState("failed"); setError(r.error ?? "That page could not be read."); return; }
      setState("done");
      onRead?.(`Here is the readable text of ${r.url}:\n\n${r.text}`);
    } catch (e) {
      setState("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="browsecard">
      <div className="browsecard-h">
        <span className="bact-globe" aria-hidden="true">🌐</span>
        <span className="browsecard-t">
          {state === "done" ? "Read" : "Wants to look at"} <strong>{host}</strong>
        </span>
        {state === "idle" && (
          <button type="button" className="ghostbtn" disabled={disabled || !onRead} onClick={() => void read()}>
            Open and read
          </button>
        )}
        {state === "reading" && <span className="hint">Reading…</span>}
      </div>
      <code className="browsecard-url num">{url}</code>
      {state === "failed" && <div className="hint">{error}</div>}
      {!onRead && state === "idle" && <div className="hint">Only the newest reply can look something up.</div>}
    </div>
  );
}
