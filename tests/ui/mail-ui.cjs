// Drafted email. Forge AI writes it; a person sends it, and only after seeing
// who it is going to.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const DRAFT = [
  "Here is a draft.",
  "",
  "To: supplier@example.net",
  "Subject: Order 1042",
  "",
  "Could you confirm the delivery date?",
].join("\n");

const seed = [{
  id: "m1", title: "Email", updated: Date.now(),
  messages: [{ role: "user", content: "write to the supplier" }, { role: "assistant", content: DRAFT, model: "Test" }],
}];

async function scenario(name, server, cfg, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, ...cfg });
  await page.addInitScript(BRIDGE);
  await page.addInitScript((l) => localStorage.setItem("forge.conversations.v1", JSON.stringify(l)), seed);
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

  await scenario("With no account, a draft says it cannot be sent and offers to be copied", server, {}, async (page) => {
    await page.locator(".conv", { hasText: "Email" }).first().click();
    await page.waitForSelector(".emailcard", { timeout: 5000 });
    assert.equal(await page.getByRole("button", { name: "Send this" }).count(), 0, "there is nothing to press");
    assert.match(await page.locator(".emailnote").innerText(), /no outgoing mail account/i);
    assert.equal(await page.getByRole("button", { name: "Copy message" }).count(), 1, "copying still works");
  });

  await scenario("Sending asks who it is going to before it goes", server, { mailReady: true }, async (page) => {
    await page.locator(".conv", { hasText: "Email" }).first().click();
    await page.waitForSelector(".emailcard", { timeout: 5000 });
    await page.getByRole("button", { name: "Send this" }).click();
    // Nothing has been sent yet: it asks first, and names the recipient.
    await page.waitForFunction(() => document.body.innerText.includes("Send to supplier@example.net?"), null, { timeout: 4000 });
    assert.equal((await page.evaluate(() => window.__calls.filter((c) => c.cmd === "mail_send"))).length, 0, "nothing sent on the first press");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Send to supplier@example.net?"), null, { timeout: 4000 });
    assert.equal((await page.evaluate(() => window.__calls.filter((c) => c.cmd === "mail_send"))).length, 0, "cancelling sends nothing");
  });

  await scenario("Confirming sends it, with approval, and reports what happened", server, { mailReady: true }, async (page) => {
    await page.locator(".conv", { hasText: "Email" }).first().click();
    await page.waitForSelector(".emailcard");
    await page.getByRole("button", { name: "Send this" }).click();
    await page.getByRole("button", { name: "Yes, send" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Sent to 1 recipient"), null, { timeout: 5000 });
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "mail_send"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.approved, true, "approval travels with the send, and only a person sets it");
    assert.equal(calls[0].args.to, "supplier@example.net");
    assert.equal(calls[0].args.subject, "Order 1042");
    assert.match(calls[0].args.text, /confirm the delivery date/);
    assert.equal(await page.getByRole("button", { name: "Send this" }).count(), 0, "it cannot be sent twice by accident");
  });

  await scenario("An account can be set up in Settings, and says reading is not built", server, {}, async (page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panel = page.getByLabel("Outgoing email account");
    await panel.waitFor({ timeout: 5000 });
    await panel.getByLabel("Send as").fill("Ash <ash@example.com>");
    await panel.getByLabel("Outgoing server (SMTP)").fill("smtp.example.com");
    await panel.getByRole("button", { name: /Save account|Saving/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Saved."), null, { timeout: 5000 });
    assert.match(await panel.innerText(), /Reading your inbox is not built/, "the gap is stated rather than implied");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
