// People. Everything the app worked out is a question until it is answered,
// so the tests are mostly about what stays out of sight until then.
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
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.waitForSelector(".view.active .peoplelist", { timeout: 5000 });
  try {
    await fn(page, page.locator(".view.active"));
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

  await scenario("Confirmed facts are shown; guesses are shown as questions", server, {}, async (page, view) => {
    const dana = view.locator(".personrow", { hasText: "Dana Patel" });
    assert.match(await dana.locator(".personknown").innerText(), /Patel Logistics/, "a confirmed organisation is stated");
    assert.match(await dana.locator(".personnote").innerText(), /Prefers email to phone/);
    // The unconfirmed ones appear only under the question list.
    const ask = dana.locator(".asklist");
    assert.match(await ask.innerText(), /not used until you say so/);
    assert.match(await ask.innerText(), /Operations Manager/);
    assert.ok(!(await dana.locator(".personknown").innerText()).includes("Operations Manager"), "a guess is never shown as known");
  });

  await scenario("A question says where it came from and how often it was seen", server, {}, async (page, view) => {
    const row = view.locator(".askrow", { hasText: "Operations Manager" });
    assert.match(await row.innerText(), /Order 1042/, "the email it came from");
    assert.match(await row.innerText(), /seen 3×/, "repetition is evidence worth showing");
    const once = view.locator(".askrow", { hasText: "555 0199" });
    assert.ok(!(await once.innerText()).includes("seen 1×"), "a single sighting is not padded with a count");
  });

  await scenario("Answering a question removes it", server, {}, async (page, view) => {
    const before = await view.locator(".askrow").count();
    await view.locator(".askrow", { hasText: "Operations Manager" }).getByRole("button", { name: "Yes" }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".view.active .askrow").length < n, before, { timeout: 4000 },
    );
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "contacts_decide"));
    assert.equal(calls[0].args.state, "confirmed");
  });

  await scenario("Saying no records a rejection rather than silently dropping it", server, {}, async (page, view) => {
    await view.locator(".askrow", { hasText: "555 0199" }).getByRole("button", { name: "No" }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c.cmd === "contacts_decide"), null, { timeout: 4000 });
    const call = (await page.evaluate(() => window.__calls.filter((c) => c.cmd === "contacts_decide")))[0];
    assert.equal(call.args.state, "rejected");
  });

  await scenario("A briefing uses only what was confirmed", server, {}, async (page, view) => {
    await view.locator(".personrow", { hasText: "Dana Patel" }).getByRole("button", { name: "Brief me on them" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((t) => t.value.includes("should remember about")),
      null, { timeout: 5000 },
    );
    const box = await page.locator('textarea[placeholder^="Ask anything"]').inputValue();
    assert.match(box, /Patel Logistics/, "the confirmed organisation is included");
    assert.ok(!box.includes("Operations Manager"), "the unconfirmed role is not");
    assert.match(box, /say that rather than guessing/, "and the model is told not to fill gaps");
  });

  await scenario("Someone with nothing confirmed says so rather than inventing a summary", server, {}, async (page, view) => {
    await view.locator(".personrow", { hasText: "jo@client.example" }).getByRole("button", { name: "Brief me on them" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((t) => t.value.includes("have not confirmed anything")),
      null, { timeout: 5000 },
    );
  });

  await scenario("Learning from the inbox needs a mail account, and says so", server, {}, async (page, view) => {
    await view.getByRole("button", { name: "Learn from my inbox" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("no incoming mail account") || document.body.innerText.includes("No incoming mail account"), null, { timeout: 5000 });
  });

  await scenario("With an account it reports what it actually read", server, { mailReady: true }, async (page, view) => {
    await view.getByRole("button", { name: "Learn from my inbox" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Read 40 emails"), null, { timeout: 5000 });
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
