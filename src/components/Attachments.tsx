import { fmtBytes, type Attachment } from "../lib/ipc";

const ICON: Record<string, string> = {
  pdf: "PDF",
  docx: "DOC",
  pptx: "PPT",
  xlsx: "XLS",
  table: "CSV",
  text: "TXT",
  image: "IMG",
  other: "?",
};

/** The files riding along with the next message. */
export function Attachments({
  files,
  onRemove,
  reading,
}: {
  files: Attachment[];
  onRemove: (name: string) => void;
  reading: boolean;
}) {
  if (!files.length && !reading) return null;
  return (
    <div className="attachbar">
      {reading && <span className="sub">Reading files…</span>}
      {files.map((f) => (
        <div key={f.path} className={`attach${f.readable ? "" : " warn"}`} title={f.note || f.path}>
          {f.kind === "image" && f.preview ? (
            <img className="athumb" src={`data:image/*;base64,${f.preview}`} alt="" />
          ) : (
            <span className="atype num">{ICON[f.kind] ?? "FILE"}</span>
          )}
          <span className="aname">{f.name}</span>
          <span className="asize num">
            {fmtBytes(f.bytes)}
            {f.pages ? ` · ${f.pages}p` : ""}
          </span>
          <button className="conv-x" title="Remove" onClick={() => onRemove(f.name)}>
            ×
          </button>
        </div>
      ))}
      {files.some((f) => !f.readable) && (
        <div className="attachnote">
          {files.filter((f) => !f.readable).map((f) => `${f.name}: ${f.note}`).join(" ")}
        </div>
      )}
    </div>
  );
}
