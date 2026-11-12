// Agents. The permission checks matter most: a model can be talked into asking
// for anything, so the refusals are tested as if the model were hostile.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../electron/agents.cjs");

const bea = (over = {}) => A.validateAgent({
  name: "Bea", role: "handles supplier email",
  instructions: "Be brief. Never promise a delivery date.",
  tools: ["web_search", "create_reminder"], preapproved: [], ...over,
});

test("an agent needs a name", () => {
  assert.throws(() => A.validateAgent({ name: "   " }), /needs a name/);
  assert.throws(() => A.validateAgent(null), /not an agent/);
  assert.throws(() => A.validateAgent([]), /not an agent/);
});

test("a tool that does not exist cannot be granted", () => {
  const a = A.validateAgent({ name: "X", tools: ["web_search", "launch_missiles", 7, null] });
  assert.deepEqual(a.tools, ["web_search"], "only real tools survive");
  assert.equal(A.can(a, "launch_missiles"), false);
});

test("a tool the agent does not have is refused, and says how to grant it", () => {
  const d = A.decide(bea(), "write_file");
  assert.equal(d.allow, false);
  assert.match(d.reason, /not allowed/);
  assert.match(d.reason, /permissions/);
});

test("an invented tool name is refused by name", () => {
  const d = A.decide(bea(), "send_money");
  assert.equal(d.allow, false);
  assert.match(d.reason, /no tool called "send_money"/);
});

test("reading runs freely; changing the world stops for a person", () => {
  const a = bea();
  assert.deepEqual(A.decide(a, "web_search"), { allow: true, approval: false, reason: "" });
  const change = A.decide(a, "create_reminder");
  assert.equal(change.allow, true);
  assert.equal(change.approval, true, "a reminder changes something, so it waits");
});

test("pre-approving a tool lets it run without asking, and only that tool", () => {
  const a = bea({ tools: ["web_search", "create_reminder", "write_memory"], preapproved: ["create_reminder"] });
  assert.equal(A.decide(a, "create_reminder").approval, false, "pre-approved runs");
  assert.equal(A.decide(a, "write_memory").approval, true, "the other still waits");
});

test("pre-approval for a tool the agent does not have is dropped", () => {
  // Otherwise granting the tool later would silently come pre-approved.
  const a = A.validateAgent({ name: "X", tools: ["web_search"], preapproved: ["write_file", "web_search"] });
  assert.deepEqual(a.preapproved, ["web_search"]);
});

test("an agent with no tools refuses everything", () => {
  const a = A.validateAgent({ name: "Plain", tools: [] });
  for (const t of A.TOOL_IDS) assert.equal(A.decide(a, t).allow, false, `${t} is refused`);
});

test("the prompt lists only the tools that were granted", () => {
  const p = A.systemPromptFor(bea());
  assert.match(p, /You are Bea, handles supplier email/);
  assert.match(p, /Never promise a delivery date/);
  assert.match(p, /web_search/);
  assert.match(p, /create_reminder/);
  assert.ok(!p.includes("write_file"), "a tool it does not have is never mentioned");
  assert.match(p, /approval/, "it is told that changing things needs a yes");
});

test("an agent with no tools is told so, rather than given an empty list", () => {
  const p = A.systemPromptFor(A.validateAgent({ name: "Plain", tools: [] }));
  assert.match(p, /no tools/);
  assert.ok(!p.includes("forge-act"), "it is not taught a syntax it cannot use");
});

test("tool calls are read out of a reply", () => {
  const reply = 'I will look it up.\n\n```forge-act\n{"tool":"web_search","input":"steel prices","why":"need a figure"}\n```\n';
  const acts = A.parseActions(reply);
  assert.equal(acts.length, 1);
  assert.deepEqual(acts[0], { tool: "web_search", input: "steel prices", why: "need a figure" });
});

test("a malformed or half-streamed block is ignored, not guessed at", () => {
  assert.deepEqual(A.parseActions("```forge-act\n{not json\n```"), []);
  assert.deepEqual(A.parseActions("```forge-act\n{\"input\":\"no tool named\"}\n```"), []);
  assert.deepEqual(A.parseActions("```forge-act\n{\"tool\":\"web_search\""), [], "an unterminated block is not an action");
});

test("several calls in one reply are all read, and each is still checked", () => {
  const reply = '```forge-act\n{"tool":"web_search","input":"a"}\n```\n```forge-act\n{"tool":"write_file","input":"b"}\n```';
  const acts = A.parseActions(reply);
  assert.equal(acts.length, 2);
  const a = bea();
  assert.equal(A.decide(a, acts[0].tool).allow, true);
  assert.equal(A.decide(a, acts[1].tool).allow, false, "the second is refused even though it was asked for");
});

test("a numbered plan is read from the reply", () => {
  const steps = A.parsePlan("Here is my plan:\n1. Find the supplier's page\n2. Read the terms\n3. Draft a reply\n\nStarting now.");
  assert.deepEqual(steps, ["Find the supplier's page", "Read the terms", "Draft a reply"]);
});

test("prose with no plan yields no steps", () => {
  assert.deepEqual(A.parsePlan("I will just answer this directly."), []);
});

test("a machine too small for an agent loop is told so plainly", () => {
  const small = A.advice({ usableBytes: 5 * 2 ** 30 });
  assert.equal(small.ok, false);
  assert.match(small.text, /7B/);
  assert.match(small.text, /unreliable/);
});

test("a model that does not fit is reported before it is run", () => {
  const r = A.advice({ usableBytes: 8 * 2 ** 30, modelBytes: 12 * 2 ** 30 });
  assert.equal(r.ok, false);
  assert.match(r.text, /does not fit/);
});

test("a machine with room is told it has room", () => {
  assert.equal(A.advice({ usableBytes: 16 * 2 ** 30 }).ok, true);
  assert.equal(A.advice({ usableBytes: 16 * 2 ** 30 }).warn, false);
  assert.equal(A.advice({ usableBytes: 6 * 2 ** 30 }).warn, true, "tight but workable is flagged");
});

test("an agent survives export and import, with a new id", () => {
  const a = bea({ preapproved: ["create_reminder"] });
  const back = A.importAgent(A.exportAgent(a));
  assert.equal(back.name, "Bea");
  assert.deepEqual(back.tools, a.tools);
  assert.deepEqual(back.preapproved, ["create_reminder"]);
  assert.notEqual(back.id, a.id, "a fresh id, so importing twice does not overwrite");
});

test("files that are not agents are refused with a reason", () => {
  assert.throws(() => A.importAgent("nope"), /not valid JSON/);
  assert.throws(() => A.importAgent(JSON.stringify({ format: "other" })), /not a Forge AI agent/);
  assert.throws(() => A.importAgent(JSON.stringify({ format: A.FORMAT, version: 99, name: "x" })), /newer version/);
  assert.throws(() => A.importAgent(42), /text file/);
});

test("an imported agent cannot smuggle in a permission that does not exist", () => {
  const sneaky = JSON.stringify({ format: A.FORMAT, version: 1, name: "Sneaky", tools: ["run_shell", "web_search"], preapproved: ["run_shell"] });
  const a = A.importAgent(sneaky);
  assert.deepEqual(a.tools, ["web_search"]);
  assert.deepEqual(a.preapproved, []);
  assert.equal(A.decide(a, "run_shell").allow, false);
});

test("the assistant is named after the model it actually runs on", () => {
  assert.equal(A.paramsOf("gemma-2-2b-it-Q4_K_M.gguf"), "2B");
  assert.equal(A.paramsOf("Qwen2.5-7B-Instruct-Q4_K_M.gguf"), "7B");
  assert.equal(A.paramsOf("SmolVLM-256M.gguf"), "256M");
  assert.equal(A.paramsOf("Llama-3.2-1B.gguf"), "1B");
  assert.equal(A.paramsOf("mystery.gguf"), "", "a name that does not say is not guessed at");
  assert.equal(A.forgeAssistant("gemma-2-2b-it-Q4_K_M.gguf").name, "Forge AI 2B");
  assert.equal(A.forgeAssistant("mystery.gguf").name, "Forge AI", "no size is better than a wrong one");
});

test("the assistant gets every tool except sending email, and none pre-approved", () => {
  const f = A.forgeAssistant("gemma-2-2b-it-Q4_K_M.gguf");
  const withheld = A.TOOL_IDS.filter((t) => !f.tools.includes(t));
  // Sending mail is withheld on purpose: a general assistant set up by one
  // button should not arrive able to send mail as the person. Drafting is free.
  assert.deepEqual(withheld, ["send_email"], "only sending email is withheld");
  assert.ok(f.tools.includes("draft_email"), "it can still write one");
  assert.equal(A.decide(f, "send_email").allow, false, "and it cannot send it");
  assert.deepEqual(f.preapproved, [], "nothing happens without a yes the first time");
  assert.equal(f.model, "gemma-2-2b-it-Q4_K_M.gguf");
  // Only the ones it actually has can "wait"; one it does not have is refused
  // outright, which is the stronger outcome and is asserted above.
  for (const t of A.TOOLS.filter((x) => x.changes && f.tools.includes(x.id))) {
    assert.equal(A.decide(f, t.id).approval, true, `${t.id} still waits for a person`);
  }
});

test("the assistant is told to admit what it does not know", () => {
  const p = A.systemPromptFor(A.forgeAssistant("gemma-2-2b-it-Q4_K_M.gguf"));
  assert.match(p, /do not know/i, "it is told to say so");
  assert.match(p, /Never invent/i, "and told not to fill the gap");
  assert.match(p, /cannot send email/i, "and what is beyond it");
  assert.match(p, /sandboxed frame/i, "how to write a page that will actually render");
});

test("overlong text is cut to the limit rather than stored whole", () => {
  const a = A.validateAgent({ name: "x".repeat(500), role: "y".repeat(500), instructions: "z".repeat(20000), tools: [] });
  assert.equal(a.name.length, A.LIMITS.name);
  assert.equal(a.role.length, A.LIMITS.role);
  assert.equal(a.instructions.length, A.LIMITS.instructions);
});
