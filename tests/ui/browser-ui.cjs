// UI tests for the browser pane inside a chat, and the activity card on a turn.
// Usage: pnpm build && node tests/ui/browser-ui.cjs
// The <webview> tag only exists in Electron; in Chromium it renders as an inert
// unknown element, which is enough to test the pane's layout and controls.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

const SEEDED = [
  {
    id: "seed1",
    title: "Browser turn",
    updated: Date.now(),
    messages: [
      {
        role: "user",
        content: "What should I know from this page?",
        browser: {
          actions: [
            { kind: "opened", label: "Opened", detail: "example.com" },
            { kind: "read", label: "Read page text" },
          ],
          page: { title: "Example Domain", url: "https://example.com/x" },
        },
      },
      { role: "assistant", content: "It is a placeholder page.", model: "Test" },
    ],
  },
];

async function scenario(name, server, fn, { seed = false } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
  await page.addInitScript(BRIDGE);
  if (seed) {
    await page.addInitScript((list) => {
      localStorage.setItem("forge.conversations.v1", JSON.stringify(list));
    }, SEEDED);
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  try {
    await fn(page);
    assert.deepEqual(pageErrors, [], "no uncaught page errors");
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
    await page.screenshot({ path: `${process.env.TMPDIR || "/tmp"}/fail-${name.replace(/\W+/g, "_")}.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await serve();

  await scenario("The browser opens as a pane inside the chat", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await assert.equal(await page.locator(".chat-pane").count(), 0, "pane is closed to begin with");
    await page.getByRole("button", { name: "Open the browser" }).click();
    await page.waitForSelector(".chat-pane", { timeout: 4000 });
    assert.equal(await page.locator(".chat-split.withpane").count(), 1, "the split layout is applied");
    // The conversation is still on screen beside it.
    assert.ok(await page.locator('textarea[placeholder^="Ask anything"]').isVisible(), "the composer stays visible");
  });

  await scenario("A new tab starts on Google", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Open the browser" }).click();
    await page.waitForSelector(".chat-pane");
    const address = page.locator(".chat-pane .browser-address");
    assert.equal(await address.inputValue(), "https://www.google.com", "the address bar shows Google");
  });

  await scenario("The pane closes again, from the icon and from its own button", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Open the browser" }).click();
    await page.waitForSelector(".chat-pane");
    await page.getByRole("button", { name: "Close browser" }).click();
    await page.waitForSelector(".chat-pane", { state: "detached", timeout: 4000 });
    await page.getByRole("button", { name: "Open the browser" }).click();
    await page.waitForSelector(".chat-pane");
    await page.getByRole("button", { name: "Hide the browser" }).click();
    await page.waitForSelector(".chat-pane", { state: "detached", timeout: 4000 });
  });

  await scenario("A turn shows what the browser did, collapsed until asked", server, async (page) => {
    await page.locator(".conv", { hasText: "Browser turn" }).first().click();
    const card = page.locator(".bact");
    await card.waitFor({ timeout: 4000 });
    await page.getByRole("button", { name: /Used the browser \(2 actions\)/ }).waitFor();
    assert.equal(await page.locator(".bact-list").count(), 0, "the actions start collapsed");
    await page.getByRole("button", { name: /Used the browser/ }).click();
    await page.waitForSelector(".bact-list");
    const rows = await page.locator(".bact-row").allInnerTexts();
    assert.equal(rows.length, 2, "both actions are listed");
    assert.ok(rows.join(" ").includes("example.com"), "the address that was opened is named");
    assert.ok(rows.join(" ").includes("Read page text"), "reading the page is listed");
    // The page card names the page it ended on.
    assert.ok(await page.locator(".bact-title").innerText(), "the page card has a title");
  }, { seed: true });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
