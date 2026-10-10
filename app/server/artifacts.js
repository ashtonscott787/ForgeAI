'use strict';
// Artifacts: ForgeAI's own version of "live HTML pages the AI makes with you".
// Each artifact is a single HTML page stored in the owning organisation's database. It is served under
// /art/<id> on this ForgeAI, so you can open it in a browser, or share the URL with people who are also
// signed in to this ForgeAI (and the artifact is shared). Artifacts can also be made public (unauthenticated),
// or restricted to the author only.
//
// Interactive artifacts can talk to each other: each page is injected with a small `window.forge` bridge that
// sends `postMessage({ bus: 'forge.art', ... })` through this server. The server fans the message out to every
// open page of every artifact in the same organisation that opted in. The owner of an artifact can switch the
// bus off at any time; no page is reached outside this ForgeAI without explicit sharing.
//
// Published versions never run arbitrary code from the browser: the HTML is CSP-restricted to `self` scripts,
// `'unsafe-inline'` so inline <script> works (that is how ForgeAI writes pages), no external network, inline
// styles, data: images; a bridge-only connection to this origin's own /art/bus endpoint.

const { EventEmitter } = require('events'); const crypto = require('crypto');

const BRIDGE = `<script>(() => {
  const art = { id: document.documentElement.dataset.artId || null, origin: location.origin };
  const subs = new Set(); let es = null; let seq = 0; const pend = new Map();
  const send = (type, body) => fetch('/art/bus', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-art-id': art.id || '' }, body: JSON.stringify({ type, body }) });
  const open = () => { if (es || !art.id) return; es = new EventSource('/art/bus/' + encodeURIComponent(art.id)); es.onmessage = (e) => { try { const m = JSON.parse(e.data); subs.forEach((f) => { try { f(m); } catch {} }); } catch {} }; es.onerror = () => { try { es.close(); } catch {} es = null; setTimeout(open, 2000); }; };
  window.forge = {
    id: art.id,
    onMessage(fn) { subs.add(fn); open(); return () => subs.delete(fn); },
    send(toOrChannel, data) { return send('msg', { to: typeof toOrChannel === 'string' ? toOrChannel : null, data }); },
    broadcast(channel, data) { return send('msg', { channel, data }); },
    async ask(assistant, prompt, options) { const r = await fetch('/art/ask', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-art-id': art.id || '' }, body: JSON.stringify({ prompt, options }) }); if (!r.ok) throw new Error('ask failed: ' + r.status); return r.text(); },
    async save(key, value) { const r = await fetch('/art/kv', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-art-id': art.id || '' }, body: JSON.stringify({ key, value }) }); return r.ok; },
    async load(key) { const r = await fetch('/art/kv?key=' + encodeURIComponent(key), { credentials: 'same-origin', headers: { 'x-art-id': art.id || '' } }); if (!r.ok) return null; return (await r.json()).value; },
  };
})();</script>`;

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'self'";

function wrap(html, id) {
  const h = String(html || '');
  const inject = BRIDGE;
  if (/<html[^>]*>/i.test(h)) {
    const withId = h.replace(/<html([^>]*)>/i, (m, a) => /\bdata-art-id=/.test(a) ? m : `<html${a} data-art-id="${id}">`);
    if (/<\/body>/i.test(withId)) return withId.replace(/<\/body>/i, inject + '</body>');
    return withId + inject;
  }
  return `<!doctype html><html lang="en" data-art-id="${id}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${h}${inject}</body></html>`;
}

class Artifacts extends EventEmitter {
  constructor({ store }) { super(); this.store = store; this.channels = new Map(); this.initDone = new Set(); }
  // Schema is created lazily per organisation DB
  init(orgDb) {
    if (this.initDone.has(orgDb.id)) return;
    orgDb.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT, html TEXT, kind TEXT DEFAULT 'html', visibility TEXT DEFAULT 'private', share_token TEXT, bus INTEGER DEFAULT 1, author TEXT, conv_id TEXT, origin TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS artifact_kv (art_id TEXT, k TEXT, v TEXT, PRIMARY KEY (art_id, k));
      CREATE INDEX IF NOT EXISTS artifacts_conv ON artifacts(conv_id);`);
    this.initDone.add(orgDb.id);
  }
  create(orgDb, { title, html, kind, visibility, bus, author, conv_id, origin, id }) {
    this.init(orgDb);
    const aid = id || ('art_' + crypto.randomBytes(8).toString('hex'));
    const v = ['private', 'org', 'public'].includes(visibility) ? visibility : 'private';
    const share = v === 'public' ? crypto.randomBytes(10).toString('base64url') : null;
    const now = new Date().toISOString();
    orgDb.run('INSERT INTO artifacts(id,title,html,kind,visibility,share_token,bus,author,conv_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      aid, String(title || 'Artifact').slice(0, 120), String(html || ''), kind || 'html', v, share, bus === false ? 0 : 1, author || null, conv_id || null, origin || null, now, now);
    return this.get(orgDb, aid);
  }
  update(orgDb, id, patch) {
    this.init(orgDb); const cur = this.get(orgDb, id); if (!cur) return null;
    const v = patch.visibility && ['private', 'org', 'public'].includes(patch.visibility) ? patch.visibility : cur.visibility;
    const share = v === 'public' ? (cur.share_token || crypto.randomBytes(10).toString('base64url')) : null;
    const now = new Date().toISOString();
    orgDb.run('UPDATE artifacts SET title=?, html=?, visibility=?, share_token=?, bus=?, updated_at=? WHERE id=?',
      patch.title ?? cur.title, patch.html ?? cur.html, v, share, patch.bus === false ? 0 : (patch.bus === true ? 1 : cur.bus), now, id);
    return this.get(orgDb, id);
  }
  remove(orgDb, id) { this.init(orgDb); orgDb.run('DELETE FROM artifacts WHERE id=?', id); orgDb.run('DELETE FROM artifact_kv WHERE art_id=?', id); for (const [k, s] of this.channels) if (k.endsWith('|' + id)) { s.forEach((r) => { try { r.end(); } catch {} }); this.channels.delete(k); } }
  get(orgDb, id) { this.init(orgDb); return orgDb.get('SELECT * FROM artifacts WHERE id=?', id); }
  list(orgDb, { conv_id, limit = 100 } = {}) { this.init(orgDb); return conv_id ? orgDb.all('SELECT * FROM artifacts WHERE conv_id=? ORDER BY updated_at DESC LIMIT ?', conv_id, limit) : orgDb.all('SELECT * FROM artifacts ORDER BY updated_at DESC LIMIT ?', limit); }
  renderPage(orgDb, id) { const a = this.get(orgDb, id); if (!a) return null; return { html: wrap(a.html, a.id), title: a.title, csp: CSP, visibility: a.visibility, bus: !!a.bus, share_token: a.share_token }; }
  findByShare(orgDb, token) { this.init(orgDb); return orgDb.get('SELECT * FROM artifacts WHERE share_token=? AND visibility=\'public\'', token); }
  // ---- cross-artifact message bus (per org)
  subscribe(orgDb, artId, res) {
    const key = orgDb.id + '|' + artId; const set = this.channels.get(key) || new Set(); set.add(res); this.channels.set(key, set);
    res.on('close', () => { set.delete(res); if (!set.size) this.channels.delete(key); });
  }
  fanout(orgDb, fromId, m) {
    const prefix = orgDb.id + '|'; const payload = `data: ${JSON.stringify({ from: fromId, at: Date.now(), ...m })}\n\n`;
    const only = m.to || null;
    for (const [k, set] of this.channels) {
      if (!k.startsWith(prefix)) continue;
      const toId = k.slice(prefix.length); if (toId === fromId) continue; // don't echo back to the sender
      if (only && only !== toId) continue;
      const art = this.get(orgDb, toId); if (!art || !art.bus) continue; // artifact's bus is off
      for (const res of set) { try { res.write(payload); } catch {} }
    }
  }
  kvGet(orgDb, artId, k) { this.init(orgDb); const r = orgDb.get('SELECT v FROM artifact_kv WHERE art_id=? AND k=?', artId, String(k).slice(0, 120)); return r ? JSON.parse(r.v) : null; }
  kvSet(orgDb, artId, k, v) { this.init(orgDb); const key = String(k).slice(0, 120); if (v === null || v === undefined) { orgDb.run('DELETE FROM artifact_kv WHERE art_id=? AND k=?', artId, key); return; } orgDb.run('INSERT INTO artifact_kv(art_id,k,v) VALUES(?,?,?) ON CONFLICT(art_id,k) DO UPDATE SET v=excluded.v', artId, key, JSON.stringify(v)); }
}

module.exports = { Artifacts, wrap, CSP };
