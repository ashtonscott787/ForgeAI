// Run with: pnpm test. Engine library checks, using generated Mach-O files and, when provided, the real build.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { missingEngineLibraries, machoLoads } = require("../electron/engine-check.cjs");
const { addVersionedLinks } = require("../scripts/engine-links.cjs");

/** A minimal 64-bit little-endian Mach-O with the given dependency and rpath names. */
function macho({ dylibs = [], rpaths = [] }) {
  const cmds = [];
  const cmd = (type, name) => {
    const str = Buffer.from(name + "\0");
    const size = Math.ceil((8 + 8 + str.length) / 8) * 8; // header(8) + name offset(4) + pad, then name
    const b = Buffer.alloc(size);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(size, 4);
    b.writeUInt32LE(8 + 4 + 4, 8); // name offset from the start of the command
    str.copy(b, 16);
    return b;
  };
  for (const d of dylibs) cmds.push(cmd(0xc, d));
  for (const r of rpaths) cmds.push(cmd(0x8000001c, r));
  const body = Buffer.concat(cmds);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body]);
}

function tempEngine(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-engine-"));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
  return dir;
}

test("a program whose library is missing is reported by name", () => {
  const dir = tempEngine({ "tool": macho({ dylibs: ["@rpath/libthing.0.dylib"], rpaths: ["@loader_path"] }) });
  const missing = missingEngineLibraries(dir);
  assert.deepEqual(missing.map((m) => m.name), ["@rpath/libthing.0.dylib"]);
  assert.equal(missing[0].needed_by, "tool");
});

test("the same program loads when the library is present", () => {
  const dir = tempEngine({
    "tool": macho({ dylibs: ["@rpath/libthing.0.dylib"], rpaths: ["@loader_path"] }),
    "libthing.0.dylib": macho({}),
  });
  assert.deepEqual(missingEngineLibraries(dir), []);
});

test("a missing library needed by another library is found too", () => {
  const dir = tempEngine({
    "tool": macho({ dylibs: ["@rpath/libmid.0.dylib"], rpaths: ["@loader_path"] }),
    "libmid.0.dylib": macho({ dylibs: ["@rpath/libdeep.0.dylib"], rpaths: ["@loader_path"] }),
  });
  assert.deepEqual(missingEngineLibraries(dir).map((m) => m.name), ["@rpath/libdeep.0.dylib"]);
});

test("system libraries are not checked; they are part of macOS", () => {
  const dir = tempEngine({ "tool": macho({ dylibs: ["/usr/lib/libSystem.B.dylib"] }) });
  assert.deepEqual(missingEngineLibraries(dir), []);
});

test("a folder that does not exist is reported, not treated as an empty engine", () => {
  const missing = missingEngineLibraries(path.join(os.tmpdir(), "no-such-engine-" + Date.now()));
  assert.equal(missing.length, 1);
});

test("a non-Mach-O file is ignored (Windows and Linux binaries)", () => {
  const dir = tempEngine({ "llama-server.exe": Buffer.from("MZ not a mach-o") });
  assert.equal(machoLoads(path.join(dir, "llama-server.exe")), null);
  assert.deepEqual(missingEngineLibraries(dir), []);
});

test("the link step adds the short names the programs ask for, and the engine then loads", () => {
  const dir = tempEngine({
    "tool": macho({ dylibs: ["@rpath/libllama.0.dylib"], rpaths: ["@loader_path"] }),
    "libllama.0.9.0.dylib": macho({}),
  });
  assert.equal(missingEngineLibraries(dir).length, 1, "before: the short name is missing");
  assert.deepEqual(addVersionedLinks(dir), ["libllama.0.dylib"]);
  assert.deepEqual(missingEngineLibraries(dir), [], "after: the engine can load");
});

test("the link step leaves existing names alone", () => {
  const dir = tempEngine({ "libx.0.9.0.dylib": macho({}), "libx.0.dylib": macho({}) });
  assert.deepEqual(addVersionedLinks(dir), []);
});

// The build that was published on GitHub. Set FORGE_TEST_MAC_ENGINE to its engine folder to run this.
const real = process.env.FORGE_TEST_MAC_ENGINE;
test("the published v0.5.2 macOS engine is missing libraries, and the link step fixes a copy of it",
  { skip: !real && "set FORGE_TEST_MAC_ENGINE to the engine folder of the build" }, () => {
    assert.ok(missingEngineLibraries(real).length > 0, "the published build is missing libraries (the defect)");
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mac-engine-"));
    for (const f of fs.readdirSync(real)) fs.copyFileSync(path.join(real, f), path.join(copy, f));
    addVersionedLinks(copy);
    assert.deepEqual(missingEngineLibraries(copy), [], "after the link step, every library resolves");
  });
