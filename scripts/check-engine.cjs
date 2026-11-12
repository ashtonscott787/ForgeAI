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

console.log("Engine present and loadable.");
