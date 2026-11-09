/**
 * Checks that the bundled inference engine can load: every library it names must be present.
 *
 * macOS programs name their libraries by install name (for example "@rpath/libllama.0.dylib").
 * If the file with that exact name is missing, dyld stops with "Library not loaded … tried: …",
 * and the engine never starts. Release packaging has dropped such symlinks before, so this check
 * runs before every engine start and names the missing files.
 *
 * Reads Mach-O (macOS) load commands directly, so it runs on any platform and can check a macOS
 * build from Linux. Windows and Linux binaries are not parsed here.
 */
const fs = require("node:fs");
const path = require("node:path");

const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x1f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_RPATH = 0x8000001c;
const DYLIB_CMDS = new Set([LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB]);
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;

/** Load commands of a thin 64-bit Mach-O, or of the first architecture of a fat file. null for anything else. */
function machoLoads(file) {
  const buf = fs.readFileSync(file);
  let base = 0;
  if (buf.length >= 8 && buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    if (n < 1) return null;
    base = buf.readUInt32BE(8 + 8); // offset of the first architecture
  }
  if (buf.length < base + 32 || buf.readUInt32LE(base) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(base + 16);
  const out = { dylibs: [], rpaths: [] };
  let off = base + 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (DYLIB_CMDS.has(cmd) || cmd === LC_RPATH) {
      const nameOff = buf.readUInt32LE(off + 8);
      const raw = buf.subarray(off + nameOff, off + size).toString("utf8");
      const name = raw.split("\0")[0];
      (cmd === LC_RPATH ? out.rpaths : out.dylibs).push(name);
    }
    off += size;
  }
  return out;
}

/**
 * Lists every library the engine needs that is not present. Checks dependencies of bundled
 * libraries too, because a missing library can be needed by another one.
 * Returns [] when all are present, or when the directory has no Mach-O binaries.
 */
function missingEngineLibraries(dir) {
  if (!fs.existsSync(dir)) return [{ name: "(engine folder)", needed_by: "", reason: "folder not found" }];
  const files = fs.readdirSync(dir).filter((f) => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
  const missing = [];
  const seen = new Set();
  const visit = (file, neededBy) => {
    if (seen.has(file)) return;
    seen.add(file);
    const loads = machoLoads(file);
    if (!loads) return;
    const here = path.dirname(file);
    for (const dep of loads.dylibs) {
      if (!dep.startsWith("@")) continue; // system libraries are part of macOS, not the bundle
      const leaf = dep.split("/").pop();
      const candidates = [];
      if (dep.startsWith("@rpath/")) {
        candidates.push(path.join(dir, leaf));
        for (const r of loads.rpaths) {
          const expanded = r.replace("@loader_path", here).replace("@executable_path", dir);
          candidates.push(path.join(expanded, leaf));
        }
      } else if (dep.startsWith("@loader_path/") || dep.startsWith("@executable_path/")) {
        candidates.push(path.join(dep.startsWith("@loader_path/") ? here : dir, dep.split("/").slice(1).join("/")));
      }
      const found = candidates.find((c) => fs.existsSync(c));
      if (!found) {
        missing.push({ name: dep, needed_by: path.basename(file), reason: `not in ${path.basename(dir)}` });
      } else {
        visit(found, path.basename(file));
      }
    }
  };
  for (const f of files) {
    visit(path.join(dir, f), null); // any Mach-O file; machoLoads ignores the rest
  }
  return missing;
}

module.exports = { missingEngineLibraries, machoLoads };
