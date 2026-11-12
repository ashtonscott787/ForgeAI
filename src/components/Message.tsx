import { useEffect, useState } from "react";
import { parseSegments } from "../lib/blocks";
import { MemoryAskCard } from "./MemoryAskCard";
import { ReminderAskCard } from "./ReminderAskCard";
import { ResearchCard } from "./ResearchCard";
import { api } from "../lib/ipc";
import { CopyButton } from "./Copy";
import { EmailCard } from "./EmailCard";
import { GenUI } from "./GenUI";
import { HtmlPreview } from "./HtmlPreview";
import { Markdown } from "./Markdown";
import { BrowseCard } from "./BrowseCard";
import { SaveAs } from "./SaveAs";
import { SiteCard } from "./SiteCard";

/**
 * The model's own working. Collapsed once it is finished, and shown open while
 * it is still being written, because that is the only time it is worth watching.
 */
function Thinking({ text, open }: { text: string; open: boolean }) {
  const [show, setShow] = useState(open);
  useEffect(() => { if (open) setShow(true); }, [open]);
  return (
    <div className="thinking">
      <button type="button" className="thinking-h" aria-expanded={show} onClick={() => setShow((v) => !v)}>
        <span className="thinking-dot" aria-hidden="true" />
        <span>{open ? "Thinking…" : "Thought about this"}</span>
        <span className={`bact-chev${show ? " on" : ""}`} aria-hidden="true">›</span>
      </button>
      {show && <pre className="thinking-b">{text}</pre>}
    </div>
  );
}

/** One assistant turn, rendered as the pieces it actually contains. */
export function AssistantMessage({
  content,
  streaming,
  onSend,
  onResearch,
  onOpenPane,
  showThinking = false,
}: {
  content: string;
  streaming: boolean;
  onSend: (text: string) => void;
  /** Research runs itself and feeds the findings straight back to the model. */
  onResearch?: (text: string) => void;
  /** Shows the page in the browser pane beside the conversation. */
  onOpenPane?: (url: string) => void;
  /** Off by default: most people want the answer, not the working. */
  showThinking?: boolean;
}) {
  const segments = parseSegments(content);
  const openLink = (url: string) => void api.openExternal(url).catch(() => undefined);

  // Two or more pages in one reply is a website, and showing it as a row of
  // unrelated preview cards hides the thing that matters: whether its links work.
  const htmlBlocks = segments.filter((s) => s.kind === "html").length;
  const isSite = !streaming && htmlBlocks > 1;

  // Prose long enough to be worth keeping can be saved as a real file.
  const prose = segments.filter((s) => s.kind === "text").map((s) => s.text).join("\n").trim();
  const canSave = !streaming && prose.length > 400;
  const title = (prose.match(/^#+\s*(.+)$/m)?.[1] ?? prose.split("\n")[0] ?? "Document").slice(0, 80);

  if (isSite) {
    return (
      <>
        {segments.map((s, i) => (s.kind === "text" ? <Markdown key={i} text={s.text} onLink={openLink} /> : null))}
        <SiteCard text={content} />
      </>
    );
  }

  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "text") return <Markdown key={i} text={s.text} onLink={openLink} />;
        if (s.kind === "html") return <HtmlPreview key={i} code={s.code} streaming={streaming} />;
        if (s.kind === "ui") return <GenUI key={i} spec={s.spec} disabled={streaming} onSubmit={onSend} />;
        if (s.kind === "email") return <EmailCard key={i} email={s.email} />;
        if (s.kind === "memory") return <MemoryAskCard key={i} ask={s.ask} />;
        if (s.kind === "reminder") return <ReminderAskCard key={i} ask={s.ask} />;
        if (s.kind === "thinking") return showThinking ? <Thinking key={i} text={s.text} open={s.open} /> : null;
        if (s.kind === "browse")
          return (
            <BrowseCard
              key={i}
              url={s.url}
              disabled={streaming}
              onRead={onResearch}
              onOpenPane={onOpenPane}
            />
          );
        if (s.kind === "search")
          return (
            <ResearchCard
              key={i}
              query={s.ask.query}
              disabled={streaming || !onResearch}
              onResult={(t) => onResearch?.(t)}
            />
          );
        return (
          <div key={i} className="codewrap">
            <div className="codebar">
              <span className="num">{s.lang}</span>
              <CopyButton text={s.code} label="Copy" />
            </div>
            <pre className="codeblock">
              <code>{s.code}</code>
            </pre>
          </div>
        );
      })}
      {canSave && <SaveAs text={prose} title={title} />}
    </>
  );
}
