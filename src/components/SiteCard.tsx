import { useEffect, useState } from "react";
import { api, type SiteReport } from "../lib/ipc";

/**
 * A whole website, previewed with its internal links working.
 *
 * The link report is shown before the preview rather than after, because a nav
 * that goes nowhere is the usual failure and the one a person otherwise finds
 * only by clicking every link themselves.
 */
export function SiteCard({ text }: { text: string }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [report, setReport] = useState<SiteReport | null>(null);
  const [summary, setSummary] = useState("");
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState<string>("index.html");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.siteParse(text).then((r) => {
      if (!live) return;
      setFiles(r.files);
      setReport(r.report);
      setSummary(r.summary);
      return api.sitePreview(r.files).then((p) => { if (live) setUrl(p.url); });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [text]);

  const names = Object.keys(files);
  if (!names.length) return null;
  const pages = names.filter((n) => n.endsWith(".html"));

  return (
    <div className="sitecard">
      <div className="sitecard-h">
        <strong>Website</strong>
        <span className={`hint${report && !report.ok ? " warnText" : ""}`}>{summary}</span>
        <span className="sitecard-acts">
          <button type="button" className={`ghostbtn${tab === "preview" ? " on" : ""}`} onClick={() => setTab("preview")}>Preview</button>
          <button type="button" className={`ghostbtn${tab === "code" ? " on" : ""}`} onClick={() => setTab("code")}>Code</button>
          <button
            type="button"
            className="ghostbtn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api.siteExport({ files, name: "website" })
                .then((r) => setNote(r.cancelled ? "" : r.ok ? `Saved ${r.path} (${r.files} files)` : `Not saved: ${r.error}`))
                .catch((e) => setNote(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Export ZIP
          </button>
        </span>
      </div>

      {report && report.broken.length > 0 && (
        <ul className="sitebroken">
          {report.broken.slice(0, 6).map((b, i) => (
            <li key={i}>{b.from} links to <code>{b.href}</code>, which is not in this site.</li>
          ))}
        </ul>
      )}

      <div className="sitetabs" role="tablist" aria-label="Pages">
        {names.map((n) => (
          <button
            key={n}
            role="tab"
            aria-selected={open === n}
            className={`sitetab${open === n ? " on" : ""}`}
            onClick={() => setOpen(n)}
          >
            {n}
          </button>
        ))}
      </div>

      {tab === "preview" ? (
        pages.includes(open) && url ? (
          <iframe
            className="siteframe"
            title={`Preview of ${open}`}
            src={`${url}${open === "index.html" ? "" : open}`}
            sandbox="allow-scripts"
          />
        ) : (
          <div className="hint sitepad">{pages.includes(open) ? "Preparing the preview…" : `${open} is not a page, so there is nothing to show. Use Code to read it.`}</div>
        )
      ) : (
        <pre className="codeblock siteCode"><code>{files[open]}</code></pre>
      )}

      {note && <div className="hint sitepad">{note}</div>}
    </div>
  );
}
