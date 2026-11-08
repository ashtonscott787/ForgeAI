import { useEffect, useMemo, useState } from "react";
import {
  api,
  CAP_LABEL,
  fmtBytes,
  type Catalogue,
  type CatalogueEntry,
  type DownloadProgress,
  type EngineStatus,
  type Health,
  type InstalledModel,
  type MachineCapability,
} from "../lib/ipc";
import { describeInstalled, forgetInstall, recordFor, recordInstall } from "../lib/library";

interface Props {
  self: MachineCapability | null;
  health: Health | null;
  engine: EngineStatus;
  catalogue: Catalogue | null;
  installed: InstalledModel[];
  onInstalledChange: () => void;
  onEngineChange: (e: EngineStatus) => void;
  onUse: (fileName: string) => void;
}

type Fit = { kind: "good" | "tight" | "slow" | "no"; label: string };

/** Fit is derived from detected memory, never asserted when memory is unknown. */
function fitFor(bytes: number, usable: number): Fit {
  if (usable <= 0) return { kind: "tight", label: "Checking hardware…" };
  if (bytes > usable) return { kind: "no", label: "Not enough memory" };
  if (bytes > usable * 0.8) return { kind: "slow", label: "May be slow" };
  if (bytes > usable * 0.55) return { kind: "tight", label: "Compatible" };
  return { kind: "good", label: "Recommended" };
}

const pct = (p: DownloadProgress) => (p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0);

export function Models(props: Props) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("All");
  const [cap, setCap] = useState("All");
  const [quant, setQuant] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    const off = api.onDownloadProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.model_id]: p }));
      if (p.done) {
        setProgress((prev) => {
          const copy = { ...prev };
          delete copy[p.model_id];
          return copy;
        });
        props.onInstalledChange();
      }
    });
    return () => void off.then((f) => f());
  }, [props]);

  const usable = props.self?.usable_model_bytes ?? 0;
  const entries = props.catalogue?.models ?? [];
  const installed = describeInstalled(props.installed);
  const installedIds = new Set(installed.map((i) => i.record?.model_id).filter(Boolean));

  const families = useMemo(
    () => ["All", ...Array.from(new Set(entries.map((e) => e.family)))],
    [entries],
  );
  const caps = useMemo(
    () => ["All", ...Array.from(new Set(entries.flatMap((e) => e.caps)))],
    [entries],
  );

  const shown = entries.filter((e) => {
    if (family !== "All" && e.family !== family) return false;
    if (cap !== "All" && !e.caps.includes(cap as never)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      e.developer.toLowerCase().includes(q) ||
      e.family.toLowerCase().includes(q) ||
      e.caps.some((c) => c.includes(q))
    );
  });

  async function download(entry: CatalogueEntry) {
    const q = quant[entry.id] ?? "Q4_K_M";
    setError(null);
    setNotice(null);
    setBusy((b) => ({ ...b, [entry.id]: "Looking up the file…" }));
    try {
      const r = await api.resolveArtifact(entry.repo, q);
      if (!r.matched_requested_quant) {
        setNotice(
          `${entry.name}: ${q} is not published in that repository, so Forge is fetching ${r.file_name} instead.`,
        );
      }
      setBusy((b) => ({ ...b, [entry.id]: "Starting download…" }));
      setProgress((p) => ({
        ...p,
        [entry.id]: { model_id: entry.id, received: 0, total: r.bytes, bytes_per_sec: 0, done: false },
      }));
      await api.downloadModel(entry.id, r.url, r.file_name, r.sha256);
      recordInstall(recordFor(entry, r.file_name, q, r.bytes));
      props.onInstalledChange();
    } catch (e) {
      setError(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      setProgress((p) => {
        const copy = { ...p };
        delete copy[entry.id];
        return copy;
      });
    } finally {
      setBusy((b) => {
        const copy = { ...b };
        delete copy[entry.id];
        return copy;
      });
    }
  }

  async function downloadCustom() {
    const url = customUrl.trim();
    if (!/^https:\/\/.+\.gguf(\?.*)?$/i.test(url)) {
      setError("That does not look like a direct link to a .gguf file.");
      return;
    }
    const fileName = decodeURIComponent(url.split("?")[0]!.split("/").pop() ?? "model.gguf");
    setError(null);
    setBusy((b) => ({ ...b, custom: "Starting download…" }));
    try {
      await api.downloadModel("custom:" + fileName, url, fileName, "");
      props.onInstalledChange();
      setCustomUrl("");
      setShowCustom(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => {
        const copy = { ...b };
        delete copy.custom;
        return copy;
      });
    }
  }

  async function remove(fileName: string) {
    try {
      await api.deleteModel(fileName);
      forgetInstall(fileName);
      props.onInstalledChange();
      if (props.engine.model_file === fileName) props.onEngineChange(await api.engineStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="scroll pane">
      <div className="pane-head">
        <div>
          <h2>Model library</h2>
          <p className="sub">
            Models run on this computer. Downloads come straight from Hugging Face and stay local.
          </p>
        </div>
        <button className="ghostbtn" onClick={() => setShowCustom((v) => !v)}>
          {showCustom ? "Close" : "Add from URL"}
        </button>
      </div>

      {!props.health?.runtime_available && (
        <div className="banner warn">The AI engine is missing from this copy of Forge AI.</div>
      )}
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}

      {showCustom && (
        <div className="customrow">
          <input
            className="inp"
            placeholder="https://huggingface.co/…/model-Q4_K_M.gguf"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
          />
          <button className="primary" disabled={!!busy.custom} onClick={() => void downloadCustom()}>
            {busy.custom ?? "Download"}
          </button>
        </div>
      )}

      {installed.length > 0 && (
        <>
          <h3 className="secthead">Installed · {installed.length}</h3>
          <div className="grid">
            {installed.map((i) => (
              <div key={i.file_name} className="mcard installed">
                <div className="mcard-top">
                  <div>
                    <div className="mcard-name">{i.label}</div>
                    <div className="mcard-sub">
                      {i.record?.developer ?? "Local file"} · {i.record?.quant ?? "GGUF"} ·{" "}
                      {fmtBytes(i.bytes)}
                    </div>
                  </div>
                  {props.engine.model_file === i.file_name && <span className="pill on">Running</span>}
                </div>
                <div className="mcard-actions">
                  <button className="primary" onClick={() => props.onUse(i.file_name)}>
                    Use in chat
                  </button>
                  <button className="ghostbtn" onClick={() => void remove(i.file_name)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="secthead">Available</h3>
      <div className="filters">
        <input
          className="inp search"
          placeholder="Search models, makers or capabilities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chiprow">
          {families.map((f) => (
            <button key={f} className={`fchip${family === f ? " on" : ""}`} onClick={() => setFamily(f)}>
              {f}
            </button>
          ))}
        </div>
        <div className="chiprow">
          {caps.map((c) => (
            <button key={c} className={`fchip${cap === c ? " on" : ""}`} onClick={() => setCap(c)}>
              {c === "All" ? "All capabilities" : (CAP_LABEL[c] ?? c)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid">
        {shown.map((e) => {
          const q = quant[e.id] ?? "Q4_K_M";
          const bytes = e.est_bytes[q] ?? 0;
          const fit = fitFor(bytes, usable);
          const p = progress[e.id];
          const isInstalled = installedIds.has(e.id);
          return (
            <div key={e.id} className="mcard">
              <div className="mcard-top">
                <div>
                  <div className="mcard-name">{e.name}</div>
                  <div className="mcard-sub">
                    {e.developer} · {e.params_b}B · {Math.round(e.max_context / 1024)}K context
                  </div>
                </div>
                <span className={`pill fit-${fit.kind}`}>{fit.label}</span>
              </div>

              <div className="caps">
                {e.caps.map((c) => (
                  <span key={c} className="cap">
                    {CAP_LABEL[c] ?? c}
                  </span>
                ))}
              </div>

              <div className="mcard-meta num">
                ≈{fmtBytes(bytes)} download · {e.license} ·{" "}
                {e.reference_tok_s > 0 ? `${e.reference_tok_s} tok/s` : "speed unmeasured"}
              </div>

              {p ? (
                <div className="dlwrap">
                  <div className="pbar">
                    <span style={{ width: `${pct(p)}%` }} />
                  </div>
                  <div className="dlmeta num">
                    {fmtBytes(p.received)} of {fmtBytes(p.total)}
                    {p.bytes_per_sec > 0 ? ` · ${fmtBytes(p.bytes_per_sec)}/s` : ""}
                  </div>
                </div>
              ) : (
                <div className="mcard-actions">
                  <select
                    className="qsel"
                    value={q}
                    onChange={(ev) => setQuant((s) => ({ ...s, [e.id]: ev.target.value }))}
                  >
                    {e.quants.map((qq) => (
                      <option key={qq} value={qq}>
                        {qq}
                      </option>
                    ))}
                  </select>
                  <button
                    className={isInstalled ? "ghostbtn grow" : "primary"}
                    disabled={!!busy[e.id] || fit.kind === "no" || isInstalled}
                    onClick={() => void download(e)}
                  >
                    {isInstalled ? "Installed" : (busy[e.id] ?? "Download")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shown.length === 0 && <p className="sub">Nothing matches that search.</p>}
    </div>
  );
}
