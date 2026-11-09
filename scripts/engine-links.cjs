#!/usr/bin/env node
/**
 * Makes the bundled inference engine loadable on macOS.
 *
 * Versioned libraries such as libllama.0.9.0.dylib are installed under the names their programs
 * ask for, libllama.0.dylib. Those short names are links. A copy that drops the links leaves the
 * engine unable to load (dyld: "Library not loaded … tried: …"). This adds each missing short name
 * as a link to the versioned file, then checks that the engine can load. It exits non-zero if
 * anything is still missing, so a broken engine never reaches a release.
 *
 * Usage: node scripts/engine-links.cjs <engine directory>
 */
const fs = require("node:fs");
const path = require("node:path");
const { missingEngineLibraries } = require("../electron/engine-check.cjs");

const VERSIONED = /^(lib.+?)\.(\d+)\.\d+\.\d+\.dylib$/;

/** Adds the short names. Returns the names it created. Existing files are left alone. */
function addVersionedLinks(dir) {
  const created = [];
  for (const f of fs.readdirSync(dir)) {
    const m = VERSIONED.exec(f);
    if (!m) continue;
    const short = `${m[1]}.${m[2]}.dylib`;
    const target = path.join(dir, short);
    if (fs.existsSync(target)) continue;
    fs.symlinkSync(f, target);
    created.push(short);
  }
  return created;
}

module.exports = { addVersionedLinks };

if (require.main === module) {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/engine-links.cjs <engine directory>");
    process.exit(2);
  }
  // --check: verify only, for the packaged application. Never changes files.
  const checkOnly = process.argv.includes("--check");
  const created = checkOnly ? [] : addVersionedLinks(dir);
  if (!checkOnly) console.log(`added ${created.length} library link(s)`);
  const missing = missingEngineLibraries(dir);
  if (missing.length) {
    console.error(`the engine still cannot load; ${missing.length} missing:`);
    for (const m of missing.slice(0, 20)) console.error(`  ${m.name} (needed by ${m.needed_by})`);
    process.exit(1);
  }
  console.log("engine libraries: all present");
}
