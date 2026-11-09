import { useEffect, useState } from "react";
import { api, type Settings, type UpdateInfo } from "../lib/ipc";

export function SettingsView({
  settings,
  onChange,
  version,
  update,
  checking,
  onCheck,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  version: string;
  update: UpdateInfo | null;
  checking: boolean;
  onCheck: () => void;
}) {
  const [saved, setSaved] = useState(false);

  const save = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    onChange(next);
    try {
      await api.setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch {
      /* the UI already reflects it; a failed write is reported on next load */
    }
  };

  return (
    <>
      <div className="phead">
        <h2>Settings</h2>
        <p>Applied the next time a model is loaded. {saved && <span className="savedtag">Saved</span>}</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          <div className="panel">
            <div className="panel-h"><span className="t">Updates</span></div>
            <div className="panel-b">
              <Field label="Automatically check for updates" hint="Looks at the GitHub releases page on launch and every few hours.">
                <Toggle on={settings.update_check !== false} onChange={(v) => save({ update_check: v })} />
              </Field>
              <Field label="Automatically download updates" hint="Fetches the update in the background once one is found.">
                <Toggle on={settings.update_download === true} onChange={(v) => save({ update_download: v })} />
              </Field>
              <Field label="Install when safe" hint="Applies a downloaded update once nothing is generating or downloading. Forge AI restarts itself.">
                <Toggle on={settings.update_install === true} onChange={(v) => save({ update_install: v })} />
              </Field>
              <Field label="Channel" hint="Beta also offers pre-releases.">
                <select
                  value={settings.update_channel ?? "stable"}
                  onChange={(e) => save({ update_channel: e.target.value as "stable" | "beta", skipped_version: null })}
                >
                  <option value="stable">Stable</option>
                  <option value="beta">Beta</option>
                </select>
              </Field>
              <Field
                label="This version"
                hint={`Forge AI ${version}${settings.last_update_check ? ` · last checked ${new Date(settings.last_update_check).toLocaleString()}` : " · not checked yet"}`}
              >
                <div className="rowbtns">
                  <button className="ghostbtn" disabled={checking} onClick={onCheck}>
                    {checking ? "Checking…" : "Check for updates"}
                  </button>
                  {update?.html_url && (
                    <button className="ghostbtn" onClick={() => void api.openExternal(update.html_url!)}>
                      Release notes
                    </button>
                  )}
                </div>
              </Field>
              {update && !update.available && (
                <p className="fhint">Forge AI {version} is the newest release.</p>
              )}
              {settings.skipped_version && (
                <p className="fhint">
                  Skipping {settings.skipped_version}.{" "}
                  <button className="linkbtn" onClick={() => save({ skipped_version: null })}>
                    Stop skipping
                  </button>
                </p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><span className="t">Inference</span></div>
            <div className="panel-b">
              <Field
                label="Context size"
                hint="Tokens the model can see at once. Larger uses more memory."
              >
                <select
                  value={settings.context_size}
                  onChange={(e) => save({ context_size: Number(e.target.value) })}
                >
                  {[2048, 4096, 8192, 16384, 32768].map((n) => (
                    <option key={n} value={n}>{n.toLocaleString()}</option>
                  ))}
                </select>
              </Field>

              <Field
                label="Where the model runs"
                hint="Graphics card is fastest where there is one. Processor only avoids the GPU entirely — slower, but it works when video memory is short. Split puts some layers on each."
              >
                <select
                  value={settings.run_mode ?? "gpu"}
                  onChange={(e) => save({ run_mode: e.target.value as "gpu" | "cpu" | "split" })}
                >
                  <option value="gpu">Graphics card</option>
                  <option value="cpu">Processor only</option>
                  <option value="split">Split between both</option>
                </select>
              </Field>

              {(settings.run_mode ?? "gpu") === "split" && (
                <Field label="Layers on the graphics card" hint="The rest stay on the processor.">
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={settings.split_layers ?? 20}
                    onChange={(e) => save({ split_layers: Number(e.target.value) })}
                  />
                </Field>
              )}

              <Field
                label="Hold the model in memory"
                hint="On, the whole model is read into RAM before answering: faster, but it must fit. Off, it stays on disk and is paged in as needed."
              >
                <Toggle
                  on={settings.load_into_memory === true}
                  onChange={(v) => save({ load_into_memory: v })}
                />
              </Field>

              <Field
                label="Memory Forge AI may use"
                hint="A ceiling on what models may take. Lower it to keep room for other apps; it cannot exceed what this computer has."
              >
                <MemoryBudget settings={settings} save={save} />
              </Field>

              <Field label="CPU threads" hint="Leave empty to let the runtime decide.">
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={settings.threads ?? ""}
                  placeholder="auto"
                  onChange={(e) =>
                    save({ threads: e.target.value === "" ? null : Number(e.target.value) })
                  }
                />
              </Field>
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><span className="t">Appearance</span></div>
            <div className="panel-b">
              <Field label="Theme" hint="Follows your operating system by default.">
                <div className="seg wide">
                  {(["light", "system", "dark"] as const).map((t) => (
                    <button
                      key={t}
                      className={settings.theme === t ? "on" : ""}
                      onClick={() => save({ theme: t })}
                    >
                      {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <div className="fieldtext">
        <div className="flabel">{label}</div>
        <div className="fhint">{hint}</div>
      </div>
      <div className="fctl">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle${on ? " on" : ""}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

/** The ceiling is expressed against the machine's real memory, read live. */
function MemoryBudget({
  settings,
  save,
}: {
  settings: Settings;
  save: (p: Partial<Settings>) => void;
}) {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    void api
      .environment()
      .then((e) => setTotal(e.total_memory_bytes))
      .catch(() => undefined);
  }, []);
  const GiB = 1024 ** 3;
  const max = Math.max(2, Math.floor((total || 8 * GiB) / GiB));
  const current = settings.memory_budget_bytes ? Math.round(settings.memory_budget_bytes / GiB) : max;
  return (
    <div className="budget">
      <input
        type="range"
        min={1}
        max={max}
        step={1}
        value={Math.min(current, max)}
        onChange={(e) => {
          const gib = Number(e.target.value);
          save({ memory_budget_bytes: gib >= max ? null : gib * GiB });
        }}
      />
      <span className="num">
        {Math.min(current, max)} GB{current >= max ? " · no limit" : ""} of {max} GB
      </span>
    </div>
  );
}
