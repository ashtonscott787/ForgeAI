// The command line llama-server is started with.
//
// There were two of them. The window built a careful one — tier-sized
// context, one slot, the performance cores, a compressed cache, the access
// key — and the MCP server built its own with a fixed --ctx-size 4096 and
// nothing else. A ten-thousand-token prompt through Claude Code failed
// against a context a sixth the size the window would have given it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ea = require(path.join(__dirname, "..", "electron", "engine-args.cjs"));

const machine = (over = {}) => ({
  performance_cores: 4,
  gpu_name: "Apple M3",
  gpu_kind: "apple",
  tier_label: "Tiny",
  tier_is_override: false,
  tier_settings: { context: 4096, parallel: 1, kv_type: "q8_0", flash_attention: false, gpu_layers: 999 },
  ...over,
});

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("the essentials are always there", () => {
  const { all } = ea.planEngine({ modelPath: "/m.gguf", port: 1234, machine: machine(), apiKey: "k" });
  assert.equal(valueAfter(all, "--model"), "/m.gguf");
  assert.equal(valueAfter(all, "--port"), "1234");
  assert.equal(valueAfter(all, "--host"), "127.0.0.1", "never on a network interface");
  assert.equal(valueAfter(all, "--ctx-size"), "4096");
  assert.equal(valueAfter(all, "--parallel"), "1", "one conversation, not four");
  assert.equal(valueAfter(all, "--api-key"), "k");
  assert.ok(all.includes("--no-cors-credentials"));
  assert.equal(valueAfter(all, "--threads"), "4", "the performance cores");
});

test("the graphics hardware decides the layers, and a setting overrides it", () => {
  const m = machine();
  assert.equal(ea.layersFrom({}, 999), 999, "the tier's answer when nothing is set");
  assert.equal(ea.layersFrom({ run_mode: "cpu" }, 999), 0, "the person said processor only");
  assert.equal(ea.layersFrom({ run_mode: "split", split_layers: 12 }, 999), 12);
  assert.equal(ea.layersFrom({ gpu_layers: 20 }, 999), 20, "an explicit number wins");
  const { all } = ea.planEngine({ modelPath: "/m.gguf", port: 1, machine: m, apiKey: "k" });
  assert.equal(valueAfter(all, "--n-gpu-layers"), "999");
});

test("the person's own context size beats the tier's", () => {
  const { all } = ea.planEngine({ modelPath: "/m.gguf", port: 1, settings: { context_size: 16384 }, machine: machine(), apiKey: "k" });
  assert.equal(valueAfter(all, "--ctx-size"), "16384");
});

test("the tuning flags come back separately, so they can be dropped", () => {
  // An engine that does not recognise one refuses to start rather than
  // ignoring it, and a tuning flag is never worth the app not running.
  const plan = ea.planEngine({
    modelPath: "/m.gguf", port: 1, machine: machine({ tier_settings: { context: 8192, parallel: 1, kv_type: "q8_0", flash_attention: true, gpu_layers: 999 } }), apiKey: "k",
  });
  assert.deepEqual(plan.tuning, ["--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  for (const flag of plan.tuning) assert.ok(!plan.args.includes(flag), `${flag} is not in the core arguments`);
  assert.deepEqual(plan.all, [...plan.args, ...plan.tuning]);
});

test("full precision asks for no cache flags at all", () => {
  const plan = ea.planEngine({
    modelPath: "/m.gguf", port: 1, machine: machine({ tier_settings: { context: 32768, parallel: 1, kv_type: "f16", flash_attention: true, gpu_layers: 999 } }), apiKey: "k",
  });
  assert.deepEqual(plan.tuning, ["--flash-attn", "on"]);
});

test("a projector, memory loading and other computers are added only when asked for", () => {
  const plain = ea.planEngine({ modelPath: "/m.gguf", port: 1, machine: machine(), apiKey: "k" });
  assert.ok(!plain.all.includes("--mmproj"));
  assert.ok(!plain.all.includes("--no-mmap"));
  assert.ok(!plain.all.includes("--rpc"));

  const loaded = ea.planEngine({
    modelPath: "/m.gguf", port: 1, settings: { load_into_memory: true }, machine: machine(), apiKey: "k",
    projectorPath: "/mmproj.gguf", rpcPeers: ["10.0.0.2:50052", "10.0.0.3:50052"],
  });
  assert.equal(valueAfter(loaded.all, "--mmproj"), "/mmproj.gguf");
  assert.ok(loaded.all.includes("--no-mmap"));
  assert.equal(valueAfter(loaded.all, "--rpc"), "10.0.0.2:50052,10.0.0.3:50052");
});

test("with no key there is no key flag, rather than an empty one", () => {
  const { all } = ea.engineArgs({ modelPath: "/m.gguf", port: 1, contextTokens: 4096, gpuLayers: 0, threads: 2 });
  assert.ok(!all.includes("--api-key"));
  assert.ok(!all.includes("--no-cors-credentials"));
});

test("the log line names the tier, the layers and the context", () => {
  const line = ea.describeEngine({ machine: machine(), contextTokens: 4096, layers: 999 });
  assert.match(line, /Tiny tier/);
  assert.match(line, /Apple M3/);
  assert.match(line, /999 GPU layers/);
  assert.match(line, /4096 context/);
  assert.match(line, /1 slot/);
});

// The point of the module. Either caller assembling its own command line is
// how they came apart in the first place.
test("both callers build their arguments here", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["electron/main.cjs", "electron/mcp-server.cjs"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(src, /engine-args\.cjs/, `${f} uses the shared builder`);
    // A hand-written "--ctx-size" beside it would be a second command line.
    const spawned = src.slice(src.indexOf("spawn("), src.indexOf("spawn(") + 400);
    assert.doesNotMatch(spawned, /"--ctx-size"/, `${f} does not assemble its own`);
  }
  const mcp = fs.readFileSync(path.join(root, "electron", "mcp-server.cjs"), "utf8");
  assert.doesNotMatch(mcp, /"--ctx-size", "4096"/, "the fixed 4096 context is gone");
});
