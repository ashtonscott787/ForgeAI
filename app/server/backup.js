'use strict';
// Per-organisation backups: independent schedule, destination, encryption key and retention.
// Format: gzip(JSON{ db: base64, files: {relPath: base64} }) encrypted with AES-256-GCM using the org's own key.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

class Backups {
  constructor(store, vault) { this.store = store; this.vault = vault; }
  orgKey(orgDb) {
    let ref = orgDb.kv('backup_key_ref');
    if (!ref || !this.vault.reveal(ref)) { ref = this.vault.put(crypto.randomBytes(32).toString('base64')); orgDb.setKv('backup_key_ref', ref); }
    return Buffer.from(this.vault.reveal(ref), 'base64');
  }
  dest(orgDb) {
    const p = orgDb.policy().backup || {};
    const d = p.dest && p.dest.trim() ? path.join(p.dest.trim(), orgDb.id) : path.join(this.store.dataDir, 'backups', orgDb.id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  list(orgDb) {
    const d = this.dest(orgDb);
    return fs.readdirSync(d).filter((f) => f.endsWith('.aicbak')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(d, f)).size, at: fs.statSync(path.join(d, f)).mtime.toISOString() }));
  }
  create(orgDb, actor = 'system') {
    const tmp = path.join(orgDb.dir, 'backup-tmp.sqlite');
    try { fs.unlinkSync(tmp); } catch {}
    orgDb.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const files = {};
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(full, r); else files[r] = fs.readFileSync(full).toString('base64');
      }
    };
    walk(path.join(orgDb.dir, 'files'), '');
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, org: orgDb.org.name, at: new Date().toISOString(), db: fs.readFileSync(tmp).toString('base64'), files })));
    fs.unlinkSync(tmp);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.orgKey(orgDb), iv);
    const enc = Buffer.concat([c.update(payload), c.final()]);
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.aicbak`;
    fs.writeFileSync(path.join(this.dest(orgDb), name), Buffer.concat([Buffer.from('AICB1'), iv, c.getAuthTag(), enc]), { mode: 0o600 });
    orgDb.setKv('last_backup', new Date().toISOString());
    orgDb.audit(actor, 'backup.create', name);
    this.prune(orgDb);
    return name;
  }
  prune(orgDb) {
    const keep = Math.max(1, (orgDb.policy().backup || {}).keep || 14);
    const d = this.dest(orgDb);
    this.list(orgDb).slice(keep).forEach((b) => fs.unlinkSync(path.join(d, b.name)));
  }
  restore(orgDb, name, actor) {
    if (!/^backup-[\w-]+\.aicbak$/.test(name)) throw new Error('Invalid backup name');
    const buf = fs.readFileSync(path.join(this.dest(orgDb), name));
    if (buf.subarray(0, 5).toString() !== 'AICB1') throw new Error('Not an ForgeAI backup');
    const d = crypto.createDecipheriv('aes-256-gcm', this.orgKey(orgDb), buf.subarray(5, 17));
    d.setAuthTag(buf.subarray(17, 33));
    const data = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(33)), d.final()])).toString());
    this.create(orgDb, actor + ' (pre-restore safety copy)');
    const id = orgDb.id, dir = orgDb.dir;
    this.store.closeOrg(id);
    for (const f of ['org.sqlite-wal', 'org.sqlite-shm']) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    fs.writeFileSync(path.join(dir, 'org.sqlite'), Buffer.from(data.db, 'base64'));
    fs.rmSync(path.join(dir, 'files'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    for (const [rel, b64] of Object.entries(data.files || {})) {
      const out = path.join(dir, 'files', rel);
      if (!out.startsWith(path.join(dir, 'files'))) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    }
    const fresh = this.store.openOrg(id);
    fresh.audit(actor, 'backup.restore', name);
    return fresh;
  }
  tick() {
    for (const o of this.store.listOrgs()) {
      const db = this.store.openOrg(o.id); const b = db.policy().backup || {};
      if (!b.enabled) continue;
      const last = db.kv('last_backup');
      if (!last || Date.now() - new Date(last).getTime() > (b.every_hours || 24) * 3600e3) { try { this.create(db, 'scheduler'); } catch (e) { db.audit('scheduler', 'backup.failed', e.message); } }
    }
  }
}
module.exports = { Backups };
