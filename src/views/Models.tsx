import { useEffect, useState } from "react";
import {
  api,
  fileNameFor,
  fmtBytes,
  type Artifact,
  type CatalogueEntry,
  type Catalogue,
  type DownloadProgress,
  type EngineStatus,
  type Health,
  type InstalledModel,
  type MachineCapability,
} from "../lib/ipc";

interface Props {
  self: MachineCapability | null;
  health: Health | null;
  engine: EngineStatus;
  onEngineChange: (s: EngineStatus) => void;
}

export function Models(props: Props) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.installedModels().then(setInstalled).catch(() => undefined);

  useEffect(() => {
    api.catalogue().then(setCat).catch((e) => setError(String(e)));
    refresh();
    const un = api.onDownloadProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.model_id]: p }));
      if (p.done) refresh();
    });
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const download = async (entry: CatalogueEntry, a: Artifact) => {
    setError(null);
    setBusy(entry.id);
    try {
      await api.downloadModel(entry.id, a.url, fileNameFor(entry, a), a.sha256);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const load = async (fileName: string) => {
    setError(null);
    setBusy(fileName);
    try {
      props.onEngineChange(await api.startEngine(fileName));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const unload = async () => {
    await api.stopEngine();
    props.onEngineChange(await api.engineStatus());
  };

  const remove = async (fileName: string) => {
    if (props.engine.model_file === fileName) await unload();
    try {
      await api.deleteModel(fileName);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const usable = props.self?.usable_model_bytes ?? 0;

  return (
    <>
      <div className="phead">
        <h2>Models</h2>
        <p>
          Downloaded to your machine and verified against the catalogue checksum before use.
          Speeds shown after a run are measured, not estimated.
        </p>
      </div>
      <div className="scroll">
        <div className="pbody">
          {error && <div className="banner err">{error}</div>}

          <div className="panel">
            <div className="panel-h">
              <span className="t">Installed</span>
              <span className="badge">
                {installed.length} · {fmtBytes(installed.reduce((a, m) => a + m.bytes, 0))}
              </span>
            </div>
            <div className="panel-b" style={{ padding: 0 }}>
              {installed.length === 0 && (
                <div className="emptyrow">Nothing installed yet. Pick one from the catalogue below.</div>
              )}
              {installed.map((m) => {
                const active = props.engine.model_file === m.file_name;
                return (
                  <div className="link" key={m.file_name}>
                    <span className="pair">
                      {m.file_name}
                      {active && <em> · loaded</em>}
                    </span>
                    <span className="bw">{fmtBytes(m.bytes)}</span>
                    {active ? (
                      <button className="btn ghost small" onClick={unload}>
                        Unload
                      </button>
                    ) : (
                      <button
                        className="btn primary small"
                        disabled={busy !== null || !props.health?.runtime_available}
                        onClick={() => load(m.file_name)}
                      >
                        {busy === m.file_name ? "Loading…" : "Load"}
                      </button>
                    )}
                    <button className="btn ghost small" onClick={() => remove(m.file_name)}>
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel-h">
              <span className="t">Catalogue</span>
            </div>
            <div className="panel-b" style={{ padding: 0 }}>
              {cat?.models.map((entry) => {
                const a = entry.artifacts[0];
                if (!a) return null;
                const file = fileNameFor(entry, a);
                const have = installed.some((m) => m.file_name === file);
                const p = progress[entry.id];
                const fits = usable === 0 || a.bytes < usable;
                return (
                  <div className="catrow" key={entry.id}>
                    <div className="catmain">
                      <div className="mname">
                        {entry.name}
                        {!fits && <span className="tag">Too large for this machine</span>}
                        {!a.sha256 && <span className="tag soon">Unverified digest</span>}
                      </div>
                      <div className="mmeta">
                        {entry.params_b}B<i />
                        {fmtBytes(a.bytes)}<i />
                        {entry.license}<i />
                        {entry.reference_tok_s > 0 ? `~${entry.reference_tok_s} tok/s ref` : "speed unmeasured"}
                      </div>
                      {p && !p.done && (
                        <div className="dlbar">
                          <div className="bar">
                            <i style={{ width: `${p.total ? (p.received / p.total) * 100 : 0}%` }} />
                          </div>
                          <div className="barlbl">
                            <span>
                              {fmtBytes(p.received)} of {fmtBytes(p.total)}
                            </span>
                            <span className="num">{fmtBytes(p.bytes_per_sec)}/s</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="catact">
                      {have ? (
                        <span className="fit local">
                          <span className="d" />
                          Installed
                        </span>
                      ) : (
                        <button
                          className="btn primary small"
                          disabled={busy !== null}
                          onClick={() => download(entry, a)}
                        >
                          {busy === entry.id ? "Downloading…" : "Download"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
