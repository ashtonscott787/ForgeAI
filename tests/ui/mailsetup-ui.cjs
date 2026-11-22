// Setting up a mail account.
// Usage: pnpm build && node tests/ui/mailsetup-ui.cjs
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];

async function scenario(name, server, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true, mailReady: false });
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".app");
  await page.locator(".boot").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: "Mail", exact: true }).click();
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

const open = async (page) => {
  await page.getByRole("button", { name: "Set up a mail account" }).click();
  await page.locator(".sheet").waitFor();
};

(async () => {
  const server = await serve();

  await scenario("the empty page offers the set-up, not a trip to settings", server, async (page) => {
    const btn = page.getByRole("button", { name: "Set up a mail account" });
    assert.equal(await btn.count(), 1);
    await btn.click();
    assert.equal(await page.locator(".sheet").count(), 1, "it opens over the page");
  });

  await scenario("it asks what the address is for first", server, async (page) => {
    await open(page);
    for (const k of ["Personal", "School", "Work", "Other"]) {
      assert.equal(await page.locator(".pick").filter({ hasText: k }).count(), 1, `${k} is offered`);
    }
  });

  await scenario("a personal address is recognised from the address itself", server, async (page) => {
    await open(page);
    await page.locator(".pick").filter({ hasText: "Personal" }).click();
    await page.getByLabel("Your email address").fill("someone@gmail.com");
    await page.getByRole("button", { name: "Continue" }).click();
    const found = page.locator(".sheet-found");
    await found.waitFor();
    assert.match(await found.innerText(), /Gmail/);
    assert.match(await found.innerText(), /the address itself/);
    assert.equal(await page.getByLabel("Password").count(), 1, "and it goes straight to the password");
  });

  await scenario("a school address on its own domain is settled by where its mail goes", server, async (page) => {
    await open(page);
    await page.locator(".pick").filter({ hasText: "School" }).click();
    await page.getByLabel("Your email address").fill("me@school.example");
    await page.getByRole("button", { name: "Continue" }).click();
    const found = page.locator(".sheet-found");
    await found.waitFor();
    assert.match(await found.innerText(), /Gmail/, "a Google-hosted school address");
    assert.match(await found.innerText(), /where this domain delivers its mail/);
  });

  await scenario("a domain that says nothing asks, rather than guessing", server, async (page) => {
    await open(page);
    await page.locator(".pick").filter({ hasText: "Work" }).click();
    await page.getByLabel("Your email address").fill("me@unknown.example");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".pickgrid.tight").waitFor();
    for (const c of ["Google", "Apple", "Microsoft", "Something else"]) {
      assert.equal(await page.locator(".pick").filter({ hasText: c }).count(), 1, `${c} is offered`);
    }
  });

  await scenario("a provider that cannot work says so instead of taking a password", server, async (page) => {
    await open(page);
    await page.locator(".pick").filter({ hasText: "Work" }).click();
    await page.getByLabel("Your email address").fill("me@corp.example");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".sheet-bad").waitFor();
    assert.match(await page.locator(".sheet-bad").innerText(), /switched off password sign-in/i);
    assert.equal(await page.getByLabel("Password").count(), 0, "no password is asked for");
    assert.equal(await page.getByRole("button", { name: "Finish" }).isDisabled(), true);
  });

  await scenario("something that is not an address is refused before any lookup", server, async (page) => {
    await open(page);
    await page.locator(".pick").filter({ hasText: "Personal" }).click();
    await page.getByLabel("Your email address").fill("not an address");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".sheet-bad").waitFor();
    assert.match(await page.locator(".sheet-bad").innerText(), /does not look like an email address/i);
  });

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
