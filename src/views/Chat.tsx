import { useEffect, useRef, useState } from "react";
import { AssistantMessage } from "../components/Message";
import { ModelSelectorPrompt } from "../components/ModelSelector";
import { streamChat, type ChatMessage, type StreamHandle } from "../lib/chat";
import type { EngineStatus, Health, MachineCapability } from "../lib/ipc";
import { api } from "../lib/ipc";
import type { InstalledEntry } from "../lib/library";
import type { LocalModel, ModelConfiguration } from "../lib/models";
import { SYSTEM_PROMPT } from "../lib/prompt";
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
  onGoto: (v: "models" | "setup") => void;
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
  const [stats, setStats] = useState<string | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, status]);

  const hasModels = props.installed.length > 0;

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
    setStats(null);
    setPrompt("");
    const next: ChatMessage[] = [...messages, { role: "user", content: body }];
    setMessages([...next, { role: "assistant", content: "", model: picked.label }]);
    setStreaming(true);

    let engine = props.engine;
    if (!engine.running || engine.model_file !== picked.file_name) {
      setStatus(
        props.value === "auto"
          ? `Auto chose ${picked.label} — starting it…`
          : `Starting ${picked.label}…`,
      );
      try {
        engine = await api.ensureEngine(picked.file_name);
        props.onEngineChange(engine);
      } catch (e) {
        setStreaming(false);
        setStatus(null);
        setMessages((prev) => prev.slice(0, -1));
        setError(
          `${picked.label} did not start. ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
    }
    setStatus(null);

    handleRef.current = streamChat(
      engine.base_url,
      [{ role: "system", content: SYSTEM_PROMPT }, ...next],
      {
        onToken: (piece) =>
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + piece };
            }
            return copy;
          }),
        onDone: ({ tokens, seconds }) => {
          setStreaming(false);
          if (tokens > 0 && seconds > 0) {
            setStats(`${picked.label} · ${tokens} tokens · ${(tokens / seconds).toFixed(1)} tok/s`);
          }
        },
        onError: (message) => {
          setStreaming(false);
          setError(message);
        },
      },
    );
  }

  const empty = messages.length === 0;

  return (
    <>
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
                    />
                  ) : streaming && i === messages.length - 1 ? (
                    <span className="caret-blink" />
                  ) : null
                ) : (
                  m.content
                )}
              </div>
            </div>
          ))}
          {status && <div className="runstats loading">{status}</div>}
          {stats && <div className="runstats num">{stats}</div>}
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
          {error && <div className="banner err">{error}</div>}

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
            onStop={() => handleRef.current?.cancel()}
            onSubmit={({ prompt: text }) => void send(text)}
          />
        </div>
      </div>
    </>
  );
}
