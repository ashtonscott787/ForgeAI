import { useEffect, useState } from "react";
import type { ReminderAsk } from "../lib/blocks";
import { api } from "../lib/ipc";

/**
 * The model offers to set a reminder. The time is resolved and shown first,
 * because "every Friday" and "this Friday" are easy to mishear and a silent
 * reminder at the wrong moment is worse than none.
 */
export function ReminderAskCard({ ask }: { ask: ReminderAsk }) {
  const [when, setWhen] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [state, setState] = useState<"ask" | "set" | "no">("ask");
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .parseWhen(ask.when)
      .then((r) => {
        if ("error" in r) {
          setBad(r.error);
          return;
        }
        const repeat = r.repeat ? ` · repeats ${r.repeat.kind === "weekdays" ? "every weekday" : r.repeat.kind}` : "";
        setWhen(
          new Date(r.at).toLocaleString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "numeric",
            minute: "2-digit",
          }) + repeat,
        );
      })
      .catch((e) => setBad(e instanceof Error ? e.message : String(e)));
  }, [ask.when]);

  if (state === "set") return <div className="memask done">Reminder set.</div>;
  if (state === "no") return <div className="memask done">Not set.</div>;

  return (
    <div className="memask">
      <div className="maskhead">Set a reminder?</div>
      <div className="masktext">{ask.text}</div>
      <div className="mcard-sub num">{bad ? `Could not read "${ask.when}" as a time — ${bad}` : (when ?? "working out the time…")}</div>
      {error && <div className="banner err">{error}</div>}
      <div className="uactions">
        <button
          className="primary"
          disabled={!when}
          onClick={() => {
            void api
              .reminderCreate(ask.text, ask.when)
              .then(() => setState("set"))
              .catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
        >
          Set it
        </button>
        <button className="ghostbtn" onClick={() => setState("no")}>
          No thanks
        </button>
      </div>
    </div>
  );
}
