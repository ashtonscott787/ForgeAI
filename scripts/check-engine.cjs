#!/usr/bin/env node
/**
 * Refuses to package an app with no engine in it.
 *
 * electron-builder treats a missing extraResources path as a warning, so a
 * build with no engine/ folder succeeds and produces an installer that cannot
 * run a model. Nothing announces that until someone downloads it and tries.
 */
const fs = require("node:fs");
const path = require("node:path");

const { BINARIES, expectedOn } = require("./engine-manifest.cjs");

const engineDir = path.join(__dirname, "..", "engine");
const bin = path.join(engineDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");

if (!fs.existsSync(bin)) {
  console.error(`
Refusing to package: there is no engine in engine/.

The app would build, and the installer would look finished, but it could not
run a single model. Get the engine first:

    pnpm engine:get

`);
  process.exit(1);
}

if (process.platform === "darwin") {
  const { missingEngineLibraries } = require(path.join(__dirname, "..", "electron", "engine-check.cjs"));
  const missing = missingEngineLibraries(engineDir);
  if (missing.length) {
    const names = [...new Set(missing.map((m) => m.name.split("/").pop()))];
    console.error(`
Refusing to package: the engine cannot load. ${names.length} libraries are missing,
including ${names.slice(0, 3).join(", ")}.

This is the defect that shipped in 0.5.2. Fix it with:

    node scripts/engine-links.cjs engine

`);
    process.exit(1);
  }
}

// Every optional tool, named either way. A feature whose binary is absent
// is reported here rather than discovered by somebody pressing its button
// in a release — which is what happened with 0.7.0.
const suffix = process.platform === "win32" ? ".exe" : "";
const present = (b) => fs.existsSync(path.join(engineDir, b.name + suffix));
const optional = BINARIES.filter((b) => !b.required);
// Published for this platform and absent: a build defect, and the guard stops.
const missing = optional.filter((b) => expectedOn(b) && !present(b));
// Not published for this platform at all: upstream's doing, said once and
// not treated as a failure.
const unavailable = optional.filter((b) => !expectedOn(b));
for (const b of unavailable) {
  console.log(`note: ${b.name} is not published for ${process.platform}, so "${b.gives}" will be unavailable in this build.`);
}
if (missing.length) {
  console.error(`
Refusing to package: ${missing.length} engine tool(s) are missing, so the
features that need them would be in the app and unable to run.

${missing.map((b) => `  ${b.name}${suffix} — ${b.gives}`).join("\n")}

Get them with:

    pnpm engine:get --force

Set FORGE_ALLOW_PARTIAL_ENGINE=1 to package without them on purpose.
`);
  if (process.env.FORGE_ALLOW_PARTIAL_ENGINE !== "1") process.exit(1);
}

const have = BINARIES.filter(present).length;
console.log(`Engine present and loadable, with ${have}/${BINARIES.length} tools.`);
