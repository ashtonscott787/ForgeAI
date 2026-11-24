import { useEffect, useState } from "react";
import { api, type InstalledModel, type WorkshopStatus } from "../lib/ipc";

/**
 * Making your own model from one you already have.
 *
 * Two jobs, both producing a real file that then appears in the model list
 * like any other. Shrinking stores the weights at lower precision: smaller,
 * faster, a little less accurate. Combining bakes an adapter — somebody
 * else's fine-tune, as a small .gguf — permanently into a base model.
 *
 * The panel opens by saying what this is not. "Build your own model" sounds
 * like training one, and training is not what happens here; somebody who
 * reads that sentence first will not waste an evening looking for the button.
 */
const since = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function WorkshopPanel({ installed }: { installed: InstalledModel[] }) {
  const [s, setS] = useState<WorkshopStatus | null>(null);
  const [source, setSource] = useState("");
  const [format, setFormat] = useState("Q4_K_M");
  const [name, setName] = useState("");
  const [adapter, setAdapter] = useState("");
  const [said, setSaid] = useState("");
  const [tab, setTab] = useState<"shrink" | "combine">("shrink");
  const [touched, setTouched] = useState(false);

  const look = () => void api.workshopStatus().then(setS).catch(() => setS(null));
  useEffect(look, []);

  // A job runs for minutes, so while one is going the panel keeps looking.
  useEffect(() => {
    if (!s?.job) return;
    const t = window.setInterval(look, 1500);
    return () => window.clearInterval(t);
  }, [s?.job]);

  const models = installed.filter((m) => !m.file_name.startsWith("mmproj-"));
  useEffect(() => {
    if (!source && models.length) setSource(models[0]!.file_name);
  }, [models.length]);

  // The name follows the choices until it is typed in, and then it is left alone.
  useEffect(() => {
    if (touched || !source) return;
    void api.workshopSuggest(source, format).then(setName).catch(() => undefined);
  }, [source, format, touched]);

  if (!s) return null;
  const job = s.job;

  return (
    <div className="panel">
      <div className="panel-h"><span className="t">Make your own model</span></div>
      <div className="panel-b">
        <p className="hint">
          From a model you already have: a smaller copy of it, or one with somebody's adapter baked
          in. The result is a real file that appears in your model list.
        </p>
        <p className="sheet-warn">
          This does not train a model, and it cannot teach one to write like you from your own
          documents. Training needs a different kind of tool and a great deal more hardware. What is
          here reshapes a model that already exists.
        </p>

        <div className="seg wide" role="tablist">
          <button role="tab" aria-selected={tab === "shrink"} className={tab === "shrink" ? "on" : ""} onClick={() => setTab("shrink")}>
            Make it smaller
          </button>
          <button role="tab" aria-selected={tab === "combine"} className={tab === "combine" ? "on" : ""} onClick={() => setTab("combine")}>
            Bake in an adapter
          </button>
        </div>

        {models.length === 0 ? (
          <p className="hint">No models installed yet, so there is nothing to work from.</p>
        ) : (
          <>
            <label className="row">
              <span>Start from</span>
              <select value={source} disabled={Boolean(job)} onChange={(e) => setSource(e.target.value)}>
                {models.map((m) => (
                  <option key={m.file_name} value={m.file_name}>{m.file_name}</option>
                ))}
              </select>
            </label>

            {tab === "shrink" ? (
              <>
                <label className="row">
                  <span>Store it as</span>
                  <select value={format} disabled={Boolean(job)} onChange={(e) => setFormat(e.target.value)}>
                    {s.formats.map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                </label>
                <p className="hint">{s.formats.find((f) => f.id === format)?.note}</p>
              </>
            ) : !s.can_combine ? (
              <p className="sheet-bad">{s.why_no_combine ?? "Combining is not available in this build."}</p>
            ) : (
              <label className="row">
                <span>Adapter file</span>
                <input
                  value={adapter}
                  disabled={Boolean(job)}
                  placeholder="/path/to/adapter.gguf"
                  aria-label="Path to the adapter file"
                  onChange={(e) => setAdapter(e.target.value)}
                />
              </label>
            )}

            <label className="row">
              <span>Call it</span>
              <input
                value={name}
                disabled={Boolean(job)}
                aria-label="Name for the new model"
                onChange={(e) => { setTouched(true); setName(e.target.value); }}
              />
            </label>

            <div className="sheet-acts left">
              {job ? (
                <>
                  <button className="ghostbtn" onClick={() => void api.workshopStop().then(look)}>Stop</button>
                  <span className="hint">
                    Making {job.out} — {since(job.started)} so far. It can take several minutes and the
                    rest of the app keeps working.
                  </span>
                </>
              ) : (
                <button
                  className="btn primary"
                  disabled={tab === "shrink" ? !s.can_shrink || !source : !s.can_combine || !source || !adapter.trim()}
                  onClick={() => {
                    setSaid("");
                    const run =
                      tab === "shrink"
                        ? api.workshopShrink({ source, format, name })
                        : api.workshopCombine({ source, adapter: adapter.trim(), name });
                    void run.then((r) => {
                      if (!r.ok) setSaid(r.why ?? "That did not work.");
                      look();
                    });
                  }}
                >
                  {tab === "shrink" ? "Make it" : "Combine them"}
                </button>
              )}
            </div>

            {said && <p className="sheet-bad" role="status">{said}</p>}
            {job && job.log.length > 0 && <pre className="worker-log">{job.log.join("\n")}</pre>}
          </>
        )}
      </div>
    </div>
  );
}
