// The agent configuration surface. Permissions are the security-critical part,
// so the tests are about what a tick does and what unticking takes away.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, fn, cfg = { local: true }) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, cfg);
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
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

  await scenario("A machine too small for an agent loop is warned, not left to find out", server, async (page) => {
    const warn = page.locator(".banner.warn");
    await warn.first().waitFor({ timeout: 4000 });
    assert.match(await warn.first().innerText(), /7B/, "it names what an agent loop actually needs");
  }, { local: true, usableGb: 5 });

  await scenario("A machine with room is not warned", server, async (page) => {
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".banner.warn").count(), 0, "no scare on a machine that can run it");
  }, { local: true, usableGb: 16 });

  await scenario("An agent is created with a name, a job and explicit permissions", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Bea");
    await page.getByLabel("What it is for").fill("handles supplier email");
    await page.getByLabel("Standing instructions").fill("Be brief. Never promise a delivery date.");
    await page.getByLabel("Search the web", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Bea" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /handles supplier email/);
    assert.match(await row.innerText(), /1 permission/, "exactly what was ticked, and no more");
  });

  await scenario("Nothing is pre-approved until it is ticked, and only changing tools offer it", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Carl");
    // A read-only tool never offers "without asking me": it never stops anyway.
    await page.getByLabel("Search the web", { exact: true }).check();
    assert.equal(await page.getByLabel("Allow Search the web without asking").count(), 0,
      "a read-only tool has nothing to pre-approve");
    // A changing tool does.
    await page.getByLabel("Create a reminder", { exact: true }).check();
    const pre = page.getByLabel("Allow Create a reminder without asking");
    await pre.waitFor({ timeout: 4000 });
    assert.equal(await pre.isChecked(), false, "it starts off, so the default is to ask");
  });

  await scenario("Unticking a permission takes its pre-approval with it", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Dot");
    await page.getByLabel("Create a reminder", { exact: true }).check();
    await page.getByLabel("Allow Create a reminder without asking").check();
    assert.equal(await page.getByLabel("Allow Create a reminder without asking").isChecked(), true);
    // Remove the permission, then grant it again: it must not come back pre-approved.
    await page.getByLabel("Create a reminder", { exact: true }).uncheck();
    await page.getByLabel("Create a reminder", { exact: true }).check();
    const pre = page.getByLabel("Allow Create a reminder without asking");
    await pre.waitFor({ timeout: 4000 });
    assert.equal(await pre.isChecked(), false, "granting a tool again does not restore a stale pre-approval");
  });

  await scenario("An agent with nothing ticked says so, rather than looking capable", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Empty");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Empty" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /0 permissions/);
  });

  await scenario("An agent carries an icon and a description, so it can be told apart", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Mail");
    await page.getByLabel("Description").fill("drafts replies to suppliers");
    const icons = page.locator(".iconopt");
    await icons.first().waitFor({ timeout: 4000 });
    await icons.nth(1).click();
    assert.equal(await icons.nth(1).getAttribute("aria-checked"), "true", "the chosen icon is marked");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Mail" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /drafts replies to suppliers/, "the description is what the list shows");
    assert.ok((await row.locator(".agenticon").innerText()).trim().length > 0, "and its icon");
  });

  await scenario("An agent can be duplicated without touching the original", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Bea");
    await page.getByLabel("Search the web", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".packrow", { hasText: "Bea" }).first().waitFor({ timeout: 4000 });
    await page.locator(".packrow", { hasText: "Bea" }).first().getByRole("button", { name: "Duplicate" }).click();
    await page.locator(".packrow", { hasText: "Bea copy" }).waitFor({ timeout: 4000 });
    assert.equal(await page.locator(".packrow").count(), 2, "the original is still there");
    assert.match(await page.locator(".packrow", { hasText: "Bea copy" }).innerText(), /1 permission/, "the copy keeps its permissions");
  });

  await scenario("An agent can be tested without it doing anything", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Tester");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".packrow", { hasText: "Tester" }).first().getByRole("button", { name: "Run" }).click();
    const test = page.getByRole("button", { name: "Test this agent" });
    await test.waitFor({ timeout: 4000 });
    assert.match(await test.getAttribute("title"), /without doing anything to your computer/);
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
