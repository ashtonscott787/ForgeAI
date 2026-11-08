/**
 * Reminders that survive a restart.
 *
 * Honest about its limits: this is a timer inside the application. If Forge AI
 * is closed or the computer is asleep when a reminder is due, it fires at the
 * next launch and is marked late rather than pretending it arrived on time.
 * Nothing here can wake a machine that is off.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Notification } = require("electron");
const { advance } = require("./when.cjs");

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout silently misfires beyond this

let file = "";
let items = [];
let timer = null;
let notify = null;

const save = () => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, file);
};

const id = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function load(dir, onFire) {
  file = path.join(dir, "reminders.json");
  notify = onFire;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    items = Array.isArray(raw) ? raw : [];
  } catch {
    items = [];
  }
  return items;
}

function fire(r, late) {
  r.last_fired = Date.now();
  r.late = Boolean(late);
  if (r.repeat) {
    const next = advance(r.at, r.repeat);
    if (next) {
      r.history = [...(r.history ?? []), { fired: Date.now(), late: Boolean(late) }].slice(-20);
      r.at = next;
      r.state = "pending";
    } else {
      r.state = "done";
    }
  } else {
    r.state = "done";
  }
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: late ? "Forge AI · missed reminder" : "Forge AI",
        body: late ? `${r.text} (was due ${new Date(r.last_fired).toLocaleString()})` : r.text,
        silent: false,
      });
      n.show();
    }
  } catch {
    /* a failed notification must not stop the schedule */
  }
  notify?.(r, late);
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  const pending = items.filter((r) => r.state === "pending");

  // Anything already due fires immediately, flagged as late.
  const overdue = pending.filter((r) => r.at <= now);
  if (overdue.length) {
    for (const r of overdue) fire(r, now - r.at > 60_000);
    save();
    return schedule();
  }

  const next = pending.sort((a, b) => a.at - b.at)[0];
  if (!next) return;
  timer = setTimeout(() => {
    const due = items.filter((r) => r.state === "pending" && r.at <= Date.now() + 500);
    for (const r of due) fire(r, false);
    save();
    schedule();
  }, Math.min(next.at - now, MAX_TIMEOUT));
}

const list = () => items.slice().sort((a, b) => a.at - b.at);

function create({ text, at, repeat }) {
  if (!String(text || "").trim()) throw new Error("a reminder needs something to say");
  if (!Number.isFinite(at)) throw new Error("a reminder needs a time");
  const r = {
    id: id(),
    text: String(text).trim(),
    at,
    repeat: repeat ?? null,
    state: "pending",
    created: Date.now(),
    history: [],
  };
  items.push(r);
  save();
  schedule();
  return r;
}

function update(patch) {
  const r = items.find((x) => x.id === patch.id);
  if (!r) throw new Error("that reminder no longer exists");
  Object.assign(r, {
    text: patch.text ?? r.text,
    at: Number.isFinite(patch.at) ? patch.at : r.at,
    repeat: patch.repeat === undefined ? r.repeat : patch.repeat,
    state: patch.state ?? r.state,
  });
  save();
  schedule();
  return r;
}

function remove(rid) {
  items = items.filter((x) => x.id !== rid);
  save();
  schedule();
}

function snooze(rid, minutes) {
  const r = items.find((x) => x.id === rid);
  if (!r) throw new Error("that reminder no longer exists");
  r.at = Date.now() + Math.max(1, Number(minutes) || 10) * 60_000;
  r.state = "pending";
  r.late = false;
  save();
  schedule();
  return r;
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { load, list, create, update, remove, snooze, schedule, stop };
