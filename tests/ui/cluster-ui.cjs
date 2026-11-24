// Linking computers together, and making a model from one you already have.
// Usage: pnpm build && node tests/ui/cluster-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, cfg, where, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: where, exact: true }).click();
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

(async () => {
  const server = await serve();

  // ---- more than one computer ----

  await scenario("it explains what a cluster is for before asking for anything", server, {}, "Systems", async (page) => {
    const panel = page.locator(".panel", { hasText: "More than one computer" });
    await panel.waitFor();
    const text = await panel.innerText();
    assert.match(text, /split across machines/i);
    assert.match(text, /larger model than/i, "it says what is gained");
  });

  await scenario("a machine is added, checked, and the one that did not answer says why", server, {}, "Systems", async (page) => {
    await page.getByLabel("Address of another computer").fill("studio.local:50052");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Address of another computer").fill("asleep.local:50052");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Check them" }).click();
    const rows = page.locator(".peer");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).innerText(), /answered in \d+ms/);
    assert.match(await rows.nth(1).innerText(), /nothing is listening/);
  });

  await scenario("an address that is not an address is refused, not stored", server, {}, "Systems", async (page) => {
    await page.getByLabel("Address of another computer").fill("not a host!!");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const said = page.locator(".connect-said");
    await said.waitFor();
    assert.match(await said.innerText(), /is not an address/i);
    assert.equal(await page.locator(".peer").count(), 0, "nothing was added");
  });

  await scenario("lending this machine warns that there is no password on it", server, {}, "Systems", async (page) => {
    const panel = page.locator(".panel", { hasText: "More than one computer" });
    const text = await panel.innerText();
    assert.match(text, /no password/i, "the warning is next to the switch");
    assert.match(text, /cannot read your chats/i, "and it says what the worker cannot see");
  });

  await scenario("the worker offers this computer only until a network address is chosen", server, {}, "Systems", async (page) => {
    const select = page.getByLabel("Listen on");
    assert.match(await select.inputValue(), /127\.0\.0\.1/, "loopback is the default");
    const options = await select.locator("option").allInnerTexts();
    assert.ok(options.some((o) => /this computer only/i.test(o)));
    assert.ok(options.some((o) => /192\.168\.1\.42/.test(o)), "the real network address is offered as a choice");
    assert.ok(!options.some((o) => /0\.0\.0\.0/.test(o)), "every interface is not a choice in the list");
  });

  await scenario("lending starts and stops, and says where to point the other machine", server, {}, "Systems", async (page) => {
    await page.getByRole("button", { name: "Start lending" }).click();
    const said = page.locator(".connect-said");
    await said.waitFor();
    assert.match(await said.innerText(), /127\.0\.0\.1:50052/, "it gives the address to type on the other computer");
    await page.getByRole("button", { name: "Stop lending" }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("button", { name: "Start lending" }).count(), 1);
  });

  await scenario("a build with no worker in it says so instead of offering the feature", server, { noWorker: true }, "Systems", async (page) => {
    const panel = page.locator(".panel", { hasText: "More than one computer" });
    await panel.waitFor();
    assert.match(await panel.innerText(), /built without the worker/i);
    assert.equal(await page.getByRole("button", { name: "Start lending" }).count(), 0);
  });

  // ---- making a model ----

  await scenario("the workshop says it is not training before anything else", server, {}, "Models", async (page) => {
    const panel = page.locator(".panel", { hasText: "Make your own model" });
    await panel.waitFor();
    const text = await panel.innerText();
    assert.match(text, /does not train a model/i);
    assert.match(text, /cannot teach one to write like you/i);
  });

  await scenario("a name is suggested from the model and the format, and can be overridden", server, {}, "Models", async (page) => {
    const name = page.getByLabel("Name for the new model");
    await name.waitFor();
    assert.match(await name.inputValue(), /Q4_K_M\.gguf$/, "named after the format it will be stored as");
    await name.fill("my-own-model");
    await page.getByLabel("Store it as").selectOption("Q6_K");
    await page.waitForTimeout(150);
    assert.equal(await name.inputValue(), "my-own-model", "a typed name is not overwritten");
  });

  await scenario("each format says what it costs", server, {}, "Models", async (page) => {
    const panel = page.locator(".panel", { hasText: "Make your own model" });
    assert.match(await panel.innerText(), /About half the size/i);
    await page.getByLabel("Store it as").selectOption("Q6_K");
    await page.waitForTimeout(100);
    assert.match(await panel.innerText(), /indistinguishable/i);
  });

  await scenario("a running job can be watched and stopped", server, {}, "Models", async (page) => {
    await page.getByRole("button", { name: "Make it" }).click();
    const panel = page.locator(".panel", { hasText: "Make your own model" });
    await page.getByRole("button", { name: "Stop" }).waitFor();
    assert.match(await panel.innerText(), /so far/, "it says how long it has been going");
    assert.match(await panel.innerText(), /quantizing/, "the tool's own output is shown");
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Make it" }).waitFor();
  });

  await scenario("an adapter in the wrong format is refused with the reason", server, {}, "Models", async (page) => {
    await page.getByRole("tab", { name: "Bake in an adapter" }).click();
    await page.getByLabel("Path to the adapter file").fill("/tmp/adapter.safetensors");
    await page.getByLabel("Name for the new model").fill("combined");
    await page.getByRole("button", { name: "Combine them" }).click();
    const bad = page.locator(".sheet-bad");
    await bad.waitFor();
    assert.match(await bad.innerText(), /has to be a \.gguf file/i);
  });

  server.close();
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `\n${bad} of ${results.length} failed` : `\nall ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
