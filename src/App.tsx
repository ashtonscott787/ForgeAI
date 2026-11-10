import { Browser } from "./views/Browser";
import type { BrowserActivity } from "./lib/chat";
import { cloudRows } from "./lib/cloud";
import { publisherFor } from "./lib/publisher";
import { loadConversations, newConversation, saveConversations, titleFrom, type Conversation } from "./lib/history";
import type { ChatMessage } from "./lib/chat";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Chat } from "./views/Chat";
import { Integrations } from "./views/Integrations";
import { MemoryView } from "./views/MemoryView";
import { Models } from "./views/Models";
import { Reminders } from "./views/Reminders";
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
  type UpdateInfo,
  type UpdateProgress,
  type MachineCapability,
  type Settings,
  type ProviderStatus,
} from "./lib/ipc";
import type { LocalModel, ModelConfiguration } from "./lib/models";
import { describeInstalled, type InstalledEntry } from "./lib/library";
import { Orb } from "./components/Orb";
import { UpdateCard } from "./components/UpdateCard";
import { markFor } from "./components/Marks";
import "./styles.css";

type View = "chat" | "browser" | "models" | "reminders" | "memory" | "integrations" | "setup" | "settings";

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
    author: publisherFor(m.record?.developer),
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
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  // Text and images handed over from the browser. The chat puts them in the composer; the person sends them.
  const [handoff, setHandoff] = useState<{ text: string; images: string[]; browser?: BrowserActivity } | null>(null);
  // The browser pane belongs to a conversation, so switching chats keeps each one's pane as it was.
  const [panes, setPanes] = useState<Record<string, boolean>>({});
  const [convQuery, setConvQuery] = useState("");
  useEffect(() => {
    if (!inTauri) return;
    void api.providerStatus().then(setProviders).catch(() => undefined);
  }, []);

  // updates
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [uPhase, setUPhase] = useState<"idle" | "downloading" | "verifying" | "ready" | "installing">("idle");
  const [uProgress, setUProgress] = useState<UpdateProgress | null>(null);
  const [uFile, setUFile] = useState<string | null>(null);
  const [uError, setUError] = useState<string | null>(null);
  const [uDismissed, setUDismissed] = useState(false);

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
  // Writes name their conversation, so a reply that finishes after a switch lands where it started.
  const setMessagesFor = useCallback(
    (convId: string, m: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) =>
      setConvos((list) =>
        list.map((c) => {
          if (c.id !== convId) return c;
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
  // One selector: installed local models first, then verified cloud models.
  const models = useMemo(() => [...selectorRows(installed), ...cloudRows(providers)], [installed, providers]);

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (!inTauri) return;
      setChecking(true);
      setUError(null);
      try {
        const info = await api.checkUpdate(settings.update_channel ?? "stable");
        setUpdate(info);
        if (manual) setUDismissed(false);
        const next = { ...settings, last_update_check: Date.now() };
        setSettings(next);
        void api.setSettings(next).catch(() => undefined);
      } catch (e) {
        setUError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
      }
    },
    [settings],
  );

  const downloadUpdate = useCallback(async () => {
    if (!update?.installable) return;
    setUPhase("downloading");
    setUError(null);
    try {
      const r = await api.downloadUpdate(update);
      setUPhase("verifying");
      setUFile(r.file);
      setUPhase("ready");
      return r.file;
    } catch (e) {
      setUPhase("idle");
      setUError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [update]);

  const installUpdate = useCallback(
    async (file: string) => {
      setUPhase("installing");
      try {
        await api.applyUpdate(file);
      } catch (e) {
        setUPhase("ready");
        setUError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  // Check on launch and every six hours, unless the user turned it off.
  useEffect(() => {
    if (!inTauri || settings.update_check === false) return;
    const t = setTimeout(() => void runCheck(false), 4000);
    const i = setInterval(() => void runCheck(false), 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
    // Re-running on every settings change would re-check constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.update_check, settings.update_channel]);

  // Fetch in the background when asked to.
  useEffect(() => {
    if (!update?.available || !update.installable) return;
    if (settings.update_download !== true || uPhase !== "idle" || uFile) return;
    void downloadUpdate();
  }, [update, settings.update_download, uPhase, uFile, downloadUpdate]);

  useEffect(() => {
    const off = api.onUpdateProgress(setUProgress);
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);

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
          <Orb size={20} spin={engine.running} />
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
          {convos.filter((c) => c.messages.length > 0).length > 3 && (
            <input
              className="convsearch"
              type="search"
              aria-label="Search chats"
              placeholder="Search chats"
              value={convQuery}
              onChange={(e) => setConvQuery(e.target.value)}
            />
          )}
          <div className="convlist">
            {convos
              .filter((c) => c.messages.length > 0)
              .filter((c) => {
                // Titles alone miss the chat you remember by something said in it.
                const q = convQuery.trim().toLowerCase();
                if (!q) return true;
                return (
                  c.title.toLowerCase().includes(q) ||
                  c.messages.some((m) => m.content.toLowerCase().includes(q))
                );
              })
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
                ["browser", "Browser"],
                ["models", "Models"],
                ["reminders", "Reminders"],
                ["memory", "Memory"],
                ["integrations", "Integrations"],
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

          {update?.available && !uDismissed && settings.skipped_version !== update.version && (
            <div className="updateslot">
              <UpdateCard
                info={update}
                progress={uProgress}
                phase={uPhase}
                error={uError}
                onUpdate={() => {
                  void (async () => {
                    const file = uFile ?? (await downloadUpdate());
                    if (file) await installUpdate(file);
                  })();
                }}
                onReveal={uFile ? () => void api.revealUpdate(uFile).catch(() => undefined) : undefined}
                onLater={() => setUDismissed(true)}
                onSkip={() => {
                  const next = { ...settings, skipped_version: update.version ?? null };
                  setSettings(next);
                  void api.setSettings(next).catch(() => undefined);
                }}
              />
            </div>
          )}

          <div className="views">
          <section className={`view${view === "chat" ? " active" : ""}`}>
            <div className={`chat-split${panes[activeId] ? " withpane" : ""}`}>
            <button
              type="button"
              className={`browser-toggle${panes[activeId] ? " on" : ""}`}
              aria-pressed={Boolean(panes[activeId])}
              title={panes[activeId] ? "Hide the browser" : "Open the browser"}
              aria-label={panes[activeId] ? "Hide the browser" : "Open the browser"}
              onClick={() => setPanes((p) => ({ ...p, [activeId]: !p[activeId] }))}
            >
              🌐
            </button>
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
              contextSize={settings.context_size}
              messages={active.messages}
              conversationId={activeId}
              handoff={handoff}
              onHandoffUsed={() => setHandoff(null)}
              providers={providers}
              onMessagesFor={setMessagesFor}
            />
            {panes[activeId] && (
              <aside className="chat-pane" aria-label="Browser">
                <Browser
                  compact
                  onClose={() => setPanes((p) => ({ ...p, [activeId]: false }))}
                  onSendToChat={(text, images = [], browser) => setHandoff({ text, images, browser })}
                />
              </aside>
            )}
            </div>
          </section>

          <section className={`view${view === "browser" ? " active" : ""}`}>
            <Browser
              onSendToChat={(text, images = [], browser) => {
                setHandoff({ text, images, browser });
                setView("chat");
              }}
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

          <section className={`view${view === "reminders" ? " active" : ""}`}>
            <Reminders />
          </section>

          <section className={`view${view === "memory" ? " active" : ""}`}>
            <MemoryView />
          </section>

          <section className={`view${view === "integrations" ? " active" : ""}`}>
            <Integrations />
          </section>

          <section className={`view${view === "setup" ? " active" : ""}`}>
            <Setup self={self} health={health} />
          </section>

          <section className={`view${view === "settings" ? " active" : ""}`}>
            <SettingsView
              settings={settings}
              onChange={setSettings}
              version={health?.app_version ?? "—"}
              update={update}
              checking={checking}
              onCheck={() => void runCheck(true)}
              providers={providers}
              onProviders={setProviders}
              models={models}
              onUseModel={setValue}
            />
          </section>
          </div>
        </main>
      </div>
    </div>
  );
}
