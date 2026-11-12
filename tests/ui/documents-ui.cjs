// Saving a reply as a file, and previewing a site, as a person would do it.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { serve, BRIDGE } = require("./harness.cjs");

const results = [];
const F = "```";

const SITE_REPLY = [
  "Here is your site.", "",
  F + "html index.html",
  '<!doctype html><html><body><nav><a href="about.html">About</a></nav><h1>Home</h1></body></html>',
  F, "",
  F + "html about.html",
  '<!doctype html><html><body><a href="index.html">Home</a><h1>About</h1></body></html>',
  F,
].join("\n");

const BROKEN_REPLY = [
  F + "html index.html",
  '<!doctype html><html><body><a href="missing.html">Gone</a><h1>Home</h1></body></html>',
  F,
  F + "html other.html", "<h1>Other</h1>", F,
].join("\n");

const LONG_REPLY = "# Quarterly report\n\n" + "Revenue rose across every region this quarter, driven mainly by the northern territories. ".repeat(8);

const convo = (id, title, assistant) => ({
  id, title, updated: Date.now(),
  messages: [{ role: "user", content: "make it" }, { role: "assistant", content: assistant, model: "Test" }],
});

async function scenario(name, server, seed, fn) {
  const browser = await chromium.launch({ executablePath: process.env.FORGE_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((c) => { window.__cfg = c; }, { local: true });
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

  await scenario("A multipage reply becomes one website, not loose previews", server,
    [convo("s1", "Site", SITE_REPLY)], async (page) => {
      await page.locator(".conv", { hasText: "Site" }).first().click();
      await page.waitForSelector(".sitecard", { timeout: 5000 });
      const tabs = await page.locator(".sitetab").allInnerTexts();
      assert.deepEqual(tabs.sort(), ["about.html", "index.html"], "every page gets a tab");
      assert.match(await page.locator(".sitecard-h .hint").first().innerText(), /every internal link resolves/);
    });

  await scenario("A broken internal link is reported before you click it", server,
    [convo("s2", "Broken", BROKEN_REPLY)], async (page) => {
      await page.locator(".conv", { hasText: "Broken" }).first().click();
      await page.waitForSelector(".sitebroken", { timeout: 5000 });
      const text = await page.locator(".sitebroken").innerText();
      assert.match(text, /index\.html/);
      assert.match(text, /missing\.html/);
      assert.match(await page.locator(".sitecard-h .hint").first().innerText(), /broken link/i);
    });

  await scenario("A site can be exported, and says where it went", server,
    [convo("s3", "Export", SITE_REPLY)], async (page) => {
      await page.locator(".conv", { hasText: "Export" }).first().click();
      await page.waitForSelector(".sitecard");
      await page.getByRole("button", { name: "Export ZIP" }).click();
      await page.waitForFunction(() => document.body.innerText.includes("website.zip"), null, { timeout: 5000 });
      assert.match(await page.locator(".sitecard").innerText(), /3 files/);
    });

  await scenario("The code of each file can be read without leaving the chat", server,
    [convo("s4", "Code", SITE_REPLY)], async (page) => {
      await page.locator(".conv", { hasText: "Code" }).first().click();
      await page.waitForSelector(".sitecard");
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await page.waitForSelector(".siteCode");
      assert.match(await page.locator(".siteCode").innerText(), /<h1>Home<\/h1>/);
      await page.getByRole("tab", { name: "about.html" }).click();
      await page.waitForFunction(() => document.querySelector(".siteCode")?.innerText.includes("About"), null, { timeout: 4000 });
    });

  await scenario("A long reply can be saved as a real file, and says what was written", server,
    [convo("s5", "Report", LONG_REPLY)], async (page) => {
      await page.locator(".conv", { hasText: "Report" }).first().click();
      await page.waitForSelector(".saveas", { timeout: 5000 });
      for (const label of ["PDF", "Word", "Markdown", "Text", "Web page"]) {
        assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1, `${label} is offered`);
      }
      await page.getByRole("button", { name: "Word", exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes("Report.docx"), null, { timeout: 5000 });
      assert.match(await page.locator(".saveas-note").innerText(), /Saved .*Report\.docx \(4 KB\)/);
    });

  await scenario("A short reply offers no file, because there is nothing worth keeping", server,
    [convo("s6", "Short", "Yes, that is correct.")], async (page) => {
      await page.locator(".conv", { hasText: "Short" }).first().click();
      await page.waitForSelector(".msg.assistant");
      assert.equal(await page.locator(".saveas").count(), 0);
    });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
