// End-to-end UI tests for cloud models, run against the production build.
// Usage: pnpm build && pnpm test:ui
// Browser: Playwright's bundled Chromium (`pnpm exec playwright install chromium`), or set
// FORGE_CHROMIUM to a Chromium binary.
// The bridge is a stand-in for the Electron main process only. See harness.cjs.
const assert = require("node:assert/strict");
const http = require("node:http");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const KEY = "sk-ant-api03-UITESTKEY-1234567890";
const results = [];

async function scenario(name, server, fn, cfg = {}) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, cfg);
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  try {
    await fn(page);
    assert.deepEqual(pageErrors, [], "no uncaught page errors");
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
    await page.screenshot({ path: `${process.env.TMPDIR || "/tmp"}/fail-${name.replace(/\W+/g, "_")}.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

const calls = (page, cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c), cmd);
const waitForPending = (page, n = 1) => page.waitForFunction((k) => Object.keys(window.__pending).length >= k, n, { timeout: 5000 });
async function pendingIds(page) { return page.evaluate(() => Object.keys(window.__pending)); }

async function connectAnthropic(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const card = page.getByLabel("Anthropic connection");
  await card.getByLabel("Anthropic API key").fill(KEY);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByText("Connected · 2 models").waitFor({ timeout: 5000 });
}

async function sendInChat(page, text) {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "New chat" }).first().click().catch(() => {});
  const box = page.locator('textarea[placeholder^="Ask anything"]');
  await box.fill(text);
  await box.press("Enter");
}

(async () => {
  const server = await serve();

  await scenario("connect a key: saved, then verified by an authenticated test", server, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const card = page.getByLabel("Anthropic connection");
    await card.getByText("No key saved").waitFor();
    await card.getByLabel("Anthropic API key").fill(KEY);
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await card.getByText("Connected · 2 models").waitFor({ timeout: 5000 });
    assert.equal((await calls(page, "provider_key_save")).length, 1, "the key was saved once");
    assert.equal((await calls(page, "provider_test")).length, 1, "a real authenticated test ran");
    assert.equal(await card.getByLabel("Anthropic API key").count(), 0, "the key field is replaced by the saved state");
    const text = await page.content();
    assert.ok(!text.includes(KEY), "the key never appears in the rendered page");
    await card.locator("code", { hasText: "claude-test-a" }).waitFor();
  });

  await scenario("a rejected key is shown as saved but failed, with the provider's reason", server, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const card = page.getByLabel("Anthropic connection");
    await card.getByLabel("Anthropic API key").fill(KEY);
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await card.getByText("rejected this key").waitFor({ timeout: 5000 });
    await card.getByText("Key saved · last test failed").waitFor();
    assert.equal(await card.getByText("Connected ·").count(), 0, "a failed key is never shown as connected");
  }, { testError: "The provider rejected this key. Check it, or that the key has access to this service." });

  await scenario("disconnect keeps the key; remove key deletes it", server, async (page) => {
    await connectAnthropic(page);
    const card = page.getByLabel("Anthropic connection");
    await card.getByRole("button", { name: "Disconnect", exact: true }).click();
    await card.getByText("Key saved · not verified yet").waitFor();
    assert.equal((await calls(page, "provider_remove")).length, 0);
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Remove key", exact: true }).click();
    await card.getByText("No key saved").waitFor();
  });

  await scenario("a cloud reply streams into the conversation and records usage", server, async (page) => {
    await connectAnthropic(page);
    await sendInChat(page, "Say hello");
    await waitForPending(page);
    const [id] = await pendingIds(page);
    const sent = await calls(page, "provider_stream");
    assert.equal(sent.at(-1).args.provider, "anthropic");
    assert.equal(sent.at(-1).args.model, "claude-test-a");
    assert.equal(sent.at(-1).args.messages.at(-1).content, "Say hello");
    await page.evaluate((rid) => { window.__emit("provider://token", { requestId: rid, text: "Hello " }); window.__emit("provider://token", { requestId: rid, text: "there ✓" }); }, id);
    await page.getByText("Hello there ✓").waitFor({ timeout: 5000 });
    await page.evaluate((rid) => window.__finish(rid, { tokens: 2, stopReason: "end_turn", usage: { input: 9, output: 4 }, cancelled: false }), id);
    await page.waitForFunction(() => document.querySelectorAll(".send.live.stop").length === 0);
    assert.equal(await page.getByText("Hello there ✓").count(), 1);
  });

  await scenario("Stop cancels the cloud request and text arriving after it is dropped", server, async (page) => {
    await connectAnthropic(page);
    await sendInChat(page, "Long answer please");
    await waitForPending(page);
    const [id] = await pendingIds(page);
    await page.evaluate((rid) => window.__emit("provider://token", { requestId: rid, text: "Partial" }), id);
    await page.getByText("Partial").waitFor();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const cancels = await calls(page, "provider_cancel");
    assert.equal(cancels.at(-1).args.requestId, id, "the cancel names the same request");
    await page.evaluate((rid) => window.__emit("provider://token", { requestId: rid, text: " LATE" }), id);
    await page.waitForTimeout(150);
    const reply = await page.evaluate(() => Array.from(document.querySelectorAll(".msg.assistant")).map((m) => m.innerText).join("|"));
    assert.ok(reply.includes("Partial"), "text that arrived before Stop is kept");
    assert.ok(!reply.includes("LATE"), "no text is added after Stop; reply was: " + reply);
    assert.ok(await page.getByRole("button", { name: "Stop", exact: true }).count() === 0, "the input is usable again");
  });

  await scenario("a reply finishing after switching chats lands in its own conversation", server, async (page) => {
    await connectAnthropic(page);
    await sendInChat(page, "First chat question");
    await waitForPending(page);
    const [idA] = await pendingIds(page);
    // Switch to a new chat while A is still streaming.
    await page.getByRole("button", { name: "New chat" }).first().click();
    const box = page.locator('textarea[placeholder^="Ask anything"]');
    await box.fill("Second chat question");
    await box.press("Enter");
    await page.waitForFunction((n) => Object.keys(window.__pending).length >= n, 2, { timeout: 5000 });
    const ids = await pendingIds(page);
    const idB = ids.find((x) => x !== idA);
    await page.evaluate(([a, b]) => {
      window.__emit("provider://token", { requestId: a, text: "ANSWER-A" });
      window.__emit("provider://token", { requestId: b, text: "ANSWER-B" });
    }, [idA, idB]);
    await page.getByText("ANSWER-B").waitFor();
    assert.equal(await page.getByText("ANSWER-A").count(), 0, "chat B does not show chat A's reply");
    await page.evaluate(([a, b]) => { window.__finish(a, { tokens: 1, stopReason: "end_turn", usage: { input: null, output: null }, cancelled: false }); window.__finish(b, { tokens: 1, stopReason: "end_turn", usage: { input: null, output: null }, cancelled: false }); }, [idA, idB]);
    await page.locator(".conv", { hasText: "First chat question" }).first().click();
    await page.getByText("ANSWER-A").waitFor({ timeout: 5000 });
    assert.equal(await page.getByText("ANSWER-B").count(), 0, "chat A does not show chat B's reply");
  });

  await scenario("Stop in one chat does not stop a reply in another", server, async (page) => {
    await connectAnthropic(page);
    await sendInChat(page, "Chat one");
    await waitForPending(page);
    const [idA] = await pendingIds(page);
    await page.getByRole("button", { name: "New chat" }).first().click();
    const box = page.locator('textarea[placeholder^="Ask anything"]');
    await box.fill("Chat two");
    await box.press("Enter");
    await page.waitForFunction(() => Object.keys(window.__pending).length >= 2, null, { timeout: 5000 });
    // Stop is on screen for chat two; stop it.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const cancelled = (await calls(page, "provider_cancel")).at(-1).args.requestId;
    assert.notEqual(cancelled, idA, "chat one's request was not the one cancelled");
    assert.ok(await pendingIds(page).then((ids) => ids.includes(idA)), "chat one's request is still running");
    await page.evaluate((rid) => window.__finish(rid, { tokens: 0, stopReason: "end_turn", usage: { input: null, output: null }, cancelled: false }), idA);
  });

  await scenario("the default model setting picks a cloud model for new chats", server, async (page) => {
    await connectAnthropic(page);
    await page.getByLabel("Default model for new chats").selectOption("cloud:anthropic:claude-test-b");
    const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "set_settings").at(-1));
    assert.ok(saved, "the default was saved to settings");
    assert.equal(saved.args.settings.selected_model, "cloud:anthropic:claude-test-b");
  });

  // A stand-in llama-server: OpenAI-style SSE, one word every 30 ms, so Stop can land mid-reply.
  const llama = http.createServer((req, res) => {
    // The app adds these headers in the main process (see electron/main.cjs); the stand-in does the same.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const page = "```html\n<p id=\"probe\">waiting</p><p id=\"net\">pending</p><script>document.getElementById('probe').textContent = 'PREVIEW-RAN'; fetch('http://127.0.0.1:9/').then(() => { document.getElementById('net').textContent = 'REACHED'; }, () => { document.getElementById('net').textContent = 'BLOCKED'; });</script>\n```";
      const words = body.includes("PREVIEW_PAGE") ? [page] : ["local ", "model ", "answer ", "finished ", "here"];
      let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        if (i >= words.length) { clearInterval(t); res.write("data: [DONE]\n\n"); return res.end(); }
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: words[i++] } }] }) + "\n\n");
      }, 30);
      res.on("close", () => clearInterval(t));
    });
  });
  await new Promise((r) => llama.listen(0, "127.0.0.1", r));
  const engineBase = `http://127.0.0.1:${llama.address().port}`;

  await scenario("a local model still streams a complete reply", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const box = page.locator('textarea[placeholder^="Ask anything"]');
    await box.fill("Explain locally");
    await box.press("Enter");
    await page.getByText("finished here").waitFor({ timeout: 8000 });
    assert.equal((await calls(page, "provider_stream")).length, 0, "no cloud request was made");
  }, { local: true, engineBase });

  await scenario("Stop works on a local reply mid-stream and the input recovers", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const box = page.locator('textarea[placeholder^="Ask anything"]');
    await box.fill("Long local reply");
    await box.press("Enter");
    await page.getByText("local", { exact: false }).first().waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.waitForTimeout(300);
    const reply = await page.evaluate(() => Array.from(document.querySelectorAll(".msg.assistant")).map((m) => m.innerText).join("|"));
    assert.ok(!reply.includes("here"), "the reply stopped before its last word: " + reply);
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "the input is usable again");
    await box.fill("Second local question"); await box.press("Enter");
    await page.getByText("finished here").last().waitFor({ timeout: 8000 });
  }, { local: true, engineBase });

  await scenario("a generated web page runs its own script inside its frame", server, async (page) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const box = page.locator('textarea[placeholder^="Ask anything"]');
    await box.fill("PREVIEW_PAGE build a tiny page");
    await box.press("Enter");
    const frame = page.frameLocator('iframe[title="Generated page"]');
    await frame.locator("#probe").getByText("PREVIEW-RAN").waitFor({ timeout: 8000 });
    // The page's own script ran. Its policy (connect-src 'none') must block its network request.
    await frame.locator("#net").getByText("BLOCKED").waitFor({ timeout: 8000 });
    const src = await page.locator('iframe[title="Generated page"]').getAttribute("sandbox");
    assert.equal(src, "allow-scripts", "the frame stays sandboxed to scripts only");
  }, { local: true, engineBase });

  await scenario("the browser searches open sources and opens a result in a new tab", server, async (page) => {
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByLabel("Search open sources").fill("Forge AI");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Forge AI", exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Forge AI", exact: true }).click();
    const src = await page.locator("webview").first().getAttribute("src");
    assert.equal(src, "https://en.wikipedia.org/wiki/Forge_AI", "the result opened as a page");
    assert.equal(await page.locator(".browser-tab").count(), 2, "a new tab was added");
  });

  await scenario("the address bar opens https addresses and never loads plain http", server, async (page) => {
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const bar = page.getByLabel("Address or search");
    await bar.fill("example.com");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    assert.equal(await page.locator("webview").first().getAttribute("src"), "https://example.com");
    await bar.fill("http://insecure.example");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    assert.equal(await page.locator("webview").first().getAttribute("src"), "https://insecure.example", "http is upgraded to https");
  });

  await scenario("send page to chat puts the text in the composer, unsent", server, async (page) => {
    await connectAnthropic(page);
    // The guest page's methods exist only in Electron. Stand them in here with the same shapes.
    // Applied to the running page: an init script would arrive after this page has loaded.
    await page.evaluate(() => {
      const el = HTMLElement.prototype;
      el.executeJavaScript = function () { return Promise.resolve("Forge AI is a private assistant. It runs models on your computer."); };
      el.getURL = function () { return this.getAttribute("src"); };
    });
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByLabel("Address or search").fill("example.com");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await page.getByRole("button", { name: "Send page to chat", exact: true }).click();
    // Wait for the hand-off to land in the composer, rather than reading it too early.
    await page.waitForFunction(() => Array.from(document.querySelectorAll("textarea")).some((t) => t.value.includes("Forge AI is a private assistant")), null, { timeout: 5000 });
    assert.equal(await page.locator('textarea[placeholder^="Ask anything"]').inputValue().then((v) => v.includes("Forge AI is a private assistant")), true, "the page text is in the composer");
    assert.equal((await calls(page, "provider_stream")).length, 0, "nothing was sent automatically");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI scenarios passed`);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
