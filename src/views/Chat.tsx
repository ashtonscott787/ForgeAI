import { useEffect, useRef, useState } from "react";
import { Attachments } from "../components/Attachments";
import { AssistantMessage } from "../components/Message";
import { PerfLine } from "../components/Perf";
import { ModelSelectorPrompt } from "../components/ModelSelector";
import { streamChat, type BrowserActivity, type ChatMessage, type Perf, type StreamHandle } from "../lib/chat";
import { BrowserActivityCard } from "../components/BrowserActivity";
import { PROVIDER_LABEL, parseCloud, usableModels } from "../lib/cloud";
import type { Attachment, EngineStatus, Health, MachineCapability, ProviderStatus } from "../lib/ipc";
import { api, pathForFile } from "../lib/ipc";
import type { InstalledEntry } from "../lib/library";
import type { LocalModel, ModelConfiguration } from "../lib/models";
import { systemPrompt, VISION_SYSTEM } from "../lib/prompt";
import { choose } from "../lib/router";

interface Props {
  models: LocalModel[];
  installed: InstalledEntry[];
  value: string;
  configurations: Record<string, ModelConfiguration>;
  engine: EngineStatus;
  health: Health | null;
  self: MachineCapability | null;
  providers: ProviderStatus[];
  onModelChange: (v: string) => void;
  onConfigurationChange: (v: string, c: ModelConfiguration) => void;
  onEngineChange: (e: EngineStatus) => void;
  onGoto: (v: "models" | "setup" | "settings") => void;
  contextSize: number;
  /** The conversation on screen. Every request writes to the conversation it started in. */
  conversationId: string;
  /** Text and images from another view (the browser). Placed in the composer; never sent automatically. */
  handoff?: { text: string; images: string[]; browser?: BrowserActivity } | null;
  /** Show the model's working, and the finish time, under each answer. */
  showThinking?: boolean;
  onHandoffUsed?: () => void;
  messages: ChatMessage[];
  onMessagesFor: (conversationId: string, m: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
}

/** One in-flight send. Stop cancels it; nothing else can touch it. */
interface Run {
  stopped: boolean;
  stop: () => void;
}

let requestSeq = 0;
const newRequestId = () => `r${Date.now().toString(36)}${(requestSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** An image the person attached or handed over, in the attachment list. */
function imageAttachment(dataUrl: string, i: number): Attachment {
  const mime = /^data:image\/([a-z+.-]+);base64,/i.exec(dataUrl)?.[1] ?? "png";
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    name: `screenshot-${i + 1}.${mime === "jpeg" ? "jpg" : mime}`,
    path: "",
    bytes: Math.floor((b64.length * 3) / 4),
    ext: `.${mime === "jpeg" ? "jpg" : mime}`,
    kind: "image",
    pages: null,
    text: "",
    preview: b64,
    readable: true,
    note: "",
  };
}
/** The data URL a vision model is given for an attached image. */
function imageDataUrl(f: Attachment): string {
  const ext = (f.ext || ".png").replace(".", "").toLowerCase();
  const mime = ext === "jpg" ? "jpeg" : ext;
  return `data:image/${mime};base64,${f.preview}`;
}

export function Chat(props: Props) {
  const [prompt, setPrompt] = useState("");
  const messages = props.messages;
  const id = props.conversationId;
  const writeTo = (convId: string, m: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) =>
    props.onMessagesFor(convId, m);
  // Streaming and errors are tracked per conversation, so chats run independently.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const streaming = Boolean(busy[id]);
  const runs = useRef(new Map<string, Run>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const error = errors[id] ?? null;
  const setError = (msg: string | null) =>
    setErrors((p) => {
      const n = { ...p };
      if (msg) n[id] = msg;
      else delete n[id];
      return n;
    });
  const failIn = (convId: string, msg: string) => {
    setErrors((p) => ({ ...p, [convId]: msg }));
  };
  const [status, setStatus] = useState<string | null>(null);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // One automatic follow-up per search, so a model that keeps asking cannot loop.
  const researched = useRef<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  // Browser work waits here until the person actually sends, so a page they
  // looked at and then discarded never appears in the transcript.
  const pendingBrowser = useRef<BrowserActivity | null>(null);

  useEffect(() => {
    if (!props.handoff) return;
    const { text, images, browser } = props.handoff;
    setPrompt(text);
    setFiles((prev) => [...prev, ...images.map(imageAttachment)]);
    if (browser) pendingBrowser.current = browser;
    props.onHandoffUsed?.();
  }, [props.handoff]);

  /** Asks the last question again, from the point just before it was asked. */
  function regenerate() {
    if (streaming) return;
    let at = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") { at = i; break; }
    }
    if (at < 0) return;
    const asked = messages[at]!;
    void send(asked.content, messages.slice(0, at));
  }

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
   * Stop works at any stage of the send on screen. It cancels the request
   * (local stream or cloud request), stops later stages from starting, clears
   * the waiting state, and keeps any text that already arrived.
   */
  function stopRun() {
    const convId = id;
    const run = runs.current.get(convId);
    if (!run) return;
    run.stopped = true;
    runs.current.delete(convId);
    run.stop();
    setBusy((b) => ({ ...b, [convId]: false }));
    setStatus(null);
    setLoadNote(null);
    writeTo(convId, (prev) => {
      const last = prev[prev.length - 1];
      return last?.role === "assistant" && !last.content ? prev.slice(0, -1) : prev;
    });
  }

  /**
   * Sending is the only entry point. Local models load on demand; cloud models
   * are called through the provider adapter. Every write goes to `convId`.
   */
  /**
   * `base` replaces the history this turn is built on. Regenerating passes the
   * conversation as it stood before the last question, so the reply is produced
   * again from the same point rather than appended to a transcript that already
   * contains it.
   */
  async function send(text: string, base?: ChatMessage[]) {
    const convId = id;
    const body = text.trim();
    if (!body || runs.current.has(convId)) return;

    const endRun = (run: Run) => {
      if (runs.current.get(convId) === run) runs.current.delete(convId);
      setBusy((b) => ({ ...b, [convId]: false }));
    };
    const failRun = (run: Run, msg: string) => {
      endRun(run);
      setStatus(null);
      setLoadNote(null);
      writeTo(convId, (prev) => {
        const last = prev[prev.length - 1];
        return last?.role === "assistant" && !last.content ? prev.slice(0, -1) : prev;
      });
      failIn(convId, msg);
    };

    // Auto only chooses among local models. With none installed, a connected cloud model is used instead.
    let value = props.value;
    if (value === "auto" && !hasModels) {
      const firstCloud = props.models.find((m) => m.value.startsWith("cloud:"));
      if (firstCloud) value = firstCloud.value;
    }
    const cloud = parseCloud(value);
    if (!cloud) {
      if (!props.health?.runtime_available) {
        failIn(convId, "The AI engine is missing from this copy of Forge AI.");
        return;
      }
      if (!hasModels) {
        failIn(convId, "No local models are installed yet. Install one, or connect a cloud provider in Settings.");
        return;
      }
    }

    const images = files
      .filter((f) => f.kind === "image" && f.preview)
      .map((f) => imageDataUrl(f));
    if (images.length && cloud) {
      failIn(convId, "Images are only sent to local vision models for now. Remove the image, or choose a local vision model.");
      return;
    }

    let picked: { label: string; file_name?: string };
    if (cloud) {
      const s = props.providers.find((p) => p.provider === cloud.provider);
      if (!s?.verified_at) {
        failIn(convId, `${PROVIDER_LABEL[cloud.provider]} is not connected. Test the connection in Settings first.`);
        return;
      }
      if (!usableModels(s).some((m) => m.id === cloud.model)) {
        failIn(convId, "That model is no longer on this connection's list. Pick another one.");
        return;
      }
      picked = { label: cloud.model };
    } else {
      // With an image attached, Auto must pick a model that can read images.
      const visionChoice = images.length && value === "auto" ? props.installed.find((i) => i.vision) : undefined;
      const choice =
        visionChoice
          ? { file_name: visionChoice.file_name, label: visionChoice.label, why: "" }
          : value === "auto"
          ? choose(body, props.installed, props.self?.usable_model_bytes ?? 0, props.engine.model_file)

          : (() => {
              const m = props.installed.find((i) => i.file_name === value);
              return m ? { file_name: m.file_name, label: m.label, why: "" } : null;
            })();
      if (!choice) {
        failIn(convId, "That model is no longer installed. Pick another one.");
        return;
      }
      picked = { label: choice.label, file_name: choice.file_name };
      if (images.length && !props.installed.find((i) => i.file_name === choice.file_name)?.vision) {
        failIn(convId, `${choice.label} cannot read images. Install a vision model, such as SmolVLM, from the Models library, and choose it.`);
        return;
      }
    }

    setError(null);
    setErrors((p) => {
      const n = { ...p };
      delete n[convId];
      return n;
    });
    setPrompt("");
    const started = performance.now();
    const attached = files;
    const usable = attached.filter((f) => f.readable && f.text.trim());

    const run: Run = { stopped: false, stop: () => undefined };
    runs.current.set(convId, run);
    setBusy((b) => ({ ...b, [convId]: true }));

    const next: ChatMessage[] = [
      ...(base ?? messages),
      {
        role: "user",
        content: body,
        images: images.length ? images : undefined,
        files: attached.map((f) => ({ name: f.name, bytes: f.bytes, kind: f.kind, readable: f.readable })),
        browser: pendingBrowser.current ?? undefined,
      },
    ];
    pendingBrowser.current = null;
    writeTo(convId, [...next, { role: "assistant", content: "", model: picked.label }]);
    setFiles([]);

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
        failRun(run, `Could not prepare the attached files: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    const memories = await api.memoryForPrompt().catch(() => [] as string[]);
    if (run.stopped) return;
    const enabledSkills = await api.skillsForPrompt().catch(() => [] as { name: string; instructions: string }[]);
    if (run.stopped) return;
    // With an image, the short instruction is used: see VISION_SYSTEM.
    const system = images.length ? VISION_SYSTEM : systemPrompt(memories, enabledSkills);

    const outbound: ChatMessage[] = next.map((m, i) =>
      i === next.length - 1
        ? { role: "user" as const, content: sendContent, images: images.length ? images : undefined }
        : { role: m.role, content: m.content },
    );

    if (cloud) {
      // Providers reject empty turns, so earlier empty placeholders are dropped.
      const turns = outbound
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));
      const requestId = newRequestId();
      run.stop = () => {
        void api.providerCancel(requestId).catch(() => undefined);
      };
      let firstAt = 0;
      const unsubscribe = api.onProviderToken(({ requestId: rid, text }) => {
        if (rid !== requestId || run.stopped) return;
        if (!firstAt) firstAt = performance.now();
        writeTo(convId, (prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + text };
          return copy;
        });
      });
      setStatus(`Sending to ${PROVIDER_LABEL[cloud.provider]}…`);
      try {
        const streamed = await api.providerStream({
          requestId,
          provider: cloud.provider,
          model: cloud.model,
          system,
          messages: turns,
        });
        if (run.stopped) return;
        const res = { usage: streamed?.usage ?? { input: null, output: null }, tokens: streamed?.tokens ?? 0 };
        if (res.tokens === 0) {
          failRun(run, `${PROVIDER_LABEL[cloud.provider]} returned no text. Try again, or choose another model.`);
          return;
        }
        const ended = performance.now();
        const first = firstAt || ended;
        setStatus(null);
        writeTo(convId, (prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = {
              ...last,
              usage: res.usage,
              perf: {
                total_ms: ended - started,
                finished_at: Date.now(),
                load_ms: 0,
                first_token_ms: first - started,
                generate_ms: ended - first,
                tokens: res.usage.output ?? 0,
                tok_s: res.usage.output && ended > first ? (res.usage.output / (ended - first)) * 1000 : 0,
                model: picked.label,
                machine: PROVIDER_LABEL[cloud.provider] + " cloud",
                where: "cloud",
                context_chars: contextChars || undefined,
              },
            };
          }
          return copy;
        });
        endRun(run);
      } catch (e) {
        if (run.stopped) return;
        failRun(run, e instanceof Error ? e.message : String(e));
      } finally {
        void unsubscribe.then((f) => f()).catch(() => undefined);
      }
      return;
    }

    let engine = props.engine;
    const loadStarted = performance.now();
    if (!engine.running || engine.model_file !== picked.file_name) {
      setStatus(value === "auto" ? `Auto chose ${picked.label} — starting it…` : `Starting ${picked.label}…`);
      // Stop while the engine is starting must stop the start itself, not only the screen.
      run.stop = () => {
        void api.stopEngine().catch(() => undefined);
      };
      try {
        engine = await api.ensureEngine(picked.file_name!);
        if (run.stopped) return;
        props.onEngineChange(engine);
      } catch (e) {
        if (run.stopped) return;
        failRun(run, `${picked.label} did not start. ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const loadMs = engine === props.engine ? 0 : performance.now() - loadStarted;
    setStatus(null);
    setLoadNote(null);

    let firstTokenAt = 0;
    const handle: StreamHandle = streamChat(engine.base_url, [{ role: "system", content: system }, ...outbound], {
      onToken: (piece) => {
        if (run.stopped) return;
        if (!firstTokenAt) firstTokenAt = performance.now();
        writeTo(convId, (prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + piece };
          return copy;
        });
      },
      onDone: ({ tokens }) => {
        if (run.stopped) return;
        // A reply with no text is a failure the person should see, not an empty bubble.
        if (tokens === 0) {
          failRun(run, `${picked.label} returned no text. Try again, or choose another model.`);
          return;
        }
        endRun(run);
        const ended = performance.now();
        const first = firstTokenAt || ended;
        const generateMs = ended - first;
        writeTo(convId, (prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            const perf: Perf = {
              total_ms: ended - started,
              finished_at: Date.now(),
              load_ms: loadMs,
              first_token_ms: first - started,
              generate_ms: generateMs,
              tokens,
              tok_s: generateMs > 0 ? (tokens / generateMs) * 1000 : 0,
              model: picked.label,
              machine: props.self?.name ?? "this computer",
              where: "local",
              context_chars: contextChars || undefined,
            };
            copy[copy.length - 1] = { ...last, perf };
          }
          return copy;
        });
      },
      onError: (message) => {
        if (run.stopped) return;
        failRun(run, message);
      },
    });
    run.stop = () => handle.cancel();
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
                      showThinking={props.showThinking === true}
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
                {m.role === "user" && m.browser && <BrowserActivityCard activity={m.browser} />}
                {m.role === "user" && m.files && m.files.length > 0 && (
                  <div className="msgfiles num">
                    {m.files.map((f) => `${f.name}${f.readable ? "" : " (not read)"}`).join(" · ")}
                  </div>
                )}
              </div>
              {m.perf && <PerfLine perf={m.perf} />}
              {m.role === "assistant" && i === messages.length - 1 && !streaming && m.content && (
                <div className="turnacts">
                  <button type="button" className="linkbtn" onClick={regenerate}>Regenerate</button>
                </div>
              )}
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
