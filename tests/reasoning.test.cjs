// Reasoning models and the empty reply.
//
// From a real failure on the shipped app: DeepSeek-R1-Distill 1.5B put every
// token into reasoning_content, hit max_tokens, returned content: "", and
// the app showed an empty message. The fix has three parts and all three are
// checked here, because any one of them alone still produces a blank answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const r = require(path.join(__dirname, "..", "electron", "reasoning.cjs"));

test("the models that think out loud are recognised by their file name", () => {
  const thinkers = [
    "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
    "deepseek_r1_qwen_7b.gguf",
    "QwQ-32B-Preview-Q4_K_M.gguf",
    "Qwen3-8B-Q4_K_M.gguf",
    "phi-4-reasoning-plus-Q4.gguf",
    "Magistral-Small-2506-Q4_K_M.gguf",
  ];
  for (const m of thinkers) assert.equal(r.isReasoning(m), true, m);

  const plain = ["gemma-2-2b-it-Q4_K_M.gguf", "qwen2.5-3b-instruct-q4_k_m.gguf", "Llama-3.2-3B-Instruct-Q4.gguf", "", null];
  for (const m of plain) assert.equal(r.isReasoning(m), false, String(m));
});

test("the caller's limit is the limit on the answer, and thinking is added on top", () => {
  const plain = r.budgetFor("gemma-2-2b-it.gguf", 1024);
  assert.equal(plain.max_tokens, 1024);
  assert.equal(plain.answer_tokens, 1024);
  assert.equal(plain.reasoning_budget, null);

  const thinker = r.budgetFor("DeepSeek-R1-Distill-Qwen-1.5B.gguf", 1024);
  assert.equal(thinker.answer_tokens, 1024, "the answer is the length that was asked for");
  assert.ok(thinker.reasoning_budget > 0, "and the thinking has its own room");
  assert.equal(thinker.max_tokens, thinker.answer_tokens + thinker.reasoning_budget);
});

// The defect this replaced: budgetFor multiplied the caller's number by
// four and took a floor of 3072, so max_tokens: 20 returned roughly six
// hundred tokens of text that stopped mid-word.
test("a small limit stays small", () => {
  const b = r.budgetFor("QwQ-32B.gguf", 20);
  assert.equal(b.answer_tokens, 20, "twenty means twenty");
  assert.ok(b.max_tokens < 3072 + 20, "no floor overriding what was asked");
  assert.ok(b.reasoning_budget > 0, "thinking still has room, separately");
});

test("the answer is held to the asked length even if the engine ignores the budget", () => {
  // reasoning_budget is llama.cpp's own field. An engine that does not know
  // it either refuses the request — and the retry sends no budget at all —
  // or ignores it. Either way nothing else caps the output.
  const long = "word ".repeat(400);
  const capped = r.capAnswer(long, 20);
  assert.equal(capped.cut, true);
  assert.ok(capped.text.length <= 20 * 4, "about twenty tokens of characters");
  assert.doesNotMatch(capped.text, /\s$/, "and it does not end in a dangling space");

  const short = r.capAnswer("Wellington.", 20);
  assert.equal(short.cut, false);
  assert.equal(short.text, "Wellington.", "a short answer is untouched");
});

test("a cut-off answer is reported as cut off, and still returned", () => {
  const note = r.explainTruncated({ content: "the long answer", finishReason: "length", answerTokens: 20 });
  assert.match(note, /cut off at the 20-token limit/);
  // A complete answer is never annotated.
  assert.equal(r.explainTruncated({ content: "done", finishReason: "stop", answerTokens: 20 }), null);
  // An empty one belongs to explainEmpty, which says something different.
  assert.equal(r.explainTruncated({ content: "", finishReason: "length", answerTokens: 20 }), null);
  assert.equal(r.wasTruncated({ content: "x", finishReason: "length" }), true);
  assert.equal(r.wasTruncated({ content: "", finishReason: "length" }), false);
});

test("the request carries the budget only when it is needed", () => {
  assert.deepEqual(r.requestFields("gemma-2-2b-it.gguf", 512), { max_tokens: 512 });
  const f = r.requestFields("DeepSeek-R1-Distill.gguf", 512);
  assert.ok(f.max_tokens > 512);
  assert.ok(f[r.BUDGET_FIELD] > 0, "under the name the engine actually reads");
  assert.equal(f.reasoning_budget, undefined, "and not under the one it ignores");
});

test("an answer that arrived is never explained away", () => {
  assert.equal(r.explainEmpty({ content: "Wellington", finishReason: "stop" }), null);
  assert.equal(r.explainEmpty({ content: "  x  ", finishReason: "length" }), null, "cut off, but it said something");
});

test("every way of coming back empty gets its own sentence", () => {
  const ranOut = r.explainEmpty({
    content: "",
    reasoning: "Okay, so the user wants...",
    finishReason: "length",
    modelLabel: "DeepSeek R1 Distill Qwen 1.5B",
    maxTokens: 1024,
  });
  assert.match(ranOut, /DeepSeek R1 Distill Qwen 1\.5B/, "it names the model");
  assert.match(ranOut, /thinking and never began the answer/);
  assert.match(ranOut, /1024-token limit/, "and the limit it hit");

  const cutOff = r.explainEmpty({ content: "", finishReason: "length", maxTokens: 256 });
  assert.match(cutOff, /reached its 256-token limit/);
  assert.doesNotMatch(cutOff, /thinking/, "no thinking happened, so none is blamed");

  const thoughtOnly = r.explainEmpty({ content: "", reasoning: "hmm", finishReason: "stop" });
  assert.match(thoughtOnly, /never wrote an answer/);

  const silence = r.explainEmpty({ content: "", finishReason: "stop" });
  assert.match(silence, /no text at all, and no working either/);

  // Four distinct failures, four distinct sentences: "returned no text" was
  // true of all of them and told nobody which.
  const all = [ranOut, cutOff, thoughtOnly, silence];
  assert.equal(new Set(all).size, 4);
});

test("every reader shares this judgement rather than having its own", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  for (const f of ["electron/mcp-server.cjs", "electron/share-server.cjs"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(src, /reasoning\.cjs|require\("\.\/reasoning/, `${f} uses the shared module`);
  }
  const chat = fs.readFileSync(path.join(root, "src", "lib", "chat.ts"), "utf8");
  assert.match(chat, /finish_reason/, "the chat window reads why the reply ended");
});

// The test that should have existed. 0.7.2 sent `reasoning_budget`, a field
// name recalled rather than checked. The shipped engine accepts it without
// complaint and ignores it, so nothing capped the thinking: a twenty-token
// answer took twenty-five seconds and the code meant to notice saw a 200
// and reported success.
test("the budget field is one the shipped engine actually reads", () => {
  const fs = require("node:fs");
  const lib = path.join(__dirname, "..", "engine", "libllama-server-impl.dylib");
  if (!fs.existsSync(lib)) return; // no macOS engine in this checkout
  const bin = fs.readFileSync(lib);
  // NUL-terminated, so the shorter name is not matched inside the longer
  // one: "reasoning_budget" is a prefix of "reasoning_budget_tokens", and a
  // plain substring search would find it and pass for the wrong reason.
  const named = (n) => bin.includes(Buffer.from(`${n}\0`, "binary"));
  assert.ok(named(r.BUDGET_FIELD), `the engine knows ${r.BUDGET_FIELD}`);
  assert.ok(!named("reasoning_budget"), "and reasoning_budget, which 0.7.2 sent, is not a field it reads");
});

test("the budget never goes low enough to produce a stray closing tag", () => {
  // At 0 the engine ends the thinking before it starts, and the answer
  // arrives beginning "</think>".
  for (const asked of [1, 5, 20]) {
    const f = r.requestFields("DeepSeek-R1-Distill.gguf", asked);
    assert.ok(f[r.BUDGET_FIELD] >= r.MIN_BUDGET, `asked ${asked} still leaves room to close the block`);
  }
  assert.equal(r.stripStrayThink("</think>\n\nWellington"), "Wellington");
  assert.equal(r.stripStrayThink("Wellington"), "Wellington", "a normal answer is untouched");
  assert.equal(r.stripStrayThink("<think>a</think>b"), "<think>a</think>b", "a real block is left alone");
});

test("whether the budget was honoured is judged from the reply, not from a 200", () => {
  // An engine that ignores the field returns success, so the absence of an
  // error proves nothing. It was the whole of the old check.
  assert.equal(r.budgetHonoured({ reasoning: "x".repeat(40 * 4), budget: 50 }), true);
  assert.equal(r.budgetHonoured({ reasoning: "x".repeat(2000 * 4), budget: 50 }), false, "it thought far past the budget");
  assert.equal(r.budgetHonoured({ reasoning: "", budget: 50 }), true, "no thinking is within any budget");
  assert.equal(r.budgetHonoured({ reasoning: "x", budget: null }), null, "nothing was asked, so nothing to judge");
  // A model stops at a sentence rather than exactly on the token, so a
  // near miss is not a failure.
  assert.equal(r.budgetHonoured({ reasoning: "x".repeat(60 * 4), budget: 50 }), true);
});

test("the MCP server asks the reply, not the status code", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp-server.cjs"), "utf8");
  assert.match(src, /budgetHonoured/, "it judges from the reply");
  assert.doesNotMatch(src, /budgetAccepted/, "the check that could never fire is gone");
  assert.doesNotMatch(src, /reasoning_budget\b(?!_)/, "and the field name it ignored is not sent");
});
