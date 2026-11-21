// What agents did. The temptation here is to draw arrows between agents as if
// they were talking, so the tests check that the links are labelled as shared
// permissions and nothing more.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../electron/agent-log.cjs");

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-alog-")); L.load(dir); });
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const AGENTS = [
  { id: "a1", name: "Bea", icon: "📧", tools: ["web_search", "read_email", "draft_email"], packs: ["p1"] },
  { id: "a2", name: "Finn", icon: "📊", tools: ["web_search", "read_files"], packs: ["p1", "p2"] },
  { id: "a3", name: "Solo", icon: "🤖", tools: ["create_reminder"], packs: [] },
];

test("an event is recorded with what happened and when", () => {
  const e = L.record({ agent_id: "a1", agent_name: "Bea", kind: "tool", tool: "web_search", input: "steel prices", ok: true });
  assert.equal(e.tool, "web_search");
  assert.equal(e.ok, true);
  assert.ok(e.at > 0);
  assert.equal(L.recent().length, 1);
});

test("a long input is cut, because a log is not a copy of every document read", () => {
  const e = L.record({ agent_id: "a1", kind: "tool", tool: "read_files", input: "x".repeat(5000) });
  assert.ok(e.input.length <= 300, `kept ${e.input.length} characters`);
});

test("history survives being reloaded", () => {
  L.record({ agent_id: "a1", agent_name: "Bea", kind: "started" });
  L.record({ agent_id: "a1", agent_name: "Bea", kind: "tool", tool: "web_search", ok: true });
  const reloaded = L.load(dir);
  assert.equal(reloaded, 2, "both events came back");
  assert.equal(L.recent()[1].tool, "web_search");
});

test("the history is bounded, keeping the newest", () => {
  for (let i = 0; i < L.MAX_EVENTS + 50; i++) L.record({ agent_id: "a1", kind: "tool", tool: `t${i}` });
  const all = L.recent(L.MAX_EVENTS);
  assert.equal(all.length, L.MAX_EVENTS);
  assert.equal(all[all.length - 1].tool, `t${L.MAX_EVENTS + 49}`, "the newest is kept");
});

test("each agent's work is counted separately", () => {
  L.record({ agent_id: "a1", kind: "started" });
  L.record({ agent_id: "a1", kind: "tool", tool: "web_search", ok: true });
  L.record({ agent_id: "a1", kind: "tool", tool: "web_search", ok: false });
  L.record({ agent_id: "a2", kind: "tool", tool: "read_files", ok: true });

  const s = L.summary(AGENTS);
  const bea = s.agents.find((a) => a.id === "a1");
  assert.equal(bea.runs, 1);
  assert.equal(bea.calls, 2);
  assert.equal(bea.failures, 1, "a failed call is counted as one");
  assert.equal(bea.used.web_search, 2);
  assert.equal(s.agents.find((a) => a.id === "a2").calls, 1);
  assert.equal(s.agents.find((a) => a.id === "a3").calls, 0, "an agent that did nothing still appears");
});

test("waiting for approval is counted as its own thing", () => {
  L.record({ agent_id: "a1", kind: "approval", tool: "draft_email" });
  const bea = L.summary(AGENTS).agents.find((a) => a.id === "a1");
  assert.equal(bea.waiting, 1);
  assert.equal(bea.failures, 0, "waiting is not failing");
});

test("links are shared permissions, and are labelled as such", () => {
  const s = L.summary(AGENTS);
  const link = s.links.find((l) => l.a === "a1" && l.b === "a2");
  assert.ok(link, "two agents sharing a tool are linked");
  assert.deepEqual(link.tools, ["web_search"]);
  assert.deepEqual(link.packs, ["p1"]);
  assert.equal(link.why, "shared permissions", "never described as the agents talking");
});

test("an agent sharing nothing is linked to nobody", () => {
  const s = L.summary(AGENTS);
  assert.equal(s.links.filter((l) => l.a === "a3" || l.b === "a3").length, 0);
});

test("a link carries no sender, no recipient and no message", () => {
  // The honest limit: agents run one at a time and never contact each other.
  // Scanning the source for words was the wrong check — it flagged a comment
  // that exists to deny exactly this. The data shape is what matters.
  const s = L.summary(AGENTS);
  assert.ok(s.links.length > 0, "there is a link to inspect");
  for (const l of s.links) {
    assert.equal(l.why, "shared permissions");
    assert.deepEqual(Object.keys(l).sort(), ["a", "b", "packs", "tools", "why"]);
    for (const field of ["from", "to", "message", "direction", "sent", "received"]) {
      assert.equal(field in l, false, `a link must not carry ${field}`);
    }
  }
});

test("no recorded event describes one agent reaching another", () => {
  L.record({ agent_id: "a1", kind: "started" });
  L.record({ agent_id: "a1", kind: "tool", tool: "web_search", ok: true });
  L.record({ agent_id: "a2", kind: "failed", detail: "the model stopped" });
  for (const e of L.recent()) {
    assert.ok(["started", "tool", "approval", "finished", "failed"].includes(e.kind), `${e.kind} is one of the states a person asks about`);
    assert.equal("target_agent" in e, false, "an event belongs to one agent only");
  }
});

test("events from a deleted agent are ignored rather than shown as a ghost", () => {
  L.record({ agent_id: "gone", agent_name: "Deleted", kind: "tool", tool: "web_search" });
  const s = L.summary(AGENTS);
  assert.equal(s.agents.length, 3, "only agents that still exist are listed");
  assert.equal(s.events, 1, "though the event is still counted in the total");
});

test("clearing removes the history from disk too", () => {
  L.record({ agent_id: "a1", kind: "started" });
  L.clear();
  assert.equal(L.recent().length, 0);
  assert.equal(L.load(dir), 0, "and it stays cleared after a reload");
});
