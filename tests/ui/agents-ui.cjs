// The agent configuration surface. Permissions are the security-critical part,
// so the tests are about what a tick does and what unticking takes away.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

/** The agent editor, so a label cannot match a field in another view. */
const editor = (page) => page.getByLabel("Agent settings");

async function scenario(name, server, fn, cfg = { local: true }) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, cfg);
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  // The starting screen is held for about a second and covers the window, so
  // waiting for the app element alone is not waiting for the app to be usable.
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
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
    await editor(page).getByLabel("Name", { exact: true }).fill("Bea");
    await editor(page).getByLabel("What it is for").fill("handles supplier email");
    await editor(page).getByLabel("Standing instructions").fill("Be brief. Never promise a delivery date.");
    await editor(page).getByLabel("Search the web", { exact: true }).check();
    await editor(page).getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Bea" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /handles supplier email/);
    assert.match(await row.innerText(), /1 permission/, "exactly what was ticked, and no more");
  });

  await scenario("Nothing is pre-approved until it is ticked, and only changing tools offer it", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Carl");
    // A read-only tool never offers "without asking me": it never stops anyway.
    await editor(page).getByLabel("Search the web", { exact: true }).check();
    assert.equal(await editor(page).getByLabel("Allow Search the web without asking").count(), 0,
      "a read-only tool has nothing to pre-approve");
    // A changing tool does.
    await editor(page).getByLabel("Create a reminder", { exact: true }).check();
    const pre = editor(page).getByLabel("Allow Create a reminder without asking");
    await pre.waitFor({ timeout: 4000 });
    assert.equal(await pre.isChecked(), false, "it starts off, so the default is to ask");
  });

  await scenario("Unticking a permission takes its pre-approval with it", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Dot");
    await editor(page).getByLabel("Create a reminder", { exact: true }).check();
    await editor(page).getByLabel("Allow Create a reminder without asking").check();
    assert.equal(await editor(page).getByLabel("Allow Create a reminder without asking").isChecked(), true);
    // Remove the permission, then grant it again: it must not come back pre-approved.
    await editor(page).getByLabel("Create a reminder", { exact: true }).uncheck();
    await editor(page).getByLabel("Create a reminder", { exact: true }).check();
    const pre = editor(page).getByLabel("Allow Create a reminder without asking");
    await pre.waitFor({ timeout: 4000 });
    assert.equal(await pre.isChecked(), false, "granting a tool again does not restore a stale pre-approval");
  });

  await scenario("An agent with nothing ticked says so, rather than looking capable", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Empty");
    await editor(page).getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Empty" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /0 permissions/);
  });

  await scenario("An agent carries an icon and a description, so it can be told apart", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Mail");
    await editor(page).getByLabel("Description").fill("drafts replies to suppliers");
    const icons = editor(page).locator(".iconopt");
    await icons.first().waitFor({ timeout: 4000 });
    await icons.nth(1).click();
    assert.equal(await icons.nth(1).getAttribute("aria-checked"), "true", "the chosen icon is marked");
    await editor(page).getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator(".packrow", { hasText: "Mail" });
    await row.waitFor({ timeout: 4000 });
    assert.match(await row.innerText(), /drafts replies to suppliers/, "the description is what the list shows");
    assert.ok((await row.locator(".agenticon").innerText()).trim().length > 0, "and its icon");
  });

  await scenario("An agent can be duplicated without touching the original", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Bea");
    await editor(page).getByLabel("Search the web", { exact: true }).check();
    await editor(page).getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".packrow", { hasText: "Bea" }).first().waitFor({ timeout: 4000 });
    await page.locator(".packrow", { hasText: "Bea" }).first().getByRole("button", { name: "Duplicate" }).click();
    await page.locator(".packrow", { hasText: "Bea copy" }).waitFor({ timeout: 4000 });
    assert.equal(await page.locator(".packrow").count(), 2, "the original is still there");
    assert.match(await page.locator(".packrow", { hasText: "Bea copy" }).innerText(), /1 permission/, "the copy keeps its permissions");
  });

  await scenario("An agent can be tested without it doing anything", server, async (page) => {
    await page.getByRole("button", { name: "New agent" }).click();
    await editor(page).getByLabel("Name", { exact: true }).fill("Tester");
    await editor(page).getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".packrow", { hasText: "Tester" }).first().getByRole("button", { name: "Run" }).click();
    const test = page.getByRole("button", { name: "Test this agent" });
    await test.waitFor({ timeout: 4000 });
    assert.match(await test.getAttribute("title"), /without doing anything to your computer/);
  });

  await scenario("The map shows what each agent has done, and marks failures", server, async (page) => {
    const map = page.locator(".view.active .amap");
    await map.waitFor({ timeout: 5000 });
    assert.equal(await map.locator(".anode").count(), 3, "every agent is drawn");
    const bea = map.locator(".anode", { hasText: "Bea" });
    assert.match(await bea.innerText(), /2 runs · 5 actions/);
    assert.match(await bea.innerText(), /1 waited for you/, "waiting is its own number");
    assert.match(await bea.innerText(), /1 failed/);
    assert.equal(await map.locator(".anode.hasfail").count(), 1, "only the one with a failure is marked");
    assert.match(await map.locator(".anode", { hasText: "Solo" }).innerText(), /Has not run yet/);
  });

  await scenario("Lines between agents are shared permissions, and say so", server, async (page) => {
    const map = page.locator(".view.active .amap");
    await map.waitFor({ timeout: 5000 });
    const legend = await map.locator(".amap-legend").innerText();
    // Agents never contact each other; the picture must not imply they do.
    assert.match(legend, /do\s+not talk to each other/i);
    assert.match(legend, /run one at a time/i);
    assert.match(await map.locator(".amap-links li").first().innerText(), /shared permission/);
  });

  await scenario("The feed shows recent actions, newest first, with failures marked", server, async (page) => {
    const feed = page.locator(".view.active .amap-feed");
    await feed.waitFor({ timeout: 5000 });
    const items = await feed.locator("li").allInnerTexts();
    assert.match(items[0], /read email/, "newest first");
    assert.equal(await feed.locator("li.bad").count(), 1, "the failed one is marked");
    assert.match(items[0], /no account set up/, "and says why");
  });

  await scenario("With no agents, the map says so instead of drawing nothing", server, async (page) => {
    const map = page.locator(".view.active .amap");
    await map.waitFor({ timeout: 5000 });
    assert.match(await map.innerText(), /No agents yet/);
    assert.equal(await map.locator(".anode").count(), 0);
  }, { local: true, agentEvents: 0 });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
