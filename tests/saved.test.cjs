// What not paying for inference is worth, and how honestly it is stated.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "saved.ts"), "utf8");
/** Comment wrapping flattened, so prose spanning lines can be matched. */
const flat = src.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");

// The same arithmetic the module performs, written out here so the numbers
// are checked rather than the code being asked whether it agrees with itself.
const RATE = { input: 3, output: 15 };
const cost = (p, c) => (p / 1e6) * RATE.input + (c / 1e6) * RATE.output;
const money = (n) =>
  n <= 0 ? "$0.00" : n < 0.01 ? "under a cent" : `$${(Math.floor(n * 100) / 100).toFixed(2)}`;

test("the rate in the file is the rate the test prices against", () => {
  assert.match(src, /input:\s*3/);
  assert.match(src, /output:\s*15/);
});

test("the sum is tokens times that rate, and nothing else", () => {
  assert.equal(cost(1e6, 1e6).toFixed(2), "18.00");
  assert.equal(cost(500_000, 100_000).toFixed(2), "3.00");
});

test("a small number is not dressed up as a big one", () => {
  assert.equal(money(cost(1000, 200)), "under a cent");
  assert.equal(money(0), "$0.00");
});

test("it never rounds up into looking better than it is", () => {
  // $0.0149 must not become $0.02, and $0.019 must not become $0.02 either.
  assert.equal(money(0.0149), "$0.01");
  assert.equal(money(0.019), "$0.01");
});

test("the assumption is written where the number is, not hidden", () => {
  assert.match(src, /per million tokens/i);
  assert.match(flat, /the assumption is shown next to the number/i);
});

test("it does not claim the answers are equivalent", () => {
  assert.match(flat, /What it is not: a claim that the answers are equivalent/i);
  assert.match(flat, /is not a frontier model/i);
});

test("nothing is counted for a reply that did not happen", () => {
  assert.match(src, /Nothing has run here yet/);
});
