// Nothing may sit outside the window. A control that is off-screen is a
// control nobody can use, and it does not announce itself — these numbers do.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const WIDTHS = [700, 900, 1000, 1280, 1600];
const VIEWS = ["Chat", "Agents", "Models", "Memory", "Settings"];

async function check(page, width) {
  return page.evaluate((vw) => {
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > vw + 2) {
        bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`);
      }
    }
    return { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, bad: bad.slice(0, 5) };
  }, width);
}

async function scenario(name, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  try {
    await fn(browser);
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await serve();

  for (const width of WIDTHS) {
    await scenario(`Nothing sits outside a ${width}px window`, async (browser) => {
      const page = await (await browser.newContext({ viewport: { width, height: 860 } })).newPage();
      await page.addInitScript((c) => { window.__cfg = c; }, { local: true, usableGb: 16 });
      await page.addInitScript(BRIDGE);
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForSelector(".app");
      for (const view of VIEWS) {
        await page.getByRole("button", { name: view, exact: true }).click();
        await page.waitForTimeout(250);
        const r = await check(page, width);
        assert.deepEqual(r.bad, [], `${view} at ${width}px has elements past the right edge`);
        assert.ok(r.scrollW <= r.clientW + 2, `${view} at ${width}px scrolls sideways (${r.scrollW} > ${r.clientW})`);
      }
    });
  }

  await scenario("The model picker fits inside a narrow window", async (browser) => {
    const page = await (await browser.newContext({ viewport: { width: 700, height: 860 } })).newPage();
    await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
    await page.addInitScript(BRIDGE);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector(".app");
    const box = await page.locator(".pop").first().boundingBox();
    assert.ok(box, "the picker is in the document");
    assert.ok(box.x >= 0, `its left edge is on screen (${Math.round(box.x)})`);
    assert.ok(box.x + box.width <= 702, `its right edge is on screen (${Math.round(box.x + box.width)})`);
  });

  await scenario("The browser pane takes the width when both cannot fit", async (browser) => {
    const page = await (await browser.newContext({ viewport: { width: 700, height: 860 } })).newPage();
    await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
    await page.addInitScript(BRIDGE);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector(".app");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Open the browser" }).click();
    await page.waitForSelector(".chat-pane");
    const pane = await page.locator(".chat-pane").boundingBox();
    assert.ok(pane.width > 300, "the pane is usable rather than a sliver");
    assert.ok(pane.x + pane.width <= 702, "and it stays on screen");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
