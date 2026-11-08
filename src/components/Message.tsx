import { parseSegments } from "../lib/blocks";
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
}: {
  content: string;
  streaming: boolean;
  onSend: (text: string) => void;
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
