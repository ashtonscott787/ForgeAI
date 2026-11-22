// Where agents have been, drawn.
// Usage: pnpm build && node tests/ui/journeys-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, cfg, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Agents", exact: true }).click();
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

  await scenario("a curve is drawn for each journey that was actually made", server, {}, async (page) => {
    const links = page.locator(".ajlink");
    // Bea searched the web and read mail; Finn searched the web. Three trips.
    assert.equal(await links.count(), 3, "one curve per agent-and-place");
    const label = await page.locator(".ajsvg").getAttribute("aria-label");
    assert.match(label, /Bea to The web, 3 trips/);
    assert.match(label, /Finn to The web, 2 trips/);
  });

  await scenario("an agent that has been nowhere is not drawn as having been somewhere", server, {}, async (page) => {
    // Solo exists and has run nothing.
    const svg = await page.locator(".ajsvg").evaluate((el) => el.textContent || "");
    assert.ok(!svg.includes("Solo"), "an agent with no journeys is left out of the picture");
    assert.match(await page.locator(".amap-grid").innerText(), /Solo/, "but it is still listed in the counts");
  });

  await scenario("only the places that were visited appear", server, {}, async (page) => {
    const svg = await page.locator(".ajsvg").evaluate((el) => el.textContent || "");
    assert.match(svg, /The web/);
    assert.match(svg, /The desk/);
    assert.ok(!svg.includes("The publisher"), "nowhere nobody went");
    assert.ok(!svg.includes("The library"), "nor there");
  });

  await scenario("hovering a curve says in words what it means", server, {}, async (page) => {
    await page.locator(".ajlink").first().hover();
    const said = await page.locator(".ajsay").innerText();
    assert.match(said, /went to the web 3 times/i);
    assert.match(said, /web_search/, "and names the tools it used there");
  });

  await scenario("it says plainly that agents do not talk to each other", server, {}, async (page) => {
    assert.match(await page.locator(".ajsay").innerText(), /never contact each other/i);
  });

  await scenario("with nothing recorded it explains itself instead of drawing an empty chart", server,
    { agentEvents: 0 }, async (page) => {
      assert.equal(await page.locator(".ajsvg").count(), 0, "no picture at all");
    });

  await scenario("the stage replays what was recorded, as bubbles that travel", server, {}, async (page) => {
    const stage = page.locator(".stage");
    await stage.waitFor();
    // Nothing flies on arrival: a page that opens with a burst of old traffic
    // would be claiming it is happening now.
    assert.equal(await page.locator(".stage-bubble").count(), 0, "nothing is in flight on arrival");
    await page.getByRole("button", { name: "Replay the last run" }).click();
    await page.locator(".stage-bubble").first().waitFor({ timeout: 4000 });
    const text = await page.locator(".stage-bubble").first().innerText();
    assert.match(text, /Bea/, "the bubble says who is moving");
    assert.match(text, /web search|read email/, "and what it was doing");
  });

  await scenario("a failed step is marked as failed, not drawn as success", server, {}, async (page) => {
    await page.getByRole("button", { name: "Replay the last run" }).click();
    await page.waitForTimeout(1200);
    // Bea's read_email failed in the recorded history.
    assert.ok(await page.locator(".stage-bubble.failed").count() >= 1, "the failure is visibly a failure");
  });

  await scenario("it says agents never travel to each other", server, {}, async (page) => {
    assert.match(await page.locator(".stage-note").innerText(), /never contact each other/i);
  });

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
