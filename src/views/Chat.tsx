import { useEffect, useRef, useState } from "react";
import { ModelSelectorPrompt } from "../components/ModelSelector";
import { streamChat, type ChatMessage, type StreamHandle } from "../lib/chat";
import type { EngineStatus, Health, MachineCapability } from "../lib/ipc";
import type { LocalModel, ModelConfiguration } from "../lib/models";

interface Props {
  models: LocalModel[];
  value: string;
  configurations: Record<string, ModelConfiguration>;
  engine: EngineStatus;
  health: Health | null;
  self: MachineCapability | null;
  onModelChange: (v: string) => void;
  onConfigurationChange: (v: string, c: ModelConfiguration) => void;
  onGoto: (v: "models" | "setup") => void;
}

export function Chat(props: Props) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const ready = props.engine.running && props.engine.base_url !== "";

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    if (!ready) {
      setError("No model is loaded yet. Open Models, install one, then load it.");
      return;
    }
    setError(null);
    setStats(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setPrompt("");
    setStreaming(true);

    handleRef.current = streamChat(props.engine.base_url, next, {
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
          setStats(`${tokens} tokens · ${(tokens / seconds).toFixed(1)} tok/s measured`);
        }
      },
      onError: (message) => {
        setStreaming(false);
        setError(message);
      },
    });
  };

  const empty = messages.length === 0;

  return (
    <>
      {!empty && (
        <div className="scroll chatlog">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="who">{m.role === "user" ? "You" : "Forge"}</div>
              <div className="bubble">
                {m.content || (streaming && i === messages.length - 1 ? <span className="caret-blink" /> : null)}
              </div>
            </div>
          ))}
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
            </>
          )}

          {!props.health?.runtime_available && (
            <div className="banner warn">
              <b>No inference runtime in this build.</b> This installation shipped without
              llama.cpp, so models cannot run. Installers from the release workflow include it.
            </div>
          )}
          {props.health?.runtime_available && !ready && (
            <div className="banner">
              No model loaded.{" "}
              <button className="linkbtn" onClick={() => props.onGoto("models")}>
                Install and load one →
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
            onSubmit={({ prompt: text }) => send(text)}
          />
        </div>
      </div>
    </>
  );
}
