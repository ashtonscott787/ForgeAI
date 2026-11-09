// Run with: pnpm test. Cloud provider behaviour against fixture servers that
// speak each vendor's wire format. None of these calls reach a real provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { stream, listModels, ProviderError, redact, checkModelId } = require("../electron/providers.cjs");

function fixture(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const sse = (res, frames) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.end();
};
const collect = () => { const out = []; return { out, onToken: (t) => out.push(t) }; };

// ── model listing (the connection test uses this) ─────────────

test("anthropic: lists models across pages, with the key in x-api-key", async () => {
  const seen = [];
  const s = await fixture((req, res) => {
    seen.push({ key: req.headers["x-api-key"], url: req.url });
    if (!req.url.includes("after_id")) return json(res, 200, { data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" });
    return json(res, 200, { data: [{ id: "claude-b", display_name: "Claude B" }], has_more: false, last_id: "claude-b" });
  });
  const r = await listModels("anthropic", { apiKey: "sk-ant-test-123456", baseUrl: base(s) });
  s.close();
  assert.deepEqual(r.models.map((m) => m.id), ["claude-a", "claude-b"]);
  assert.equal(r.models[0].label, "Claude A");
  assert.ok(seen.every((x) => x.key === "sk-ant-test-123456"));
  assert.match(seen[1].url, /after_id=claude-a/);
});

test("openai: lists chat models and drops non-chat ones", async () => {
  const s = await fixture((req, res) => json(res, 200, { object: "list", data: [
    { id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "tts-1" }, { id: "o3-mini" },
  ] }));
  const r = await listModels("openai", { apiKey: "sk-test-abcdefgh", baseUrl: base(s) });
  s.close();
  assert.deepEqual(r.models.map((m) => m.id), ["gpt-4o", "o3-mini"]);
});

test("a 401 on the test is an auth failure, and the key never appears in the message", async () => {
  const key = "sk-live-SECRETVALUE99";
  const s = await fixture((req, res) => { res.writeHead(401); res.end(`bad key ${key}`); });
  await assert.rejects(listModels("openai", { apiKey: key, baseUrl: base(s) }), (e) => {
    assert.ok(e instanceof ProviderError && e.kind === "auth" && e.status === 401);
    assert.doesNotMatch(e.message, /SECRETVALUE/);
    return true;
  });
  s.close();
});

test("a key echoed in an error body is redacted before it can be shown", () => {
  assert.equal(redact("token sk-abcdef123456 failed", "sk-abcdef123456"), "token [key removed] failed");
  assert.equal(redact("short", "abc"), "short", "very short keys are not used as redaction patterns");
});

test("a malformed model list is reported, not silently treated as empty", async () => {
  const s = await fixture((req, res) => json(res, 200, { unexpected: true }));
  await assert.rejects(listModels("anthropic", { apiKey: "sk-ant-x-1234567", baseUrl: base(s) }), (e) => e.kind === "malformed");
  s.close();
});

test("a response that is not JSON is malformed, not a crash", async () => {
  const s = await fixture((req, res) => { res.writeHead(200); res.end("<html>proxy error</html>"); });
  await assert.rejects(listModels("openai", { apiKey: "sk-test-abcdefgh", baseUrl: base(s) }), (e) => e.kind === "malformed");
  s.close();
});

test("a redirect is refused rather than followed", async () => {
  const s = await fixture((req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/x" }); res.end(); });
  await assert.rejects(listModels("openai", { apiKey: "sk-test-abcdefgh", baseUrl: base(s) }), (e) => e.kind === "redirect");
  s.close();
});

test("a provider that never answers times out with a clear kind", async () => {
  const s = await fixture(() => { /* never respond */ });
  await assert.rejects(listModels("openai", { apiKey: "sk-test-abcdefgh", baseUrl: base(s), timeoutMs: 150 }), (e) => e.kind === "timeout");
  s.close();
});

test("unknown providers and missing keys are refused before any request", async () => {
  await assert.rejects(listModels("mystery", { apiKey: "sk-x-abcdefghi" }), (e) => e.kind === "unsupported");
  await assert.rejects(listModels("openai", { apiKey: "" }), (e) => e.kind === "auth");
});

// ── model identifiers and request limits ─────────────────────

test("model identifiers are validated, so path tricks and shell text are refused", () => {
  assert.equal(checkModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.throws(() => checkModelId("../../v1/admin"), (e) => e.kind === "bad_request");
  assert.throws(() => checkModelId("x; rm -rf /"), (e) => e.kind === "bad_request");
  assert.throws(() => checkModelId(""), (e) => e.kind === "bad_request");
});

test("an oversized request is refused before it is sent", async () => {
  await assert.rejects(stream("openai", { baseUrl: "http://127.0.0.1:9", apiKey: "sk-test-abcdefgh", model: "gpt-4o",
    messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }], onToken() {} }), (e) => e.kind === "limit");
});

// ── streaming ────────────────────────────────────────────────

test("anthropic: streamed text and reported usage are returned", async () => {
  const s = await fixture((req, res) => { req.resume(); req.on("end", () => sse(res, [
    JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 42 } } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "there" } }),
    JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
  ])); });
  const c = collect();
  const r = await stream("anthropic", { baseUrl: base(s), apiKey: "sk-ant-test-123456", model: "claude-a", messages: [{ role: "user", content: "x" }], onToken: c.onToken });
  s.close();
  assert.equal(c.out.join(""), "Hi there");
  assert.deepEqual(r.usage, { input: 42, output: 7 });
});

test("openai: usage is reported only when the provider sends it", async () => {
  const withUsage = await fixture((req, res) => { req.resume(); req.on("end", () => sse(res, [
    JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    "[DONE]",
  ])); });
  const without = await fixture((req, res) => { req.resume(); req.on("end", () => sse(res, [
    JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), "[DONE]",
  ])); });
  const a = await stream("openai", { baseUrl: base(withUsage), apiKey: "sk-test-abcdefgh", model: "gpt-4o", messages: [{ role: "user", content: "x" }], onToken() {} });
  const b = await stream("openai", { baseUrl: base(without), apiKey: "sk-test-abcdefgh", model: "gpt-4o", messages: [{ role: "user", content: "x" }], onToken() {} });
  withUsage.close(); without.close();
  assert.deepEqual(a.usage, { input: 5, output: 2 });
  assert.deepEqual(b.usage, { input: null, output: null }, "unreported usage is null, not zero");
});

test("a malformed stream frame fails the request cleanly", async () => {
  const s = await fixture((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200); res.write("data: {not json\n\n"); res.end(); }); });
  await assert.rejects(stream("openai", { baseUrl: base(s), apiKey: "sk-test-abcdefgh", model: "gpt-4o", messages: [{ role: "user", content: "x" }], onToken() {} }), (e) => e.kind === "malformed");
  s.close();
});

test("an error event inside the stream is reported, with the key removed", async () => {
  const key = "sk-stream-KEYVALUE7777";
  const s = await fixture((req, res) => { req.resume(); req.on("end", () => sse(res, [
    JSON.stringify({ type: "error", error: { message: `invalid ${key}` } }),
  ])); });
  await assert.rejects(stream("anthropic", { baseUrl: base(s), apiKey: key, model: "claude-a", messages: [{ role: "user", content: "x" }], onToken() {} }), (e) => {
    assert.equal(e.kind, "server");
    assert.doesNotMatch(e.message, /KEYVALUE/);
    return true;
  });
  s.close();
});

test("two concurrent streams keep their own text and do not mix", async () => {
  const s = await fixture((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const label = JSON.parse(body).model;
      sse(res, [1, 2, 3].map((i) => JSON.stringify({ choices: [{ delta: { content: `${label}-${i} ` } }] })));
    });
  });
  const a = collect(), b = collect();
  const [ra, rb] = await Promise.all([
    stream("openai", { baseUrl: base(s), apiKey: "sk-test-abcdefgh", model: "alpha", messages: [{ role: "user", content: "1" }], onToken: a.onToken }),
    stream("openai", { baseUrl: base(s), apiKey: "sk-test-abcdefgh", model: "beta", messages: [{ role: "user", content: "2" }], onToken: b.onToken }),
  ]);
  s.close();
  assert.equal(a.out.join(""), "alpha-1 alpha-2 alpha-3 ");
  assert.equal(b.out.join(""), "beta-1 beta-2 beta-3 ");
  assert.equal(ra.tokens, 3);
  assert.equal(rb.tokens, 3);
});

test("cancelling one stream leaves a concurrent stream running", async () => {
  const s = await fixture((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const label = JSON.parse(body).model;
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${label}${i++} ` } }] })}\n\n`);
        if (i >= 20) { clearInterval(t); res.end(); }
      }, 10);
      res.on("close", () => clearInterval(t));
    });
  });
  const ac = new AbortController();
  const keep = collect(), drop = collect();
  const kept = stream("openai", { baseUrl: base(s), apiKey: "sk-test-abcdefgh", model: "keep", messages: [{ role: "user", content: "k" }], onToken: keep.onToken });
  const cut = stream("openai", { baseUrl: base(s), apiKey: "sk-test-abcdefgh", model: "cut", messages: [{ role: "user", content: "c" }], signal: ac.signal, onToken: drop.onToken });
  setTimeout(() => ac.abort(), 40);
  await assert.rejects(cut, (e) => e.kind === "cancelled");
  const r = await kept;
  s.close();
  assert.equal(r.tokens, 20, "the other request finished in full");
  assert.ok(drop.out.length < 20, "the cancelled one stopped early");
});
