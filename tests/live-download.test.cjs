// Live: the model download the app performs, checked against Hugging Face.
// Run with: FORGE_LIVE=1 NODE_USE_ENV_PROXY=1 node --test tests/live-download.test.cjs
// Downloads about 1.7 GB. Skipped unless FORGE_LIVE=1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const live = process.env.FORGE_LIVE === "1";
const { resolveArtifact } = require("../electron/hf.cjs");
const { downloadModel } = require("../electron/transfer.cjs");

const REPO = "bartowski/gemma-2-2b-it-GGUF";
const EXPECTED_NAME = "gemma-2-2b-it-Q4_K_M.gguf";

/** HEAD on the file: independent of the repository listing. Returns Content-Length and the LFS checksum. */
function head(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: "HEAD", headers: { "User-Agent": "ForgeAI-test" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); resolve(head(new URL(res.headers.location, url).toString(), redirects + 1)); return;
      }
      res.resume();
      resolve({ status: res.statusCode, size: Number(res.headers["x-linked-size"] || res.headers["content-length"] || 0), sha: String(res.headers["x-linked-etag"] || "").replace(/"/g, "") });
    }).on("error", reject).end();
  });
}

test("live: the resolver picks the requested quant, with the right name, size and checksum", { skip: !live && "set FORGE_LIVE=1" }, async () => {
  const r = await resolveArtifact({ repo: REPO, quant: "Q4_K_M" });
  assert.equal(r.file_name, EXPECTED_NAME);
  assert.equal(r.matched_requested_quant, true);
  assert.match(r.url, /resolve\/main\/gemma-2-2b-it-Q4_K_M\.gguf/);
  const h = await head(r.url);
  assert.equal(h.status, 200);
  assert.equal(r.bytes, h.size, "the listed size matches the file's size");
  assert.match(r.sha256, /^[0-9a-f]{64}$/, "the listing publishes a SHA256 for the file");
});

test("live: the downloaded file is complete, verified and a GGUF model", { skip: !live && "set FORGE_LIVE=1", timeout: 3_600_000 }, async () => {
  const r = await resolveArtifact({ repo: REPO, quant: "Q4_K_M" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dl-live-"));
  const win = { webContents: { send() {} } };
  const out = await downloadModel(win, { dir, modelId: "gemma-2-2b-it", url: r.url, fileName: r.file_name, sha256: r.sha256 });
  assert.equal(path.basename(out), EXPECTED_NAME);
  assert.equal(fs.statSync(out).size, r.bytes, "the downloaded size is the published size");
  const fd = fs.openSync(out, "r"); const magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0); fs.closeSync(fd);
  assert.equal(magic.toString("latin1"), "GGUF", "the file is a GGUF model");
  assert.equal(fs.existsSync(out + ".part"), false, "no partial file is left behind");
  // Hash the bytes that were written, independently of the transfer code, and compare with the published checksum.
  const hash = require("node:crypto").createHash("sha256");
  await new Promise((res, rej) => fs.createReadStream(out).on("data", (c) => hash.update(c)).on("end", res).on("error", rej));
  assert.equal(hash.digest("hex"), r.sha256, "the file on disk hashes to the published SHA256");
});
