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

/** One assistant turn, rendered as the pieces it actually contains. */
export function AssistantMessage({
  content,
  streaming,
  onSend,
  onResearch,
}: {
  content: string;
  streaming: boolean;
  onSend: (text: string) => void;
  /** Research runs itself and feeds the findings straight back to the model. */
  onResearch?: (text: string) => void;
}) {
  const segments = parseSegments(content);
  const openLink = (url: string) => void api.openExternal(url).catch(() => undefined);

  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "text") return <Markdown key={i} text={s.text} onLink={openLink} />;
        if (s.kind === "html") return <HtmlPreview key={i} code={s.code} streaming={streaming} />;
        if (s.kind === "ui") return <GenUI key={i} spec={s.spec} disabled={streaming} onSubmit={onSend} />;
        if (s.kind === "email") return <EmailCard key={i} email={s.email} />;
        if (s.kind === "memory") return <MemoryAskCard key={i} ask={s.ask} />;
        if (s.kind === "reminder") return <ReminderAskCard key={i} ask={s.ask} />;
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
    </>
  );
}
