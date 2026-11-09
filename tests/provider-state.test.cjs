// Run with: pnpm test. Non-secret provider state.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const state = require("../electron/provider-state.cjs");

const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "forge-ps-"));

test("verified and failed states are separate and recorded", () => {
  state.load(dir());
  state.markVerified("openai", [{ id: "gpt-x", label: "gpt-x" }]);
  assert.ok(state.get("openai").verified_at);
  assert.deepEqual(state.get("openai").models.map((m) => m.id), ["gpt-x"]);
  state.markFailed("openai", "rejected");
  assert.equal(state.get("openai").verified_at, null, "a failure clears the verified state");
  assert.equal(state.get("openai").last_error, "rejected");
  state.disconnect("openai");
  assert.deepEqual(state.get("openai").models, []);
});

test("manual model IDs are validated and removable", () => {
  state.load(dir());
  state.addManual("anthropic", "claude-custom-1");
  assert.throws(() => state.addManual("anthropic", "bad id; rm -rf"), /not valid/);
  assert.deepEqual(state.get("anthropic").manual, ["claude-custom-1"]);
  state.removeManual("anthropic", "claude-custom-1");
  assert.deepEqual(state.get("anthropic").manual, []);
});

test("the state file never contains key material", () => {
  const d = dir();
  state.load(d);
  state.markVerified("anthropic", [{ id: "claude-x", label: "Claude X" }]);
  state.markFailed("openai", "The provider rejected this key.");
  const text = fs.readFileSync(path.join(d, "providers.json"), "utf8");
  assert.doesNotMatch(text, /sk-|x-api-key|authorization/i);
});

test("unknown providers are refused", () => {
  state.load(dir());
  assert.throws(() => state.markVerified("nope", []), /unknown provider/);
});
