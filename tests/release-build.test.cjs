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
  const { keep, BINARIES } = require(path.join(root, "scripts", "engine-manifest.cjs"));
  for (const b of BINARIES) {
    assert.equal(keep(b.name), true, `${b.name} survives the filter`);
    assert.equal(keep(`${b.name}.exe`), true, `${b.name}.exe survives the filter`);
  }
  assert.equal(keep("llama-perplexity"), false, "and the development tools do not");
  assert.equal(keep("libggml-rpc.dylib"), true, "libraries travel with them");
});

// This is the test that should have existed. The previous version checked
// scripts/get-engine.cjs and the source-build fallback — neither of which CI
// ran — while the workflow quietly copied `llama-server` and nothing else
// with its own inline find. 0.7.0 shipped clustering and the model workshop
// with their binaries absent, and the suite was green.
test("the path CI actually takes is the one that was tested", () => {
  const fetchStep = workflow.slice(workflow.indexOf("- name: Fetch the inference engine"), workflow.indexOf("- name: Build the inference engine from source"));
  assert.match(fetchStep, /node scripts\/get-engine\.cjs/, "CI fetches through the script, not a second copy of it");
  assert.doesNotMatch(fetchStep, /-name 'llama-server'/, "no inline list of binaries beside the manifest");
  assert.doesNotMatch(fetchStep, /\bcurl\b/, "and no second downloader");
});

test("the engine cache cannot outlive a change to what ships", () => {
  // The key was the llama.cpp tag alone. Three binaries were added, the tag
  // did not move, the cache hit, and the release went out with the old
  // folder in it.
  const key = /key: engine-\$\{\{ runner\.os \}\}-\$\{\{ env\.LLAMA_TAG \}\}-([^\n]+)/.exec(workflow);
  assert.ok(key, "there is an engine cache key");
  assert.match(key[1], /engine-sig\.outputs\.sig/, "and it carries the manifest signature");
});

test("packaging refuses when a tool that gates a feature is missing", () => {
  const check = fs.readFileSync(path.join(root, "scripts", "check-engine.cjs"), "utf8");
  assert.match(check, /engine-manifest/, "the check reads the same list");
  assert.match(check, /Refusing to package/, "and stops the build rather than warning");
});

// `pnpm dist` runs the guard; the workflow called electron-builder directly
// and so never did. A Windows build packaged happily with an engine tool
// missing and said nothing about it.
test("the release build runs the guard, not only a developer's machine", () => {
  const pack = workflow.slice(workflow.indexOf("- name: Package"));
  const step = pack.slice(0, pack.indexOf("- name:", 10));
  // Commands, not any mention: the comment above the guard names
  // electron-builder, and comparing raw positions found that instead.
  const commands = step
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const guardAt = commands.findIndex((l) => l.includes("scripts/check-engine.cjs"));
  const packAt = commands.findIndex((l) => l.includes("electron-builder"));
  assert.ok(guardAt >= 0, "the guard runs in the release build");
  assert.ok(packAt >= 0, "and so does the packager");
  assert.ok(guardAt < packAt, "the guard runs before it, not after");
});

test("a tool upstream does not publish is known about rather than treated as a defect", () => {
  const { BINARIES, expectedOn } = require(path.join(root, "scripts", "engine-manifest.cjs"));
  const lora = BINARIES.find((b) => b.name === "llama-export-lora");
  // Verified against the published archive: llama.cpp's Windows CPU zip
  // contains llama-server, ggml-rpc-server and llama-quantize, and not this.
  assert.equal(expectedOn(lora, "win32"), false, "not expected on Windows");
  assert.equal(expectedOn(lora, "darwin"), true, "expected on macOS");
  for (const b of BINARIES.filter((x) => x.name !== "llama-export-lora")) {
    assert.equal(expectedOn(b, "win32"), true, `${b.name} is expected on every platform`);
  }
});

test("a feature with no binary says why rather than showing a dead button", () => {
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  assert.match(main, /why_no_combine/, "the reason is reported");
  assert.match(main, /not published for Windows/, "and it names the real cause");
  const panel = fs.readFileSync(path.join(root, "src", "components", "WorkshopPanel.tsx"), "utf8");
  assert.match(panel, /why_no_combine/, "and the panel shows it");
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
