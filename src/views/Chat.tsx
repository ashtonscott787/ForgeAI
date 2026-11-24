import { useEffect, useMemo, useRef, useState } from "react";
import { castOf, hostOf, withoutHandle } from "../lib/assistants";
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
import { SYSTEM_PROMPT, relevantMemories, systemPrompt, VISION_SYSTEM } from "../lib/prompt";
import { ContextMeter } from "../components/ContextMeter";
import { Terminal } from "../components/Terminal";
import { COMPACT_INSTRUCTION, applyCompaction, canCompact, splitFor, transcriptOf } from "../lib/compact";
import type { Piece } from "../lib/context";
import { choose } from "../lib/router";

interface Props {
  /** The date, this machine and the weather, for the system prompt. */
  environment?: string;
  /** Called when a reply finishes, so a chat nobody was watching can be marked. */
  onReplyFinished?: (conversationId: string) => void;
  /** Tokens this reply used, for the running total of what was not spent. */
  onUsage?: (prompt: number, completion: number) => void;
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
  /** Opens a page in the browser pane beside this conversation. */
  onOpenPane?: (url: string) => void;
  onHandoffUsed?: () => void;
  messages: ChatMessage[];
  /** True while the last compaction of this chat can still be put back. */
  canUndoCompact?: boolean;
  onUndoCompact?: () => void;
  /** Keeps the messages as they were, so compacting can be undone. */
  onBeforeCompact?: (messages: ChatMessage[]) => void;
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
  /** Compacting: see compactNow below. */
  const [compacting, setCompacting] = useState(false);
  /**
   * The rail down the right: what is in the context window, and the shell.
   * Both belong beside the conversation rather than above the composer,
   * where the meter was pushing the thing you are writing down the screen.
   */
  const [rail, setRail] = useState<"context" | "shell" | null>(null);
  /** A command the assistant suggested, on its way to the shell's box. */
  const [toShell, setToShell] = useState<string | null>(null);
  const [extras, setExtras] = useState<{ memories: string[]; skills: { name: string; instructions: string }[] }>({
    memories: [],
    skills: [],
  });
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

  // What the meter shows. Memory and skills are fetched for display the same
  // way the send path fetches them, so the figure is of what would actually
  // be sent rather than of the messages alone.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.memoryForPrompt().catch(() => [] as string[]),
      api.skillsForPrompt().catch(() => [] as { name: string; instructions: string }[]),
    ]).then(([memories, skills]) => {
      if (alive) setExtras({ memories, skills });
    });
    return () => { alive = false; };
  }, [messages.length]);

  const pieces: Piece[] = useMemo(() => {
    const env = props.environment ?? "";
    return [
      { id: "messages", label: "Messages", text: messages.map((m) => m.content).join("\n") },
      { id: "system", label: "House rules", text: SYSTEM_PROMPT + (env ? `\n\n${env}` : "") },
      { id: "memory", label: "Memory", text: extras.memories.join("\n") },
      { id: "skills", label: "Skills", text: extras.skills.map((s) => `${s.name}\n${s.instructions}`).join("\n") },
      { id: "attachments", label: "Attachments", text: files.map((f) => f.text || "").join("\n") },
    ];
  }, [messages, extras, files, props.environment]);

  /**
   * Replaces the older half of the conversation with a summary of it.
   *
   * Only ever on request, and the original is handed up first so Undo can put
   * it back. The summary is written by the model that is loaded, which is the
   * point: it is reading the same words it will later be given.
   */
  async function compactNow() {
    if (compacting || streaming) return;
    if (!props.engine.running) {
      setError("Compacting asks the model to write the summary, so the engine has to be running. Send a message first, or start a model.");
      return;
    }
    const { older } = splitFor(messages);
    if (!canCompact(messages)) return;
    setCompacting(true);
    setError(null);
    try {
      const summary = await once(
        [
          { role: "system", content: COMPACT_INSTRUCTION },
          { role: "user", content: transcriptOf(older) },
        ],
        900,
      );
      if (!summary) {
        setError("The model returned an empty summary, so the conversation was left exactly as it was.");
        return;
      }
      props.onBeforeCompact?.(messages);
      writeTo(id, applyCompaction(messages, summary));
    } catch (e) {
      setError(`The summary could not be written: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`);
    } finally {
      setCompacting(false);
    }
  }

  /**
   * One completion, not streamed. Used by compaction and by reading a long
   * document in parts — both are internal passes whose output is not the
   * answer, so there is nothing to stream to anybody.
   */
  async function once(messages: { role: "system" | "user"; content: string }[], maxTokens = 900): Promise<string> {
    const res = await fetch(`${props.engine.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(props.engine.api_key ? { Authorization: `Bearer ${props.engine.api_key}` } : {}),
      },
      body: JSON.stringify({ messages, temperature: 0.2, max_tokens: maxTokens, stream: false }),
    });
    if (!res.ok) throw new Error(`the engine answered ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content?.trim() ?? "";
  }

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

  /**
   * Puts the last question back in the composer to be changed and asked again.
   *
   * Stopping a reply usually means the question was wrong, not that the answer
   * was unwanted, so the question comes back rather than being left on screen
   * above a half-finished answer nobody will read.
   */
  function editLastQuestion() {
    if (streaming) return;
    let at = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") { at = i; break; }
    }
    if (at < 0) return;
    setPrompt(messages[at]!.content);
    props.onMessagesFor(props.conversationId, messages.slice(0, at));
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
      // However it ended, the chat now holds something that was not there
      // when it was last looked at.
      props.onReplyFinished?.(convId);
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
      const whole = usable.map((f) => f.text).join("\n\n");
      // The plan comes from the main process, which is also what the MCP
      // server uses. One implementation of the splitting, not two.
      const plan = !cloud && props.engine.running
        ? await api.chunkPlan(whole, body, props.contextSize).catch(() => null)
        : null;
      if (plan && plan.needed && plan.count > 1) {
        try {
          const notes: string[] = [];
          for (let i = 0; i < plan.prompts.length; i++) {
            if (run.stopped) return;
            setStatus(`Reading part ${i + 1} of ${plan.count}…`);
            notes.push(await once([{ role: "user", content: plan.prompts[i]! }]));
          }
          if (run.stopped) return;
          contextChars = whole.length;
          sendContent = await api.chunkReduce(body, notes);
          setStatus(plan.describe);
        } catch (e) {
          if (run.stopped) return;
          failRun(run, `That document could not be read in parts: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
            } else {
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
          // Extracts were taken rather than the whole file. Saying so is the
          // difference between an answer from part of a document and an
          // answer that appears to be from all of it.
          const cut = (built.report ?? []).filter((r) => r.trimmed).map((r) => r.name);
          if (cut.length) {
            setStatus(`${cut.join(", ")} ${cut.length === 1 ? "was" : "were"} too long to send whole — the most relevant extracts were used.`);
          }
        } catch (e) {
          if (run.stopped) return;
          failRun(run, `Could not prepare the attached files: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
    }

    // Material from switched-on knowledge packs, found by this question. It goes
    // to the model, never into the shown message, and is labelled as the person's
    // own material so the model does not present it as something it already knew.
    try {
      const found = await api.knowledgeContext(body);
      if (run.stopped) return;
      if (found?.text) {
        contextChars += found.text.length;
        sendContent = `From your own notes (${(found.packs ?? []).join(", ")}). Use this where it answers the question, and say when it does not:\n\n${found.text}\n\n${sendContent}`;
      }
    } catch {
      // A pack that will not read must not stop the answer; the chat goes on without it.
    }

    const saved = await api.memoryForPrompt().catch(() => [] as string[]);
    // Only the notes that bear on this question. Everything saved used to go
    // into every prompt, and a small model asked about one subject with an
    // unrelated fact in front of it answers about the fact.
    const memories = relevantMemories(
      saved,
      body,
      (base ?? messages).slice(-4).map((m) => m.content),
    );
    if (run.stopped) return;
    const enabledSkills = await api.skillsForPrompt().catch(() => [] as { name: string; instructions: string }[]);
    if (run.stopped) return;
    // With an image, the short instruction is used: see VISION_SYSTEM.
    // Whoever was addressed most recently answers: naming somebody new
    // mid-conversation hands it to them, which is what writing their name is
    // for. More than one assistant can be in a chat; the others are listed so
    // the one answering knows who else is here.
    const everyone = [...(base ?? messages), { role: "user" as const, content: body }];
    const host = hostOf(everyone);
    const others = castOf(everyone).filter((x) => x.id !== host?.id);
    let system = images.length ? VISION_SYSTEM : systemPrompt(memories, enabledSkills, props.environment ?? "");
    if (host) {
      system += `\n\nYou are ${host.name} (${host.handle}), ${host.role.toLowerCase()}. ${host.instructions}`
        + ` How you talk: ${host.manner}`
        + ` Answer as ${host.name}. The person writing to you is not ${host.name} — ${host.handle} is how they`
        + " address you, so never greet them by your own name.";
      if (others.length) {
        system += ` Also in this conversation: ${others.map((o) => `${o.name} (${o.handle}, ${o.role.toLowerCase()})`).join("; ")}.`
          + " Answer only as yourself. If something belongs to one of them, say so and leave it to them.";
      }
    }

    const outbound: ChatMessage[] = next.map((m, i) =>
      i === next.length - 1
        // The handle is routing, not words. Left in, the model read "@nora"
        // as the subject and greeted the person by its own name.
        ? { role: "user" as const, content: withoutHandle(sendContent), images: images.length ? images : undefined }
        : { role: m.role, content: withoutHandle(m.content) },
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
      onDone: ({ tokens, answered, finish }) => {
        if (run.stopped) return;
        // "length" means the engine stopped at the token limit rather than
        // because the model had finished. Without that fact, a reply cut off
        // before it began reads as a model that said nothing.
        const hitLimit = finish === "length";
        // A reply with no text is a failure the person should see, not an
        // empty bubble — but there are two different failures here and they
        // need different advice.
        if (tokens === 0) {
          failRun(run,
            hitLimit
              ? `${picked.label} reached its token limit before writing anything. Raise the reply length in Settings.`
              : `${picked.label} returned no text at all. The engine log below shows what it did. `
                + "Try again, or choose another model.");
          return;
        }
        if (answered === 0) {
          // It generated, but every token was working rather than answer.
          // This is what a reasoning model does when it runs out of room
          // mid-thought; saying "returned no text" of it was simply wrong.
          failRun(run,
            hitLimit
              ? `${picked.label} used its whole token limit thinking and never began the answer — all ${tokens} tokens `
                + "were its working. It is a reasoning model, so it needs more room: raise the reply length, "
                + "or choose a model that answers directly."
              : `${picked.label} thought it through but never reached an answer — all ${tokens} tokens were `
                + "its working. That usually means the context is too small for it to finish. "
                + "Try a shorter question, a larger context size, or another model.");
          return;
        }
        endRun(run);
        // An answer that ran out of room is marked, so the reply that stops
        // mid-sentence says why rather than looking finished.
        if (hitLimit) {
          writeTo(convId, (prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, truncated: true };
            return copy;
          });
        }
        // The prompt is not counted by the stream, so it is estimated from
        // its length — roughly four characters a token for English. It is an
        // estimate and the figure it feeds says so.
        props.onUsage?.(Math.round(sendContent.length / 4), tokens);
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
        // Into the engine's own log as well, so the two accounts of the same
        // moment can be copied together.
        void api.noteFailure(`chat failed: ${message}`).catch(() => undefined);
        failRun(run, message);
      },
    }, engine.api_key);
    run.stop = () => handle.cancel();
  }

  // Who this conversation belongs to, if it was addressed to somebody.
  const withAssistant = hostOf(messages);
  const cast = castOf(messages);
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

      {/* The rail down the right. Closed it is two buttons; open it is one
          panel. It sits beside the conversation rather than above the
          composer, where the context meter used to push the box you are
          writing in further down the screen every time it grew. */}
      <div className={`rail${rail ? " open" : ""}`}>
        <div className="rail-tabs">
          <button
            className={`rail-tab${rail === "context" ? " on" : ""}`}
            aria-pressed={rail === "context"}
            title="What is in the context window"
            onClick={() => setRail((r) => (r === "context" ? null : "context"))}
          >
            Context
          </button>
          <button
            className={`rail-tab${rail === "shell" ? " on" : ""}`}
            aria-pressed={rail === "shell"}
            title="A shell on this computer"
            onClick={() => setRail((r) => (r === "shell" ? null : "shell"))}
          >
            Shell
          </button>
        </div>

        {rail === "context" && (
          <div className="rail-body">
            {messages.length === 0 ? (
              <p className="hint">Nothing has been said yet, so the window is empty.</p>
            ) : (
              <>
                <ContextMeter
                  pieces={pieces}
                  limit={props.contextSize}
                  baseUrl={props.engine.running ? props.engine.base_url : null}
                  apiKey={props.engine.api_key}
                  canCompact={canCompact(messages)}
                  compacting={compacting}
                  onCompact={() => void compactNow()}
                />
                {props.canUndoCompact && (
                  <p className="hint ctx-undo">
                    Earlier messages were replaced by a summary.{" "}
                    <button className="linkbtn" onClick={() => props.onUndoCompact?.()}>Undo that</button>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {rail === "shell" && (
          <div className="rail-body">
            <Terminal
              proposed={toShell}
              onUsedProposal={() => setToShell(null)}
              onClose={() => setRail(null)}
            />
          </div>
        )}
      </div>

      {!empty && (
        <div className="scroll chatlog">
          {cast.length > 0 && (
            <div className="withwho">
              <span className="withwho-faces">
                {cast.map((w) => (
                  w.portrait
                    ? <img key={w.id} className="face sm" src={w.portrait} alt="" width={28} height={28} title={w.name} />
                    : <span key={w.id} className="face sm initials" style={{ background: w.accent }} title={w.name} aria-hidden="true">{w.initials}</span>
                ))}
              </span>
              <span>
                {cast.length === 1
                  ? <>This conversation is with <b>{cast[0]!.name}</b> — {cast[0]!.role.toLowerCase()}.</>
                  : <>In this conversation: {cast.map((w, i) => (
                      <span key={w.id}><b>{w.name}</b>{i < cast.length - 1 ? ", " : ". "}</span>
                    ))}
                    {withAssistant && <>Last addressed: <b>{withAssistant.name}</b>.</>}</>}
              </span>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="who">{m.role === "user" ? "You" : (m.model ?? "Forge")}</div>
              <div className="bubble">
                {m.role === "assistant" ? (
                  m.content ? (
                    <AssistantMessage
                      content={m.content}
                      showThinking={props.showThinking === true}
                      onOpenPane={props.onOpenPane}
                      onShell={(c) => { setRail("shell"); setToShell(c); }}
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
              {m.truncated && (
                <p className="cutoff">
                  This answer was cut off at the reply limit.{" "}
                  <button
                    className="linkbtn"
                    disabled={streaming}
                    onClick={() => void send("Carry on from exactly where you stopped. Do not repeat anything you have already written.")}
                  >
                    Continue
                  </button>
                </p>
              )}
              {m.perf && <PerfLine perf={m.perf} />}
              {m.role === "assistant" && i === messages.length - 1 && !streaming && m.content && (
                <div className="turnacts">
                  <button type="button" className="linkbtn" onClick={regenerate}>Ask again</button>
                  <button type="button" className="linkbtn" onClick={editLastQuestion}>Edit question</button>
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
            leading={
              <button className="attachbtn" title="Attach files" onClick={() => void pick()}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M20 11.5l-7.6 7.6a4.6 4.6 0 01-6.5-6.5l8-8a3 3 0 014.3 4.3l-8 8a1.5 1.5 0 01-2.1-2.1l7.3-7.3" />
                </svg>
              </button>
            }
          />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
