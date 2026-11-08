/**
 * Where API keys live.
 *
 * Keys are encrypted with the operating system's own key store (Keychain on
 * macOS, DPAPI on Windows) through Electron's safeStorage, so the file on disk
 * is useless to another account or another machine. When the OS cannot provide
 * encryption, nothing is written and the caller is told — a key quietly saved
 * in plain text would be worse than no key at all.
 */
const fs = require("node:fs");
const path = require("node:path");
const { safeStorage } = require("electron");

let file = "";
let cache = {};

const persist = () => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

function load(dir) {
  file = path.join(dir, "secrets.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
}

const available = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

function set(provider, value) {
  const key = String(provider);
  if (!value) {
    delete cache[key];
    persist();
    return { stored: false };
  }
  if (!available()) {
    throw new Error("This computer's secure storage is unavailable, so Forge AI will not save the key rather than write it in plain text.");
  }
  cache[key] = {
    cipher: safeStorage.encryptString(String(value)).toString("base64"),
    saved: Date.now(),
    hint: String(value).slice(-4),
  };
  persist();
  return { stored: true };
}

function get(provider) {
  const row = cache[String(provider)];
  if (!row?.cipher) return null;
  try {
    return safeStorage.decryptString(Buffer.from(row.cipher, "base64"));
  } catch {
    return null;
  }
}

/** Never returns the keys themselves — only whether one is present. */
const status = () =>
  Object.fromEntries(
    Object.entries(cache).map(([k, v]) => [k, { saved: v.saved, hint: v.hint, verified: v.verified ?? null, verified_at: v.verified_at ?? null }]),
  );

function markVerified(provider, ok, detail) {
  const row = cache[String(provider)];
  if (!row) return;
  row.verified = Boolean(ok);
  row.verified_at = Date.now();
  row.detail = String(detail || "").slice(0, 200);
  persist();
}

module.exports = { load, set, get, status, markVerified, available };
