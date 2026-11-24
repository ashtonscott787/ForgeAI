// What the machine was judged to be, and which models it may legally use.
// Usage: pnpm build && node tests/ui/tiers-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

const CATALOGUE = [
  {
    id: "qwen2.5-1.5b-instruct", name: "Qwen2.5 1.5B Instruct", family: "Qwen", developer: "Alibaba Qwen",
    params_b: 1.5, layers: 28, max_context: 32768, license: "apache-2.0", caps: ["chat", "fast"],
    repo: "bartowski/Qwen2.5-1.5B-Instruct-GGUF", quants: ["Q4_K_M"], vision: false,
    est_bytes: { Q4_K_M: 998579896 }, reference_tok_s: 0,
    licence: { id: "apache-2.0", known: true, label: "Apache 2.0", kind: "free", commercial_ok: true, says: "Use it for anything, including commercially. Keep the notice." },
  },
  {
    id: "qwen2.5-3b-instruct", name: "Qwen2.5 3B Instruct", family: "Qwen", developer: "Alibaba Qwen",
    params_b: 3, layers: 36, max_context: 32768, license: "qwen-research", caps: ["chat"],
    repo: "bartowski/Qwen2.5-3B-Instruct-GGUF", quants: ["Q4_K_M"], vision: false,
    est_bytes: { Q4_K_M: 1929379840 }, reference_tok_s: 0,
    licence: { id: "qwen-research", known: true, label: "Qwen Research", kind: "research", commercial_ok: false, says: "Research and evaluation only. Commercial use is not permitted by this licence." },
  },
  {
    id: "llama-3.2-3b", name: "Llama 3.2 3B", family: "Llama", developer: "Meta",
    params_b: 3, layers: 28, max_context: 131072, license: "llama-3.2", caps: ["chat"],
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", quants: ["Q4_K_M"], vision: false,
    est_bytes: { Q4_K_M: 2019377024 }, reference_tok_s: 0,
    licence: { id: "llama-3.2", known: true, label: "Llama 3.2 Community", kind: "conditions", commercial_ok: true, says: "Commercial use allowed. Attribution required, an acceptable-use policy applies, and a separate licence is needed above 700 million monthly users." },
  },
];

async function scenario(name, server, cfg, where, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: where, exact: true }).click();
  // The tier panel sits with the inference settings rather than on the
  // first page of them, so a Settings test has to go there.
  if (cfg.category) await page.getByRole("button", { name: cfg.category, exact: true }).click();
  try {
    await fn(page);
    assert.deepEqual(errs, [], "no uncaught page errors");
    results.push(true);
    console.log("PASS", name);
  } catch (e) {
    results.push(false);
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await serve();

  // ---- what this computer is ----

  await scenario("the measurements are shown, not only the verdict", server, { category: "Inference, appearance and updates" }, "Settings", async (page) => {
    const panel = page.locator(".tierpanel");
    await panel.waitFor();
    const text = await panel.innerText();
    assert.match(text, /free now/, "free memory, which is what a model loads into");
    assert.match(text, /8 cores/, "cores");
    assert.match(text, /Apple M3/, "the graphics it found");
    // Somebody who thinks the verdict is wrong can see which number produced it.
    assert.match(text, /shares the machine's memory/);
  });

  await scenario("a card whose memory is unknown says so rather than showing zero", server,
    { category: "Inference, appearance and updates", gpuKind: "amd", gpuName: "AMD Radeon RX 7900 XTX", vramGb: 0 }, "Settings", async (page) => {
      const panel = page.locator(".tierpanel");
      await panel.waitFor();
      // Zero would read as "it has none", which is a different machine.
      assert.match(await panel.innerText(), /memory unknown|shares the machine's memory/);
    });

  await scenario("the detected tier is marked, and another can be chosen", server, { category: "Inference, appearance and updates", tier: "small" }, "Settings", async (page) => {
    const tiers = page.locator(".tier");
    await tiers.first().waitFor();
    assert.equal(await tiers.count(), 4);
    // innerText gives the text as rendered, and the chip is uppercased by
    // the stylesheet.
    assert.match(await page.locator(".tier-detected").innerText(), /detected/i);
    assert.match(await page.locator(".tier.on").innerText(), /Small/, "the detected tier is the one chosen");

    await page.locator(".tier", { hasText: "Large" }).click();
    await page.waitForTimeout(200);
    assert.match(await page.locator(".tier.on").innerText(), /Large/, "the choice took");
    assert.match(await page.locator(".tierpanel").innerText(), /measures as Small/i,
      "and what was detected is still shown beside it");
  });

  await scenario("each tier says what it does rather than only naming itself", server, { category: "Inference, appearance and updates" }, "Settings", async (page) => {
    const text = await page.locator(".tiers").innerText();
    assert.match(text, /4,096 tokens/);
    assert.match(text, /32,768 tokens/);
    assert.match(text, /compressed cache/, "the memory saving is named where it applies");
  });

  await scenario("speed is not claimed until it is measured", server, { category: "Inference, appearance and updates" }, "Settings", async (page) => {
    const row = page.locator(".speedrow");
    await row.waitFor();
    assert.match(await row.innerText(), /not measured on this computer yet/);
    await page.getByRole("button", { name: "Measure it" }).click();
    await page.waitForTimeout(300);
    assert.match(await row.innerText(), /words a second, measured on this computer/);
  });

  await scenario("a card this build cannot use is named as such", server,
    { category: "Inference, appearance and updates", gpuKind: "nvidia", gpuName: "NVIDIA GeForce RTX 4090", vramGb: 24, accelerated: false }, "Settings", async (page) => {
      const panel = page.locator(".tierpanel");
      await panel.waitFor();
      const text = await panel.innerText();
      assert.match(text, /RTX 4090/);
      assert.match(text, /cannot use it/i, "rather than quietly running on the processor");
    });

  // ---- which models may be used ----

  await scenario("a research-only model is hidden from the library by default", server, { catalogue: CATALOGUE }, "Models", async (page) => {
    await page.locator(".mcard").first().waitFor();
    const names = (await page.locator(".mcard-name").allInnerTexts()).join("|");
    assert.match(names, /Qwen2\.5 1\.5B/);
    assert.doesNotMatch(names, /Qwen2\.5 3B/, "the research licence is filtered out");
    assert.match(await page.locator(".licence-hidden").innerText(), /1 model hidden/);
  });

  await scenario("the filter can be turned off, and then the licence is on the card", server, { catalogue: CATALOGUE }, "Models", async (page) => {
    await page.getByRole("button", { name: "Usable in a business" }).click();
    await page.waitForTimeout(200);
    const names = (await page.locator(".mcard-name").allInnerTexts()).join("|");
    assert.match(names, /Qwen2\.5 3B/, "now shown");
    const card = page.locator(".mcard", { hasText: "Qwen2.5 3B" });
    assert.match(await card.innerText(), /not for commercial use/);
  });

  await scenario("a licence with conditions is marked, not hidden", server, { catalogue: CATALOGUE }, "Models", async (page) => {
    const card = page.locator(".mcard", { hasText: "Llama 3.2 3B" });
    await card.waitFor();
    const text = await card.innerText();
    assert.match(text, /Llama 3\.2 Community/);
    assert.match(text, /conditions apply/, "usable, with something asked of you");
  });

  server.close();
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `\n${bad} of ${results.length} failed` : `\nall ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
