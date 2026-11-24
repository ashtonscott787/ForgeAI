// What the machine is, and what it can run.
//
// The old report said vram_bytes: 0 on every machine ever made, so a PC with
// a 24 GB card and an eight-year-old laptop were offered the same model and
// given the same settings. Every platform branch is exercised here with a
// stand-in for the commands, because the real ones only exist on one machine
// each and the branch that matters is always the one you are not on.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const hw = require(path.join(__dirname, "..", "electron", "hardware.cjs"));

const GiB = hw.GiB;

/** A stand-in for the command runner: answers the ones named, "" otherwise. */
const runner = (answers) => (file, args) => {
  const key = `${file} ${(args || []).join(" ")}`;
  for (const [match, out] of Object.entries(answers)) {
    if (key.includes(match)) return out;
  }
  return "";
};

test("an NVIDIA card is found, by name and by memory", () => {
  const run = runner({ "nvidia-smi": "NVIDIA GeForce RTX 4090, 24564\n" });
  const gpu = hw.detectGpu("win32", "x64", run);
  assert.equal(gpu.kind, "nvidia");
  assert.equal(gpu.name, "NVIDIA GeForce RTX 4090");
  assert.equal(gpu.vram_bytes, 24564 * 1024 * 1024);
  assert.equal(gpu.unified, false);
});

test("an Apple chip reports the machine's memory as its graphics memory", () => {
  const run = runner({ "machdep.cpu.brand_string": "Apple M3\n" });
  const gpu = hw.detectGpu("darwin", "arm64", run);
  assert.equal(gpu.kind, "apple");
  assert.equal(gpu.unified, true);
  // One pool. Reporting zero of it was the single most wrong number in the
  // old hardware report.
  assert.equal(gpu.vram_bytes, os.totalmem());
});

test("a Windows card with no NVIDIA tool is named, and its memory left unknown", () => {
  const run = runner({ "Win32_VideoController": "AMD Radeon RX 7900 XTX\n" });
  const gpu = hw.detectGpu("win32", "x64", run);
  assert.equal(gpu.kind, "amd");
  assert.equal(gpu.name, "AMD Radeon RX 7900 XTX");
  // null, not 0: "nobody knows" and "it has none" lead to different
  // decisions, and conflating them is how the old report went wrong.
  assert.equal(gpu.vram_bytes, null);
});

test("a machine with no graphics card is not an error", () => {
  const gpu = hw.detectGpu("linux", "x64", runner({}));
  assert.equal(gpu.kind, "none");
  assert.equal(gpu.vram_bytes, null);
});

test("a Linux card is read from the device list", () => {
  const run = runner({ lspci: "01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [RTX 3070]\n" });
  const gpu = hw.detectGpu("linux", "x64", run);
  assert.equal(gpu.kind, "nvidia");
  assert.match(gpu.name, /RTX 3070/);
});

test("free memory uses the number that means free on each platform", () => {
  // macOS: free + inactive + purgeable + file-backed, not os.freemem().
  const vmStat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               12000.",
    "Pages inactive:                           40000.",
    "Pages purgeable:                           2000.",
    "File-backed pages:                        10000.",
  ].join("\n");
  const mac = hw.freeBytes("darwin", runner({ vm_stat: vmStat }));
  assert.equal(mac, (12000 + 40000 + 2000 + 10000) * 16384);

  // When the command says nothing, the portable answer is used rather than zero.
  assert.equal(hw.freeBytes("darwin", runner({})), os.freemem());
});

test("the four tiers are picked by the memory a model can actually use", () => {
  const t = (ram, vram, unified, accelerated) =>
    hw.tierFor({ ram_bytes: ram, vram_bytes: vram, unified, accelerated }).id;

  // An 8 GB Apple machine: one pool, 60% of it usable.
  assert.equal(t(8 * GiB, 8 * GiB, true, true), "tiny");
  assert.equal(t(16 * GiB, 16 * GiB, true, true), "small");
  assert.equal(t(32 * GiB, 32 * GiB, true, true), "medium");
  assert.equal(t(64 * GiB, 64 * GiB, true, true), "large");

  // A PC judged on its card, not its system memory.
  assert.equal(t(32 * GiB, 24 * GiB, false, true), "large");
  assert.equal(t(32 * GiB, 12 * GiB, false, true), "medium");
  assert.equal(t(32 * GiB, 6 * GiB, false, true), "small");
});

test("a machine with no acceleration is held back, however much memory it has", () => {
  // 64 GB and no graphics card runs a 32B model, at a speed that makes
  // offering it as the default a disservice.
  const id = hw.tierFor({ ram_bytes: 64 * GiB, vram_bytes: null, unified: false, accelerated: false }).id;
  assert.equal(id, "small");
});

test("every tier asks for one conversation slot", () => {
  // n_slots = 4 at 8192 each reserved four conversations' worth of memory on
  // a machine running one. That was the default everywhere.
  for (const tier of hw.TIERS) {
    assert.equal(tier.parallel, 1, `${tier.id} asks for one slot`);
    assert.ok(tier.context >= 4096, `${tier.id} has a usable context`);
    assert.ok(tier.says.length > 20, `${tier.id} explains itself`);
  }
});

test("the small tiers save memory and the large ones do not need to", () => {
  const by = Object.fromEntries(hw.TIERS.map((t) => [t.id, t]));
  assert.equal(by.tiny.kv_type, "q8_0", "a compressed conversation cache");
  assert.equal(by.tiny.gpu_layers, 0, "and nothing on a graphics card it does not have");
  assert.equal(by.large.kv_type, "f16", "full precision where there is room");
  assert.ok(by.large.context > by.tiny.context * 4);
});

test("the conversation cache is computed from the model, not guessed", () => {
  // A 1.5B and a 32B differ by more than ten times here, which is why a
  // constant would be useless.
  const small = hw.kvCacheBytes({ block_count: 28, embedding_length: 1536, context: 4096, kv_type: "f16" });
  const large = hw.kvCacheBytes({ block_count: 64, embedding_length: 5120, context: 4096, kv_type: "f16" });
  assert.equal(small, 2 * 28 * 1536 * 4096 * 2);
  assert.ok(large > small * 7);

  // Compressing it halves it.
  const q8 = hw.kvCacheBytes({ block_count: 28, embedding_length: 1536, context: 4096, kv_type: "q8_0" });
  assert.equal(q8, small / 2);

  // Unknown shape gives null, never a number somebody would act on.
  assert.equal(hw.kvCacheBytes({ block_count: null, embedding_length: 1536, context: 4096 }), null);
});

test("a model is measured against free memory, not against the machine's size", () => {
  const r = hw.fits({ model_bytes: 4 * GiB, kv_bytes: 0.5 * GiB, free_bytes: 7 * GiB });
  assert.equal(r.ok, true);

  // The same model on the same machine with something else running.
  const busy = hw.fits({ model_bytes: 4 * GiB, kv_bytes: 0.5 * GiB, free_bytes: 5 * GiB });
  assert.equal(busy.ok, false);
  assert.ok(busy.short > 0, "and it says how much it is short by");
});

test("headroom is kept, so a model that just fits does not take the machine with it", () => {
  const exact = hw.fits({ model_bytes: 6 * GiB, kv_bytes: 0, free_bytes: 6 * GiB });
  assert.equal(exact.ok, false, "6 GB free is not room for a 6 GB model");
  assert.ok(exact.have < 6 * GiB);
});

test("describing the machine answers every question at once", () => {
  const run = runner({ "nvidia-smi": "NVIDIA RTX A6000, 49140\n" });
  const m = hw.describeMachine("linux", "x64", run);
  assert.equal(m.gpu.kind, "nvidia");
  assert.equal(m.accelerated, true);
  assert.equal(m.tier, "large");
  assert.equal(m.settings.parallel, 1);
  assert.ok(m.free_bytes > 0);
  assert.ok(m.cores >= 1);
  assert.ok(m.performance_cores >= 1);
});

test("a command that is not installed is a normal machine, not a failure", () => {
  // nvidia-smi is absent on most computers in the world.
  const m = hw.describeMachine("linux", "x64", () => { throw new Error("ENOENT"); });
  assert.equal(m.gpu.kind, "none");
  assert.equal(m.accelerated, false);
  assert.ok(hw.tierById(m.tier), "it still lands in a tier");
});
