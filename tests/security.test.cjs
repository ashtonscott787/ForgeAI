// The security check. A security feature that overclaims is worse than none,
// so the tests are about what it finds, what it refuses to claim, and that it
// never changes anything itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../electron/security.cjs");

const base = (over = {}) => ({
  settings: {},
  secrets: { available: () => true },
  shared: { enabled: false, running: false },
  meshAddress: () => null,
  engineMissing: () => [],
  version: "0.5.6",
  latest: "0.5.6",
  platform: "darwin",
  ...over,
});
const find = (r, id) => r.findings.find((f) => f.id === id);

test("a clean setup reports nothing, and still states what it did not look at", () => {
  const r = S.audit(base());
  assert.deepEqual(r.findings, []);
  assert.equal(r.worst, "ok");
  assert.match(r.headline, /Nothing to fix/);
  assert.match(r.scope, /not an antivirus/, "the limits are stated even when all is well");
  assert.match(r.scope, /does not scan your operating system/);
});

test("sharing switched on with no token is the highest finding", () => {
  const r = S.audit(base({ shared: { enabled: true, running: true }, settings: { share_token: "" } }));
  const f = find(r, "share-no-token");
  assert.equal(f.severity, "high");
  assert.match(f.fix, /New token/);
  assert.equal(r.worst, "high");
});

test("a short token is flagged, a long one is not", () => {
  const short = S.audit(base({ shared: { enabled: true, running: true }, settings: { share_token: "abc123" } }));
  assert.equal(find(short, "share-weak-token").severity, "medium");
  const long = S.audit(base({ shared: { enabled: true, running: true }, settings: { share_token: "x".repeat(32) } }));
  assert.equal(find(long, "share-weak-token"), undefined);
});

test("sharing that is off is not a finding at all", () => {
  const r = S.audit(base({ settings: { share_token: "" } }));
  assert.equal(find(r, "share-no-token"), undefined, "an endpoint nobody can reach is not a weakness");
});

test("mesh sharing is reported as what it is, not as a problem", () => {
  const r = S.audit(base({ shared: { enabled: true, running: true, mesh_enabled: true }, settings: { share_token: "x".repeat(32) }, meshAddress: () => "100.88.1.4" }));
  const f = find(r, "share-mesh");
  assert.equal(f.severity, "low");
  assert.match(f.fix, /what the setting is for/, "it does not scold someone for using a feature");
});

test("an unavailable key store is serious, and the message says why refusing is right", () => {
  const r = S.audit(base({ secrets: { available: () => false } }));
  const f = find(r, "no-keystore");
  assert.equal(f.severity, "high");
  assert.match(f.fix, /safer than writing them in plain text/);
});

test("an engine that cannot load is reported as high", () => {
  const r = S.audit(base({ engineMissing: () => [{ name: "libllama.0.dylib" }, { name: "libggml.0.dylib" }] }));
  const f = find(r, "engine-broken");
  assert.equal(f.severity, "high");
  assert.match(f.found, /2 libraries/);
});

test("being out of date is reported with both versions", () => {
  const r = S.audit(base({ version: "0.5.2", latest: "0.5.6" }));
  const f = find(r, "out-of-date");
  assert.match(f.found, /0\.5\.2/);
  assert.match(f.found, /0\.5\.6/);
  assert.equal(S.audit(base({ version: "0.5.6", latest: "0.5.6" })).findings.length, 0, "being current is not a finding");
  assert.equal(S.audit(base({ version: "0.5.6", latest: null })).findings.length, 0, "an unknown latest version invents nothing");
});

test("unencrypted outgoing mail is flagged, and a normal port is not", () => {
  const odd = S.audit(base({ settings: { mail_host: "smtp.example.com", mail_port: 25, mail_secure: false } }));
  assert.equal(find(odd, "smtp-port").severity, "medium");
  const fine = S.audit(base({ settings: { mail_host: "smtp.example.com", mail_port: 587, mail_secure: false } }));
  assert.equal(find(fine, "smtp-port"), undefined);
});

test("findings come back worst first", () => {
  const r = S.audit(base({
    shared: { enabled: true, running: true, mesh_enabled: true },
    settings: { share_token: "", mail_provider: "microsoft" },
    meshAddress: () => "100.88.1.4",
    version: "0.5.2", latest: "0.5.6",
  }));
  const order = r.findings.map((f) => f.severity);
  const rank = { high: 3, medium: 2, low: 1 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i - 1]] >= rank[order[i]], `${order[i - 1]} came before ${order[i]}`);
  }
  assert.equal(r.worst, "high");
});

test("every finding says what was seen and what to do about it", () => {
  const r = S.audit(base({
    shared: { enabled: true, running: true }, settings: { share_token: "" },
    secrets: { available: () => false },
    engineMissing: () => [{ name: "x" }],
    version: "0.5.2", latest: "0.5.6",
  }));
  assert.ok(r.findings.length >= 4);
  for (const f of r.findings) {
    assert.ok(f.title && f.found && f.fix, `${f.id} is incomplete`);
    assert.ok(["high", "medium", "low"].includes(f.severity));
    assert.ok(f.area, `${f.id} says which part of the app it is about`);
  }
});

test("it changes nothing by itself", () => {
  // A security tool that edits settings on its own is a security problem.
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "security.cjs"), "utf8");
  // Call shapes, not substrings: process.execPath is a read and contains
  // "exec", which an earlier version of this check flagged.
  for (const bad of [/\bwriteFileSync\s*\(/, /\bsaveSettings\s*\(/, /secrets\.set\s*\(/, /\brmSync\s*\(/, /\bspawn(Sync)?\s*\(/, /\bexec(File|Sync)?\s*\(/, /\brequire\(["']node:child_process["']\)/]) {
    assert.ok(!bad.test(src), `security.cjs must not call ${bad}`);
  }
  const before = base();
  const snapshot = JSON.stringify(before.settings);
  S.audit(before);
  assert.equal(JSON.stringify(before.settings), snapshot, "the settings it was handed are unchanged");
});
