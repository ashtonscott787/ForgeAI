// Seeing what is in the context window, compacting a chat by hand, keeping
// work apart in workspaces, and the branching picture of a run.
// Usage: pnpm build && node tests/ui/context-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const now = Date.now();

/** A chat long enough to be worth compacting. */
const long = (n, word) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `${word} turn ${i}. ${"filler ".repeat(40)}`,
    ...(i % 2 ? { model: "Test" } : {}),
  }));

const SEED = [
  { id: "a", title: "Kitchen rebuild", updated: now - 1, messages: long(20, "kitchen") },
  { id: "b", title: "Short one", updated: now - 2, messages: long(2, "short") },
  { id: "c", title: "Quarterly numbers", updated: now - 3, space: "work", messages: long(4, "numbers") },
];

async function scenario(name, server, cfg, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.addInitScript((l) => localStorage.setItem("forge.conversations.v1", JSON.stringify(l)), SEED);
  if (cfg.spaces) {
    await page.addInitScript((l) => localStorage.setItem("forge.spaces.v1", JSON.stringify(l)), cfg.spaces);
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  try {
    await fn(page);
    assert.deepEqual(errs, [], "no uncaught page errors");
    results.push(true);
    console.log("PASS", name);
  } catch (e) {
    results.push(false);
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
  } finally {
    await browser.close();
  }
}

const WORK = [{ id: "work", name: "Work", accent: "#3f6fb4" }];

(async () => {
  const server = await serve();

  // ---- the context window ----

  await scenario("the window shows how full it is without being opened", server, {}, async (page) => {
    const ctx = page.locator(".ctx");
    await ctx.waitFor();
    assert.match(await ctx.innerText(), /% used/, "a percentage is on screen at a glance");
    assert.ok(await page.locator(".ctx-bar .ctx-seg").count() > 0, "and the bar is drawn in parts");
  });

  await scenario("opening it names every part and what is left", server, { memories: ["Ash runs a joinery"] }, async (page) => {
    await page.locator(".ctx-head").click();
    const rows = page.locator(".ctx-rows");
    await rows.waitFor();
    const text = await rows.innerText();
    for (const part of ["Messages", "House rules", "Memory", "Skills", "Attachments", "Free space"]) {
      assert.match(text, new RegExp(part), `${part} is named`);
    }
  });

  await scenario("it says the numbers are estimates when no engine is running", server, {}, async (page) => {
    await page.locator(".ctx-head").click();
    const how = page.locator(".ctx-how");
    await how.waitFor();
    assert.match(await how.innerText(), /estimated/i, "nobody is told a guess is a measurement");
  });

  await scenario("compacting is offered on a long chat and refused on a short one", server, {}, async (page) => {
    await page.locator(".ctx-head").click();
    const button = page.getByRole("button", { name: "Compact this chat" });
    await button.waitFor();
    assert.equal(await button.isDisabled(), false, "the long chat can be compacted");

    // The panel stays open across chats, so it is not clicked again here.
    await page.locator(".conv", { hasText: "Short one" }).click();
    await page.getByRole("button", { name: "Compact this chat" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Compact this chat" }).isDisabled(), true);
    assert.match(await page.locator(".ctx").innerText(), /too short/i, "and it says why");
  });

  await scenario("compacting with no engine changes nothing and says so", server, {}, async (page) => {
    await page.locator(".ctx-head").click();
    await page.getByRole("button", { name: "Compact this chat" }).click();
    const err = page.locator(".banner.err");
    await err.waitFor();
    assert.match(await err.innerText(), /engine has to be running/i);
    assert.equal(await page.locator(".msg").count() > 10, true, "the conversation is untouched");
  });

  // ---- workspaces ----

  await scenario("the sidebar lists only the chats of the workspace in view", server, { spaces: WORK }, async (page) => {
    const titles = async () => (await page.locator(".conv-t").allInnerTexts()).join("|");
    assert.match(await titles(), /Kitchen rebuild/);
    assert.doesNotMatch(await titles(), /Quarterly numbers/, "the work chat is not in Personal");

    await page.locator(".space-now").click();
    await page.getByRole("menuitem", { name: /Work/ }).click();
    await page.waitForTimeout(100);
    assert.match(await titles(), /Quarterly numbers/);
    assert.doesNotMatch(await titles(), /Kitchen rebuild/, "and the personal chats are not in Work");
  });

  await scenario("a new workspace can be made and starts empty", server, {}, async (page) => {
    await page.locator(".space-now").click();
    await page.getByRole("button", { name: "New workspace" }).click();
    await page.getByLabel("Name for the new workspace").fill("Studio");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(150);
    assert.match(await page.locator(".space-now").innerText(), /Studio/);
    assert.equal(await page.locator(".conv").count(), 0, "nothing carried over from Personal");
  });

  await scenario("it does not pretend a workspace is private", server, {}, async (page) => {
    await page.locator(".space-now").click();
    const note = page.locator(".space-note");
    await note.waitFor();
    const text = await note.innerText();
    assert.match(text, /not a lock/i);
    assert.match(text, /shared across all of them/i, "and says what is not separated");
  });

  await scenario("a chat started in a workspace stays in it", server, { spaces: WORK }, async (page) => {
    await page.locator(".space-now").click();
    await page.getByRole("menuitem", { name: /Work/ }).click();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "New chat" }).click();
    await page.locator(".space-now").click();
    await page.getByRole("menuitem", { name: /Personal/ }).click();
    await page.waitForTimeout(100);
    const titles = (await page.locator(".conv-t").allInnerTexts()).join("|");
    assert.doesNotMatch(titles, /Quarterly numbers/, "nothing from Work leaked into Personal");
  });

  // ---- the run, drawn as branches ----

  await scenario("the run is drawn as a line with branches off it", server, {}, async (page) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const wg = page.locator(".wg-svg");
    await wg.waitFor();
    assert.equal(await page.locator(".wg-trunk").count(), 1, "one line carrying on");
    assert.ok(await page.locator(".wg-branch").count() >= 2, "and a branch for each recorded step");
    assert.equal(await page.locator(".wg-branch.failed").count(), 1, "the step that failed is marked as such");
    assert.match(await page.locator(".wg").innerText(), /web search/, "labelled with the tool it used");
  });

  await scenario("with nothing recorded it draws nothing and says so", server, { agentEvents: 0 }, async (page) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".wg-svg").count(), 0, "no picture of a run that did not happen");
  });

  server.close();
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `\n${bad} of ${results.length} failed` : `\nall ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
