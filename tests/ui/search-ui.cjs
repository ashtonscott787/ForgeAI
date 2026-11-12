// Internet search in the chat, and configuring it in Settings.
// The failure path matters most: a search that did not run must never read as
// a search that found nothing.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const F = "```";
const SEARCH_REPLY = ["Let me check that.", "", F + "forge-search", '{"query":"steel prices 2026"}', F].join("\n");

const seed = (assistant) => ([{
  id: "q1", title: "Search", updated: Date.now(),
  messages: [{ role: "user", content: "what are steel prices" }, { role: "assistant", content: assistant, model: "Test" }],
}]);

async function scenario(name, server, cfg, fn, convo = seed(SEARCH_REPLY)) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.addInitScript((l) => localStorage.setItem("forge.conversations.v1", JSON.stringify(l)), convo);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
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

  await scenario("A search shows its sources as real, clickable citations", server, {}, async (page) => {
    await page.locator(".conv", { hasText: "Search" }).first().click();
    await page.waitForSelector(".searchcard-list", { timeout: 6000 });
    const items = await page.locator(".searchcard-list li").allInnerTexts();
    assert.equal(items.length, 2, "both results are listed");
    assert.match(items[0], /\[1\] Forge AI/, "citations are numbered so the model can refer to them");
    assert.match(items[0], /en\.wikipedia\.org/, "the host is shown, so a source can be judged");
    assert.match(items[1], /example\.com/);
    assert.match(await page.locator(".searchcard-h").innerText(), /2 results · Brave Search/);
  });

  await scenario("Clicking a citation opens it outside the app", server, {}, async (page) => {
    await page.locator(".conv", { hasText: "Search" }).first().click();
    await page.waitForSelector(".searchcard-list");
    await page.locator(".searchcard-title").first().click();
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "open_external"));
    assert.equal(calls.length, 1, "the link was opened");
    assert.equal(calls[0].args.url, "https://en.wikipedia.org/wiki/Forge_AI");
  });

  await scenario("A search that did not run says so, and is not mistaken for no results", server,
    { searchFails: true }, async (page) => {
      await page.locator(".conv", { hasText: "Search" }).first().click();
      await page.waitForSelector(".searchcard-fail", { timeout: 6000 });
      const text = await page.locator(".searchcard-fail").innerText();
      assert.match(text, /refused the key/);
      assert.match(text, /Settings/, "it says where to fix it");
      assert.match(await page.locator(".searchcard-h").innerText(), /did not run/);
      assert.equal(await page.locator(".searchcard-list").count(), 0, "no results are shown");
    });

  await scenario("A search that found nothing says that, which is a different thing", server,
    { searchEmpty: true }, async (page) => {
      await page.locator(".conv", { hasText: "Search" }).first().click();
      await page.waitForSelector(".searchcard", { timeout: 6000 });
      await page.waitForFunction(() => document.body.innerText.includes("returned no results"), null, { timeout: 5000 });
      assert.equal(await page.locator(".searchcard-fail").count(), 0, "it is not reported as a failure");
    });

  await scenario("Each engine says what it needs, and one that is not set up is marked", server, {}, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panel = page.getByLabel("Internet search");
    await panel.waitFor({ timeout: 5000 });
    const rows = await panel.locator(".permrow").allInnerTexts();
    assert.equal(rows.length, 4, "every engine is listed");
    assert.match(rows.find((r) => r.includes("Wikipedia")), /no key needed/);
    assert.match(rows.find((r) => r.includes("SearXNG")), /needs an address/);
    assert.match(rows.find((r) => r.includes("Brave")), /needs your key/);
    assert.match(rows.find((r) => r.includes("Brave")), /not set up/, "an engine that cannot run yet is marked");
  });

  await scenario("Choosing SearXNG asks for its address", server, {}, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panel = page.getByLabel("Internet search");
    await panel.waitFor();
    assert.equal(await panel.getByLabel("SearXNG address").count(), 0, "not shown until it is chosen");
    await panel.getByLabel("SearXNG", { exact: true }).check();
    await panel.getByLabel("SearXNG address").waitFor({ timeout: 4000 });
  });

  await scenario("A key is only kept once a real search has accepted it", server, {}, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panel = page.getByLabel("Internet search");
    await panel.waitFor();
    await panel.getByLabel("Brave Search", { exact: true }).check();
    await panel.getByLabel("Brave Search API key").fill("short");
    await panel.getByRole("button", { name: /Save key|Checking/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Not saved"), null, { timeout: 5000 });
    // A plausible key is accepted, and says what the test search returned.
    await panel.getByLabel("Brave Search API key").fill("a-long-enough-key-123456");
    await panel.getByRole("button", { name: /Save key|Checking/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("test search returned"), null, { timeout: 5000 });
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
