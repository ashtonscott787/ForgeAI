// Adding another tool over MCP, from the settings page.
// Usage: pnpm build && node tests/ui/mcp-ui.cjs
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Agents and tools", exact: true }).click();
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

  await scenario("it says a server is never run merely by being added", server, {}, async (page) => {
    const panel = page.locator(".panel.mcp");
    assert.match(await panel.innerText(), /never runs anything it offers/i);
  });

  await scenario("looking at a server shows what it offers before anything is added", server, {}, async (page) => {
    await page.getByLabel("Command that starts the server").fill("node /tmp/notes-server.js");
    await page.getByRole("button", { name: "See what it offers" }).click();
    const found = page.locator(".mcp-found");
    await found.waitFor();
    const text = await found.innerText();
    assert.match(text, /search_notes/, "the tools are listed");
    assert.match(text, /one appears to change something: delete_note/i, "the writing one is called out");
    assert.match(text, /not a guarantee/i, "and it is honest that this is a guess");
    assert.equal(await page.locator(".mcp-list li").count(), 0, "nothing has been added yet");
  });

  await scenario("a server is added switched off", server, {}, async (page) => {
    await page.getByLabel("Command that starts the server").fill("node /tmp/notes-server.js");
    await page.getByRole("button", { name: "See what it offers" }).click();
    await page.locator(".mcp-found").waitFor();
    await page.locator(".panel.mcp").getByRole("button", { name: /^Add / }).click();
    const row = page.locator(".mcp-list li").first();
    await row.waitFor();
    assert.match(await row.innerText(), /Notes/);
    assert.equal(await row.getByRole("button", { name: "Off", exact: true }).count(), 1,
      "it arrives switched off, so connecting is a separate decision");
  });

  await scenario("a program that will not start says why instead of being added", server, {}, async (page) => {
    await page.getByLabel("Command that starts the server").fill("/usr/bin/broken-thing");
    await page.getByRole("button", { name: "See what it offers" }).click();
    const found = page.locator(".mcp-found.bad");
    await found.waitFor();
    assert.match(await found.innerText(), /ENOENT/);
    assert.equal(await page.locator(".panel.mcp").getByRole("button", { name: /^Add / }).count(), 0, "there is nothing to add");
  });

  await scenario("servers already set up are listed with the command that starts them", server,
    { mcpServers: [{ id: "x", name: "Files", command: "node", args: ["/srv/files.js"], enabled: true }] },
    async (page) => {
      const row = page.locator(".mcp-list li").first();
      await row.waitFor();
      assert.match(await row.innerText(), /Files/);
      assert.match(await row.locator(".mcp-cmd").innerText(), /node \/srv\/files\.js/);
      assert.equal(await row.getByRole("button", { name: "On", exact: true }).count(), 1);
    });

  await scenario("it names the file it would write to, and what is already in it", server, {}, async (page) => {
    const panel = page.locator(".panel").filter({ hasText: "Let Claude or ChatGPT use this machine" });
    await panel.waitFor();
    const facts = await panel.locator(".connect-facts").innerText();
    assert.match(facts, /claude_desktop_config\.json/, "the exact file");
    assert.match(facts, /filesystem/, "and what else is in there, before anything is pressed");
    assert.match(await panel.innerText(), /Nothing else in that file is changed/i);
  });

  await scenario("choosing ChatGPT points at ChatGPT's own file", server, {}, async (page) => {
    const panel = page.locator(".panel").filter({ hasText: "Let Claude or ChatGPT use this machine" });
    await panel.getByRole("tab", { name: "ChatGPT" }).click();
    await page.waitForTimeout(200);
    assert.match(await panel.locator(".connect-facts").innerText(), /ChatGPT\/mcp_config\.json/);
  });

  await scenario("one press connects, and says what to do next", server, {}, async (page) => {
    const panel = page.locator(".panel").filter({ hasText: "Let Claude or ChatGPT use this machine" });
    await panel.getByRole("button", { name: "Connect to Claude" }).click();
    const said = panel.locator(".connect-said");
    await said.waitFor();
    assert.match(await said.innerText(), /Added/);
    assert.match(await said.innerText(), /Restart Claude/i, "because it will not notice on its own");
  });

  await scenario("when it is already connected there is nothing to press", server, { connected: true }, async (page) => {
    const panel = page.locator(".panel").filter({ hasText: "Let Claude or ChatGPT use this machine" });
    await panel.waitFor();
    assert.equal(await panel.getByRole("button", { name: "Connected" }).isDisabled(), true);
    assert.equal(await panel.getByRole("button", { name: "Disconnect" }).count(), 1);
  });

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
