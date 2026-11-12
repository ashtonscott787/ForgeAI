// Internet search across providers. The failures matter as much as the
// successes: a search that quietly became a different search, or that returned
// invented results, is worse than one that plainly did not run.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../electron/search.cjs");

/** Replaces the network. Every test says exactly what the service returned. */
function transport(plan) {
  const calls = [];
  S.useTransport(async (url, opts) => {
    calls.push({ url, opts });
    const r = typeof plan === "function" ? plan(url, opts) : plan;
    if (r instanceof Error) throw r;
    return r;
  });
  return calls;
}
test.afterEach(() => S.useTransport(null));

const ok = (obj) => ({ status: 200, text: JSON.stringify(obj) });
const wiki = async () => ({ sources: [{ title: "Forge", url: "https://en.wikipedia.org/wiki/Forge", snippet: "A forge is a hearth." }] });

test("Brave results come back with their real URLs", async () => {
  const calls = transport(ok({ web: { results: [
    { title: "Steel prices 2026", url: "https://example.com/steel", description: "Prices rose 4%." },
    { title: "Other", url: "https://other.example/x", description: "More." },
  ] } }));
  const run = await S.search("brave", "steel prices", { key: "k-123" });
  assert.equal(run.found, 2);
  assert.equal(run.results[0].url, "https://example.com/steel");
  assert.equal(run.results[0].source, "example.com");
  assert.match(calls[0].url, /api\.search\.brave\.com/);
  assert.equal(calls[0].opts.headers["X-Subscription-Token"], "k-123", "the person's own key is sent");
});

test("a provider with no key refuses, and does not fall back to another", async () => {
  const calls = transport(ok({}));
  await assert.rejects(() => S.search("brave", "x", {}), (e) => {
    assert.equal(e.kind, "no_key");
    assert.match(e.message, /Settings/);
    return true;
  });
  assert.equal(calls.length, 0, "nothing was requested at all");
});

test("a rejected key is reported as a key problem, not as no results", async () => {
  transport({ status: 401, text: "nope" });
  await assert.rejects(() => S.search("tavily", "x", { key: "bad" }), (e) => {
    assert.equal(e.kind, "auth");
    assert.equal(e.status, 401);
    return true;
  });
});

test("rate limiting is reported as itself", async () => {
  transport({ status: 429, text: "slow down" });
  await assert.rejects(() => S.search("brave", "x", { key: "k" }), (e) => e.kind === "rate_limit");
});

test("a provider that returns something other than JSON is reported, not guessed at", async () => {
  transport({ status: 200, text: "<html>down for maintenance</html>" });
  await assert.rejects(() => S.search("tavily", "x", { key: "k" }), (e) => e.kind === "bad_response");
});

test("an empty result set says so rather than looking like an answer", async () => {
  transport(ok({ web: { results: [] } }));
  const run = await S.search("brave", "a query with nothing", { key: "k" });
  assert.equal(run.found, 0);
  assert.match(run.note, /returned no results/);
  assert.match(S.asContext(run), /returned no results/);
  assert.match(S.asContext(run), /rather than answering from memory/);
});

test("a SearXNG instance that disables JSON is reported as that, specifically", async () => {
  transport({ status: 403, text: "" });
  await assert.rejects(() => S.search("searxng", "x", { instance: "https://searx.example" }), (e) => {
    assert.equal(e.kind, "json_disabled");
    assert.match(e.message, /does not allow its JSON API/);
    return true;
  });
});

test("a SearXNG address must be https, unless it is on this computer", async () => {
  transport(ok({ results: [] }));
  await assert.rejects(() => S.search("searxng", "x", { instance: "http://searx.example" }), (e) => e.kind === "bad_config");
  // A local instance is the one case where plain http is reasonable.
  const run = await S.search("searxng", "x", { instance: "http://127.0.0.1:8888" });
  assert.equal(run.found, 0);
});

test("results without a usable URL are dropped rather than shown uncitable", async () => {
  transport(ok({ results: [
    { title: "Good", url: "https://good.example/a", content: "yes" },
    { title: "No URL", url: "", content: "nope" },
    { title: "Not a URL", url: "javascript:alert(1)", content: "nope" },
    { title: "Duplicate", url: "https://good.example/a", content: "again" },
  ] }));
  const run = await S.search("searxng", "x", { instance: "https://searx.example" });
  assert.equal(run.found, 1, "only the one citable, unique result survives");
  assert.equal(run.results[0].url, "https://good.example/a");
});

test("Wikipedia still works, and is labelled as the source it is", async () => {
  const run = await S.search("wikipedia", "forge", { wikipedia: wiki });
  assert.equal(run.found, 1);
  assert.equal(run.results[0].provider, "wikipedia");
  assert.equal(run.label, "Wikipedia");
});

test("the context handed to a model numbers its sources so they can be cited", async () => {
  transport(ok({ web: { results: [
    { title: "A", url: "https://a.example/1", description: "first" },
    { title: "B", url: "https://b.example/2", description: "second" },
  ] } }));
  const ctx = S.asContext(await S.search("brave", "q", { key: "k" }));
  assert.match(ctx, /\[1\] A — https:\/\/a\.example\/1/);
  assert.match(ctx, /\[2\] B — https:\/\/b\.example\/2/);
  assert.match(ctx, /Cite these by their number/);
  assert.match(ctx, /Use only what is here/);
});

test("an unknown provider is refused by name", async () => {
  await assert.rejects(() => S.search("google", "x", {}), (e) => /no search provider called "google"/.test(e.message));
});

test("an empty query is refused before anything is requested", async () => {
  const calls = transport(ok({}));
  await assert.rejects(() => S.search("brave", "   ", { key: "k" }), (e) => e.kind === "empty");
  assert.equal(calls.length, 0);
});

test("a snippet is trimmed of markup and length, not passed through raw", async () => {
  transport(ok({ web: { results: [{ title: "<b>Bold</b> title", url: "https://x.example/", description: "<script>bad()</script>" + "y".repeat(900) }] } }));
  const run = await S.search("brave", "q", { key: "k" });
  assert.ok(!run.results[0].title.includes("<b>"), "markup is stripped from the title");
  assert.ok(!run.results[0].snippet.includes("<script>"), "and from the snippet");
  assert.ok(run.results[0].snippet.length <= S.LIMITS.snippet);
});

test("every provider is declared with whether it needs anything", () => {
  assert.equal(S.PROVIDERS.wikipedia.keyless, true);
  assert.equal(S.PROVIDERS.searxng.needs, "instance");
  assert.equal(S.PROVIDERS.brave.needs, "key");
  assert.equal(S.PROVIDERS.tavily.needs, "key");
});
