import { useEffect, useRef, useState } from "react";
import { Attachments } from "../components/Attachments";
import { AssistantMessage } from "../components/Message";
import { PerfLine } from "../components/Perf";
import { ModelSelectorPrompt } from "../components/ModelSelector";
import { streamChat, type ChatMessage, type StreamHandle } from "../lib/chat";
import type { Attachment, EngineStatus, Health, MachineCapability } from "../lib/ipc";
import { api, pathForFile } from "../lib/ipc";
import type { InstalledEntry } from "../lib/library";
import type { LocalModel, ModelConfiguration } from "../lib/models";
import { systemPrompt } from "../lib/prompt";
import { choose } from "../lib/router";

interface Props {
  models: LocalModel[];
  installed: InstalledEntry[];
  value: string;
  configurations: Record<string, ModelConfiguration>;
  engine: EngineStatus;
  health: Health | null;
  self: MachineCapability | null;
  onModelChange: (v: string) => void;
  onConfigurationChange: (v: string, c: ModelConfiguration) => void;
  onEngineChange: (e: EngineStatus) => void;
  onGoto: (v: "models" | "setup" | "settings") => void;
  contextSize: number;
  messages: ChatMessage[];
  onMessages: (m: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
}

export function Chat(props: Props) {
  const [prompt, setPrompt] = useState("");
  const messages = props.messages;
  const setMessages = props.onMessages;
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  // The send in progress, from the first await (files, engine start) through the
  // last token. Stop marks it stopped so no later stage starts or writes again.
  const activeRun = useRef<{ stopped: boolean; handle: StreamHandle | null } | null>(null);
  // One automatic follow-up per search, so a model that keeps asking cannot loop.
  const researched = useRef<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, status]);

  // A big model on a slow disk can take minutes; silence reads as a hang.
  useEffect(() => {
    const off = api.onEngineLoading(({ seconds, tail }) =>
      setLoadNote(`${seconds}s — ${tail.split("\n").pop()?.slice(0, 90) ?? "loading"}`),
    );
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);

  const hasModels = props.installed.length > 0;

  async function addPaths(paths: string[]) {
    const fresh = paths.filter((p) => p && !files.some((f) => f.path === p));
    if (!fresh.length) return;
    setReading(true);
    try {
      const read = await api.readFiles(fresh);
      setFiles((prev) => [...prev, ...read]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  async function pick() {
    setReading(true);
    try {
      const read = await api.pickFiles();
      setFiles((prev) => [...prev, ...read.filter((r) => !prev.some((p) => p.path === r.path))]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  /**
   * Stop works at any stage of a send, not only while tokens are arriving. It
   * cancels the stream if one is open, prevents a send that is still preparing
   * from starting its stream, and clears the waiting state at once.
   */
  function stopRun() {
    const run = activeRun.current;
    if (!run) return;
    run.stopped = true;
    run.handle?.cancel();
    activeRun.current = null;
    setStatus(null);
    setLoadNote(null);
    setStreaming(false);
    // Drop an empty reply placeholder; keep whatever text already arrived.
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      return last?.role === "assistant" && !last.content ? prev.slice(0, -1) : prev;
    });
  }

  /**
   * Sending is the only entry point, and it owns loading the model. There is
   * no Load button: the message is held, the engine is started if it is not
   * already the right one, and the turn proceeds when the model answers.
   */
  async function send(text: string) {
    const body = text.trim();
    if (!body || streaming) return;
    if (!props.health?.runtime_available) {
      setError("The AI engine is missing from this copy of Forge AI.");
      return;
    }
    if (!hasModels) {
      setError("No models are installed yet.");
      return;
    }

    const picked =
      props.value === "auto"
        ? choose(body, props.installed, props.self?.usable_model_bytes ?? 0, props.engine.model_file)
        : (() => {
            const m = props.installed.find((i) => i.file_name === props.value);
            return m ? { file_name: m.file_name, label: m.label, why: "" } : null;
          })();

    if (!picked) {
      setError("That model is no longer installed. Pick another one.");
      return;
    }

    setError(null);
    setPrompt("");
    const started = performance.now();
    const attached = files;
    const usable = attached.filter((f) => f.readable && f.text.trim());

    const next: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: body,
        files: attached.map((f) => ({ name: f.name, bytes: f.bytes, kind: f.kind, readable: f.readable })),
      },
    ];
    setMessages([...next, { role: "assistant", content: "", model: picked.label }]);
    setFiles([]);
    setStreaming(true);
    const run: { stopped: boolean; handle: StreamHandle | null } = { stopped: false, handle: null };
    activeRun.current = run;

    // Documents are folded into the message the model sees, not the one shown.
    let contextChars = 0;
    let sendContent = body;
    if (usable.length) {
      setStatus(`Reading ${usable.length} file${usable.length > 1 ? "s" : ""}…`);
      try {
        const built = await api.buildContext(
          usable.map((f) => ({ name: f.name, text: f.text })),
          body,
          Math.max(4000, Math.floor(props.contextSize * 2.6)),
        );
        if (run.stopped) return;
        contextChars = built.context.length;
        sendContent = `${built.context}\n\n${body}`;
      } catch (e) {
        if (run.stopped) return;
        setStatus(null);
        setStreaming(false);
        activeRun.current = null;
        setMessages((prev) => prev.slice(0, -1));
        setError(`Could not prepare the attached files: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    let engine = props.engine;
    const loadStarted = performance.now();
    if (!engine.running || engine.model_file !== picked.file_name) {
      setStatus(
        props.value === "auto"
          ? `Auto chose ${picked.label} — starting it…`
          : `Starting ${picked.label}…`,
      );
      try {
        engine = await api.ensureEngine(picked.file_name);
        if (run.stopped) return;
        props.onEngineChange(engine);
      } catch (e) {
        if (run.stopped) return;
        setStreaming(false);
        setStatus(null);
        setLoadNote(null);
        activeRun.current = null;
        setMessages((prev) => prev.slice(0, -1));
        setError(`${picked.label} did not start. ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const memories = await api.memoryForPrompt().catch(() => [] as string[]);
    if (run.stopped) return;
    const loadMs = engine === props.engine ? 0 : performance.now() - loadStarted;
    setStatus(null);
    setLoadNote(null);

    const outbound: ChatMessage[] = next.map((m, i) =>
      i === next.length - 1 ? { role: "user", content: sendContent } : { role: m.role, content: m.content },
    );
    let firstTokenAt = 0;

    run.handle = streamChat(
      engine.base_url,
      [{ role: "system", content: systemPrompt(memories) }, ...outbound],
      {
        onToken: (piece) => {
          if (run.stopped) return;
          if (!firstTokenAt) firstTokenAt = performance.now();
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + piece };
            }
            return copy;
          });
        },
        onDone: ({ tokens }) => {
          if (run.stopped) return;
          if (activeRun.current === run) activeRun.current = null;
          setStreaming(false);
          const ended = performance.now();
          const first = firstTokenAt || ended;
          const generateMs = ended - first;
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = {
                ...last,
                perf: {
                  total_ms: ended - started,
                  load_ms: loadMs,
                  first_token_ms: first - started,
                  generate_ms: generateMs,
                  tokens,
                  tok_s: generateMs > 0 ? (tokens / generateMs) * 1000 : 0,
                  model: picked.label,
                  machine: props.self?.name ?? "this computer",
                  where: "local",
                  context_chars: contextChars || undefined,
                },
              };
            }
            return copy;
          });
        },
        onError: (message) => {
          if (run.stopped) return;
          if (activeRun.current === run) activeRun.current = null;
          setStreaming(false);
          setError(message);
        },
      },
    );
  }

  const empty = messages.length === 0;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths = Array.from(e.dataTransfer.files).map(pathForFile).filter(Boolean);
    if (paths.length) void addPaths(paths);
    else if (e.dataTransfer.files.length) setError("Those files could not be read from the drop.");
  };

  return (
    <div
      className={`chatwrap${dragging ? " dropping" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && <div className="dropnote">Drop files to attach them</div>}
      {!empty && (
        <div className="scroll chatlog">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="who">{m.role === "user" ? "You" : (m.model ?? "Forge")}</div>
              <div className="bubble">
                {m.role === "assistant" ? (
                  m.content ? (
                    <AssistantMessage
                      content={m.content}
                      streaming={streaming && i === messages.length - 1}
                      onSend={(t) => void send(t)}
                      // Only the newest turn may run a search, and only once:
                      // reopening an old conversation must not re-run paid
                      // lookups, and a repeated query must not loop.
                      onResearch={
                        i === messages.length - 1 && props.health?.runtime_available
                          ? (t) => {
                              const key = t.slice(0, 120);
                              if (researched.current.has(key)) return;
                              researched.current.add(key);
                              void send(t);
                            }
                          : undefined
                      }
                    />
                  ) : streaming && i === messages.length - 1 ? (
                    <span className="caret-blink" />
                  ) : null
                ) : (
                  m.content
                )}
                {m.role === "user" && m.files && m.files.length > 0 && (
                  <div className="msgfiles num">
                    {m.files.map((f) => `${f.name}${f.readable ? "" : " (not read)"}`).join(" · ")}
                  </div>
                )}
              </div>
              {m.perf && <PerfLine perf={m.perf} />}
            </div>
          ))}
          {status && (
            <div className="runstats loading">
              {status}
              {loadNote ? ` · ${loadNote}` : ""}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className={empty ? "hero" : "composer-dock"}>
        <div className="hero-in">
          {empty && (
            <>
              <h1>What can I help you build?</h1>
              <p className="tagline">
                <b>Your AI.</b> Your hardware. <b>Your control.</b>
              </p>
              {status && <div className="banner">{status}</div>}
            </>
          )}

          {!props.health?.runtime_available && (
            <div className="banner warn">
              <b>The AI engine is missing from this copy of Forge AI.</b> Re-download the app;
              models cannot run without it.
            </div>
          )}
          {props.health?.runtime_available && !hasModels && (
            <div className="banner">
              No models installed yet.{" "}
              <button className="linkbtn" onClick={() => props.onGoto("models")}>
                Open the model library →
              </button>
            </div>
          )}
          {error && (
            <div className="banner err">
              <div className="errtext">{error}</div>
              <button className="ghostbtn" onClick={() => void api.openEngineLog().catch(() => undefined)}>
                Show the engine log
              </button>
            </div>
          )}

          <Attachments files={files} reading={reading} onRemove={(n) => setFiles((p) => p.filter((f) => f.name !== n))} />

          <div className="composerow">
            <button className="attachbtn" title="Attach files" onClick={() => void pick()}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M20 11.5l-7.6 7.6a4.6 4.6 0 01-6.5-6.5l8-8a3 3 0 014.3 4.3l-8 8a1.5 1.5 0 01-2.1-2.1l7.3-7.3" />
              </svg>
            </button>
            <div className="composergrow">
          <ModelSelectorPrompt
            models={props.models}
            value={props.value}
            configurations={props.configurations}
            prompt={prompt}
            usableBytes={props.self?.usable_model_bytes ?? 0}
            busy={streaming}
            onModelChange={(m) => props.onModelChange(m.value)}
            onConfigurationChange={props.onConfigurationChange}
            onPromptChange={setPrompt}
            onStop={stopRun}
            onSubmit={({ prompt: text }) => void send(text)}
          />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
