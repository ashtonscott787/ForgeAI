// Reading a model's own metadata rather than guessing from its file name.
// The parser is exercised on files built here, and — with FORGE_LIVE=1 — on the
// first megabytes of a real model fetched with a range request.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const G = require("../electron/gguf.cjs");

// ── a minimal GGUF writer, so the parser can be tested against known values ──
function str(s) {
  const b = Buffer.from(s, "utf8");
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([n, b]);
}
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

function buildGguf({ kv = {}, tensors = [], version = 3 } = {}) {
  const parts = [Buffer.from("GGUF", "ascii"), u32(version), u64(tensors.length), u64(Object.keys(kv).length)];
  for (const [k, v] of Object.entries(kv)) {
    parts.push(str(k));
    if (typeof v === "string") parts.push(u32(G.TYPES.STRING), str(v));
    // A real file uses 64 bits for anything that does not fit in 32, and a
    // parameter count is exactly such a value.
    else if (Number.isInteger(v) && v <= 0xffffffff) parts.push(u32(G.TYPES.UINT32), u32(v));
    else if (Number.isInteger(v)) parts.push(u32(G.TYPES.UINT64), u64(v));
    else throw new Error("test helper handles strings and integers");
  }
  for (const t of tensors) {
    parts.push(str(t.name), u32(t.dims.length));
    for (const d of t.dims) parts.push(u64(d));
    parts.push(u32(0), u64(0));
  }
  return Buffer.concat(parts);
}

test("a file that is not a GGUF is refused by name", () => {
  assert.throws(() => G.describe(Buffer.alloc(64)), /not a GGUF model/);
  assert.throws(() => G.describe(Buffer.from("hi")), /too short/);
  assert.throws(() => G.describe("not a buffer"), /too short/);
});

test("an unsupported version is refused rather than misread", () => {
  assert.throws(() => G.describe(buildGguf({ version: 9 })), /version 9 is not supported/);
});

test("the parameter count is summed from the tensor shapes", () => {
  const buf = buildGguf({
    kv: { "general.architecture": "llama", "general.name": "Test Model", "llama.context_length": 4096, "llama.block_count": 2 },
    tensors: [
      { name: "token_embd.weight", dims: [100, 50] },   // 5,000
      { name: "blk.0.attn_q.weight", dims: [50, 50] },  // 2,500
      { name: "output.weight", dims: [50, 100] },       // 5,000
    ],
  });
  const d = G.describe(buf);
  assert.equal(d.parameters, 12500, "every tensor is counted");
  assert.equal(d.parameters_source, "counted from tensor shapes");
  assert.equal(d.architecture, "llama");
  assert.equal(d.name, "Test Model");
  assert.equal(d.context_length, 4096);
  assert.equal(d.block_count, 2);
  assert.equal(d.complete, true);
});

test("counted shapes beat a figure the file merely states", () => {
  // An uploader's stated count can be wrong; the shapes cannot.
  const buf = buildGguf({
    kv: { "general.architecture": "llama", "general.parameter_count": 999 },
    tensors: [{ name: "a", dims: [10, 10] }],
  });
  const d = G.describe(buf);
  assert.equal(d.parameters, 100, "the shapes win");
  assert.equal(d.parameters_source, "counted from tensor shapes");
});

test("a stated count is used when the tensor table was not reached", () => {
  const full = buildGguf({
    kv: { "general.architecture": "llama", "general.parameter_count": 7000000000 },
    tensors: [{ name: "a", dims: [10, 10] }],
  });
  const partial = full.subarray(0, full.length - 12); // stops inside the tensor records
  const d = G.describe(partial);
  assert.equal(d.complete, false, "the read is known to be short");
  assert.equal(d.parameters, 7000000000);
  assert.equal(d.parameters_source, "stated in the file");
});

test("a truncated header gives back what was read instead of throwing", () => {
  const full = buildGguf({ kv: { "general.architecture": "llama", "general.name": "Half" }, tensors: [{ name: "a", dims: [4, 4] }] });
  const d = G.describe(full.subarray(0, 40));
  assert.equal(d.complete, false);
  assert.equal(d.parameters, null, "no count is invented from a partial read");
});

test("parameter counts are labelled the way model names write them", () => {
  assert.equal(G.humanParams(2614341888), "2.6B", "the real Gemma 2 2B figure");
  assert.equal(G.humanParams(7241732096), "7.2B");
  assert.equal(G.humanParams(13_000_000_000), "13B", "no decimal once it is large");
  assert.equal(G.humanParams(256_000_000), "256M");
  assert.equal(G.humanParams(0), "", "nothing is shown when nothing is known");
  assert.equal(G.humanParams(NaN), "");
});

test("a vision model is recognised from its own metadata", () => {
  const d = G.describe(buildGguf({ kv: { "general.architecture": "clip", "clip.vision.block_count": 12 }, tensors: [] }));
  assert.equal(d.vision, true);
});

test("an implausible header is rejected rather than trusted", () => {
  const bad = Buffer.concat([Buffer.from("GGUF", "ascii"), u32(3), u64(50_000_000), u64(5)]);
  assert.throws(() => G.describe(bad), /not plausible/);
});

test("describeFile grows its read when the first pass stops short", () => {
  const file = path.join(os.tmpdir(), `forge-gguf-${process.pid}.gguf`);
  // A large key/value block, so a small first read cannot reach the tensors.
  const filler = "x".repeat(200_000);
  const buf = buildGguf({
    kv: { "general.architecture": "llama", "general.name": "Big vocab", pad: filler },
    tensors: [{ name: "a", dims: [1000, 1000] }],
  });
  fs.writeFileSync(file, buf);
  try {
    const small = G.describeFile(file, [1024]);
    assert.equal(small.complete, false, "a tiny read cannot finish");
    const grown = G.describeFile(file, [1024, 10 * 1024 * 1024]);
    assert.equal(grown.complete, true, "a larger read does");
    assert.equal(grown.parameters, 1_000_000);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ── against a real model ──────────────────────────────────────
// Only the header is fetched, with a range request, so this costs megabytes
// rather than gigabytes. Run with:
//   FORGE_LIVE=1 NODE_USE_ENV_PROXY=1 node --test tests/gguf.test.cjs
const LIVE = process.env.FORGE_LIVE === "1";
const REAL = {
  url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf?download=true",
  // Gemma 2 2B, published as 2.61B parameters.
  parameters: 2614341888,
  architecture: "gemma2",
  context: 8192,
  blocks: 26,
};

test("a real published model reports its own exact parameter count", { skip: !LIVE }, async () => {
  const { execFileSync } = require("node:child_process");
  const file = path.join(os.tmpdir(), `forge-live-gguf-${process.pid}.bin`);
  try {
    execFileSync("curl", ["-sSL", "-r", "0-26000000", "-o", file, REAL.url], { timeout: 120_000 });
    const d = G.describeFile(file, [48 * 1024 * 1024]);
    assert.equal(d.complete, true, "the header was read in full");
    assert.equal(d.architecture, REAL.architecture);
    assert.equal(d.context_length, REAL.context);
    assert.equal(d.block_count, REAL.blocks);
    assert.equal(d.parameters, REAL.parameters, "counted from tensor shapes, to the parameter");
    assert.equal(d.parameters_label, "2.6B");
    assert.equal(d.parameters_source, "counted from tensor shapes");
  } finally {
    fs.rmSync(file, { force: true });
  }
});
