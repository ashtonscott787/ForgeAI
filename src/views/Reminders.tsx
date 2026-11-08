import { useEffect, useState } from "react";
import { api, type Reminder } from "../lib/ipc";

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const REPEAT: Record<string, string> = {
  daily: "every day",
  weekly: "every week",
  weekdays: "every weekday",
  monthly: "every month",
};

/**
 * Reminders live in the application, so this page says plainly what happens
 * when the computer is asleep rather than implying a reminder can wake it.
 */
export function Reminders() {
  const [items, setItems] = useState<Reminder[]>([]);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void api.remindersList().then(setItems).catch(() => undefined);
  useEffect(refresh, []);
  useEffect(() => {
    const off = api.onReminderFired(() => refresh());
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!when.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    void api
      .parseWhen(when)
      .then((r) => {
        if (!live) return;
        setPreview("error" in r ? r.error : `${fmt(r.at)}${r.repeat ? ` · ${REPEAT[r.repeat.kind]}` : ""}`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [when]);

  async function add() {
    setError(null);
    try {
      await api.reminderCreate(text.trim(), when.trim() || text.trim());
      setText("");
      setWhen("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pending = items.filter((r) => r.state === "pending");
  const done = items.filter((r) => r.state === "done").sort((a, b) => (b.last_fired ?? 0) - (a.last_fired ?? 0));

  return (
    <div className="scroll pane">
      <div className="pane-head">
        <div>
          <h2>Reminders</h2>
          <p className="sub">
            Reminders are kept by Forge AI itself. One that falls due while the app is closed or the
            computer is asleep arrives at the next launch, marked late — nothing here can wake a
            machine that is off.
          </p>
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}

      <div className="remform">
        <input className="inp" placeholder="What should I remind you about?" value={text} onChange={(e) => setText(e.target.value)} />
        <input
          className="inp"
          placeholder="When — “at 7pm”, “in two hours”, “every Friday at 9am”"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) void add();
          }}
        />
        <button className="primary" disabled={!text.trim() || !when.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      {preview && <p className="fhint">{preview}</p>}

      <h3 className="secthead">Upcoming · {pending.length}</h3>
      {pending.length === 0 && <p className="sub">Nothing scheduled.</p>}
      <div className="remlist">
        {pending.map((r) => (
          <div key={r.id} className="remrow">
            <div className="remmain">
              <div className="remtext">{r.text}</div>
              <div className="mcard-sub num">
                {fmt(r.at)}
                {r.repeat ? ` · ${REPEAT[r.repeat.kind]}` : ""}
              </div>
            </div>
            <button className="ghostbtn" onClick={() => void api.reminderSnooze(r.id, 10).then(refresh)}>
              +10 min
            </button>
            <button className="ghostbtn" onClick={() => void api.reminderDelete(r.id).then(refresh)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {done.length > 0 && (
        <>
          <h3 className="secthead">Past · {done.length}</h3>
          <div className="remlist">
            {done.slice(0, 40).map((r) => (
              <div key={r.id} className="remrow past">
                <div className="remmain">
                  <div className="remtext">{r.text}</div>
                  <div className="mcard-sub num">
                    {r.last_fired ? fmt(r.last_fired) : fmt(r.at)}
                    {r.late ? " · arrived late" : ""}
                  </div>
                </div>
                <button className="ghostbtn" onClick={() => void api.reminderDelete(r.id).then(refresh)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
