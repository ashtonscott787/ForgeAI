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

const DAY = 24 * 60 * 60 * 1000;

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
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editWhen, setEditWhen] = useState("");
  const [now, setNow] = useState(Date.now());

  const refresh = () => void api.remindersList().then(setItems).catch((e) => setError(String(e)));
  useEffect(refresh, []);
  useEffect(() => {
    const off = api.onReminderFired(() => refresh());
    // Keep "due now" and "overdue" honest while the page is open.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(tick);
      void off.then((f) => f()).catch(() => undefined);
    };
  }, []);

  /** Shows what a typed time means before it is saved. */
  const previewOf = (input: string, set: (s: string | null) => void) => {
    if (!input.trim()) return set(null);
    void api
      .parseWhen(input)
      .then((r) => set("error" in r ? r.error : `${fmt(r.at)}${r.repeat ? ` · ${REPEAT[r.repeat.kind]}` : ""}`))
      .catch(() => set(null));
  };
  useEffect(() => previewOf(when, setPreview), [when]);
  useEffect(() => previewOf(editWhen, setEditPreview), [editWhen]);
  const [editPreview, setEditPreview] = useState<string | null>(null);

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

  async function saveEdit(r: Reminder) {
    setError(null);
    try {
      const patch: Partial<Reminder> & { id: string } = { id: r.id, text: editText.trim() || r.text };
      if (editWhen.trim()) {
        const parsed = await api.parseWhen(editWhen);
        if ("error" in parsed) throw new Error(parsed.error);
        patch.at = parsed.at;
        patch.repeat = parsed.repeat;
        patch.state = "pending";
      }
      await api.reminderUpdate(patch);
      setEditing(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function act(p: Promise<unknown>) {
    setError(null);
    try {
      await p;
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pending = items.filter((r) => r.state === "pending").sort((a, b) => a.at - b.at);
  const done = items.filter((r) => r.state === "done").sort((a, b) => (b.last_fired ?? 0) - (a.last_fired ?? 0));

  return (
    <div className="scroll pane">
      <div className="pane-head">
        <div>
          <h2>Reminders</h2>
          <p className="sub">
            Reminders are kept by Forge AI itself. One that falls due while the app is closed or the
            computer is asleep arrives at the next launch, marked late. Nothing here can wake a machine that is off.
          </p>
        </div>
      </div>

      {error && <div className="banner err" role="alert">{error}</div>}

      <form
        className="remform"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void add();
        }}
      >
        <input className="inp" aria-label="What to remind you about" placeholder="What should I remind you about?" value={text} onChange={(e) => setText(e.target.value)} />
        <input
          className="inp"
          aria-label="When"
          placeholder="When: “at 7pm”, “in two hours”, “every Friday at 9am”"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!text.trim()}>Add reminder</button>
      </form>
      {preview && <p className="fhint" role="status">{preview}</p>}

      <h3 className="secthead">Upcoming · {pending.length}</h3>
      {pending.length === 0 && (
        <p className="sub">
          Nothing scheduled. Try typing <em>“call Sam”</em> with <em>“tomorrow at 9am”</em>, or <em>“water the plants”</em> with <em>“every Monday at 8am”</em>.
        </p>
      )}
      <div className="remlist">
        {pending.map((r) => {
          const due = r.at <= now;
          return (
            <div key={r.id} className={`remrow${due ? " due" : ""}`}>
              {editing === r.id ? (
                <div className="remmain">
                  <input className="inp" aria-label="Reminder text" value={editText} onChange={(e) => setEditText(e.target.value)} />
                  <input className="inp" aria-label="New time, or leave blank to keep it" placeholder="New time, or leave blank to keep it" value={editWhen} onChange={(e) => setEditWhen(e.target.value)} />
                  {editPreview && <p className="fhint">{editPreview}</p>}
                  <div className="actions">
                    <button className="primary" onClick={() => void saveEdit(r)}>Save</button>
                    <button className="ghostbtn" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="remmain">
                    <div className="remtext">{r.text}</div>
                    <div className="mcard-sub num">
                      {due ? "Due now" : fmt(r.at)}
                      {r.repeat ? ` · ${REPEAT[r.repeat.kind]}` : ""}
                    </div>
                  </div>
                  <button className="ghostbtn" onClick={() => void act(api.reminderSnooze(r.id, 10))}>Snooze 10 min</button>
                  <button className="ghostbtn" onClick={() => void act(api.reminderSnooze(r.id, 60))}>1 hour</button>
                  <button className="ghostbtn" onClick={() => void act(api.reminderUpdate({ id: r.id, at: r.at + DAY }))}>Tomorrow</button>
                  <button className="ghostbtn" onClick={() => { setEditing(r.id); setEditText(r.text); setEditWhen(""); }}>Edit</button>
                  <button className="ghostbtn" onClick={() => void act(api.reminderUpdate({ id: r.id, state: "done" }))}>Done</button>
                  <button className="ghostbtn" onClick={() => void act(api.reminderDelete(r.id))}>Delete</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {done.length > 0 && (
        <>
          <div className="secthead-row">
            <h3 className="secthead">Past · {done.length}</h3>
            <button
              className="ghostbtn"
              onClick={() => {
                if (window.confirm(`Delete all ${done.length} past reminders?`)) {
                  void act(Promise.all(done.map((r) => api.reminderDelete(r.id))));
                }
              }}
            >
              Clear past
            </button>
          </div>
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
                <button className="ghostbtn" onClick={() => void act(api.reminderUpdate({ id: r.id, state: "pending", at: Date.now() + 10 * 60_000 }))}>Reopen</button>
                <button className="ghostbtn" onClick={() => void act(api.reminderDelete(r.id))}>Delete</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
