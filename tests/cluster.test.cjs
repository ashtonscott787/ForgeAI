// Linking computers together. The worker has no authentication of any kind,
// so where it is allowed to listen is the part worth testing hardest.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const cluster = require(path.join(__dirname, "..", "electron", "cluster.cjs"));

test("a private address is told from a public one", () => {
  for (const host of ["127.0.0.1", "10.0.0.4", "192.168.1.20", "172.16.3.1", "172.31.255.4", "100.101.102.103", "fd7a::1", "fe80::1"]) {
    assert.equal(cluster.isPrivateAddress(host), true, `${host} is private`);
  }
  for (const host of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "203.0.113.9", ""]) {
    assert.equal(cluster.isPrivateAddress(host), false, `${host} is not private`);
  }
});

test("an address is parsed, or refused, but never half-parsed", () => {
  assert.deepEqual(cluster.parsePeer("192.168.1.5"), { host: "192.168.1.5", port: 50052 });
  assert.deepEqual(cluster.parsePeer(" studio.local:50100 "), { host: "studio.local", port: 50100 });
  assert.deepEqual(cluster.parsePeer("[fd7a::1]:50052"), { host: "fd7a::1", port: 50052 });
  for (const bad of ["", "   ", "host:0", "host:70000", "host:abc", "a:b:c", "has space:1", null]) {
    assert.equal(cluster.parsePeer(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("a port that is open is reachable, and one that is not says why", async () => {
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const good = await cluster.reach({ host: "127.0.0.1", port });
    assert.equal(good.ok, true);
    assert.equal(typeof good.ms, "number");
  } finally {
    server.close();
  }
  const bad = await cluster.reach({ host: "127.0.0.1", port });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /nothing is listening/);

  const nowhere = await cluster.reach({ host: "no-such-host.invalid", port: 50052 }, 2500);
  assert.equal(nowhere.ok, false);
  assert.ok(nowhere.why.length > 0, "and it says what went wrong");
});

test("only the machines that answered are handed to the engine", () => {
  const peers = [
    { host: "10.0.0.2", port: 50052, ok: true },
    { host: "10.0.0.3", port: 50052, ok: false },
    { host: "10.0.0.4", port: 50100, ok: true },
  ];
  assert.deepEqual(cluster.rpcFlags(peers), ["--rpc", "10.0.0.2:50052,10.0.0.4:50100"]);
  // An address nothing is listening on makes llama-server fail to start, so
  // one unplugged laptop would otherwise read as "Forge AI is broken".
  assert.deepEqual(cluster.rpcFlags([{ host: "10.0.0.3", port: 50052, ok: false }]), []);
  assert.deepEqual(cluster.rpcFlags([]), []);
});

test("an IPv6 peer keeps its brackets when it is passed on", () => {
  assert.deepEqual(cluster.rpcFlags([{ host: "fd7a::1", port: 50052, ok: true }]), ["--rpc", "[fd7a::1]:50052"]);
});

test("the worker refuses to listen somewhere it should not", () => {
  const bin = process.execPath;
  assert.throws(
    () => cluster.startWorker({ bin, host: "0.0.0.0" }),
    /no password of any kind/i,
    "every interface is not offered by default",
  );
  assert.throws(
    () => cluster.startWorker({ bin, host: "203.0.113.9" }),
    /not a private address/i,
    "and neither is a public one",
  );
});

test("reaching several machines reports each one by name", async () => {
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const rows = await cluster.reachAll([
      { host: "127.0.0.1", port },
      { host: "127.0.0.1", port: 1 },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].label, `127.0.0.1:${port}`);
    assert.equal(rows[1].ok, false);
    assert.ok(rows[1].why);
  } finally {
    server.close();
  }
});

test("this machine's own addresses are listed, and marked private or not", () => {
  const found = cluster.localAddresses();
  assert.ok(Array.isArray(found));
  for (const nic of found) {
    assert.equal(typeof nic.address, "string");
    assert.equal(nic.private, cluster.isPrivateAddress(nic.address));
  }
});

test("the engine bundle ships the worker this needs", () => {
  const fs = require("node:fs");
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "get-engine.cjs"), "utf8");
  // Clustering is impossible without it, and it was filtered out of the
  // bundle for every release up to 0.6.6.
  assert.match(script, /ggml-rpc-server/, "the worker binary is kept from the archive");
});
