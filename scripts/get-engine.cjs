#!/usr/bin/env node
/**
 * Puts the inference engine in engine/, which is what the packaged app ships.
 *
 * CI downloads this before packaging; nothing did so locally, and
 * electron-builder only *warns* when an extraResources path is missing. A local
 * build therefore produced a .dmg that looked complete and could not run a
 * model — the worst kind of failure, because it is silent until someone tries.
 *
 * The tag must match the workflow's LLAMA_TAG. A test asserts that it does, so
 * the two cannot drift apart unnoticed.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LLAMA_TAG = "b12180";

/**
 * Only what the project actually publishes for this tag. There is no Linux
 * build among them — a name was invented for one here and it 404'd, which is
 * exactly the kind of guess that turns into a broken instruction. Linux builds
 * from source, as the workflow already does when a download fails.
 */
const ASSETS = {
  "darwin-arm64": `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`,
  "darwin-x64": `llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`,
  "win32-x64": `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
};

const root = path.join(__dirname, "..");
const engineDir = path.join(root, "engine");
const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function die(message) {
  console.error(`\nCould not set up the engine: ${message}\n`);
  process.exit(1);
}

function main() {
  // The override exists so the download and unpacking can be exercised from a
  // machine that is not the target one.
  const key = process.env.FORGE_ENGINE_PLATFORM || `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    die(
      `llama.cpp publishes no build for ${key} at ${LLAMA_TAG}.\n` +
      `  Published: ${Object.keys(ASSETS).join(", ")}.\n` +
      `  Build it from source and put llama-server, with its libraries, in engine/.`,
    );
  }

  if (fs.existsSync(path.join(engineDir, binName)) && !process.argv.includes("--force")) {
    console.log(`engine/ already has ${binName}. Pass --force to fetch it again.`);
    return finish();
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-engine-"));
  const file = path.join(tmp, asset);
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}`;

  console.log(`Fetching ${asset}`);
  console.log(`  from ${url}`);
  try {
    execFileSync("curl", ["-sSfL", "--retry", "5", "--retry-all-errors", "-o", file, url], { stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    die(`the download failed. Check the network, or fetch ${url} by hand and unpack it into engine/.`);
  }

  console.log("Unpacking");
  try {
    if (asset.endsWith(".tar.gz")) execFileSync("tar", ["xzf", file, "-C", tmp]);
    else if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path "${file}" -DestinationPath "${tmp}"`]);
    } else execFileSync("unzip", ["-qo", file, "-d", tmp]);
  } catch (e) {
    die(`the archive could not be unpacked (${e.message}).`);
  }

  fs.mkdirSync(engineDir, { recursive: true });
  // The archives differ in layout between platforms, so take what is wanted by
  // name wherever it sits rather than assuming a path.
  let copied = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(p); continue; }
      if (/^llama-server(\.exe)?$/.test(entry.name) || /\.(dylib|so|dll)$/.test(entry.name) || /^LICENSE/.test(entry.name)) {
        const dest = path.join(engineDir, entry.name);
        // Copy a link as a link. Dereferencing it writes a full duplicate of
        // the library under each of its names — three copies of every dylib,
        // and it is the same flattening that left 0.5.2 unable to load at all.
        if (entry.isSymbolicLink()) {
          const target = fs.readlinkSync(p);
          try { fs.rmSync(dest, { force: true }); } catch { /* nothing there */ }
          fs.symlinkSync(target, dest);
        } else {
          fs.copyFileSync(p, dest);
        }
        copied++;
      }
    }
  };
  walk(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!copied) die("the archive held no engine files.");
  console.log(`Copied ${copied} files into engine/`);

  try { fs.chmodSync(path.join(engineDir, binName), 0o755); } catch { /* already executable */ }
  finish();
}

function finish() {
  // macOS needs the unversioned library links, or the engine cannot load. This
  // is the defect that shipped in 0.5.2.
  const forMac = (process.env.FORGE_ENGINE_PLATFORM || process.platform).startsWith("darwin");
  if (forMac) {
    execFileSync(process.execPath, [path.join(__dirname, "engine-links.cjs"), engineDir], { stdio: "inherit" });
  }
  check(forMac);
  console.log("\nThe engine is ready. `pnpm dist` will now package a build that can run a model.");
}

/** Refuses to call it done unless the engine is actually there and loadable. */
function check(forMac = process.platform === "darwin") {
  const bin = path.join(engineDir, process.env.FORGE_ENGINE_PLATFORM === "win32-x64" ? "llama-server.exe" : "llama-server");
  if (!fs.existsSync(bin)) die(`engine/${path.basename(bin)} is missing.`);
  if (forMac) {
    const { missingEngineLibraries } = require(path.join(__dirname, "..", "electron", "engine-check.cjs"));
    const missing = missingEngineLibraries(engineDir);
    if (missing.length) {
      die(`${missing.length} libraries the engine needs are missing. Try again with --force.`);
    }
    console.log("Every engine library resolves.");
  }
}

if (require.main === module) main();
module.exports = { LLAMA_TAG, ASSETS };
