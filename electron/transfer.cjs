/**
 * Downloads model files: resumable, checksum-verified when a checksum is known,
 * and never renames a short or interrupted transfer into place.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

const safeName = (n) => { if (!n || n !== path.basename(n) || !n.endsWith(".gguf")) throw new Error("invalid model file name"); return n; };

function get(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "ForgeAI/0.1", ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 10) {
        res.resume(); resolve(get(new URL(res.headers.location, url).toString(), headers, redirects + 1)); return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}


// One transfer per model file at a time. A second request for the same file is
// refused rather than writing to the same .part file twice.
const inFlight = new Set();
/** Failures that a retry can fix: the connection, a stall, or a body that ended early. */
function isTransient(e) {
  return /connection dropped|cut short|stalled|did not answer|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN/i.test(String(e && e.message));
}

async function downloadModel(win, { dir, modelId, url, fileName, sha256, retryWaits }) {
  const name = safeName(fileName);
  if (inFlight.has(name)) throw new Error("this model is already downloading");
  inFlight.add(name);
  try {
    // A dropped connection is common on large files. Retry from the partial file, a few times, with
    // growing waits. Checksum failures and server refusals are not retried: they will not change.
    const WAITS = retryWaits ?? [2_000, 5_000, 15_000, 30_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await transfer(win, { dir, modelId, url, fileName: name, sha256 }, true);
      } catch (e) {
        if (!isTransient(e) || attempt >= WAITS.length) throw e;
        win.webContents.send("download://progress", { model_id: modelId, received: 0, total: 0, bytes_per_sec: 0, done: false, retrying: attempt + 1, reason: e.message });
        await new Promise((r) => setTimeout(r, WAITS[attempt]));
      }
    }
  } finally {
    inFlight.delete(name);
  }
}

async function transfer(win, { dir, modelId, url, fileName, sha256 }, mayRestart) {
  const final = path.join(dir, fileName), part = final + ".part";
  if (fs.existsSync(final)) return final;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await get(url, have ? { Range: `bytes=${have}-` } : {});
  if (res.statusCode === 416 && have > 0 && mayRestart) {
    // The partial file is not something the server can resume from. Start over once.
    res.resume();
    fs.rmSync(part, { force: true });
    return transfer(win, { dir, modelId, url, fileName, sha256 }, false);
  }
  if (res.statusCode === 200) have = 0; // server ignored Range: restart
  else if (res.statusCode !== 206) { res.resume(); throw new Error(`download failed: HTTP ${res.statusCode}`); }
  const length = Number(res.headers["content-length"] || 0);
  const total = have + length;
  const free = (() => { try { return fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize; } catch { return Infinity; } })();
  if (length > free) { res.resume(); throw new Error("not enough free disk space for this model"); }
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  let received = have, last = 0, lastBytes = have, t0 = Date.now();
  await new Promise((resolve, reject) => {
    // A stalled connection must fail, not hang the download forever.
    res.setTimeout(120_000, () => res.destroy(new Error("the download stalled: no data for two minutes")));
    res.on("data", (c) => {
      received += c.length;
      const now = Date.now();
      if (now - last > 250) {
        const bps = ((received - lastBytes) * 1000) / Math.max(1, now - (last || t0));
        last = now; lastBytes = received;
        win.webContents.send("download://progress", { model_id: modelId, received, total, bytes_per_sec: bps, done: false });
      }
    });
    // The partial file is kept so the next attempt resumes from it.
    res.on("error", () => { out.destroy(); reject(new Error("the connection dropped during the download — start it again to resume")); });
    res.on("close", () => {
      if (!res.complete) { out.destroy(); reject(new Error("the connection dropped during the download — start it again to resume")); }
    });
    out.on("error", (e) => { res.destroy(); reject(e); });
    out.on("finish", () => {
      // A short body must never be renamed into place as if it were the whole model.
      if (length && received !== total) reject(new Error("the download was cut short — start it again to resume"));
      else resolve();
    });
    res.pipe(out);
  });
  if (sha256) {
    const h = crypto.createHash("sha256");
    await new Promise((r, j) => fs.createReadStream(part).on("data", (c) => h.update(c)).on("end", r).on("error", j));
    if (h.digest("hex") !== sha256.toLowerCase()) { fs.rmSync(part); throw new Error("downloaded file failed its checksum and was discarded"); }
  }
  fs.renameSync(part, final);
  win.webContents.send("download://progress", { model_id: modelId, received, total, bytes_per_sec: 0, done: true });
  return final;
}


module.exports = { downloadModel };
