import { useMemo, useState } from "react";
import { api } from "../lib/ipc";
import { CopyButton } from "./Copy";

type Tab = "preview" | "code" | "split";
type Device = { id: string; label: string; width: number | null };

const DEVICES: Device[] = [
  { id: "fit", label: "Fit", width: null },
  { id: "desktop", label: "Desktop", width: 1280 },
  { id: "tablet", label: "Tablet", width: 834 },
  { id: "mobile", label: "Mobile", width: 390 },
];

/**
 * A generated page, rendered live.
 *
 * The frame is sandboxed to scripts only: no same-origin access, no forms
 * posting out, no downloads, no top-level navigation. A generated page can
 * therefore run its own JavaScript but cannot reach Forge AI, the file system
 * or the network credentials of the app.
 */
export function HtmlPreview({ code, streaming }: { code: string; streaming?: boolean }) {
  const [tab, setTab] = useState<Tab>("preview");
  const [device, setDevice] = useState<Device>(DEVICES[0]!);
  const [big, setBig] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Re-mounting on every token would thrash the frame, so the preview only
  // takes a new document once the block is complete.
  const doc = useMemo(() => code, [code]);

  const frame = (
    <div className={`previewstage${device.width ? " bounded" : ""}`}>
      <iframe
        className="previewframe"
        title="Generated page"
        sandbox="allow-scripts"
        srcDoc={doc}
        style={device.width ? { width: device.width } : undefined}
      />
    </div>
  );

  const codeView = (
    <pre className="codeblock preview-code">
      <code>{code}</code>
    </pre>
  );

  return (
    <div className={`previewcard${big ? " expanded" : ""}`}>
      <div className="previewbar">
        <div className="segtabs">
          {(["preview", "code", "split"] as Tab[]).map((t) => (
            <button key={t} className={`tabbtn${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {t === "preview" ? "Preview" : t === "code" ? "Code" : "Split"}
            </button>
          ))}
        </div>
        <div className="segtabs">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              className={`tabbtn${device.id === d.id ? " on" : ""}`}
              onClick={() => setDevice(d)}
              title={d.width ? `${d.width}px wide` : "Fill the panel"}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="previewbar-right">
          {streaming && <span className="sub">writing…</span>}
          <CopyButton text={code} label="Copy HTML" />
          <button className="ghostbtn" onClick={() => setBig((v) => !v)}>
            {big ? "Shrink" : "Expand"}
          </button>
          <button className="ghostbtn" onClick={() => void api.previewInBrowser(code, "forge-preview")}>
            Open in browser
          </button>
          <button
            className="ghostbtn"
            onClick={() => {
              void api
                .saveTextFile("forge-page.html", code)
                .then((p) => p && setSaved(p))
                .catch(() => undefined);
            }}
          >
            Export
          </button>
        </div>
      </div>

      {tab === "preview" && frame}
      {tab === "code" && codeView}
      {tab === "split" && (
        <div className="splitview">
          {codeView}
          {frame}
        </div>
      )}
      {saved && <div className="previewsaved num">Saved to {saved}</div>}
    </div>
  );
}
