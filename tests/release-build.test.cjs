// The release workflow, checked against the repository it builds. Everything
// here is a thing that can drift silently and is only noticed by downloading
// a finished installer and finding something missing from it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "desktop.yml"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const getEngine = fs.readFileSync(path.join(root, "scripts", "get-engine.cjs"), "utf8");

test("the Electron cache key names the Electron that is actually installed", () => {
  // It said 38.0.0 while package.json said 45.4.1, which would have restored
  // the old binary from cache into a build of the new app.
  const version = pkg.devDependencies.electron.replace(/^[^0-9]*/, "");
  const key = /key: electron-\$\{\{ runner\.os \}\}-([0-9][^\s]*)/.exec(workflow);
  assert.ok(key, "there is an Electron cache key");
  assert.equal(key[1], version, "the cache key follows the installed version");
});

test("every tool the app runs is kept from the downloaded archive", () => {
  for (const tool of ["llama-server", "ggml-rpc-server", "llama-quantize", "llama-export-lora"]) {
    assert.match(getEngine, new RegExp(tool), `${tool} survives the filter`);
  }
});

test("the source-build fallback produces the same set of tools", () => {
  // A fallback build that made only llama-server would ship an app whose
  // clustering and model workshop are missing, and nothing would say so.
  const build = /cmake --build _b[^\n]*/.exec(workflow);
  assert.ok(build, "there is a build line");
  for (const target of ["llama-server", "rpc-server", "llama-quantize", "llama-export-lora"]) {
    assert.match(build[0], new RegExp(`\\b${target}\\b`), `${target} is built`);
  }
  assert.match(workflow, /GGML_RPC=ON/, "and the RPC backend is compiled in");
});

test("macOS signing falls back to ad-hoc rather than failing, and says which it did", () => {
  assert.match(workflow, /MAC_CERT_P12/, "a Developer ID certificate is used when there is one");
  assert.match(workflow, /notarytool submit/, "and the result is notarized");
  assert.match(workflow, /ad-hoc signed/, "with no certificate the build still completes");
  // Apple Silicon will not launch a Mach-O with no signature at all.
  assert.match(workflow, /codesign --force --deep --sign -/, "the ad-hoc path still signs");
});

test("the hardened runtime is given the entitlements Electron cannot start without", () => {
  const plist = fs.readFileSync(path.join(root, "build", "entitlements.mac.plist"), "utf8");
  for (const needed of ["allow-jit", "allow-unsigned-executable-memory", "disable-library-validation"]) {
    assert.match(plist, new RegExp(needed), `${needed} is granted`);
  }
  assert.match(workflow, /entitlements\.mac\.plist/, "and the signing step uses the file");
});

test("the engine tag in the script matches the one the workflow builds", () => {
  const inScript = /const LLAMA_TAG = "([^"]+)"/.exec(getEngine);
  assert.ok(inScript, "the script pins a tag");
  assert.match(workflow, new RegExp(inScript[1]), "and the workflow uses the same one");
});
