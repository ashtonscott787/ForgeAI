// What is in the context window, and whether the number is honest about
// where it came from. The module is imported and run, not read as text, so
// these are the real answers rather than a second implementation agreeing
// with itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "context.ts"));

test("an estimate is characters divided by four, rounded up", async () => {
  const { estimateTokens } = await load();
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(4000)), 1000);
});

test("the parts add up to what is used, and free is the rest", async () => {
  const { measure } = await load();
  const r = measure(
    [
      { id: "a", label: "A", text: "x".repeat(400) }, // 100
      { id: "b", label: "B", text: "x".repeat(800) }, // 200
    ],
    1000,
  );
  assert.equal(r.used, 300);
  assert.equal(r.free, 700);
  assert.equal(r.over, 0);
  assert.equal(r.parts.map((p) => p.tokens).reduce((a, b) => a + b, 0), r.used);
});

test("a share is of the window, so the segments and the free space make one bar", async () => {
  const { measure } = await load();
  // 2000 characters is 500 tokens, which is half of a 1000-token window.
  const r = measure([{ id: "a", label: "A", text: "x".repeat(2000) }], 1000);
  assert.equal(r.parts[0].tokens, 500);
  assert.equal(r.parts[0].share, 0.5);
  const shares = r.parts.reduce((n, p) => n + p.share, 0) + r.free / r.limit;
  assert.ok(Math.abs(shares - 1) < 1e-9, "the segments plus the free space are the whole bar");
});

test("over a full window there is an overflow and no free space", async () => {
  const { measure, pressure } = await load();
  const r = measure([{ id: "a", label: "A", text: "x".repeat(8000) }], 1000);
  assert.equal(r.used, 2000);
  assert.equal(r.free, 0, "never negative: there is no minus-700 tokens of room");
  assert.equal(r.over, 1000);
  assert.equal(pressure(r), "over");
});

test("the reading says whether it was measured or estimated", async () => {
  const { measure } = await load();
  const pieces = [{ id: "a", label: "A", text: "x".repeat(400) }];
  assert.equal(measure(pieces, 1000).estimated, true);
  const exact = measure(pieces, 1000, { a: 77 });
  assert.equal(exact.estimated, false);
  assert.equal(exact.parts[0].tokens, 77, "the engine's count wins over the guess");
});

test("pressure is named at the thresholds it documents", async () => {
  const { measure, pressure, TIGHT, FULL } = await load();
  const at = (frac) => pressure(measure([{ id: "a", label: "A", text: "x".repeat(frac * 4000) }], 1000));
  assert.equal(at(0.5), "fine");
  assert.equal(at(TIGHT), "tight");
  assert.equal(at(FULL), "full");
});

test("a part the engine could not count does not quietly become a guess", async () => {
  const { countAll } = await load();
  // No server on this port: every count fails, so the whole reading fails
  // rather than coming back as a mixture.
  const got = await countAll("http://127.0.0.1:1", [{ id: "a", label: "A", text: "hello" }]);
  assert.equal(got, null);
});

test("the engine's own count is used when the engine answers", async () => {
  const http = require("node:http");
  const { countWithEngine, countAll } = await load();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { content } = JSON.parse(body);
      // Stand-in for a vocabulary: one token per word.
      const tokens = content.split(/\s+/).filter(Boolean).map((_, i) => i);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tokens }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await countWithEngine(base, "one two three four five"), 5);
    const all = await countAll(base, [
      { id: "a", label: "A", text: "one two" },
      { id: "b", label: "B", text: "" },
    ]);
    assert.deepEqual(all, { a: 2, b: 0 }, "empty pieces cost nothing and are not asked about");
  } finally {
    server.close();
  }
});
