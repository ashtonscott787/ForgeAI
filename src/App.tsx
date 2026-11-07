import { useCallback, useEffect, useMemo, useState } from "react";
import { Chat } from "./views/Chat";
import { Models } from "./views/Models";
import { Setup } from "./views/Setup";
import { SettingsView } from "./views/SettingsView";
import {
  api,
  fmtBytes,
  inTauri,
  type Catalogue,
  type EngineStatus,
  type Health,
  type MachineCapability,
  type Settings,
} from "./lib/ipc";
import type { LocalModel, ModelConfiguration } from "./lib/models";
import "./styles.css";

type View = "chat" | "models" | "setup" | "settings";

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  context_size: 8192,
  gpu_layers: 999,
  threads: null,
  selected_model: null,
  experimental_cluster: false,
};

/** Catalogue entries become selector rows. Unmeasured speed stays unmeasured. */
function toLocalModels(cat: Catalogue | null): LocalModel[] {
  if (!cat) return [];
  return cat.models.map((e) => {
    const a = e.artifacts[0];
    return {
      value: e.id,
      name: e.name,
      family: e.family,
      mark: e.family.toLowerCase().includes("qwen")
        ? "qwen"
        : e.family.toLowerCase().includes("meta")
          ? "meta"
          : e.family.toLowerCase().includes("deepseek")
            ? "ds"
            : "generic",
      params: `${e.params_b}B`,
      iq: 0,
      tps: e.reference_tok_s,
      context: e.max_context,
      bytes: a?.bytes ?? 0,
    };
  });
}

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [health, setHealth] = useState<Health | null>(null);
  const [self, setSelf] = useState<MachineCapability | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [engine, setEngine] = useState<EngineStatus>({
    running: false,
    port: 0,
    model_file: null,
    base_url: "",
  });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [value, setValue] = useState("");
  const [configurations, setConfigurations] = useState<Record<string, ModelConfiguration>>({});

  // theme
  const applyTheme = useCallback((pref: Settings["theme"]) => {
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    document.documentElement.dataset.theme = pref === "system" ? (light ? "light" : "dark") : pref;
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [settings.theme, applyTheme]);

  // boot
  useEffect(() => {
    if (!inTauri) return;
    void (async () => {
      const [h, m, c, s, e] = await Promise.all([
        api.health().catch(() => null),
        api.detectHardware().catch(() => null),
        api.catalogue().catch(() => null),
        api.getSettings().catch(() => DEFAULT_SETTINGS),
        api.engineStatus().catch(() => null),
      ]);
      setHealth(h);
      setSelf(m);
      setCat(c);
      setSettings(s);
      if (e) setEngine(e);
      if (c?.models[0]) setValue(s.selected_model ?? c.models[0].id);
    })();
  }, []);

  const models = useMemo(() => toLocalModels(cat), [cat]);

  // Keep the chosen model persisted so a restart lands where you left off.
  useEffect(() => {
    if (!inTauri || !value || value === settings.selected_model) return;
    const next = { ...settings, selected_model: value };
    setSettings(next);
    void api.setSettings(next).catch(() => undefined);
  }, [value, settings]);

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="brand">
          <svg viewBox="0 0 24 24">
            <path d="M14 2l-2 7h6l-8 13 2-9H6z" fill="currentColor" />
          </svg>
          Forge AI
        </div>
        <div className="tb-spacer" />
        <div className="chips">
          <div className={`chip${engine.running ? " on" : ""}`}>
            <span className="dot" />
            {engine.running ? "Local · running" : "Local · idle"}
          </div>
          <div className="chip on">
            <span className="dot" />
            Private
          </div>
        </div>
      </div>

      <div className="body">
        <aside className="side">
          <button
            className="newchat"
            onClick={() => {
              setView("chat");
              window.location.reload();
            }}
          >
            New chat
          </button>
          <div className="side-bottom">
            {(
              [
                ["chat", "Chat"],
                ["models", "Models"],
                ["setup", "Hardware"],
                ["settings", "Settings"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`sitem nav${view === v ? " active" : ""}`}
                onClick={() => setView(v)}
              >
                <span>{label}</span>
              </button>
            ))}
          </div>
          {self && (
            <div className="sidefoot">
              {self.backend.toUpperCase()} · {fmtBytes(self.usable_model_bytes)} usable
            </div>
          )}
        </aside>

        <main className="main">
          {!inTauri && (
            <div className="banner warn standalone">
              Running in a browser, so the Rust core is unreachable: hardware detection, downloads
              and inference are all unavailable here. This mode exists for design work only.
            </div>
          )}

          <section className={`view${view === "chat" ? " active" : ""}`}>
            <Chat
              models={models}
              value={value}
              configurations={configurations}
              engine={engine}
              health={health}
              self={self}
              onModelChange={setValue}
              onConfigurationChange={(v, c) => setConfigurations((p) => ({ ...p, [v]: c }))}
              onGoto={setView}
            />
          </section>

          <section className={`view${view === "models" ? " active" : ""}`}>
            <Models self={self} health={health} engine={engine} onEngineChange={setEngine} />
          </section>

          <section className={`view${view === "setup" ? " active" : ""}`}>
            <Setup self={self} health={health} />
          </section>

          <section className={`view${view === "settings" ? " active" : ""}`}>
            <SettingsView settings={settings} onChange={setSettings} />
          </section>
        </main>
      </div>
    </div>
  );
}
