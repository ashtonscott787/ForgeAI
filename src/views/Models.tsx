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
import { describeInstalled, forgetInstall, recordFor, recordInstall, type LibraryRecord } from "../lib/library";
import { Logo } from "../components/Logo";
import type { HubHit, HubSort, RepoFile } from "../lib/ipc";

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

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

const pct = (p: DownloadProgress) => (p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0);

export function Models(props: Props) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("All");
  const [cap, setCap] = useState("All");
  const [maxParams, setMaxParams] = useState(70);
  const [quant, setQuant] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [tab, setTab] = useState<"curated" | "hub">("curated");
  const [hubQuery, setHubQuery] = useState("");
  const [hubSort, setHubSort] = useState<HubSort>("downloads");
  const [hubHits, setHubHits] = useState<HubHit[] | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoFile[] | null>(null);

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
    if (maxParams < 70 && e.params_b > maxParams) return false;
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

  async function searchHub() {
    setHubBusy(true);
    setError(null);
    setRepoFiles(null);
    setOpenRepo(null);
    try {
      setHubHits(await api.searchHub({ query: hubQuery, sort: hubSort, limit: 36 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHubHits([]);
    } finally {
      setHubBusy(false);
    }
  }

  async function openFiles(repo: string) {
    if (openRepo === repo) {
      setOpenRepo(null);
      return;
    }
    setOpenRepo(repo);
    setRepoFiles(null);
    setError(null);
    try {
      const r = await api.listRepoFiles(repo);
      setRepoFiles(r.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpenRepo(null);
    }
  }

  /** Download a specific GGUF chosen from a repository listing. */
  async function downloadFile(repo: string, f: RepoFile) {
    const id = `${repo}:${f.file_name}`;
    setError(null);
    setBusy((b) => ({ ...b, [id]: "Starting…" }));
    setProgress((p) => ({
      ...p,
      [id]: { model_id: id, received: 0, total: f.bytes, bytes_per_sec: 0, done: false },
    }));
    try {
      await api.downloadModel(id, f.url, f.file_name, f.sha256);
      const rec: LibraryRecord = {
        file_name: f.file_name,
        model_id: id,
        name: repo.split("/")[1] ?? f.file_name,
        family: repo.split("/")[0] ?? "",
        developer: repo.split("/")[0] ?? "Hugging Face",
        params_b: 0,
        max_context: 0,
        caps: [],
        quant: f.quant,
        bytes: f.bytes,
        added: Date.now(),
      };
      recordInstall(rec);
      props.onInstalledChange();
    } catch (e) {
      setError(`${f.file_name}: ${e instanceof Error ? e.message : String(e)}`);
      setProgress((p) => {
        const copy = { ...p };
        delete copy[id];
        return copy;
      });
    } finally {
      setBusy((b) => {
        const copy = { ...b };
        delete copy[id];
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
            Models run on this computer. Downloads go straight to your machine and stay there.
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
            placeholder="Direct link to a .gguf model file"
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

      <div className="secthead-row">
        <h3 className="secthead">Available</h3>
        <div className="segtabs">
          <button className={`tabbtn${tab === "curated" ? " on" : ""}`} onClick={() => setTab("curated")}>
            Picked for you
          </button>
          <button className={`tabbtn${tab === "hub" ? " on" : ""}`} onClick={() => setTab("hub")}>
            Browse all models
          </button>
        </div>
      </div>

      {tab === "curated" ? (
        <>
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
            <div className="sizerow">
              <label className="glabel" htmlFor="sizecap">
                Size up to <b className="num">{maxParams >= 70 ? "any" : `${maxParams}B`}</b> parameters
              </label>
              <input
                id="sizecap"
                type="range"
                min={1}
                max={70}
                step={1}
                value={maxParams}
                onChange={(e) => setMaxParams(Number(e.target.value))}
              />
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
                <div className="mcard-id">
                  <Logo author={e.repo.split("/")[0] ?? e.developer} name={`${e.family} ${e.developer}`} />
                  <div>
                  <div className="mcard-name">{e.name}</div>
                  <div className="mcard-sub">
                    {e.developer} · {e.params_b}B · {Math.round(e.max_context / 1024)}K context
                  </div>
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
        </>
      ) : (
        <>
          <div className="hubbar">
            <input
              className="inp search"
              placeholder="Search every available model — try qwen3, kimi, mistral, gemma"
              value={hubQuery}
              onChange={(e) => setHubQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void searchHub();
              }}
            />
            <select className="qsel" value={hubSort} onChange={(e) => setHubSort(e.target.value as HubSort)}>
              <option value="downloads">Most downloaded</option>
              <option value="likes">Most liked</option>
              <option value="trendingScore">Trending</option>
              <option value="lastModified">Recently updated</option>
            </select>
            <button className="primary" disabled={hubBusy} onClick={() => void searchHub()}>
              {hubBusy ? "Searching…" : "Search"}
            </button>
          </div>
          <p className="sub">
            Only models published in a format this app can run appear here. Pick one to see every
            size and quantization it offers, with what each needs from your machine.
          </p>

          {hubHits !== null && hubHits.length === 0 && !hubBusy && (
            <p className="sub">Nothing matched. Try a shorter word, or the maker&rsquo;s name.</p>
          )}

          <div className="hublist">
            {(hubHits ?? []).map((h) => (
              <div key={h.repo} className="hubitem">
                <div className="hubrow">
                  <Logo author={h.author} name={h.repo} />
                  <div className="hubtext">
                    <div className="mcard-name">{h.repo.split("/")[1] ?? h.repo}</div>
                    <div className="mcard-sub">
                      {h.author} · {compact(h.downloads)} downloads · {compact(h.likes)} likes
                      {h.license ? ` · ${h.license}` : ""}
                    </div>
                  </div>
                  <button className="ghostbtn" onClick={() => void openFiles(h.repo)}>
                    {openRepo === h.repo ? "Hide files" : "Choose file"}
                  </button>
                </div>

                {openRepo === h.repo && (
                  <div className="filelist">
                    {repoFiles === null ? (
                      <div className="sub">Reading the repository…</div>
                    ) : (
                      repoFiles.map((f) => {
                        const fFit = fitFor(f.bytes, usable);
                        const id = `${h.repo}:${f.file_name}`;
                        const fp = progress[id];
                        return (
                          <div key={f.path} className="filerow">
                            <span className="fq num">{f.quant}</span>
                            <span className="fn">{f.file_name}</span>
                            <span className="num fsz">{fmtBytes(f.bytes)}</span>
                            <span className={`pill fit-${fFit.kind}`}>{fFit.label}</span>
                            {fp ? (
                              <span className="num fsz">{Math.round(pct(fp))}%</span>
                            ) : f.split ? (
                              <span className="sub">split upload — not supported</span>
                            ) : (
                              <button
                                className="ghostbtn"
                                disabled={!!busy[id] || fFit.kind === "no"}
                                onClick={() => void downloadFile(h.repo, f)}
                              >
                                {busy[id] ?? "Download"}
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
