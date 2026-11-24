// Documents longer than the context window.
//
// An attached document went into the prompt whole, and past the window the
// engine failed with a message about tokens rather than an answer about the
// document. Splitting it is not a nicety: it is the difference between an
// answer and an error.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "chunking.ts"));

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const paragraphs = (n, each = 60) => Array.from({ length: n }, (_, i) => `Paragraph ${i}. ${words(each)}`).join("\n\n");

test("a document that fits is not split", async () => {
  const { planFor } = await load();
  const p = planFor("a short note", 8192);
  assert.equal(p.needed, false);
  assert.deepEqual(p.parts, ["a short note"]);
});

test("a document that does not fit is split, and nothing is lost", async () => {
  const { planFor } = await load();
  const doc = paragraphs(60);
  const p = planFor(doc, 4096);
  assert.equal(p.needed, true);
  assert.ok(p.parts.length > 1, "it was split");
  // Every paragraph still appears somewhere. Splitting that silently drops
  // text is worse than refusing, because the answer looks complete.
  const joined = p.parts.join("\n\n");
  for (let i = 0; i < 60; i += 7) {
    assert.match(joined, new RegExp(`Paragraph ${i}\\.`), `paragraph ${i} survived`);
  }
});

test("every part fits the budget it was given", async () => {
  const { planFor } = await load();
  const p = planFor(paragraphs(120), 4096);
  for (const part of p.parts) {
    // Four characters a token, the same estimate the planner uses.
    assert.ok(part.length / 4 <= p.budget, `a part of ${Math.round(part.length / 4)} tokens fits ${p.budget}`);
  }
});

test("it cuts at a paragraph break rather than mid-sentence where it can", async () => {
  const { splitText } = await load();
  const parts = splitText(paragraphs(40), 400);
  assert.ok(parts.length > 1);
  // A piece that begins mid-word is a piece that gets summarised badly.
  for (const part of parts.slice(1)) {
    assert.match(part, /^(Paragraph|word)/, `starts cleanly: ${part.slice(0, 30)}`);
  }
});

test("text with no breaks at all is still split rather than refused", async () => {
  const { splitText } = await load();
  const parts = splitText("x".repeat(20000), 500);
  assert.ok(parts.length > 1, "a wall of characters is cut anyway");
  assert.equal(parts.join("").length, 20000, "and nothing is dropped doing it");
});

test("each part is asked about the actual question", async () => {
  const { mapPrompt } = await load();
  const out = mapPrompt("what is the total due?", "Invoice total $4,250.00", 0, 3);
  assert.match(out, /part 1 of 3/);
  assert.match(out, /what is the total due\?/);
  assert.match(out, /Quote figures, dates and names exactly/);
  assert.match(out, /NOTHING/, "a part with nothing in it can say so");
});

test("the final pass is given the notes and told not to go beyond them", async () => {
  const { reducePrompt } = await load();
  const out = reducePrompt("what is the total?", ["total is $4,250.00", "NOTHING", "due 30 Nov"]);
  assert.match(out, /\$4,250\.00/);
  assert.match(out, /30 Nov/);
  assert.doesNotMatch(out, /NOTHING/, "parts that said nothing are left out");
  assert.match(out, /do not invent anything that is not in them/);
});

test("the person is told it is happening, with real numbers", async () => {
  const { planFor, describePlan } = await load();
  const long = describePlan(planFor(paragraphs(120), 4096));
  assert.match(long, /Reading it in \d+ parts/);
  assert.match(long, /tokens/);
  assert.equal(describePlan(planFor("short", 8192)), "", "and nothing is said when nothing is happening");
});

test("a tiny context still leaves room to work in", async () => {
  const { planFor } = await load();
  const p = planFor(paragraphs(30), 512);
  assert.ok(p.budget >= 500, "a floor, so the plan is never zero-sized");
  assert.ok(p.parts.length > 1);
});
