// Which saved notes are put in front of the model.
//
// From a real failure: asked "tell me aobut rowing", a 1.5B model wrote
// several paragraphs about sushi and pizza, because a saved note said the
// person liked them and every saved note went into every prompt. The
// transcript sent was correct; the system prompt was the problem.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "prompt.ts"));

const SAVED = [
  "Ash likes sushi and pizza",
  "Ash runs a joinery in Dunedin",
  "Ash prefers metric measurements",
  "Ash rows for a club on the harbour",
];

test("a note about food stays out of a question about rowing", async () => {
  const { relevantMemories } = await load();
  const kept = relevantMemories(SAVED, "tell me about rowing");
  assert.deepEqual(kept, ["Ash rows for a club on the harbour"]);
  assert.ok(!kept.some((m) => /sushi/.test(m)), "the defect that caused this test");
});

test("a note that does bear on the question is kept", async () => {
  const { relevantMemories } = await load();
  assert.deepEqual(relevantMemories(SAVED, "what sushi should I make tonight?"), ["Ash likes sushi and pizza"]);
  assert.deepEqual(relevantMemories(SAVED, "quote for a joinery job"), ["Ash runs a joinery in Dunedin"]);
});

test("the conversation so far counts, not only the last line", async () => {
  const { relevantMemories } = await load();
  // "How long should it be?" on its own matches nothing; in a conversation
  // about a joinery bench it should still bring the joinery note.
  assert.deepEqual(relevantMemories(SAVED, "how long should it be?"), []);
  assert.deepEqual(
    relevantMemories(SAVED, "how long should it be?", ["I am building a joinery bench"]),
    ["Ash runs a joinery in Dunedin"],
  );
});

test("common words do not make everything relevant", async () => {
  const { relevantMemories } = await load();
  // Every saved line contains "Ash" — a name is uncommon, so that is a real
  // match. Words like "the" and "likes" are not.
  assert.deepEqual(relevantMemories(["I like the thing", "They have that one"], "what can you do with the two of them?"), []);
});

test("nothing is kept when nothing was asked", async () => {
  const { relevantMemories } = await load();
  assert.deepEqual(relevantMemories(SAVED, ""), []);
  assert.deepEqual(relevantMemories([], "anything"), []);
});

test("the number put in front of the model is capped", async () => {
  const { relevantMemories } = await load();
  const many = Array.from({ length: 30 }, (_, i) => `note ${i} about rowing`);
  assert.equal(relevantMemories(many, "rowing").length, 6);
  assert.equal(relevantMemories(many, "rowing", [], 2).length, 2);
});

test("the prompt says the notes are not what was asked about", async () => {
  const { systemPrompt, SYSTEM_PROMPT } = await load();
  const out = systemPrompt(["Ash likes sushi and pizza"]);
  assert.match(out, /have NOT just said these things/);
  assert.match(out, /none of them is the subject of the current question/);
  assert.match(SYSTEM_PROMPT, /Answer the last message in the conversation/);
});

test("with no relevant notes the prompt carries none at all", async () => {
  const { systemPrompt } = await load();
  const out = systemPrompt([]);
  assert.doesNotMatch(out, /Background notes/);
});

test("the prompt file stays in one alphabet", () => {
  // A stray Cyrillic word got into an assistant's instructions once and was
  // sent to the model on every turn. It happened again while writing this
  // filter's stop-word list.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "prompt.ts"), "utf8");
  const stray = [...src].filter((c) => c.codePointAt(0) > 0x2bff);
  assert.deepEqual(stray, [], "non-Latin characters in the prompt");
});
