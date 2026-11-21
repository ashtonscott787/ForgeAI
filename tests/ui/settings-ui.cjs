// The settings page is a list of categories and one category at a time.
// Usage: pnpm build && node tests/ui/settings-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  try {
    await fn(page);
    assert.deepEqual(errs, [], "no uncaught page errors");
    results.push(true);
    console.log("PASS", name);
  } catch (e) {
    results.push(false);
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 5).join("\n    "));
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await serve();

  await scenario("every category is listed, and one of them is open", server, async (page) => {
    const nav = page.locator(".setnav");
    for (const c of ["Answering", "AI models", "Internet and search", "Email", "Files and documents",
                     "Sharing and privacy", "Agents and tools"]) {
      assert.equal(await nav.getByRole("button", { name: c, exact: true }).count(), 1, `${c} is listed`);
    }
    assert.equal(await page.locator(".setgroup").count(), 1, "exactly one category is shown at a time");
    assert.equal(await page.locator(".setcat.active").count(), 1, "and it is the one marked in the list");
  });

  await scenario("choosing a category swaps what is on the right", server, async (page) => {
    await page.getByRole("button", { name: "Email", exact: true }).click();
    const group = page.locator(".setgroup");
    assert.match(await group.getAttribute("aria-label"), /Email/);
    assert.ok(!(await group.innerText()).includes("Show its thinking"), "the previous category is gone");
    await page.getByRole("button", { name: "Answering", exact: true }).click();
    assert.match(await page.locator(".setgroup").innerText(), /Show its thinking/);
  });

  await scenario("the search narrows the list and opens what it finds", server, async (page) => {
    await page.getByLabel("Search settings").fill("privacy");
    const cats = page.locator(".setcat");
    assert.equal(await cats.count(), 1, "only the matching category is listed");
    assert.match(await page.locator(".setgroup").getAttribute("aria-label"), /Sharing and privacy/,
      "and it is opened rather than only listed");
  });

  await scenario("a search that matches nothing says so instead of emptying the page", server, async (page) => {
    await page.getByLabel("Search settings").fill("xyzzy");
    assert.equal(await page.locator(".setcat").count(), 0);
    assert.match(await page.locator(".setnone").innerText(), /Nothing matches/i);
    assert.equal(await page.locator(".setgroup").count(), 1, "the category that was open stays open");
  });

  await scenario("the current category is announced, not only coloured", server, async (page) => {
    const active = page.locator('.setcat[aria-current="page"]');
    assert.equal(await active.count(), 1);
    assert.match(await active.innerText(), /Answering/);
  });

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
