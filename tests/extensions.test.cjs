// Run with: pnpm test. Skills and connectors, without the OS keychain.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Electron's binary is not needed here; stub the module the keychain code imports.
const electronPath = require.resolve("electron", { paths: [path.join(__dirname, "../electron")] });
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { safeStorage: undefined, app: undefined } };
const skills = require("../electron/skills.cjs");
const connectors = require("../electron/connectors.cjs");

const tempDir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "forge-ext-"));

test("skills: add, enable, export, and only enabled skills reach the prompt", () => {
  skills.load(tempDir());
  const on = skills.add({ name: "Plain English", instructions: "Explain without jargon." });
  const off = skills.add({ name: "Haiku", instructions: "Answer in haiku.", enabled: false });
  assert.deepEqual(skills.forPrompt().map((s) => s.name), ["Plain English"]);
  skills.update({ id: off.id, enabled: true });
  assert.equal(skills.forPrompt().length, 2);
  skills.update({ id: on.id, enabled: false });
  assert.deepEqual(skills.forPrompt().map((s) => s.name), ["Haiku"]);
  assert.equal(skills.exportAll().length, 2);
  skills.remove(on.id);
  assert.equal(skills.list().length, 1);
});

test("skills: an empty name or empty instructions is refused", () => {
  skills.load(tempDir());
  assert.throws(() => skills.add({ name: "", instructions: "x" }), /needs a name/);
  assert.throws(() => skills.add({ name: "x", instructions: "   " }), /needs instructions/);
});

test("skills: import adds copies and never overwrites existing skills", () => {
  skills.load(tempDir());
  skills.add({ name: "Same", instructions: "original" });
  const r = skills.importAll([{ name: "Same", instructions: "replacement" }, { name: "", instructions: "bad" }]);
  assert.equal(r.added, 1);
  assert.equal(skills.list().find((s) => s.name === "Same").instructions, "original");
});

test("connectors: only https, or http to this computer, is accepted", () => {
  connectors.load(tempDir());
  assert.throws(() => connectors.add({ name: "a", base_url: "http://example.com" }), /https/);
  assert.throws(() => connectors.add({ name: "a", base_url: "ftp://127.0.0.1" }), /https/);
  assert.throws(() => connectors.add({ name: "a", base_url: "https://u:p@example.com" }), /credentials/);
  assert.throws(() => connectors.add({ name: "a", base_url: "https://example.com", auth_header: "bad header" }), /letters/);
  const ok = connectors.add({ name: "Local", base_url: "http://127.0.0.1:9999/" });
  assert.equal(ok.base_url, "http://127.0.0.1:9999");
});

test("connectors: a request reaches the address and returns status and body", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`hello ${req.url}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  connectors.load(tempDir());
  const c = connectors.add({ name: "Local", base_url: `http://127.0.0.1:${server.address().port}` });
  try {
    const r = await connectors.call(c.id, { path: "/status" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "hello /status");
  } finally {
    server.close();
  }
});

test("connectors: redirects are not followed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  connectors.load(tempDir());
  const c = connectors.add({ name: "Redirect", base_url: `http://127.0.0.1:${server.address().port}` });
  try {
    await assert.rejects(connectors.call(c.id, { path: "/" }), /redirect/);
  } finally {
    server.close();
  }
});
