import { useState } from "react";
import { api, type Settings } from "../lib/ipc";

export function SettingsView({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [saved, setSaved] = useState(false);

  const update = async (patch: Partial<Settings>) => {
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
            <div className="panel-h"><span className="t">Inference</span></div>
            <div className="panel-b">
              <Field
                label="Context size"
                hint="Tokens the model can see at once. Larger uses more memory."
              >
                <select
                  value={settings.context_size}
                  onChange={(e) => update({ context_size: Number(e.target.value) })}
                >
                  {[2048, 4096, 8192, 16384, 32768].map((n) => (
                    <option key={n} value={n}>{n.toLocaleString()}</option>
                  ))}
                </select>
              </Field>

              <Field
                label="GPU layers"
                hint="How many layers to offload to the GPU. 999 means all of them; 0 is CPU only."
              >
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={settings.gpu_layers}
                  onChange={(e) => update({ gpu_layers: Number(e.target.value) })}
                />
              </Field>

              <Field label="CPU threads" hint="Leave empty to let the runtime decide.">
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={settings.threads ?? ""}
                  placeholder="auto"
                  onChange={(e) =>
                    update({ threads: e.target.value === "" ? null : Number(e.target.value) })
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
                      onClick={() => update({ theme: t })}
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
