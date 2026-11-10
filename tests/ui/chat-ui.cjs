// UI tests for finding a chat again, and asking the last question again.
// Usage: pnpm build && node tests/ui/chat-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const now = Date.now();
const conv = (id, title, msgs, age) => ({ id, title, updated: now - age, messages: msgs });
const SEED = [
  conv("a", "Sourdough starter", [
    { role: "user", content: "How do I feed a sourdough starter?" },
    { role: "assistant", content: "Equal weights of flour and water.", model: "Test" },
  ], 1),
  conv("b", "Tax return", [
    { role: "user", content: "When is the tax return due?" },
    { role: "assistant", content: "It depends on your country.", model: "Test" },
  ], 2),
  conv("c", "Bike repair", [
    { role: "user", content: "My derailleur is rubbing." },
    { role: "assistant", content: "Check the limit screws.", model: "Test" },
  ], 3),
  conv("d", "Holiday plan", [
    { role: "user", content: "Where should I go in March?" },
    { role: "assistant", content: "Somewhere with sourdough bakeries.", model: "Test" },
  ], 4),
];

async function scenario(name, server, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
  await page.addInitScript(BRIDGE);
  await page.addInitScript((l) => localStorage.setItem("forge.conversations.v1", JSON.stringify(l)), SEED);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  try {
    await fn(page);
    assert.deepEqual(pageErrors, [], "no uncaught page errors");
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

  await scenario("Chats can be found by their title", server, async (page) => {
    assert.equal(await page.locator(".conv").count(), 4, "all four chats are listed");
    await page.getByLabel("Search chats").fill("bike");
    await page.waitForFunction(() => document.querySelectorAll(".conv").length === 1);
    assert.ok((await page.locator(".conv").first().innerText()).includes("Bike"), "the bike chat is the one left");
  });

  await scenario("Chats can be found by something said inside them", server, async (page) => {
    // "sourdough" is in one title and in another chat's reply, so both should match.
    await page.getByLabel("Search chats").fill("sourdough");
    await page.waitForFunction(() => document.querySelectorAll(".conv").length === 2);
    const titles = (await page.locator(".conv").allInnerTexts()).join(" ");
    assert.ok(titles.includes("Sourdough starter"), "the title match is listed");
    assert.ok(titles.includes("Holiday plan"), "the chat whose reply mentions it is listed too");
  });

  await scenario("A search that matches nothing empties the list rather than ignoring it", server, async (page) => {
    await page.getByLabel("Search chats").fill("zzzznothing");
    await page.waitForFunction(() => document.querySelectorAll(".conv").length === 0);
  });

  await scenario("The last answer can be asked for again, without repeating the question", server, async (page) => {
    await page.locator(".conv", { hasText: "Bike repair" }).first().click();
    await page.getByRole("button", { name: "Regenerate" }).waitFor({ timeout: 4000 });
    await page.getByRole("button", { name: "Regenerate" }).click();
    // The question is asked again from before it, so it must not appear twice.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".msg.user")).filter((m) => m.textContent.includes("derailleur")).length === 1,
      null,
      { timeout: 5000 },
    );
    const users = await page.locator(".msg.user").count();
    assert.equal(users, 1, "the question still appears exactly once");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
