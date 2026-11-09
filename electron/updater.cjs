/**
 * Updating Forge AI from GitHub Releases.
 *
 * Deliberate choices, because this replaces the application on disk:
 *
 * - Only one repository is ever contacted, and it is compiled in below. A
 *   release cannot redirect the download somewhere else.
 * - Every download is checked against a SHA256SUMS.txt published in the same
 *   release. No checksum, no install — the update is refused rather than run.
 * - Neither build is code-signed, so this is integrity checking, not proof of
 *   authorship. Anyone who can publish a release to that repository can publish
 *   an update. That is the honest limit of an unsigned application.
 * - No token is embedded, so the repository must be public for this to work.
 */
const { app, net, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const OWNER = "ashtonscott787";
const REPO = "ForgeAI";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;
const UA = { "User-Agent": "ForgeAI-updater", Accept: "application/vnd.github+json" };

const cmp = (a, b) => {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
    // A release without a suffix outranks a prerelease of the same numbers.
    if (typeof x === "number") return 1;
    if (typeof y === "number") return -1;
    return x > y ? 1 : -1;
  }
  return 0;
};

function get(url, headers = UA, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      resolve(res);
    }).on("error", reject);
  });
}
async function getJSON(url) {
  const res = await get(url);
  if (res.statusCode === 404) {
    res.resume();
    throw new Error("No public releases found. Update checks need the repository (or a releases mirror) to be public.");
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`GitHub returned HTTP ${res.statusCode}`);
  }
  let body = "";
  res.setEncoding("utf8");
  await new Promise((r, j) => { res.on("data", (c) => (body += c)); res.on("end", r); res.on("error", j); });
  return JSON.parse(body);
}

const PLATFORM = () => {
  if (process.platform === "darwin") return { kind: "mac", match: (n) => /macos.*\.zip$/i.test(n) };
  if (process.platform === "win32") return { kind: "win", match: (n) => /windows.*setup.*\.exe$/i.test(n) };
  return { kind: "other", match: () => false };
};

/** Looks for a newer release and reports exactly what it found. */
async function checkForUpdate({ channel } = {}) {
  const list = await getJSON(`${API}?per_page=10`);
  const wantPre = channel === "beta";
  const releases = (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && (wantPre || !r.prerelease))
    .sort((a, b) => cmp(b.tag_name, a.tag_name));
  const rel = releases[0];
  const current = app.getVersion();
  if (!rel) return { available: false, current, checked_at: Date.now(), reason: "no releases published yet" };

  const version = String(rel.tag_name).replace(/^v/, "");
  const plat = PLATFORM();
  const asset = (rel.assets || []).find((a) => plat.match(a.name));
  const sums = (rel.assets || []).find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));

  return {
    available: cmp(version, current) > 0,
    current,
    version,
    notes: String(rel.body || "").slice(0, 8000),
    published_at: rel.published_at,
    html_url: rel.html_url,
    checked_at: Date.now(),
    asset: asset ? { name: asset.name, url: asset.browser_download_url, bytes: asset.size } : null,
    checksums_url: sums ? sums.browser_download_url : null,
    installable: Boolean(asset && sums),
    reason: !asset
      ? `That release has no ${plat.kind === "mac" ? "macOS" : "Windows"} build attached.`
      : !sums
        ? "That release has no SHA256SUMS.txt, so the download cannot be verified. Forge AI will not install it."
        : "",
  };
}

async function download(url, dest, onProgress) {
  const res = await get(url, { "User-Agent": "ForgeAI-updater" });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`download failed: HTTP ${res.statusCode}`);
  }
  const total = Number(res.headers["content-length"] || 0);
  const out = fs.createWriteStream(dest);
  let received = 0;
  let last = 0;
  await new Promise((resolve, reject) => {
    res.on("data", (c) => {
      received += c.length;
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        onProgress?.({ received, total });
      }
    });
    res.pipe(out);
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
  onProgress?.({ received, total: total || received });
  return dest;
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

/** Downloads the update and verifies it. Never installs an unverified file. */
async function fetchUpdate(info, onProgress) {
  if (!info?.asset?.url) throw new Error("no download for this platform in that release");
  if (!info.checksums_url) throw new Error("that release publishes no checksums, so it will not be installed");

  const sumsRes = await get(info.checksums_url, { "User-Agent": "ForgeAI-updater" });
  let sumsText = "";
  sumsRes.setEncoding("utf8");
  await new Promise((r, j) => { sumsRes.on("data", (c) => (sumsText += c)); sumsRes.on("end", r); sumsRes.on("error", j); });
  const line = sumsText.split("\n").find((l) => l.trim().endsWith(info.asset.name) || l.includes(` ${info.asset.name}`));
  const expected = (line || "").trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected || "")) {
    throw new Error(`no checksum listed for ${info.asset.name}; refusing to install`);
  }

  const dir = path.join(app.getPath("userData"), "updates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, info.asset.name);
  await download(info.asset.url, file, onProgress);

  const actual = await sha256(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error("the downloaded file did not match its published checksum and was deleted");
  }
  return { file, version: info.version, verified: true };
}

/** Where this app lives, so it can replace itself in place. */
function appBundlePath() {
  if (process.platform !== "darwin") return null;
  const p = path.resolve(process.execPath, "..", "..", "..");
  return p.endsWith(".app") ? p : null;
}

/**
 * Swaps in the new version. On macOS the bundle is replaced in place and the
 * app relaunches; on Windows the signed-by-nobody NSIS installer is run and the
 * app exits so it can overwrite itself.
 */
async function applyUpdate({ file }) {
  if (process.platform === "darwin") {
    const bundle = appBundlePath();
    if (!bundle) throw new Error("cannot find the application bundle to replace");
    // Staged beside the app, not in /tmp: a rename across volumes fails with
    // EXDEV, and the swap has to be a rename to be atomic.
    const parent = path.dirname(bundle);
    let staging;
    try {
      staging = fs.mkdtempSync(path.join(parent, ".forge-update-"));
    } catch (e) {
      throw new Error(
        `Forge AI cannot write next to itself in ${parent} (${e.code ?? e.message}). Move Forge AI to your Applications folder and try again.`,
      );
    }
    await new Promise((resolve, reject) =>
      execFile("ditto", ["-x", "-k", file, staging], (e) => (e ? reject(new Error(`could not unpack the update: ${e.message}`)) : resolve())),
    );
    const inner = fs.readdirSync(staging).find((n) => n.endsWith(".app"));
    if (!inner) throw new Error("the update did not contain an application");
    const next = path.join(staging, inner);
    if (!fs.existsSync(path.join(next, "Contents", "MacOS"))) throw new Error("the update looks damaged");

    const parked = `${bundle}.old-${Date.now()}`;
    try {
      fs.renameSync(bundle, parked);
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `Forge AI could not move its own application aside (${e.code ?? e.message}). If it is running from a disk image or a read-only folder, move it to Applications first.`,
      );
    }
    try {
      fs.renameSync(next, bundle);
    } catch (e) {
      fs.renameSync(parked, bundle); // put it back rather than leave nothing
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`could not install the update: ${e.code ?? e.message}`);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    spawn("open", ["-n", bundle], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.exit(0), 400);
    return { restarting: true };
  }

  if (process.platform === "win32") {
    spawn(file, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.exit(0), 400);
    return { restarting: true };
  }

  await shell.openPath(file);
  return { restarting: false };
}

/** Clears bundles parked by a previous update. Runs once at startup. */
function cleanupOldBundles() {
  try {
    const bundle = appBundlePath();
    if (!bundle) return;
    const dir = path.dirname(bundle);
    const base = path.basename(bundle);
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${base}.old-`) || name.startsWith(".forge-update-")) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* tidying is never worth failing a launch over */
  }
}

/** Last resort: show the verified download so it can be installed by hand. */
function revealUpdate(file) {
  shell.showItemInFolder(file);
  return { revealed: true };
}

module.exports = { checkForUpdate, fetchUpdate, applyUpdate, revealUpdate, cleanupOldBundles, compareVersions: cmp, OWNER, REPO };
