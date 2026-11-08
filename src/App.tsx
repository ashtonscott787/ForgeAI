import { loadConversations, newConversation, saveConversations, titleFrom, type Conversation } from "./lib/history";
import type { ChatMessage } from "./lib/chat";
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
  type InstalledModel,
  type MachineCapability,
  type Settings,
} from "./lib/ipc";
import type { LocalModel, ModelConfiguration } from "./lib/models";
import { describeInstalled, type InstalledEntry } from "./lib/library";
import { Globe } from "./components/Globe";
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

/** The chat selector lists what is installed, with Auto at the top. */
function selectorRows(installed: InstalledEntry[]): LocalModel[] {
  const auto: LocalModel = {
    value: "auto",
    name: "Auto",
    family: "Best model for this request",
    mark: "generic",
    params: "—",
    iq: 0,
    tps: 0,
    context: 0,
    bytes: 0,
  };
  const rows = installed.map((m) => ({
    value: m.file_name,
    name: m.label,
    family: m.record?.developer ?? "Installed file",
    mark: markFor(m.record?.family ?? m.label),
    params: m.record ? `${m.record.params_b}B` : "GGUF",
    iq: 0,
    tps: 0,
    context: m.record?.max_context ?? 0,
    bytes: m.bytes,
  }));
  return installed.length ? [auto, ...rows] : rows;
}

function markFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("qwen")) return "qwen";
  if (n.includes("llama") || n.includes("meta")) return "meta";
  if (n.includes("deepseek")) return "ds";
  return "generic";
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
  const [value, setValue] = useState("auto");
  const [installedFiles, setInstalledFiles] = useState<InstalledModel[]>([]);
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

  // conversations
  const [convos, setConvos] = useState<Conversation[]>(() => {
    const l = loadConversations();
    return l.length ? l : [newConversation()];
  });
  const [activeId, setActiveId] = useState<string>(() => convos[0]?.id ?? "");
  const active: Conversation = convos.find((c) => c.id === activeId) ?? convos[0] ?? newConversation();
  useEffect(() => saveConversations(convos), [convos]);
  const setActiveMessages = useCallback(
    (m: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) =>
      setConvos((list) =>
        list.map((c) => {
          if (c.id !== activeId) return c;
          const messages = typeof m === "function" ? m(c.messages) : m;
          const firstUser = messages.find((x) => x.role === "user");
          return {
            ...c,
            messages,
            updated: Date.now(),
            title: c.title === "New chat" && firstUser ? titleFrom(firstUser.content) : c.title,
          };
        }),
      ),
    [activeId],
  );
  const startNewChat = () => {
    setView("chat");
    if (active.messages.length === 0) return;
    const c = newConversation();
    setConvos((l) => [c, ...l]);
    setActiveId(c.id);
  };
  const deleteChat = (id: string) => {
    setConvos((l) => {
      const rest = l.filter((c) => c.id !== id);
      const next = rest.length ? rest : [newConversation()];
      if (id === activeId && next[0]) setActiveId(next[0].id);
      return next;
    });
  };

  // boot
  useEffect(() => {
    if (!inTauri) return;
    void (async () => {
      const [h, m, c, s, e, inst] = await Promise.all([
        api.health().catch(() => null),
        api.detectHardware().catch(() => null),
        api.catalogue().catch(() => null),
        api.getSettings().catch(() => DEFAULT_SETTINGS),
        api.engineStatus().catch(() => null),
        api.installedModels().catch(() => []),
      ]);
      setHealth(h);
      setSelf(m);
      setCat(c);
      setSettings(s);
      if (e) setEngine(e);
      setInstalledFiles(inst);
      if (s.selected_model) setValue(s.selected_model);
    })();
  }, []);

  const refreshInstalled = useCallback(() => {
    void api
      .installedModels()
      .then(setInstalledFiles)
      .catch(() => undefined);
  }, []);
  const installed = useMemo(() => describeInstalled(installedFiles), [installedFiles]);
  const models = useMemo(() => selectorRows(installed), [installed]);

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
          <Globe size={20} spin={engine.running} />
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
          <button className="newchat" onClick={startNewChat}>
            New chat
          </button>
          <div className="convlist">
            {convos
              .filter((c) => c.messages.length > 0)
              .sort((a, b) => b.updated - a.updated)
              .map((c) => (
                <div
                  key={c.id}
                  className={`conv${c.id === activeId && view === "chat" ? " active" : ""}`}
                  onClick={() => {
                    setActiveId(c.id);
                    setView("chat");
                  }}
                >
                  <span className="conv-t">{c.title}</span>
                  <button
                    className="conv-x"
                    title="Delete conversation"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteChat(c.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
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
              Preview mode: hardware detection, downloads and inference only work in the desktop app.
            </div>
          )}

          <section className={`view${view === "chat" ? " active" : ""}`}>
            <Chat
              models={models}
              installed={installed}
              onEngineChange={setEngine}
              value={value}
              configurations={configurations}
              engine={engine}
              health={health}
              self={self}
              onModelChange={setValue}
              onConfigurationChange={(v, c) => setConfigurations((p) => ({ ...p, [v]: c }))}
              onGoto={setView}
              messages={active.messages}
              onMessages={setActiveMessages}
            />
          </section>

          <section className={`view${view === "models" ? " active" : ""}`}>
            <Models
              self={self}
              health={health}
              engine={engine}
              catalogue={cat}
              installed={installedFiles}
              onInstalledChange={refreshInstalled}
              onEngineChange={setEngine}
              onUse={(f) => {
                setValue(f);
                setView("chat");
              }}
            />
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
