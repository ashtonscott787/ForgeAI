'use strict';
// Provider vault. Secrets are encrypted at rest and only ever decrypted inside provider adapters.
// Nothing in the API returns a raw secret; the UI only sees a masked hint.
// Encryption backend:
//   - In the Mac app: Electron safeStorage (key held in the macOS Keychain).
//   - Headless/server mode: AES-256-GCM with a random master key file (chmod 600) or AICORE_MASTER_KEY.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Vault {
  constructor(dataDir, backend) {
    this.file = path.join(dataDir, 'vault.json');
    this.backend = backend || fileKeyBackend(dataDir);
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  put(value, ref) {
    ref = ref || 'sec_' + crypto.randomBytes(8).toString('hex');
    this.data[ref] = { v: this.backend.encrypt(String(value)), hint: mask(value), at: new Date().toISOString() };
    this.save();
    return ref;
  }
  // Only adapters / backup code call this.
  reveal(ref) {
    const e = ref && this.data[ref];
    return e ? this.backend.decrypt(e.v) : null;
  }
  hint(ref) { return (ref && this.data[ref] && this.data[ref].hint) || null; }
  remove(ref) { if (ref && this.data[ref]) { delete this.data[ref]; this.save(); } }
  get backendName() { return this.backend.name; }
}

function mask(v) { v = String(v); return v.length <= 8 ? '••••' : v.slice(0, 3) + '…' + v.slice(-4); }

function fileKeyBackend(dataDir) {
  let key;
  if (process.env.AICORE_MASTER_KEY) key = crypto.createHash('sha256').update(process.env.AICORE_MASTER_KEY).digest();
  else {
    const kf = path.join(dataDir, 'master.key');
    if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(kf, 'utf8'), 'base64');
  }
  return {
    name: process.env.AICORE_MASTER_KEY ? 'AES-256-GCM (env key)' : 'AES-256-GCM (key file)',
    encrypt(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    decrypt(b64) {
      const b = Buffer.from(b64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

// Used by the Electron wrapper.
function safeStorageBackend(safeStorage) {
  return {
    name: 'macOS Keychain (safeStorage)',
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

module.exports = { Vault, safeStorageBackend, fileKeyBackend };
