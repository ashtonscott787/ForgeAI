// Making a model from one you already have. These jobs write files into the
// models folder, so what they refuse to do matters as much as what they do.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const shop = require(path.join(__dirname, "..", "electron", "workshop.cjs"));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-workshop-"));
  fs.writeFileSync(path.join(dir, "base-Q8_0.gguf"), Buffer.alloc(4096));
  return dir;
}

test("a name is made safe, and a nameless one is refused", () => {
  assert.equal(shop.safeOutputName("My Model"), "My-Model.gguf");
  assert.equal(shop.safeOutputName("../../etc/passwd"), "etc-passwd.gguf");
  assert.equal(shop.safeOutputName("tidy.gguf"), "tidy.gguf");
  assert.equal(shop.safeOutputName("   "), "");
  assert.equal(shop.safeOutputName("..."), "");
  assert.ok(!shop.safeOutputName("a/b/c").includes("/"), "no path separators survive");
});

test("the suggested name replaces the old format rather than stacking them", () => {
  assert.equal(shop.suggestName("gemma-3-4b-it-Q8_0.gguf", "Q4_K_M"), "gemma-3-4b-it-Q4_K_M.gguf");
  assert.equal(shop.suggestName("model-F16.gguf", "Q5_K_M"), "model-Q5_K_M.gguf");
  assert.equal(shop.suggestName("plain.gguf", "Q4_K_M"), "plain-Q4_K_M.gguf");
});

test("shrinking is planned only when every input is real", () => {
  const dir = sandbox();
  try {
    const ok = shop.planShrink({ dir, source: "base-Q8_0.gguf", format: "Q4_K_M" });
    assert.equal(ok.ok, true);
    assert.equal(ok.out, "base-Q4_K_M.gguf");

    assert.match(shop.planShrink({ dir, source: "missing.gguf", format: "Q4_K_M" }).why, /not in the models folder/);
    assert.match(shop.planShrink({ dir, source: "base-Q8_0.gguf", format: "Q9_WILD" }).why, /not one of the formats/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("it never writes over the model it is reading, or over anything else", () => {
  const dir = sandbox();
  try {
    const onto = shop.planShrink({ dir, source: "base-Q8_0.gguf", format: "Q4_K_M", outName: "base-Q8_0" });
    assert.equal(onto.ok, false);
    assert.match(onto.why, /different name/);

    fs.writeFileSync(path.join(dir, "taken.gguf"), "x");
    const clash = shop.planShrink({ dir, source: "base-Q8_0.gguf", format: "Q4_K_M", outName: "taken" });
    assert.equal(clash.ok, false);
    assert.match(clash.why, /already a model called taken\.gguf/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that tries to climb out of the folder stays in it", () => {
  const dir = sandbox();
  try {
    const p = shop.planShrink({ dir, source: "base-Q8_0.gguf", format: "Q4_K_M", outName: "../../escape" });
    assert.equal(p.ok, true);
    assert.equal(path.dirname(path.resolve(p.dest)), path.resolve(dir), "it was written inside the models folder");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("combining needs a real adapter, and says what it cannot convert", () => {
  const dir = sandbox();
  try {
    const safet = path.join(dir, "adapter.safetensors");
    fs.writeFileSync(safet, "x");
    const wrong = shop.planCombine({ dir, source: "base-Q8_0.gguf", adapter: safet, outName: "mine" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.why, /safetensors/i, "it names the format it cannot take");

    const gguf = path.join(dir, "adapter.gguf");
    fs.writeFileSync(gguf, "x");
    assert.equal(shop.planCombine({ dir, source: "base-Q8_0.gguf", adapter: gguf, outName: "mine" }).ok, true);
    assert.match(shop.planCombine({ dir, source: "base-Q8_0.gguf", adapter: path.join(dir, "nope.gguf"), outName: "mine" }).why, /could not be found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that fails leaves no half-written model behind", async () => {
  const dir = sandbox();
  const dest = path.join(dir, "out.gguf");
  try {
    const r = await shop.finishInto({
      dest,
      run: async (part) => {
        fs.writeFileSync(part, Buffer.alloc(2048)); // started, then died
        return { ok: false, why: "it stopped with code 1" };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(dest), false, "nothing appears in the model list");
    assert.equal(fs.existsSync(`${dest}.part`), false, "and the partial file is cleared away");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool that claims success but writes nothing is not believed", async () => {
  const dir = sandbox();
  const dest = path.join(dir, "out.gguf");
  try {
    const r = await shop.finishInto({ dest, run: async () => ({ ok: true }) });
    assert.equal(r.ok, false);
    assert.match(r.why, /wrote nothing usable/);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that works lands as a finished file, under its own name", async () => {
  const dir = sandbox();
  const dest = path.join(dir, "out.gguf");
  try {
    const r = await shop.finishInto({
      dest,
      run: async (part) => { fs.writeFileSync(part, Buffer.alloc(2 * 1024 * 1024)); return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.file, "out.gguf");
    assert.equal(r.bytes, 2 * 1024 * 1024);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool runner reports a missing binary rather than throwing", async () => {
  const r = await shop.runTool({ bin: path.join(os.tmpdir(), "definitely-not-here-forge"), args: [] });
  assert.equal(r.ok, false);
  assert.ok(r.why.length > 0);
});

test("every offered format is one llama-quantize is actually asked for", () => {
  // The id is passed to the tool verbatim, so a typo here is a job that
  // fails after the person has waited for it.
  for (const f of shop.FORMATS) {
    assert.match(f.id, /^(IQ|Q|F|BF)[0-9A-Z_]*$/);
    assert.ok(f.note.length > 20, `${f.id} says what it costs`);
    assert.equal(shop.isFormat(f.id), true);
  }
  assert.equal(shop.isFormat("nonsense"), false);
});

test("the module does not claim it can train or fine-tune", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "workshop.cjs"), "utf8");
  // Comment wrapping flattened: the sentence spans two lines, and a plain
  // match against the raw file fails for the formatting rather than the words.
  const flat = src.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
  assert.match(flat, /cannot train a model from nothing/i, "the gap is stated where somebody will read it");
  assert.match(flat, /cannot fine-tune one on your own writing/i);
});
