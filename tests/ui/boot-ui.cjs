// The starting screen. It reports stages that actually happen, so the test
// checks it clears once the work is done rather than after a fixed time.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, cfg, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  try {
    await fn(page);
    assert.deepEqual(errs, [], "no uncaught page errors");
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 5).join("\n    "));
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await serve();

  await scenario("The starting screen appears and then clears once the app is ready", server, { slowBoot: 900 }, async (page) => {
    const boot = page.getByLabel("Starting Forge AI");
    await boot.waitFor({ timeout: 4000 });
    assert.match(await boot.innerText(), /Forge AI/);
    assert.match(await boot.innerText(), /runs on this computer/, "it says what the app is while you wait");
    // It must go away on its own when the real work finishes.
    await page.waitForSelector(".app", { timeout: 8000 });
    assert.equal(await page.locator(".boot").count(), 0, "the screen clears itself");
  });

  await scenario("It names the stage it is on, not a percentage", server, { slowBoot: 1500 }, async (page) => {
    const boot = page.getByLabel("Starting Forge AI");
    await boot.waitFor({ timeout: 4000 });
    const text = await boot.innerText();
    for (const stage of ["Reading your settings", "Looking at this machine", "Finding your models"]) {
      assert.ok(text.includes(stage), `${stage} is listed`);
    }
    assert.ok(!/\d+\s*%/.test(text), "no invented percentage");
    await page.waitForSelector(".app", { timeout: 10000 });
  });

  await scenario("It marks the current stage, and ticks the ones that are done", server, { slowBoot: 1200 }, async (page) => {
    await page.getByLabel("Starting Forge AI").waitFor({ timeout: 4000 });
    await page.waitForFunction(() => document.querySelectorAll(".boot-stages li.done").length >= 1, null, { timeout: 8000 });
    assert.equal(await page.locator(".boot-stages li.now").count(), 1, "exactly one stage is current");
    await page.waitForSelector(".app", { timeout: 10000 });
  });

  await scenario("A startup step that fails does not stop the app opening", server, { bootFails: true }, async (page) => {
    // Each startup call has its own catch, so hardware detection failing
    // degrades rather than blocks — the app opens without that information
    // instead of stranding someone on a screen that cannot finish.
    await page.waitForSelector(".app", { timeout: 8000 });
    assert.equal(await page.locator(".boot").count(), 0, "the starting screen cleared");
    assert.ok(await page.locator('textarea[placeholder^="Ask anything"]').count() >= 1, "and the app is usable");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
