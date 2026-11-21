// Screenshots of the real build, for looking at the interface rather than
// asserting on it. Usage: node tests/ui/shot.cjs <outdir> [view ...]
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");
const path = require("node:path");
const fs = require("node:fs");

const now = Date.now();
const SEED = [
  { id: "a", title: "Sourdough starter", updated: now - 1, messages: [
    { role: "user", content: "How do I feed a sourdough starter?" },
    { role: "assistant", content: "Equal weights of flour and water, once a day at room temperature.\n\n- 50g starter\n- 50g flour\n- 50g water", model: "Forge AI 2.6B" },
  ] },
  { id: "b", title: "Tax return", updated: now - 2, messages: [] },
  { id: "c", title: "Bike repair", updated: now - 3, messages: [] },
];

(async () => {
  const out = process.argv[2] || "/tmp/shots";
  const views = process.argv.slice(3);
  fs.mkdirSync(out, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
  await page.addInitScript(BRIDGE);
  await page.addInitScript((l) => localStorage.setItem("forge.conversations.v1", JSON.stringify(l)), SEED);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "chat.png") });
  for (const v of views) {
    const nav = page.locator(`nav button, .nav button, button`).filter({ hasText: new RegExp(`^${v}$`, "i") }).first();
    if (await nav.count()) {
      await nav.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, `${v.toLowerCase()}.png`) });
    } else {
      console.log(`(no nav button for ${v})`);
    }
  }
  console.log("wrote", out);
  await browser.close();
  server.close();
})();
