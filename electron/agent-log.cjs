/**
 * A record of what agents actually did.
 *
 * The run log in the Agents page vanished when the page closed, so there was
 * no way to see what an agent had been doing — only what it was doing right
 * now. This keeps a bounded history on disk so the activity map has something
 * real to draw.
 *
 * What it is not: agents do not talk to each other, and nothing here pretends
 * they do. What can honestly be drawn is which agents touched the same tool or
 * the same knowledge pack, which is a shared resource rather than a
 * conversation, and `links()` says so by calling it that.
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX_EVENTS = 2000;
const MAX_INPUT = 300;

let file = "";
let events = [];

function load(dir) {
  file = path.join(dir, "agent-activity.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    events = Array.isArray(raw) ? raw.slice(-MAX_EVENTS) : [];
  } catch {
    events = [];
  }
  return events.length;
}

const persist = () => {
  if (!file) return;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(events), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // A history that cannot be written is not worth failing a run over.
  }
};

/**
 * Records one thing that happened. `kind` is started, tool, approval, finished
 * or failed — the states a person would ask about.
 */
function record(entry) {
  const e = {
    at: Date.now(),
    agent_id: String(entry.agent_id || ""),
    agent_name: String(entry.agent_name || "").slice(0, 80),
    kind: String(entry.kind || "tool"),
    tool: entry.tool ? String(entry.tool).slice(0, 40) : null,
    // Truncated: a log is for seeing what happened, not for keeping a copy of
    // every document an agent read.
    input: entry.input ? String(entry.input).slice(0, MAX_INPUT) : "",
    ok: entry.ok === undefined ? null : Boolean(entry.ok),
    detail: entry.detail ? String(entry.detail).slice(0, 300) : "",
  };
  events.push(e);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  persist();
  return e;
}

const recent = (n = 200) => events.slice(-Math.max(1, Math.min(n, MAX_EVENTS)));

function clear() {
  events = [];
  persist();
}

/**
 * What each agent has been doing, and what any two of them have in common.
 *
 * The links are shared tools and shared knowledge packs — not messages. Agents
 * run one at a time and never contact each other, so drawing an arrow between
 * them would be an invention.
 */
function summary(agents = []) {
  const byAgent = new Map();
  for (const a of agents) {
    byAgent.set(a.id, {
      id: a.id,
      name: a.name,
      icon: a.icon || "",
      tools: a.tools || [],
      packs: a.packs || [],
      runs: 0,
      calls: 0,
      failures: 0,
      waiting: 0,
      last_at: null,
      last_kind: null,
      used: {},
    });
  }
  for (const e of events) {
    const row = byAgent.get(e.agent_id);
    if (!row) continue;
    if (e.kind === "started") row.runs++;
    if (e.kind === "tool") {
      row.calls++;
      if (e.tool) row.used[e.tool] = (row.used[e.tool] || 0) + 1;
      if (e.ok === false) row.failures++;
    }
    if (e.kind === "approval") row.waiting++;
    if (e.kind === "failed") row.failures++;
    row.last_at = e.at;
    row.last_kind = e.kind;
  }

  const rows = [...byAgent.values()];
  const links = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const tools = a.tools.filter((t) => b.tools.includes(t));
      const packs = (a.packs || []).filter((p) => (b.packs || []).includes(p));
      if (tools.length || packs.length) {
        links.push({
          a: a.id, b: b.id, tools, packs,
          // Named for what it is, so nobody reads it as the agents talking.
          why: "shared permissions",
        });
      }
    }
  }
  return { agents: rows, links, events: events.length };
}

module.exports = { load, record, recent, clear, summary, MAX_EVENTS };
