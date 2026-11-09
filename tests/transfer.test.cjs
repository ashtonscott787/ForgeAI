// Run with: pnpm test
// Exercises electron/transfer.cjs against a real local HTTP server.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { downloadModel } = require("../electron/transfer.cjs");

const win = { webContents: { send() {} } };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const urlOf = (server) => `http://127.0.0.1:${server.address().port}/model.gguf`;

function fullHandler(data) {
  return (req, res) => {
    const range = req.headers.range;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      if (start >= data.length) { res.writeHead(416); return res.end(); }
      res.writeHead(206, { "Content-Length": data.length - start });
      return res.end(data.subarray(start));
    }
    res.writeHead(200, { "Content-Length": data.length });
    res.end(data);
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "forge-dl-"));
}

test("downloads a complete file and verifies its checksum", async () => {
  const data = crypto.randomBytes(300_000);
  const server = await serve(fullHandler(data));
  const dir = tempDir();
  try {
    const out = await downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "a.gguf", sha256: sha(data) });
    assert.deepEqual(fs.readFileSync(out), data);
    assert.equal(fs.existsSync(out + ".part"), false);
  } finally { server.close(); }
});

test("resumes from a partial file with a Range request", async () => {
  const data = crypto.randomBytes(200_000);
  const server = await serve(fullHandler(data));
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "b.gguf.part"), data.subarray(0, 80_000));
    const out = await downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "b.gguf", sha256: sha(data) });
    assert.deepEqual(fs.readFileSync(out), data);
  } finally { server.close(); }
});

test("restarts once when the partial file is rejected with 416", async () => {
  const data = crypto.randomBytes(120_000);
  const server = await serve(fullHandler(data));
  const dir = tempDir();
  try {
    // Larger than the real file, so the server cannot satisfy the Range.
    fs.writeFileSync(path.join(dir, "c.gguf.part"), crypto.randomBytes(500_000));
    const out = await downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "c.gguf", sha256: sha(data) });
    assert.deepEqual(fs.readFileSync(out), data);
  } finally { server.close(); }
});

test("a connection dropped mid-body fails and never produces the final file", async () => {
  const data = crypto.randomBytes(400_000);
  const server = await serve((req, res) => {
    res.writeHead(200, { "Content-Length": data.length });
    res.write(data.subarray(0, 100_000));
    setTimeout(() => res.socket.destroy(), 50);
  });
  const dir = tempDir();
  try {
    await assert.rejects(
      downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "d.gguf", sha256: "", retryWaits: [] }),
      /interrupted|cut short|dropped|stalled/,
    );
    assert.equal(fs.existsSync(path.join(dir, "d.gguf")), false, "a truncated model must not be installed");
    assert.equal(fs.existsSync(path.join(dir, "d.gguf.part")), true, "the partial file is kept for resume");
  } finally { server.close(); }
});

test("a checksum mismatch is refused and the file is discarded", async () => {
  const data = crypto.randomBytes(50_000);
  const server = await serve(fullHandler(data));
  const dir = tempDir();
  try {
    await assert.rejects(
      downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "e.gguf", sha256: "0".repeat(64) }),
      /checksum/,
    );
    assert.equal(fs.existsSync(path.join(dir, "e.gguf.part")), false);
    assert.equal(fs.existsSync(path.join(dir, "e.gguf")), false);
  } finally { server.close(); }
});

test("a second request for the same model while one is running is refused", async () => {
  const data = crypto.randomBytes(20_000);
  const server = await serve((req, res) => {
    res.writeHead(200, { "Content-Length": data.length });
    setTimeout(() => res.end(data), 200);
  });
  const dir = tempDir();
  try {
    const first = downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "f.gguf", sha256: "" });
    await assert.rejects(
      downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "f.gguf", sha256: "" }),
      /already downloading/,
    );
    await first;
  } finally { server.close(); }
});

test("a connection dropped mid-download is retried and resumes from the partial file", async () => {
  const data = crypto.randomBytes(300_000);
  let requests = 0;
  const server = await serve((req, res) => {
    requests += 1;
    const range = req.headers.range;
    if (requests === 1) {
      // First attempt: send part of the body, then drop the connection.
      res.writeHead(200, { "Content-Length": data.length });
      res.write(data.subarray(0, 100_000));
      setTimeout(() => res.socket.destroy(), 30);
      return;
    }
    // Later attempts: honour the Range request, as a real server does.
    const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    res.writeHead(range ? 206 : 200, { "Content-Length": data.length - start });
    res.end(data.subarray(start));
  });
  const dir = tempDir();
  try {
    const out = await downloadModel(win, { dir, modelId: "m", url: urlOf(server), fileName: "r.gguf", sha256: sha(data), retryWaits: [10] });
    assert.deepEqual(fs.readFileSync(out), data);
    assert.equal(requests, 2, "one retry, which resumed");
  } finally { server.close(); }
});
