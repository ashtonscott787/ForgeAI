// The Systems view. Its value is that it distinguishes four states, so the
// tests are mostly about not flattening them into a red or green dot.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  // The starting screen is held for about a second and covers the window, so
  // waiting for the app element alone is not waiting for the app to be usable.
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Systems", exact: true }).click();
  await page.waitForSelector(".view.active .sysmap", { timeout: 5000 });
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

  await scenario("Everything checked is drawn, grouped by where it lives", server, async (page) => {
    const view = page.locator(".view.active");
    assert.equal(await view.locator(".sysrow").count(), 10, "every row is drawn");
    const groups = await view.locator(".sysgroup-name").allInnerTexts();
    assert.deepEqual(groups, ["THIS COMPUTER", "PRIVATE MESH", "SHARING", "EMAIL", "SEARCH"]);
  });

  await scenario("Off, not set up and failed are shown as three different things", server, async (page) => {
    const view = page.locator(".view.active");
    assert.equal(await view.locator(".sysrow.failed").count(), 1, "one thing is broken");
    assert.equal(await view.locator(".sysrow.off").count(), 2, "two are switched off");
    assert.equal(await view.locator(".sysrow.not_set_up").count(), 1, "one was never set up");
    // The difference matters: an endpoint that is off is not a fault.
    assert.match(await view.locator(".sysrow.off").first().innerText(), /off/);
    assert.match(await view.locator(".sysrow.not_set_up").first().innerText(), /not set up/);
  });

  await scenario("A measured time is shown for things that were actually probed", server, async (page) => {
    const view = page.locator(".view.active");
    assert.match(await view.locator(".sysrow.connected").first().innerText(), /\d+ ms/, "a real latency");
    assert.match(await view.locator(".sysrow.failed").innerText(), /2585 ms/, "including for the one that failed");
  });

  await scenario("The headline reports the failure rather than the successes", server, async (page) => {
    const bar = page.locator(".view.active .sysbar");
    assert.match(await bar.innerText(), /1 not working/, "four connected does not round up to fine");
    assert.equal(await bar.locator(".sysdot.failed").count(), 1);
  });

  await scenario("The reason a check failed is given, not just the fact", server, async (page) => {
    assert.match(await page.locator(".view.active .sysnotes").innerText(), /ECONNREFUSED/);
  });

  await scenario("Checking can be turned off, and done once on demand", server, async (page) => {
    const view = page.locator(".view.active");
    const toggle = view.getByLabel("Keep checking");
    assert.equal(await toggle.isChecked(), true, "it is live by default");
    await toggle.uncheck();
    assert.equal(await toggle.isChecked(), false);
    const before = (await page.evaluate(() => window.__calls.filter((c) => c.cmd === "system_status"))).length;
    await view.getByRole("button", { name: "Check now" }).click();
    await page.waitForFunction(
      (n) => window.__calls.filter((c) => c.cmd === "system_status").length > n,
      before, { timeout: 4000 },
    );
  });

  await scenario("The security check states what it does not look at", server, async (page) => {
    const sec = page.locator(".view.active .syssec");
    await sec.waitFor({ timeout: 5000 });
    const text = await sec.innerText();
    assert.match(text, /not an antivirus/, "it refuses to be mistaken for one");
    assert.match(text, /does not scan your operating system or your network/);
    assert.match(text, /2 things worth looking at/);
  });

  await scenario("A finding can be taken into the chat to work on", server, async (page) => {
    const sec = page.locator(".view.active .syssec");
    await sec.waitFor();
    assert.equal(await sec.locator(".findrow.high").count(), 1, "the serious one is marked");
    await sec.getByRole("button", { name: "Work on this" }).first().click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((t) => t.value.includes("security check found this")),
      null, { timeout: 5000 },
    );
    const box = await page.locator('textarea[placeholder^="Ask anything"]').inputValue();
    assert.match(box, /no access token/, "the finding came with it");
    assert.match(box, /If it does not matter much for a single-user machine, say so/, "and permission to say it is minor");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
