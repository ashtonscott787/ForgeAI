// Compacting throws away part of somebody's conversation, so what survives
// and what does not is checked rather than assumed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "compact.ts"));
const talk = (n) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));

test("the recent messages are kept exactly as they were", async () => {
  const { splitFor, KEEP_RECENT } = await load();
  const messages = talk(20);
  const { older, recent } = splitFor(messages);
  assert.equal(recent.length, KEEP_RECENT);
  assert.deepEqual(recent, messages.slice(-KEEP_RECENT));
  assert.equal(older.length, 20 - KEEP_RECENT);
  assert.deepEqual([...older, ...recent], messages, "nothing is dropped between the two halves");
});

test("a short conversation is refused rather than summarised", async () => {
  const { canCompact, KEEP_RECENT, MIN_OLDER } = await load();
  assert.equal(canCompact(talk(KEEP_RECENT)), false);
  assert.equal(canCompact(talk(KEEP_RECENT + MIN_OLDER - 1)), false);
  assert.equal(canCompact(talk(KEEP_RECENT + MIN_OLDER)), true);
});

test("compacting replaces the older half with one summary and touches nothing else", async () => {
  const { applyCompaction, splitFor, isSummary } = await load();
  const messages = talk(20);
  const out = applyCompaction(messages, "They were deciding on a name.");
  const { recent } = splitFor(messages);
  assert.equal(out.length, recent.length + 1);
  assert.ok(isSummary(out[0]));
  assert.match(out[0].content, /deciding on a name/);
  assert.deepEqual(out.slice(1), recent, "the recent turns are the same objects' content, word for word");
});

test("an empty summary changes nothing at all", async () => {
  const { applyCompaction } = await load();
  const messages = talk(20);
  assert.deepEqual(applyCompaction(messages, "   "), messages);
});

test("compacting twice folds the first summary in rather than stacking them", async () => {
  const { applyCompaction, isSummary } = await load();
  const once = applyCompaction(talk(30), "first summary");
  const twice = applyCompaction([...once, ...talk(10)], "second summary");
  assert.equal(twice.filter(isSummary).length, 1);
  assert.match(twice[0].content, /second summary/);
});

test("the transcript handed over names who said what", async () => {
  const { transcriptOf } = await load();
  const out = transcriptOf([
    { role: "user", content: "my name is Ash" },
    { role: "assistant", content: "noted" },
  ]);
  assert.match(out, /Person: my name is Ash/);
  assert.match(out, /Assistant: noted/);
});

test("the instruction asks for the things that are expensive to lose", async () => {
  const { COMPACT_INSTRUCTION } = await load();
  for (const must of [/decisions/i, /facts/i, /unfinished/i]) {
    assert.match(COMPACT_INSTRUCTION, must);
  }
  // A summary that greets the person, or offers to help, is not a summary.
  assert.match(COMPACT_INSTRUCTION, /do not address the person/i);
});
