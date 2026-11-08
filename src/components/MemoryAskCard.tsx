import { useState } from "react";
import { api } from "../lib/ipc";
import type { MemoryAsk } from "../lib/blocks";

/** The model suggests remembering something. Nothing is stored until you say so. */
export function MemoryAskCard({ ask }: { ask: MemoryAsk }) {
  const [state, setState] = useState<"ask" | "saved" | "no" | "error">("ask");
  const [error, setError] = useState("");

  if (state === "saved") return <div className="memask done">Saved to memory.</div>;
  if (state === "no") return <div className="memask done">Not saved.</div>;

  return (
    <div className="memask">
      <div className="maskhead">Remember this?</div>
      <div className="masktext">{ask.text}</div>
      {state === "error" && <div className="banner err">{error}</div>}
      <div className="uactions">
        <button
          className="primary"
          onClick={() => {
            void api
              .memoryAdd({ text: ask.text, scope: ask.scope, project: ask.project, source: "suggested in chat" })
              .then(() => setState("saved"))
              .catch((e) => {
                setError(e instanceof Error ? e.message : String(e));
                setState("error");
              });
          }}
        >
          Remember
        </button>
        <button className="ghostbtn" onClick={() => setState("no")}>
          No thanks
        </button>
      </div>
    </div>
  );
}
