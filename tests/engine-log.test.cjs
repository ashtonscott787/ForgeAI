// Run with: pnpm test. Regression test for ERR_STREAM_WRITE_AFTER_END in engine logging.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { openEngineLog } = require("../electron/engine-log.cjs");

const tmp = () => path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "forge-log-")), "engine.log");

test("the naive pattern (writing to a stream after end) throws ERR_STREAM_WRITE_AFTER_END", () => {
  // This is the failure the guard exists to prevent. It documents the cause.
  const s = new PassThrough();
  s.resume();
  s.end();
  let code = null;
  s.on("error", (e) => { code = e.code; });
  s.write("late");
  return new Promise((r) => setImmediate(() => {
    assert.equal(code, "ERR_STREAM_WRITE_AFTER_END");
    r();
  }));
});

test("the guarded log accepts writes until closed, then ignores them without throwing", async () => {
  const file = tmp();
  const log = openEngineLog(file);
  log.write("first\n");
  log.close();
  assert.equal(log.write("after close\n"), false, "a write after close is ignored");
  log.close(); // idempotent
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(file, "utf8"), "first\n");
});

test("a second engine opening the same log path does not break the first", async () => {
  const file = tmp();
  const a = openEngineLog(file);
  a.write("A1\n");
  a.close();
  const b = openEngineLog(file);
  b.write("B1\n");
  // A late chunk from the first engine's process must be dropped, not written or thrown.
  a.write("A-late\n");
  b.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /A-late/);
});

test("a destroyed log does not throw on write", () => {
  const file = tmp();
  const log = openEngineLog(file);
  log.close();
  assert.doesNotThrow(() => log.write("x"));
});
