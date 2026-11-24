// Measuring how fast this machine is.
//
// Every reference_tok_s in the catalogue is 0.0 and always has been. A
// number from somebody else's machine would be no better: the same model
// runs at 13 tokens a second on an 8 GB laptop and 90 on a workstation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bench = require(path.join(__dirname, "..", "electron", "benchmark.cjs"));

/** An engine that answers in a fixed time with a fixed number of tokens. */
function fakeEngine({ seconds, usage, text = "one, two, three", status = 200 }) {
  let t = 1000;
  return {
    now: () => t,
    fetchImpl: async () => {
      t += seconds * 1000;
      return {
        ok: status === 200,
        status,
        json: async () => ({
          choices: [{ message: { content: text } }],
          ...(usage ? { usage } : {}),
        }),
      };
    },
  };
}

test("the rate is the engine's own token count over the time it took", async () => {
  const e = fakeEngine({ seconds: 2, usage: { completion_tokens: 64 } });
  const r = await bench.measure({ baseUrl: "http://x", ...e });
  assert.equal(r.ok, true);
  assert.equal(r.tokens, 64);
  assert.equal(r.seconds, 2);
  assert.equal(r.tok_s, 32);
  assert.equal(r.counted, true, "the engine counted, so the estimate was not used");
});

test("without a count from the engine the length is used, and it says so", async () => {
  const e = fakeEngine({ seconds: 1, text: "x".repeat(400) });
  const r = await bench.measure({ baseUrl: "http://x", ...e });
  assert.equal(r.tokens, 100, "four characters a token");
  assert.equal(r.counted, false, "and the reading admits it is an estimate");
});

test("an engine that refuses is not a measurement", async () => {
  const e = fakeEngine({ seconds: 1, status: 401 });
  const r = await bench.measure({ baseUrl: "http://x", ...e });
  assert.equal(r.ok, false);
  assert.match(r.why, /401/);
});

test("the key is sent, because the engine now refuses without it", async () => {
  let seen = null;
  await bench.measure({
    baseUrl: "http://x",
    apiKey: "secret",
    now: () => 1000,
    fetchImpl: async (_url, opts) => {
      seen = opts.headers;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    },
  });
  assert.equal(seen.authorization, "Bearer secret");
});

test("a bigger model is expected to be proportionally slower", () => {
  // Measured 40 tok/s on a 1.5B; a 7B does roughly a fifth of that.
  const got = bench.scale(40, { fromParams: 1.5e9, toParams: 7e9 });
  assert.ok(got > 8 && got < 9, `about 8.6, got ${got}`);
  // And a smaller one proportionally faster.
  assert.ok(bench.scale(40, { fromParams: 7e9, toParams: 1.5e9 }) > 40);
  // Nothing to scale from gives nothing, not zero.
  assert.equal(bench.scale(null, { fromParams: 1, toParams: 2 }), null);
  assert.equal(bench.scale(40, { fromParams: 1.5e9, toParams: 0 }), null);
});

test("the speed is described in words a second, which is what it means to a person", () => {
  assert.match(bench.describe(40), /about 30 words a second/);
  // A slow machine gets a decimal, because the difference between 2.1 and
  // 3.4 words a second is the difference between unusable and workable.
  assert.match(bench.describe(4), /about 3\.0 words a second/);
  assert.match(bench.describe(2.8), /about 2\.1 words a second/);
  assert.equal(bench.describe(0), "not measured yet");
  assert.equal(bench.describe(NaN), "not measured yet");
});

test("a measurement is kept only while it is a measurement of what is running", () => {
  const record = { tok_s: 30, model_file: "a.gguf", tier: "small" };
  assert.equal(bench.stillValid(record, { model_file: "a.gguf", tier: "small" }), true);
  // A different model is a different speed.
  assert.equal(bench.stillValid(record, { model_file: "b.gguf", tier: "small" }), false);
  // So are different settings, which is what a tier is.
  assert.equal(bench.stillValid(record, { model_file: "a.gguf", tier: "large" }), false);
  assert.equal(bench.stillValid(null, { model_file: "a.gguf", tier: "small" }), false);
  assert.equal(bench.stillValid({ model_file: "a.gguf", tier: "small" }, { model_file: "a.gguf", tier: "small" }), false, "no rate is no measurement");
});

test("a measurement survives being written and read back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bench-"));
  const file = path.join(dir, "deep", "speed.json");
  try {
    assert.equal(bench.save(file, { tok_s: 12.5, model_file: "a.gguf", tier: "tiny" }), true);
    assert.deepEqual(bench.load(file), { tok_s: 12.5, model_file: "a.gguf", tier: "tiny" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable or absent record is an empty one, never a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bench-"));
  try {
    assert.deepEqual(bench.load(path.join(dir, "nothing.json")), {});
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    assert.deepEqual(bench.load(broken), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the catalogue's own placeholder is not treated as a speed", () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron", "catalogue.json"), "utf8"));
  const models = cat.models || cat;
  const placeholders = models.filter((m) => !m.reference_tok_s);
  // Every one of them is 0.0. Recording that here so the day somebody fills
  // one in, the test says what changed rather than passing silently.
  assert.equal(placeholders.length, models.length, "every reference speed is still a placeholder");
  assert.equal(bench.describe(0), "not measured yet", "and zero reads as unmeasured, not as instant");
});
