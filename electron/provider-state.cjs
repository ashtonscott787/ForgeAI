/**
 * What Forge AI knows about each cloud provider, minus the key itself.
 *
 * Saved credential (keychain, secrets.cjs) and verified connection (here) are
 * separate facts. A key can be saved and not yet verified, or verified and later
 * fail. This file records the last test result, the models that test returned,
 * and any model IDs the person typed in by hand. It contains no secrets.
 */
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = ["anthropic", "openai"];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

let file = "";
let state = {};

const blank = () => ({ verified_at: null, models: [], manual: [], last_error: null, last_error_at: null });

function load(dir) {
  file = path.join(dir, "providers.json");
  state = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const p of PROVIDERS) if (raw && typeof raw[p] === "object") state[p] = { ...blank(), ...raw[p] };
  } catch {
    state = {};
  }
  return snapshot();
}

function save() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function check(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  if (!state[provider]) state[provider] = blank();
  return state[provider];
}

/** A successful authenticated test: record the models it returned. */
function markVerified(provider, models) {
  const row = check(provider);
  row.verified_at = Date.now();
  row.models = models.filter((m) => MODEL_ID.test(m.id)).slice(0, 1000).map((m) => ({ id: m.id, label: String(m.label || m.id).slice(0, 120) }));
  row.last_error = null;
  row.last_error_at = null;
  save();
  return snapshot();
}

/** A failed test or request. The stored verification is cleared, because it no longer holds. */
function markFailed(provider, message) {
  const row = check(provider);
  row.verified_at = null;
  row.last_error = String(message).slice(0, 300);
  row.last_error_at = Date.now();
  save();
  return snapshot();
}

/** Forget the verified connection but keep the key and manual model names. */
function disconnect(provider) {
  const row = check(provider);
  row.verified_at = null;
  row.models = [];
  row.last_error = null;
  row.last_error_at = null;
  save();
  return snapshot();
}

/** Forget everything about a provider. The caller removes the key from the keychain. */
function forget(provider) {
  state[provider] = blank();
  save();
  return snapshot();
}

function addManual(provider, id) {
  const clean = String(id || "").trim();
  if (!MODEL_ID.test(clean)) throw new Error("That model name is not valid. Use the exact ID from the provider's documentation.");
  const row = check(provider);
  if (!row.manual.includes(clean) && row.manual.length < 50) row.manual.push(clean);
  save();
  return snapshot();
}

function removeManual(provider, id) {
  const row = check(provider);
  row.manual = row.manual.filter((m) => m !== id);
  save();
  return snapshot();
}

function get(provider) {
  return snapshot()[provider] ?? null;
}

/** The public view: no secrets, and no key material. */
function snapshot() {
  const out = {};
  for (const p of PROVIDERS) {
    const row = state[p] ?? blank();
    out[p] = { verified_at: row.verified_at, models: row.models.slice(), manual: row.manual.slice(), last_error: row.last_error, last_error_at: row.last_error_at };
  }
  return out;
}

module.exports = { load, markVerified, markFailed, disconnect, forget, addManual, removeManual, get, snapshot, PROVIDERS, MODEL_ID };
