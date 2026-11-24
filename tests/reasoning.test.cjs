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

test("a reasoning model gets several times the room, and a cap on thinking", () => {
  const plain = r.budgetFor("gemma-2-2b-it.gguf", 1024);
  assert.equal(plain.max_tokens, 1024);
  assert.equal(plain.reasoning_budget, null);

  const thinker = r.budgetFor("DeepSeek-R1-Distill-Qwen-1.5B.gguf", 1024);
  assert.ok(thinker.max_tokens >= 4096, "room to think and then answer");
  assert.ok(thinker.reasoning_budget < thinker.max_tokens, "thinking cannot take all of it");
  assert.ok(thinker.max_tokens - thinker.reasoning_budget >= 1000, "and an answer's worth is left underneath");
});

test("a tiny limit still leaves a reasoning model somewhere to answer", () => {
  const b = r.budgetFor("QwQ-32B.gguf", 50);
  assert.ok(b.max_tokens >= 3072, "a floor, so a small ask is not a blank reply");
  assert.ok(b.max_tokens - b.reasoning_budget > 0);
});

test("the request carries the budget only when it is needed", () => {
  assert.deepEqual(r.requestFields("gemma-2-2b-it.gguf", 512), { max_tokens: 512 });
  const f = r.requestFields("DeepSeek-R1-Distill.gguf", 512);
  assert.ok(f.max_tokens > 512);
  assert.ok(f.reasoning_budget > 0);
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
