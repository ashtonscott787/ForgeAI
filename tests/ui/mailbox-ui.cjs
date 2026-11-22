// Reading mail in the app. Read-only is the property worth protecting, so the
// tests check what is absent as much as what is there.
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
  // The starting screen is held for about a second and covers the window, so
  // waiting for the app element alone is not waiting for the app to be usable.
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Mail", exact: true }).click();
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

  await scenario("With no account, it says so and points at Settings", server, {}, async (page) => {
    await page.waitForFunction(() => document.body.innerText.includes("No incoming mail account"), null, { timeout: 5000 });
    assert.match(await page.locator(".view.active .pbody").innerText(), /Settings/);
    assert.equal(await page.locator(".view.active .maillist").count(), 0, "no empty list is shown");
  });

  await scenario("The inbox lists messages, and marks the unread ones", server, { mailReady: true }, async (page) => {
    await page.waitForSelector(".view.active .maillist", { timeout: 5000 });
    const rows = page.locator(".view.active .mailrow");
    assert.equal(await rows.count(), 2);
    assert.match(await rows.first().innerText(), /Dana Patel/);
    assert.match(await rows.first().innerText(), /Order 1042 delayed/);
    assert.equal(await page.locator(".view.active .mailrow.unread").count(), 1, "one is unread");
    assert.match(await page.locator(".view.active .pbody").innerText(), /1 unread of 2/);
  });

  await scenario("Opening a message shows its text", server, { mailReady: true }, async (page) => {
    await page.waitForSelector(".view.active .maillist");
    await page.locator(".view.active .mailmain").first().click();
    await page.waitForSelector(".view.active .mailbody", { timeout: 5000 });
    assert.match(await page.locator(".view.active .mailbody").innerText(), /pallets are held at customs/);
  });

  await scenario("A reply is drafted in the chat, not sent from here", server, { mailReady: true }, async (page) => {
    await page.waitForSelector(".view.active .maillist");
    await page.locator(".view.active .mailmain").first().click();
    await page.waitForSelector(".view.active .mailbody");
    await page.getByRole("button", { name: "Draft a reply" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((t) => t.value.includes("Draft a reply to this email")),
      null, { timeout: 5000 },
    );
    const box = await page.locator('textarea[placeholder^="Ask anything"]').inputValue();
    assert.match(box, /pallets are held at customs/, "the message came with it");
    assert.match(box, /do not promise anything it does not already say/, "and the instruction not to overpromise");
    const sent = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "mail_send"));
    assert.equal(sent.length, 0, "nothing was sent");
  });

  await scenario("Nothing in the mail view can change the mailbox", server, { mailReady: true }, async (page) => {
    await page.waitForSelector(".view.active .maillist");
    const view = await page.locator(".view.active").innerText();
    // Scoped to the mail view: other views legitimately have Delete buttons
    // of their own, and matching those proves nothing about this one.
    const mail = page.locator(".view.active");
    for (const verb of ["Delete", "Archive", "Move", "Mark as read", "Trash"]) {
      assert.equal(await mail.getByRole("button", { name: verb, exact: true }).count(), 0, `no ${verb} button in the mail view`);
    }
    // Messages are fetched with BODY.PEEK, so reading one does not even mark
    // it read. The page says exactly that rather than a vaguer promise.
    assert.match(view, /deletes, moves or marks anything as read/i, "and it says so");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
