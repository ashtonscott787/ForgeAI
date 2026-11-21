// What is actually connected. The whole point is that nothing reports
// "connected" because it was configured, so the tests are mostly about the
// difference between off, not set up, and failed.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const S = require("../electron/status.cjs");

const base = (over = {}) => ({
  engine: { running: false, port: 0, model_file: null },
  shared: { enabled: false, running: false, urls: [], mesh_enabled: false },
  settings: { search_provider: "wikipedia" },
  secrets: { get: () => null },
  models: [],
  packs: 0,
  agents: 0,
  meshAddress: () => null,
  ...over,
});

const row = (snap, name) => snap.rows.find((r) => r.name === name);

test("a port nothing is listening on is reported as failed, with how long it took", async () => {
  const r = await S.probe({ host: "127.0.0.1", port: 1, timeout: 2000 });
  assert.equal(r.ok, false);
  assert.ok(typeof r.ms === "number" && r.ms >= 0, "a duration is measured either way");
  assert.ok(r.detail, "and a reason is given");
});

test("a port that is listening is reported as connected", async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await S.probe({ host: "127.0.0.1", port: srv.address().port });
    assert.equal(r.ok, true);
    assert.equal(r.detail, "");
  } finally { srv.close(); }
});

test("an engine that says it is running but answers nothing is failed, not connected", async () => {
  // This is the case the whole module exists for: configured is not connected.
  const snap = await S.snapshot(base({ engine: { running: true, port: 1, model_file: "gemma.gguf" } }));
  const engine = row(snap, "Inference engine");
  assert.equal(engine.state, "failed");
  assert.ok(engine.note, "and it says why");
  assert.equal(snap.worst, "failed");
  assert.match(snap.headline, /not working/);
});

test("an engine that is really listening is connected, with a latency", async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const snap = await S.snapshot(base({ engine: { running: true, port: srv.address().port, model_file: "gemma.gguf" } }));
    const engine = row(snap, "Inference engine");
    assert.equal(engine.state, "connected");
    assert.equal(engine.detail, "gemma.gguf");
    assert.ok(typeof engine.ms === "number", "the time is measured, not estimated");
  } finally { srv.close(); }
});

test("off and not set up are different states", async () => {
  const snap = await S.snapshot(base());
  assert.equal(row(snap, "Inference engine").state, "off", "no model loaded is off, not broken");
  assert.equal(row(snap, "Models").state, "not_set_up", "nothing installed is not set up");
  assert.equal(row(snap, "Local endpoint").state, "off", "sharing switched off is off");
  assert.equal(row(snap, "Incoming (IMAP)").state, "not_set_up");
  assert.notEqual(snap.worst, "failed", "none of that is a failure");
});

test("a mesh address is reported when there is one, and plainly absent when not", async () => {
  const without = await S.snapshot(base());
  assert.equal(row(without, "Tailscale").state, "not_set_up");
  assert.match(row(without, "Tailscale").note, /Start Tailscale/);

  const with_ = await S.snapshot(base({ meshAddress: () => "100.88.1.4" }));
  assert.equal(row(with_, "Tailscale").state, "connected");
  assert.equal(row(with_, "Tailscale").detail, "100.88.1.4");
});

test("sharing switched on for the mesh but not bound to it is a failure, not a success", async () => {
  const snap = await S.snapshot(base({
    meshAddress: () => "100.88.1.4",
    shared: { enabled: true, running: true, mesh_enabled: true, urls: ["http://127.0.0.1:11435"] },
  }));
  const r = row(snap, "Shared to the mesh");
  assert.equal(r.state, "failed", "it was asked for and did not happen");
  assert.match(r.note, /not available/);
});

test("sharing bound to the mesh says where it can be reached", async () => {
  const snap = await S.snapshot(base({
    meshAddress: () => "100.88.1.4",
    shared: { enabled: true, running: true, mesh_enabled: true, urls: ["http://127.0.0.1:11435", "http://100.88.1.4:11435"] },
  }));
  const r = row(snap, "Shared to the mesh");
  assert.equal(r.state, "connected");
  assert.match(r.detail, /100\.88\.1\.4/);
});

test("a search engine needing a key it does not have is not set up", async () => {
  const snap = await S.snapshot(base({ settings: { search_provider: "brave" }, secrets: { get: () => null } }));
  const r = row(snap, "brave");
  assert.equal(r.state, "not_set_up");
  assert.match(r.note, /key/);

  const withKey = await S.snapshot(base({ settings: { search_provider: "brave" }, secrets: { get: () => "k" } }));
  assert.equal(row(withKey, "brave").state, "connected");
});

test("the headline never rounds a failure up to fine", async () => {
  const snap = await S.snapshot(base({
    models: [{ file_name: "a.gguf" }],
    packs: 2,
    engine: { running: true, port: 1, model_file: "a.gguf" },
  }));
  assert.ok(snap.counts.connected > 0, "some things are connected");
  assert.equal(snap.counts.failed, 1, "and one is not");
  assert.match(snap.headline, /1 not working/, "the failure is what gets said");
});

test("one slow service does not stop the rest being reported", async () => {
  const snap = await S.snapshot(base({
    settings: { search_provider: "wikipedia", imap_host: "10.255.255.1", imap_port: 993 },
    models: [{ file_name: "a.gguf" }],
  }));
  assert.ok(snap.rows.length >= 7, "every group still reported");
  assert.equal(row(snap, "Models").state, "connected");
});
