// Run with: pnpm test. Keyless information lookup and page text.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { wikipediaSearch, wikipediaSummary, readablePageText, checkPageUrl, WebError } = require("../electron/open-web.cjs");

function fixture(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("search returns sources with URLs and cleaned snippets, and sends a User-Agent", async () => {
  let ua = "";
  const s = await fixture((req, res) => {
    ua = req.headers["user-agent"];
    json(res, 200, { query: { search: [
      { title: "Forge AI", snippet: "A <span class=\"searchmatch\">desktop</span> &amp; local app" },
      { title: "Rust (programming language)", snippet: "Systems &quot;language&quot;" },
    ] } });
  });
  const r = await wikipediaSearch("forge desktop", { base: base(s) });
  s.close();
  assert.equal(r.provider, "wikipedia");
  assert.equal(r.sources.length, 2);
  assert.equal(r.sources[0].snippet, "A desktop & local app", "markup removed, entities decoded");
  assert.match(r.sources[1].url, /\/wiki\/Rust_\(programming_language\)$/);
  assert.match(r.answer, /\[1\] Forge AI/);
  assert.match(ua, /ForgeAI/);
});

test("an empty or oversized query is refused before any request", async () => {
  await assert.rejects(wikipediaSearch("   "), (e) => e instanceof WebError && e.kind === "bad_request");
});

test("a changed reply shape is reported as malformed, not as zero results", async () => {
  const s = await fixture((req, res) => json(res, 200, { unexpected: true }));
  await assert.rejects(wikipediaSearch("x", { base: base(s) }), (e) => e.kind === "malformed");
  s.close();
});

test("redirects and server errors are reported", async () => {
  const s = await fixture((req, res) => { res.writeHead(301, { location: "http://127.0.0.1:1/" }); res.end(); });
  await assert.rejects(wikipediaSearch("x", { base: base(s) }), (e) => e.kind === "redirect");
  s.close();
  const t = await fixture((req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(wikipediaSearch("x", { base: base(t) }), (e) => e.kind === "server");
  t.close();
});

test("a source that never answers times out", async () => {
  const s = await fixture(() => {});
  await assert.rejects(wikipediaSearch("x", { base: base(s) }), (e) => e.kind === "timeout" || e.kind === "network");
  s.close();
});

test("summary fetches one article's lead and its page URL", async () => {
  const s = await fixture((req, res) => json(res, 200, { title: "Forge AI", extract: "Forge AI is an app.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Forge_AI" } } }));
  const r = await wikipediaSummary("Forge AI", { base: base(s) });
  s.close();
  assert.equal(r.text, "Forge AI is an app.");
  assert.equal(r.url, "https://en.wikipedia.org/wiki/Forge_AI");
});

test("page text drops scripts, styles and markup, and keeps readable lines", () => {
  const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
    <body><nav>Home</nav><h1>Title &amp; more</h1><p>First paragraph.</p><!-- hidden --><p>Second&nbsp;paragraph</p></body></html>`;
  const text = readablePageText(html);
  assert.doesNotMatch(text, /alert|color:red|hidden/);
  assert.match(text, /Title & more/);
  assert.match(text, /First paragraph\.\nSecond/);
});

test("page text is capped", () => {
  assert.equal(readablePageText("<p>" + "a".repeat(50_000) + "</p>", 1000).length, 1000);
});

test("only public https pages may be opened in the browser", () => {
  assert.equal(checkPageUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.throws(() => checkPageUrl("http://example.com"), /https/);
  assert.throws(() => checkPageUrl("file:///etc/passwd"), /https/);
  assert.throws(() => checkPageUrl("javascript:alert(1)"), /https/);
  assert.throws(() => checkPageUrl("https://localhost:8080/"), /Local/);
  assert.throws(() => checkPageUrl("https://user:pw@example.com/"), /credentials/);
});
