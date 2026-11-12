// The endpoint other apps use to reach this machine's models.
// Security matters more than features here: it opens a port.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer, listen, newToken, sameToken, isMeshAddress } = require("../electron/share-server.cjs");

const MODELS = [
  { file_name: "gemma-2-2b-it-Q4_K_M.gguf", bytes: 1708582752, vision: false },
  { file_name: "SmolVLM-256M.gguf", bytes: 1000, vision: true },
];
const TOKEN = "test-token-abcdefghijklmnop";

/** A stand-in llama-server, so these tests do not need a real engine. */
function fakeEngine(onBody) {
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      onBody?.(JSON.parse(b || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })));
}

async function withServer(opts, fn) {
  const started = [];
  const engine = await fakeEngine(opts.onBody);
  const srv = createServer({
    listModels: () => MODELS,
    ensureEngine: async (f) => { started.push(f); if (opts.failEngine) throw new Error("no engine here"); return { base_url: engine.url }; },
    getToken: () => (opts.token === undefined ? TOKEN : opts.token),
    machineName: () => "test-mac",
  });
  const h = await listen(srv, { port: 0 });
  try { return await fn(h, started); } finally { h.close(); engine.s.close(); }
}

const call = (url, { method = "GET", token = TOKEN, body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers } },
      (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, text: t })); },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

test("a request without a token is refused, and says where to find one", async () => {
  await withServer({}, async (h) => {
    const r = await call(`${h.urls[0]}/v1/models`, { token: null });
    assert.equal(r.status, 401);
    assert.match(JSON.parse(r.text).error.message, /Settings/);
  });
});

test("a wrong token is refused", async () => {
  await withServer({}, async (h) => {
    assert.equal((await call(`${h.urls[0]}/v1/models`, { token: "wrong-token-aaaaaaaaaaaaaaa" })).status, 401);
    // A token of a different length must not be accepted either.
    assert.equal((await call(`${h.urls[0]}/v1/models`, { token: "short" })).status, 401);
  });
});

test("the server will not answer at all when no token is configured", async () => {
  await withServer({ token: "" }, async (h) => {
    assert.equal((await call(`${h.urls[0]}/v1/models`, { token: "" })).status, 401);
    assert.equal((await call(`${h.urls[0]}/forge/health`)).status, 401);
  });
});

test("a web page cannot call it, even with the right token", async () => {
  await withServer({}, async (h) => {
    const r = await call(`${h.urls[0]}/v1/models`, { headers: { origin: "https://example.com" } });
    assert.equal(r.status, 403);
  });
});

test("installed models are listed in the OpenAI shape", async () => {
  await withServer({}, async (h) => {
    const r = await call(`${h.urls[0]}/v1/models`);
    assert.equal(r.status, 200);
    const d = JSON.parse(r.text);
    assert.equal(d.object, "list");
    assert.deepEqual(d.data.map((m) => m.id), ["gemma-2-2b-it-Q4_K_M", "SmolVLM-256M"]);
    assert.equal(d.data[1].forge.vision, true, "a vision model says so");
  });
});

test("a chat request starts the named model and streams the engine's answer back", async () => {
  let seen = null;
  await withServer({ onBody: (b) => (seen = b) }, async (h, started) => {
    const r = await call(`${h.urls[0]}/v1/chat/completions`, {
      method: "POST",
      body: { model: "gemma-2-2b-it-Q4_K_M", messages: [{ role: "user", content: "hello" }], stream: true },
    });
    assert.equal(r.status, 200);
    assert.match(r.text, /\[DONE\]/, "the engine's stream reached the caller");
    assert.deepEqual(started, ["gemma-2-2b-it-Q4_K_M.gguf"], "the model was started by file name");
    assert.equal(seen.model, "gemma-2-2b-it-Q4_K_M.gguf", "the engine is given the name it knows");
    assert.equal(seen.messages[0].content, "hello", "the conversation is passed through unchanged");
  });
});

test("a model that is not installed is refused by name, and nothing is downloaded", async () => {
  await withServer({}, async (h, started) => {
    const r = await call(`${h.urls[0]}/v1/chat/completions`, { method: "POST", body: { model: "gpt-4o", messages: [] } });
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.text).error.message, /No model called "gpt-4o" is installed/);
    assert.deepEqual(started, [], "no model was started");
  });
});

test("an engine that will not start is reported, not hidden", async () => {
  await withServer({ failEngine: true }, async (h) => {
    const r = await call(`${h.urls[0]}/v1/chat/completions`, { method: "POST", body: { model: "SmolVLM-256M", messages: [] } });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.text).error.message, /no engine here/);
  });
});

test("only loopback is bound unless a mesh address is given, and a public address is refused", async () => {
  const srv = createServer({ listModels: () => MODELS, ensureEngine: async () => ({ base_url: "http://127.0.0.1:1" }), getToken: () => TOKEN });
  const h = await listen(srv, { port: 0 });
  assert.deepEqual(h.urls.length, 1, "one address when no mesh is asked for");
  assert.match(h.urls[0], /^http:\/\/127\.0\.0\.1:/);
  h.close();

  const srv2 = createServer({ listModels: () => MODELS, ensureEngine: async () => ({ base_url: "http://127.0.0.1:1" }), getToken: () => TOKEN });
  await assert.rejects(() => listen(srv2, { port: 0, meshAddress: "192.168.1.10" }), /not a private mesh address/);
  try { srv2.close(); } catch { /* never listened */ }
});

test("mesh addresses are recognised, and ordinary ones are not", () => {
  assert.equal(isMeshAddress("100.64.0.1"), true);
  assert.equal(isMeshAddress("100.127.255.254"), true);
  assert.equal(isMeshAddress("100.63.0.1"), false, "below the range");
  assert.equal(isMeshAddress("100.128.0.1"), false, "above the range");
  assert.equal(isMeshAddress("192.168.0.5"), false);
  assert.equal(isMeshAddress("10.0.0.1"), false);
});

test("tokens are random, long, and compared safely", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 24, "long enough not to be guessed");
  assert.equal(sameToken(a, a), true);
  assert.equal(sameToken(a, b), false);
  assert.equal(sameToken("", ""), false, "an empty token never matches");
  assert.equal(sameToken(null, undefined), false);
});

test("an oversized body is rejected rather than buffered", async () => {
  await withServer({}, async (h) => {
    const big = "x".repeat(9 * 1024 * 1024);
    const r = await call(`${h.urls[0]}/v1/chat/completions`, { method: "POST", body: { model: "SmolVLM-256M", messages: [{ role: "user", content: big }] } })
      .catch((e) => ({ status: 413, text: String(e.message) }));
    assert.ok(r.status === 413 || r.status >= 400, "a body over the cap does not succeed");
  });
});

test("an unknown path says what the endpoint does offer", async () => {
  await withServer({}, async (h) => {
    const r = await call(`${h.urls[0]}/v1/embeddings`);
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.text).error.message, /v1\/models/);
  });
});
