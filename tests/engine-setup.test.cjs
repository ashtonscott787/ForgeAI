// The local engine setup. Its whole job is to stop a build that cannot run a
// model from looking finished, so the tag it uses must match CI's and the
// guard must actually refuse.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const { LLAMA_TAG, ASSETS } = require("../scripts/get-engine.cjs");

test("the engine tag matches the one CI packages with", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/desktop.yml"), "utf8");
  const m = wf.match(/LLAMA_TAG:\s*(\S+)/);
  assert.ok(m, "the workflow declares a tag");
  assert.equal(LLAMA_TAG, m[1], "a local build must use the same engine as a released one");
});

test("the asset names match the ones the workflow downloads", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/desktop.yml"), "utf8");
  for (const asset of [ASSETS["darwin-arm64"], ASSETS["win32-x64"]]) {
    assert.ok(wf.includes(asset), `the workflow fetches ${asset}`);
  }
});

test("every supported platform names an asset for its own tag", () => {
  for (const [platform, asset] of Object.entries(ASSETS)) {
    assert.match(asset, new RegExp(`^llama-${LLAMA_TAG}-bin-`), `${platform} uses the pinned tag`);
    assert.match(asset, /\.(tar\.gz|zip)$/, `${platform} names a real archive`);
  }
});

test("packaging is refused when there is no engine", () => {
  // An empty directory, not the repository's own engine/ — that may or may not
  // have been fetched, and a test whose result depends on that proves nothing.
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "forge-noeng-"));
  const r = runGuard(path.join(tmp, "engine"));
  fs.rmSync(tmp, { recursive: true, force: true });
  // The whole point: electron-builder only warns, so this must not.
  assert.notEqual(r.status, 0, "it exits non-zero");
  assert.match(r.output, /Refusing to package/);
  assert.match(r.output, /pnpm engine:get/, "and says how to fix it");
});

test("the guard passes once an engine is present", () => {
  // A stand-in binary: the guard checks presence, and on macOS loadability.
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "forge-eng-"));
  const engine = path.join(tmp, "engine");
  fs.mkdirSync(engine);
  fs.writeFileSync(path.join(engine, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const r = runGuard(engine);
    assert.equal(r.status, 0, `the guard should pass; it said: ${r.output}`);
    assert.match(r.output, /Engine present/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Runs the guard against a chosen engine folder. */
function runGuard(engineDir) {
  const script = `
    const path = require("node:path");
    const real = path.join(${JSON.stringify(root)}, "engine");
    const want = ${JSON.stringify(engineDir)};
    const fs = require("node:fs");
    const origExists = fs.existsSync;
    fs.existsSync = (p) => origExists(String(p).replace(real, want));
    process.argv[1] = ${JSON.stringify(path.join(root, "scripts/check-engine.cjs"))};
    require(${JSON.stringify(path.join(root, "scripts/check-engine.cjs"))});
  `;
  try {
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output: out };
  } catch (e) {
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// ── against the real release ──────────────────────────────────
// A name that 404s is how a setup instruction rots: everything looks right
// until someone on that platform runs it. Checked with a HEAD request, so it
// costs nothing. Run with FORGE_LIVE=1.
test("every asset named here exists in the published release", { skip: process.env.FORGE_LIVE !== "1" }, () => {
  for (const [platform, asset] of Object.entries(ASSETS)) {
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}`;
    const code = execFileSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-L", url], { encoding: "utf8" }).trim();
    assert.equal(code, "200", `${platform}: ${asset} is not published (HTTP ${code})`);
  }
});

test("no platform is promised a build that is not published", () => {
  // Linux was listed here once with an invented name. It 404'd, and a name
  // that 404s is worse than an honest "build it yourself".
  assert.ok(!("linux-x64" in ASSETS), "linux is not claimed, because llama.cpp publishes no build for this tag");
  assert.deepEqual(Object.keys(ASSETS).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
});

test("CI does not also pin a pnpm version, which would conflict with packageManager", () => {
  // pnpm/action-setup refuses to run when it is given a version AND
  // package.json declares packageManager. Adding the pin broke both CI jobs.
  const wf = fs.readFileSync(path.join(root, ".github/workflows/desktop.yml"), "utf8");
  // Only this step: a fixed-size window caught "node-version: 22" from the
  // next one and failed for the wrong reason.
  const from = wf.indexOf("pnpm/action-setup");
  const next = wf.indexOf("\n      - ", from);
  const setup = wf.slice(from, next === -1 ? wf.length : next);
  assert.ok(!/\bversion:\s*\d/.test(setup), `the workflow still pins a pnpm version: ${setup}`);
  assert.match(require(path.join(root, "package.json")).packageManager, /^pnpm@/, "and package.json declares one");
});
