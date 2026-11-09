// Run with: pnpm test. Provider adapters against fixture servers in each vendor's SSE format.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { stream, ProviderError } = require("../electron/providers.cjs");

function fixture(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const sse = (res, frames) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.end();
};

test("anthropic: text deltas stream in order and the key goes in x-api-key", async () => {
  let seen = {};
  const s = await fixture((req, res) => {
    seen = { key: req.headers["x-api-key"], version: req.headers["anthropic-version"], path: req.url };
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      seen.body = JSON.parse(body);
      sse(res, [
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "héllo " } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "🙂 world" } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ]);
    });
  });
  const out = [];
  const r = await stream("anthropic", { baseUrl: base(s), apiKey: "sk-test", model: "m", system: "be brief", messages: [{ role: "user", content: "hi" }], onToken: (t) => out.push(t) });
  s.close();
  assert.equal(out.join(""), "héllo 🙂 world");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(seen.key, "sk-test");
  assert.equal(seen.version, "2023-06-01");
  assert.equal(seen.path, "/v1/messages");
  assert.equal(seen.body.system, "be brief");
  assert.equal(seen.body.stream, true);
});

test("openai: delta content streams and [DONE] ends cleanly", async () => {
  const s = await fixture((req, res) => {
    req.on("data", () => {}); req.on("end", () => sse(res, [
      JSON.stringify({ choices: [{ delta: { content: "a" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "b" }, finish_reason: "stop" }] }),
      "[DONE]",
    ]));
  });
  const out = [];
  const r = await stream("openai", { baseUrl: base(s), apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }], onToken: (t) => out.push(t) });
  s.close();
  assert.equal(out.join(""), "ab");
  assert.equal(r.stopReason, "stop");
});

test("HTTP 401 and 429 map to clear, typed errors", async () => {
  const s = await fixture((req, res) => { req.resume(); req.on("end", () => { res.writeHead(req.url === "/v1/messages" ? 401 : 429); res.end("{}"); }); });
  await assert.rejects(stream("anthropic", { baseUrl: base(s), apiKey: "bad", model: "m", messages: [], onToken() {} }), (e) => e instanceof ProviderError && e.kind === "auth");
  await assert.rejects(stream("openai", { baseUrl: base(s), apiKey: "k", model: "m", messages: [], onToken() {} }), (e) => e instanceof ProviderError && e.kind === "rate_limit");
  s.close();
});

test("aborting mid-stream stops tokens and reports cancellation", async () => {
  const s = await fixture((req, res) => {
    req.resume(); req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => { if (res.destroyed) return clearInterval(t); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" + i++ } }] })}\n\n`); }, 10);
      req.on("close", () => clearInterval(t));
    });
  });
  const ac = new AbortController();
  let after = 0, cancelled = false;
  setTimeout(() => { cancelled = true; ac.abort(); }, 80);
  await assert.rejects(stream("openai", { baseUrl: base(s), apiKey: "k", model: "m", messages: [], signal: ac.signal, onToken() { if (cancelled) after++; } }), (e) => e.kind === "cancelled");
  await new Promise((r) => setTimeout(r, 60));
  s.close();
  assert.equal(after, 0, "no tokens are delivered after the abort");
});

test("insecure remote addresses, missing keys and unknown providers are refused", async () => {
  await assert.rejects(stream("openai", { baseUrl: "http://example.com", apiKey: "k", model: "m", messages: [], onToken() {} }), /https/);
  await assert.rejects(stream("openai", { apiKey: "", model: "m", messages: [], onToken() {} }), /No key/);
  await assert.rejects(stream("nope", { apiKey: "k", model: "m", messages: [], onToken() {} }), /no adapter/);
});

test("an unreachable provider reports a network error", async () => {
  await assert.rejects(stream("openai", { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m", messages: [], onToken() {} }), (e) => e.kind === "network");
});
