'use strict';
// ForgeAI Link — a built-in encrypted tunnel between ForgeAI computers on different networks.
//
// One computer is the hub: it has an address the others can reach (a ForgeAI Server on a small cloud machine, a home
// computer with a port opened on the router — ForgeAI can try to open it for you — or simply the same office network).
// Every other computer is a spoke: it connects OUT to the hub over TLS (so no port needs opening on the spoke) and keeps
// that one connection open. Inside it, ForgeAI multiplexes as many TCP streams as it needs: the spoke's ForgeAI API, its
// llama.cpp RPC server for clusters, and streams relayed to other spokes. Everything stays on the owner's own machines —
// there is no third-party relay service and nothing is sent anywhere except the hub.
//
// Pairing: the hub shows a one-time code; the spoke enters the hub address + code once and receives a long-lived link token
// and the hub's certificate fingerprint, which it pins from then on. A spoke only ever accepts streams to its own
// loopback ports that ForgeAI itself uses (its API, llama.cpp RPC, the local model apps) — never arbitrary hosts.
//
// Frame format on the tunnel: [type u8][stream id u32][length u32][payload]. Streams opened by the hub use even ids,
// streams opened by the spoke use odd ids, so both sides can open streams without coordination.

const net = require('net'); const tls = require('tls'); const crypto = require('crypto'); const { Duplex, EventEmitter } = require('stream'); const os = require('os');

const { Mux, MuxStream, T, HDR, MAX_FRAME, forwardListener } = require('./link_mux');

class LinkHub extends EventEmitter {
  constructor({ store, vault, log }) { super(); this.store = store; this.vault = vault; this.log = log || (() => {}); this.conns = new Map(); this.forwards = new Map(); this.exposed = new Map(); this.codes = new Map(); }
  settings() { return { enabled: false, name: os.hostname(), ...this.store.getSetting('link_hub', {}) }; }
  spokes() { return this.store.getSetting('link_spokes', {}); }
  saveSpokes(s) { this.store.setSetting('link_spokes', s); }
  // One-time pairing code shown to the owner; valid 15 minutes, single use.
  newCode() { const code = crypto.randomInt(0, 1e8).toString().padStart(8, '0').replace(/(\d{4})(\d{4})/, '$1-$2'); this.codes.set(code, Date.now() + 15 * 60000); return code; }
  // Enrolment keys: reusable codes for rolling ForgeAI out to many computers (silent installs). Each has an expiry and a
  // maximum number of uses, and can be revoked. Only a hash is stored.
  enrolKeys() { return this.store.getSetting('link_enrol', []); }
  newEnrolKey({ label, uses = 25, days = 7 } = {}) {
    const raw = 'FGE-' + crypto.randomBytes(15).toString('base64url').replace(/[-_]/g, 'x').toUpperCase().match(/.{1,5}/g).join('-');
    const k = { id: 'enr_' + crypto.randomBytes(5).toString('hex'), label: String(label || 'Rollout').slice(0, 60), hash: crypto.createHash('sha256').update(raw).digest('hex'), uses: Math.max(1, Math.min(10000, +uses || 25)), used: 0, expires: Date.now() + Math.max(1, Math.min(365, +days || 7)) * 86400000, created: Date.now(), joined: [] };
    this.store.setSetting('link_enrol', [...this.enrolKeys(), k]); return { ...k, key: raw, hash: undefined };
  }
  revokeEnrolKey(id) { this.store.setSetting('link_enrol', this.enrolKeys().filter((k) => k.id !== id)); }

  // ---- Owner-approved join requests ------------------------------------------------------------
  // A fresh computer can ASK to join (it sends only its identity, never a token). Nothing happens and it gets no
  // access until the owner approves THAT specific request on the hub. On approval the hub mints a single-use key
  // bound to the request's nonce; the device collects it once and then joins exactly like the key path. There is no
  // automatic hand-out and no "first hub wins" — a human on the hub must say yes.
  joinRequests() { return this.store.getSetting('link_requests', []); }
  addJoinRequest({ id, name, os, address, port, scheme, version, nonce } = {}) {
    if (!this.settings().enabled) throw new Error('Remote link is turned off on this hub');
    if (!/^[a-z0-9_-]{6,64}$/i.test(String(id || ''))) throw new Error('Bad computer id');
    if (!nonce) throw new Error('Missing request nonce');
    const nonceHash = crypto.createHash('sha256').update(String(nonce)).digest('hex');
    let list = this.joinRequests().filter((r) => (r.status === 'pending') || (Date.now() - (r.decidedAt || r.at) < 86400000));
    const ex = list.find((r) => r.id === id && r.status === 'pending');
    if (ex) { ex.name = String(name || id).slice(0, 60); ex.address = String(address || '').slice(0, 60); ex.os = String(os || '').slice(0, 20); ex.port = +port || ex.port; ex.scheme = scheme || ex.scheme; ex.version = String(version || '').slice(0, 20); ex.nonceHash = nonceHash; ex.at = Date.now(); this.store.setSetting('link_requests', list); this.emit('request'); return { status: 'pending' }; }
    list = list.slice(-200);
    list.push({ reqId: 'req_' + crypto.randomBytes(5).toString('hex'), id: String(id), name: String(name || id).slice(0, 60), os: String(os || '').slice(0, 20), address: String(address || '').slice(0, 60), port: +port || 4545, scheme: scheme === 'https' ? 'https' : 'http', version: String(version || '').slice(0, 20), nonceHash, status: 'pending', at: Date.now() });
    this.store.setSetting('link_requests', list); this.emit('request'); return { status: 'pending' };
  }
  approveJoinRequest(reqId, { label } = {}) {
    const list = this.joinRequests(); const r = list.find((x) => x.reqId === reqId); if (!r) throw new Error('No such join request');
    if (r.status === 'approved' && r.keyRef) return { ok: true, already: true };
    if (r.status === 'collected') throw new Error('That computer has already joined');
    const k = this.newEnrolKey({ label: label || ('Approved: ' + r.name), uses: 1, days: 2 });
    r.status = 'approved'; r.decidedAt = Date.now(); r.keyRef = this.vault.put(k.key); r.keyId = k.id;
    this.store.setSetting('link_requests', list); this.log(`Approved join request from ${r.name}`); return { ok: true };
  }
  declineJoinRequest(reqId) {
    const list = this.joinRequests(); const r = list.find((x) => x.reqId === reqId); if (!r) return { ok: true };
    if (r.keyRef) { this.vault.remove(r.keyRef); this.revokeEnrolKey(r.keyId); }
    r.status = 'declined'; r.decidedAt = Date.now(); r.keyRef = null; r.keyId = null;
    this.store.setSetting('link_requests', list); return { ok: true };
  }
  // Device polls this with its id + the nonce it chose. The approved key is released exactly once, to that device only.
  claimDecision(id, nonce) {
    const list = this.joinRequests(); const r = list.find((x) => x.id === id && ['pending', 'approved', 'declined', 'collected'].includes(x.status));
    if (!r) return { status: 'unknown' };
    if (r.status !== 'approved' || !r.keyRef) return { status: r.status === 'approved' ? 'collected' : r.status };
    const want = r.nonceHash || ''; const got = crypto.createHash('sha256').update(String(nonce || '')).digest('hex');
    if (want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return { status: 'pending' };
    const key = this.vault.reveal(r.keyRef); this.vault.remove(r.keyRef); r.keyRef = null; r.status = 'collected'; r.decidedAt = Date.now();
    this.store.setSetting('link_requests', list); this.log(`${r.name} collected its approval and is joining`);
    return { status: 'approved', key };
  }
  useEnrolKey(raw, who) {
    const h = crypto.createHash('sha256').update(String(raw || '').trim().toUpperCase()).digest('hex'); const list = this.enrolKeys(); const k = list.find((x) => x.hash === h);
    if (!k) return false; if (k.expires < Date.now()) throw new Error('That enrolment key has expired — make a new one on the hub'); if (k.used >= k.uses) throw new Error('That enrolment key has been used up — make a new one on the hub');
    k.used++; k.joined = [...(k.joined || []), { name: who, at: Date.now() }].slice(-200); this.store.setSetting('link_enrol', list); return true;
  }
  pair({ code, id, name, port, scheme, workerToken, version }) {
    const c = String(code || '').trim(); const exp = this.codes.get(c);
    if (exp && exp >= Date.now()) this.codes.delete(c);
    else if (!/^FGE-/i.test(c) || !this.useEnrolKey(c, name)) { this.codes.delete(c); throw new Error('That pairing code is wrong or has expired — make a new one on the hub'); }
    if (!/^[a-z0-9_-]{6,64}$/i.test(String(id || ''))) throw new Error('Bad computer id');
    const token = crypto.randomBytes(32).toString('base64url'); const all = this.spokes(); const old = all[id] || {};
    if (old.token_ref) this.vault.remove(old.token_ref); if (old.worker_ref) this.vault.remove(old.worker_ref);
    let nm = String(name || id).slice(0, 60); const taken = Object.values(all).filter((x) => x.id !== id).map((x) => x.name); if (taken.includes(nm)) { let i = 2; while (taken.includes(`${nm} (${i})`)) i++; nm = `${nm} (${i})`; }
    all[id] = { id, name: nm, port: +port || 4545, scheme: scheme === 'https' ? 'https' : 'http', version: version || null, token_ref: this.vault.put(token), worker_ref: workerToken ? this.vault.put(String(workerToken)) : null, paired_at: new Date().toISOString(), expose: old.expose || null };
    this.saveSpokes(all); this.log(`Paired ${all[id].name}`);
    return { token, hubId: this.hubId, hubName: this.settings().name, hubPort: this.hubPort, hubScheme: this.hubScheme, hubWorkerToken: this.workerToken && this.workerToken() };
  }
  // Called for every HTTP "upgrade" on the main server; returns true when it handled a link connection.
  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x'); if (url.pathname !== '/link/connect') return false;
    const fail = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); return true; };
    if (!this.settings().enabled) return fail(503, 'Link hub is off');
    if (!socket.encrypted && !/^(127\.|::1$|::ffff:127\.)/.test(socket.remoteAddress || '')) return fail(426, 'TLS required');
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); let hello = {};
    try { hello = JSON.parse(Buffer.from(req.headers['x-forgeai-link'] || '', 'base64').toString()); } catch {}
    const sp = this.spokes()[hello.id]; const want = sp && sp.token_ref ? this.vault.reveal(sp.token_ref) : null;
    if (!sp || !want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return fail(401, 'Unknown computer or bad link token');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: forgeai-link\r\nConnection: Upgrade\r\n\r\n');
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    const old = this.conns.get(sp.id); if (old) old.mux.close(new Error('Replaced by a new connection'));
    const mux = new Mux(socket, { even: true }); if (head && head.length) mux.onData(head);
    const all = this.spokes(); all[sp.id] = { ...all[sp.id], port: +hello.port || sp.port, scheme: hello.scheme || sp.scheme, version: hello.version || sp.version, lastSeen: new Date().toISOString(), address: socket.remoteAddress }; if (hello.workerToken) { if (all[sp.id].worker_ref) this.vault.remove(all[sp.id].worker_ref); all[sp.id].worker_ref = this.vault.put(String(hello.workerToken)); } this.saveSpokes(all);
    const conn = { id: sp.id, name: all[sp.id].name, mux, since: Date.now(), bytesIn: 0, bytesOut: 0, machine: hello.machine || null, availability: hello.availability || null, hello };
    socket.on('data', (d) => { conn.bytesIn += d.length; }); const w = socket.write.bind(socket); socket.write = (d, ...a) => { conn.bytesOut += d.length; return w(d, ...a); };
    this.conns.set(sp.id, conn);
    mux.on('open', (hdr, st, done) => this.onOpen(conn, hdr, st, done));
    mux.on('ctrl', (m, reply) => this.onCtrl(conn, m, reply));
    mux.on('close', () => { if (this.conns.get(sp.id) === conn) { this.conns.delete(sp.id); this.dropForwards(sp.id); this.emit('spoke', { id: sp.id, online: false }); this.broadcastPeers(); } });
    this.log(`${conn.name} connected from ${socket.remoteAddress}`);
    this.emit('spoke', { id: sp.id, online: true, conn }); this.broadcastPeers();
    return true;
  }
  // A spoke opened a stream: to the hub's own loopback ports, or via the hub to another spoke.
  onOpen(conn, hdr, st, done) {
    if (hdr.via) { const target = this.conns.get(hdr.via); if (!target) return done(new Error(`${hdr.via} is not connected to the hub`)); target.mux.open({ host: hdr.host, port: hdr.port }).then((far) => { done(); st.pipe(far).pipe(st); far.on('error', () => st.destroy()); st.on('error', () => far.destroy()); far.on('close', () => st.destroy()); st.on('close', () => far.destroy()); }).catch(done); return; }
    this.connectLocal(hdr, st, done);
  }
  // Only loopback ports ForgeAI itself uses may be reached through the link.
  connectLocal(hdr, st, done) {
    const port = +hdr.port; const allowed = this.allowedPorts ? this.allowedPorts() : [];
    if (!/^(127\.0\.0\.1|localhost|::1)$/.test(String(hdr.host || '127.0.0.1')) || !allowed.includes(port)) return done(new Error(`Port ${port} on this computer is not shared over the link`));
    const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { done(); c.pipe(st).pipe(c); }); c.once('error', (e) => { if (!st.opened) done(e); st.destroy(); }); st.on('error', () => c.destroy()); st.on('close', () => c.destroy()); c.on('close', () => st.destroy());
  }
  peers(forId) {
    const all = this.spokes(); const list = [];
    if (this.workerToken) list.push({ id: 'hub', name: this.settings().name, port: this.hubPort, scheme: this.hubScheme, workerToken: this.workerToken(), online: true, machine: this.machine ? this.machine() : null, availability: this.availability ? this.availability() : null });
    for (const s of Object.values(all)) { if (s.id === forId) continue; const c = this.conns.get(s.id); list.push({ id: s.id, name: s.name, port: s.port, scheme: s.scheme, workerToken: s.worker_ref ? this.vault.reveal(s.worker_ref) : null, online: !!c, machine: c ? c.machine : null, availability: c ? c.availability : null, lastSeen: s.lastSeen || null }); }
    return list;
  }
  broadcastPeers() { for (const c of this.conns.values()) c.mux.ctrl('peers', { peers: this.peers(c.id) }, 5000).catch(() => {}); }
  onCtrl(conn, m, reply) {
    if (m.req === 'peers') return reply({ peers: this.peers(conn.id) });
    if (m.req === 'status') { conn.machine = m.body && m.body.machine || conn.machine; conn.availability = m.body && m.body.availability || conn.availability; this.emit('status', conn); return reply({ ok: true }); }
    reply(null, new Error('Unknown request'));
  }
  // Local port on the hub that reaches host:port on a spoke (used to add the spoke as a computer and for llama.cpp RPC).
  async forward(spokeId, port, host = '127.0.0.1') {
    const key = `${spokeId}|${host}:${port}`; if (this.forwards.has(key)) return this.forwards.get(key).port;
    const srv = forwardListener(() => { const c = this.conns.get(spokeId); if (!c) return Promise.reject(new Error(`${spokeId} is offline`)); return c.mux.open({ host, port }); }, (e) => this.log(`forward ${key}: ${e.message}`));
    await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(0, '127.0.0.1', ok); });
    this.forwards.set(key, { port: srv.address().port, srv, spokeId }); return srv.address().port;
  }
  dropForwards(spokeId) { /* keep listeners: the node keeps its address and simply fails to connect while the spoke is offline */ }
  // Remote access: a port on the hub that anyone can open in a browser to reach a spoke's ForgeAI sign-in page. Explicit, per spoke, HTTPS-only.
  async expose(spokeId, publicPort) {
    const sp = this.spokes()[spokeId]; if (!sp) throw new Error('Unknown computer');
    if (sp.scheme !== 'https') throw new Error(`${sp.name} serves ForgeAI over plain HTTP. Turn on HTTPS under Settings → Remote access on that computer first — passwords must never cross the internet unencrypted.`);
    this.unexpose(spokeId);
    const srv = forwardListener(() => { const c = this.conns.get(spokeId); if (!c) return Promise.reject(new Error(`${spokeId} is offline`)); return c.mux.open({ host: '127.0.0.1', port: sp.port }); });
    await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(+publicPort, '0.0.0.0', ok); });
    this.exposed.set(spokeId, { srv, port: +publicPort }); const all = this.spokes(); all[spokeId].expose = +publicPort; this.saveSpokes(all); this.log(`Remote access to ${sp.name} on port ${publicPort}`);
    return +publicPort;
  }
  unexpose(spokeId) { const e = this.exposed.get(spokeId); if (e) { try { e.srv.close(); } catch {} this.exposed.delete(spokeId); } const all = this.spokes(); if (all[spokeId]) { all[spokeId].expose = null; this.saveSpokes(all); } }
  async restoreExposed() { for (const s of Object.values(this.spokes())) if (s.expose) await this.expose(s.id, s.expose).catch((e) => this.log(`expose ${s.name}: ${e.message}`)); }
  forget(spokeId) { const c = this.conns.get(spokeId); if (c) c.mux.close(new Error('Removed from the hub')); this.unexpose(spokeId); const all = this.spokes(); const s = all[spokeId]; if (s) { if (s.token_ref) this.vault.remove(s.token_ref); if (s.worker_ref) this.vault.remove(s.worker_ref); delete all[spokeId]; this.saveSpokes(all); } for (const [k, f] of this.forwards) if (f.spokeId === spokeId) { try { f.srv.close(); } catch {} this.forwards.delete(k); } this.broadcastPeers(); }

  saveRelay(cfg) { const cur = this.settings(); const r = { enabled: !!cfg.enabled, url: String(cfg.url || cur.relay_url || '').slice(0, 400), hubId: String(cfg.hubId || cur.relay_hubId || '').slice(0, 120), token: cfg.token ? this.vault.put(String(cfg.token)) : (cur.relay_token_ref || null) }; this.store.setSetting('link_hub', { ...cur, relay_enabled: r.enabled, relay_url: r.url, relay_hubId: r.hubId, relay_token_ref: r.token }); if (r.enabled) this.startRelay().catch(() => {}); else this.stopRelay(); return this.status(); }
  async startRelay() {
    const s = this.settings(); if (!s.relay_enabled) return; if (this._relayMux) return;
    this._relayState = { enabled: true, status: 'connecting', url: s.relay_url, hubId: s.relay_hubId, error: null };
    try {
      const u = new URL(s.relay_url); const { registerWithRelay } = require('./relay'); const token = this.vault.reveal(s.relay_token_ref);
      const { mux } = await registerWithRelay({ host: u.hostname, port: +u.port || 443, hubId: s.relay_hubId, token });
      this._relayMux = mux; this._relayState = { enabled: true, status: 'connected', since: Date.now(), url: s.relay_url, hubId: s.relay_hubId, error: null };
      this.log(`Registered with relay ${s.relay_url} as ${s.relay_hubId}`);
      mux.on('open', (hdr, st) => { if (hdr && hdr.relay_connect) { /* new spoke via relay: hand it to local accept */ st.pipe(require('net').connect(this.app && this.app.listenInfo ? this.app.listenInfo.port : 4545, '127.0.0.1')).pipe(st); } });
      mux.once('close', () => { this._relayMux = null; this._relayState = { enabled: true, status: 'retrying', url: s.relay_url, hubId: s.relay_hubId, error: 'disconnected' }; setTimeout(() => this.startRelay().catch(() => {}), 10000); });
    } catch (e) { this._relayState = { enabled: true, status: 'error', url: s.relay_url, hubId: s.relay_hubId, error: e.message }; this.log(`Relay: ${e.message}`); setTimeout(() => this.startRelay().catch(() => {}), 15000); }
  }
  stopRelay() { if (this._relayMux) try { this._relayMux.close(new Error('Stopped')); } catch {} this._relayMux = null; this._relayState = { enabled: false }; }

  status() { return { ...this.settings(), enrol: this.enrolKeys().map((k) => ({ ...k, hash: undefined, expired: k.expires < Date.now() })), requests: this.joinRequests().filter((r) => r.status === 'pending').map((r) => ({ reqId: r.reqId, name: r.name, os: r.os, address: r.address, version: r.version, at: r.at })), relay: this._relayState || { enabled: false }, spokes: Object.values(this.spokes()).map((s) => { const c = this.conns.get(s.id); return { id: s.id, name: s.name, online: !!c, since: c ? c.since : null, address: c ? c.hello && s.address : s.address || null, lastSeen: s.lastSeen || null, version: s.version, scheme: s.scheme, port: s.port, expose: s.expose || null, bytesIn: c ? c.bytesIn : 0, bytesOut: c ? c.bytesOut : 0, machine: c ? c.machine : null, availability: c ? c.availability : null }; }), forwards: [...this.forwards.entries()].map(([k, f]) => ({ key: k, port: f.port })), codes: [...this.codes.entries()].filter(([, e]) => e > Date.now()).map(([c, e]) => ({ code: c, expiresAt: new Date(e).toISOString() })) }; }
}

// ---------------------------------------------------------------- Spoke
class LinkSpoke extends EventEmitter {
  constructor({ store, vault, log }) { super(); this.store = store; this.vault = vault; this.log = log || (() => {}); this.mux = null; this.state = { status: 'off', error: null, since: null, attempts: 0 }; this.forwards = new Map(); this.peers = []; this.timer = null; this.stopped = true; }
  settings() { return this.store.getSetting('link', { enabled: false }); }
  save(s) { this.store.setSetting('link', s); return s; }
  // One-time pairing with a hub. `hello` describes this computer (id, name, port, scheme, workerToken).
  // Pair with a hub. `hubAddress` may be one address, or a comma/space list, or an array — every address of the
  // same hub (each VLAN/interface, the public address, the relay). The first that answers and accepts us wins,
  // and all of them are remembered so later reconnects can try each (a laptop that moves between networks).
  async pair(hubAddress, code, hello) {
    const addrs = (Array.isArray(hubAddress) ? hubAddress : String(hubAddress || '').split(/[\s,]+/))
      .map((a) => String(a || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    if (!addrs.length) throw new Error('Enter the hub address, like ai.example.com:4545 or 203.0.113.5:4545');
    if (addrs.length > 1) {
      const errs = [];
      for (const a of addrs) { try { return await this.pairOne(a, code, hello, addrs); } catch (e) { errs.push(`${a}: ${e.message}`); } }
      throw new Error(`None of the hub's addresses could be reached:\n${errs.join('\n')}`);
    }
    return this.pairOne(addrs[0], code, hello, addrs);
  }
  async pairOne(addr, code, hello, allAddrs) {
    const [host, p] = addr.split(':'); const port = +p || 4545; let fp = null;
    const res = await new Promise((ok, bad) => {
      const req = require('https').request({ host, port, path: '/node/link/pair', method: 'POST', headers: { 'content-type': 'application/json' }, rejectUnauthorized: false, agent: false, timeout: 15000 }, (r) => { fp = r.socket.getPeerCertificate().fingerprint256; let d = ''; r.setEncoding('utf8'); r.on('data', (c) => d += c); r.on('end', () => { try { ok({ status: r.statusCode, body: JSON.parse(d) }); } catch { ok({ status: r.statusCode === 200 ? 502 : r.statusCode, body: { error: 'That address is not a ForgeAI hub (unexpected reply)' } }); } }); });
      req.on('timeout', () => req.destroy(new Error(`${addr} did not answer. Check the address, that the hub is on, and that its port is open on the router.`)));
      req.on('error', (e) => bad(new Error(/ECONNREFUSED/.test(e.message) ? `${addr} refused the connection — is Remote link turned on there, and is the port right?` : /ENOTFOUND/.test(e.message) ? `${host}: the host name could not be found` : /wrong version number|EPROTO/.test(e.message) ? `${addr} is not serving HTTPS. The hub must use HTTPS (Settings → Remote access on the hub).` : e.message)));
      req.end(JSON.stringify({ code, ...hello }));
    });
    if (res.status !== 200) throw new Error(res.body.error || `Pairing failed (${res.status})`);
    const old = this.settings(); if (old.token_ref) this.vault.remove(old.token_ref); if (old.hub_worker_ref) this.vault.remove(old.hub_worker_ref);
    const s = this.save({ enabled: true, host, port, addresses: (allAddrs && allAddrs.length > 1) ? allAddrs : undefined, fingerprint: fp, hubId: res.body.hubId, hubName: res.body.hubName, hubPort: res.body.hubPort, hubScheme: res.body.hubScheme, token_ref: this.vault.put(res.body.token), hub_worker_ref: res.body.hubWorkerToken ? this.vault.put(res.body.hubWorkerToken) : null, paired_at: new Date().toISOString() });
    this.start(); return { hubName: s.hubName, fingerprint: fp };
  }
  // Small HTTPS JSON helper to a hub address (host[:port]).
  _hubJSON(addr, path, method, body) {
    const [host, p] = String(addr).replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':'); const port = +p || 4545;
    return new Promise((ok, bad) => {
      const req = require('https').request({ host, port, path, method, headers: { 'content-type': 'application/json' }, rejectUnauthorized: false, agent: false, timeout: 15000 }, (r) => { let d = ''; r.setEncoding('utf8'); r.on('data', (c) => d += c); r.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch {} if (r.statusCode === 200) ok(j); else bad(new Error(j.error || `Hub answered ${r.statusCode}`)); }); });
      req.on('timeout', () => req.destroy(new Error(`${addr} did not answer`)));
      req.on('error', (e) => bad(new Error(/ECONNREFUSED/.test(e.message) ? `${addr} refused the connection — is Remote link on there?` : e.message)));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  // Ask a hub to let this computer join. Sends only identity + a fresh nonce — never a token. The owner must approve
  // on the hub before anything is granted; this computer then collects its one-time key and pairs normally.
  async requestJoin(hubAddress) {
    const addrs = (Array.isArray(hubAddress) ? hubAddress : String(hubAddress || '').split(/[\s,]+/)).map((a) => String(a || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    if (!addrs.length) throw new Error('Enter the hub address, like ai.example.com:4545');
    const hello = this.hello ? this.hello() : {}; const nonce = crypto.randomBytes(18).toString('base64url');
    const errs = [];
    for (const addr of addrs) {
      try { await this._hubJSON(addr, '/node/link/request', 'POST', { id: hello.id, name: hello.name, os: process.platform, port: hello.port, scheme: hello.scheme, version: hello.version, nonce });
        this.save({ ...this.settings(), request: { hub: addr, addresses: addrs, nonce, id: hello.id, at: Date.now(), status: 'pending' } });
        this.startRequestPoll(); return { status: 'pending', hub: addr }; }
      catch (e) { errs.push(`${addr}: ${e.message}`); }
    }
    throw new Error(`Could not reach that hub to ask to join:\n${errs.join('\n')}`);
  }
  requestStatus() { const r = this.settings().request; return r ? { hub: r.hub, status: r.status || 'pending', at: r.at } : null; }
  cancelRequest() { const s = this.settings(); if (s.request) { delete s.request; this.save(s); } clearInterval(this._reqTimer); this._reqTimer = null; return { ok: true }; }
  startRequestPoll() {
    clearInterval(this._reqTimer);
    const tick = async () => {
      const s = this.settings(); const r = s.request; if (!r || r.status === 'done') { clearInterval(this._reqTimer); this._reqTimer = null; return; }
      if (s.enabled && s.token_ref) { clearInterval(this._reqTimer); this._reqTimer = null; return; } // already paired another way
      if (Date.now() - r.at > 7 * 86400000) { this.cancelRequest(); return; } // give up after a week
      try {
        const d = await this._hubJSON((r.addresses && r.addresses[0]) || r.hub, `/node/link/request/status?id=${encodeURIComponent(r.id)}&nonce=${encodeURIComponent(r.nonce)}`, 'GET');
        if (d.status === 'approved' && d.key) {
          this.log('Join request approved — pairing');
          try { await this.pair(r.addresses || r.hub, d.key, this.hello ? this.hello() : {}); const s2 = this.settings(); delete s2.request; this.save(s2); clearInterval(this._reqTimer); this._reqTimer = null; this.emit('state'); }
          catch (e) { this.log('pair after approval failed: ' + e.message); }
        } else if (d.status === 'declined') { this.log('Join request was declined on the hub'); const s2 = this.settings(); s2.request = { ...r, status: 'declined' }; this.save(s2); clearInterval(this._reqTimer); this._reqTimer = null; this.emit('state'); }
      } catch {}
    };
    this._reqTimer = setInterval(tick, 10000); this._reqTimer.unref && this._reqTimer.unref(); tick();
  }
  start() { const s = this.settings(); if (s.request && !(s.enabled && s.token_ref)) this.startRequestPoll(); if (!s.enabled || !s.token_ref) return; this.stopped = false; if (this.mux) return; this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.timer); if (this.mux) this.mux.close(new Error('Stopped')); this.state = { ...this.state, status: 'off', error: null }; }
  unpair() { this.stop(); const s = this.settings(); if (s.token_ref) this.vault.remove(s.token_ref); if (s.hub_worker_ref) this.vault.remove(s.hub_worker_ref); for (const f of this.forwards.values()) { try { f.srv.close(); } catch {} } this.forwards.clear(); this.peers = []; this.save({ enabled: false }); this.emit('peers', []); }
  // Which hub address to dial this attempt: the one that last worked, then rotate through the rest so a laptop
  // that moved to another VLAN / off the network finds the hub on whichever address is reachable now.
  dialAddress(s) {
    const list = (s.addresses && s.addresses.length ? s.addresses : [`${s.host}:${s.port}`]);
    const a = list[this.state.attempts % list.length];
    const [host, p] = a.split(':'); return { host, port: +p || 4545 };
  }
  connect() {
    const s = this.settings(); if (this.stopped || !s.enabled) return;
    const { host, port } = this.dialAddress(s);
    this.state = { ...this.state, status: 'connecting', error: null, dialing: `${host}:${port}` };
    const hello = this.hello ? this.hello() : {};
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: host, timeout: 15000 });
    const fail = (e) => { if (sock.destroyed && this.state.status === 'connected') return; sock.destroy(); this.state = { ...this.state, status: 'retrying', error: e.message, attempts: this.state.attempts + 1 }; this.log(`link: ${e.message}`); this.schedule(); };
    sock.once('timeout', () => fail(new Error(`${host}:${port} did not answer`)));
    sock.once('error', fail);
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate().fingerprint256;
      if (s.fingerprint && fp !== s.fingerprint) return fail(new Error('The hub\'s certificate changed — possible interception. Pair again if the hub was reinstalled.'));
      const token = this.vault.reveal(s.token_ref);
      sock.write(`GET /link/connect HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: forgeai-link\r\nAuthorization: Bearer ${token}\r\nX-ForgeAI-Link: ${Buffer.from(JSON.stringify(hello)).toString('base64')}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        sock.removeListener('data', onData); const head = buf.subarray(0, i).toString(); const rest = buf.subarray(i + 4);
        const m = /^HTTP\/1\.1 (\d+) ?(.*)/.exec(head); if (!m || m[1] !== '101') { const code = m ? m[1] : '?'; return fail(new Error(code === '401' ? 'The hub no longer recognises this computer — pair again' : code === '503' ? 'Remote link is turned off on the hub' : code === '426' ? 'The hub requires HTTPS' : `Hub answered ${code} ${m ? m[2] : ''}`)); }
        sock.removeAllListeners('error'); sock.removeAllListeners('timeout'); sock.setTimeout(0); sock.setNoDelay(true); sock.setKeepAlive(true, 15000);
        const mux = new Mux(sock, { even: false }); this.mux = mux; if (rest.length) mux.onData(rest);
        this.state = { status: 'connected', error: null, since: Date.now(), attempts: 0 }; this.log(`Connected to hub ${s.hubName || s.host}`);
        mux.on('open', (hdr, st, done) => this.onOpen(hdr, st, done));
        mux.on('ctrl', (m, reply) => { if (m.req === 'peers') { this.setPeers(m.body.peers || []); reply({ ok: true }); } else reply(null, new Error('Unknown request')); });
        mux.on('close', (err) => { if (this.mux === mux) { this.mux = null; if (!this.stopped) { this.state = { ...this.state, status: 'retrying', error: err ? err.message : 'Link closed' }; this.schedule(); } } this.emit('state'); });
        this.emit('state'); mux.ctrl('peers', {}).then((r) => this.setPeers(r.peers || [])).catch(() => {});
      };
      sock.on('data', onData);
    });
  }
  schedule() { clearTimeout(this.timer); const wait = Math.min(60000, 2000 * 2 ** Math.min(5, this.state.attempts)); this.timer = setTimeout(() => this.connect(), wait); this.timer.unref && this.timer.unref(); this.emit('state'); }
  // Streams from the hub (or relayed from other spokes) may only reach ForgeAI's own loopback ports here.
  onOpen(hdr, st, done) {
    const port = +hdr.port; const allowed = this.allowedPorts ? this.allowedPorts() : [];
    if (!/^(127\.0\.0\.1|localhost|::1)$/.test(String(hdr.host || '127.0.0.1')) || !allowed.includes(port)) return done(new Error(`Port ${port} on this computer is not shared over the link`));
    const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { done(); c.pipe(st).pipe(c); }); c.once('error', (e) => { if (!st.opened) done(e); st.destroy(); }); st.on('error', () => c.destroy()); st.on('close', () => c.destroy()); c.on('close', () => st.destroy());
  }
  setPeers(list) { this.peers = list; this.emit('peers', list); }
  // Local port here that reaches host:port on the hub ('hub') or on another spoke (through the hub).
  async forward(peerId, port, host = '127.0.0.1') {
    const key = `${peerId}|${host}:${port}`; if (this.forwards.has(key)) return this.forwards.get(key).port;
    const srv = forwardListener(() => { if (!this.mux) return Promise.reject(new Error('Not connected to the hub')); return this.mux.open(peerId === 'hub' ? { host, port } : { via: peerId, host, port }); }, (e) => this.log(`forward ${key}: ${e.message}`));
    await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(0, '127.0.0.1', ok); });
    this.forwards.set(key, { port: srv.address().port, srv, peerId }); return srv.address().port;
  }
  report(body) { if (this.mux) this.mux.ctrl('status', body, 5000).catch(() => {}); }
  status() { const s = this.settings(); return { enabled: !!s.enabled, hub: s.enabled ? `${s.host}:${s.port}` : null, hubName: s.hubName || null, fingerprint: s.fingerprint || null, pairedAt: s.paired_at || null, ...this.state, peers: this.peers.map((p) => ({ id: p.id, name: p.name, online: p.online, availability: p.availability || null })), forwards: [...this.forwards.entries()].map(([k, f]) => ({ key: k, port: f.port })) }; }
}

// ---------------------------------------------------------------- Opening a port on the home router (NAT-PMP, then UPnP IGD). Best effort; many routers allow it, some don't.
async function defaultGateway() {
  const { execFile } = require('child_process'); const run = (c, a) => new Promise((ok) => execFile(c, a, { timeout: 5000 }, (e, out) => ok(out || '')));
  if (process.platform === 'darwin') { const o = await run('route', ['-n', 'get', 'default']); const m = /gateway: (\S+)/.exec(o); return m ? m[1] : null; }
  if (process.platform === 'linux') { const o = await run('ip', ['route']); const m = /default via (\S+)/.exec(o); return m ? m[1] : null; }
  if (process.platform === 'win32') { const o = await run('powershell', ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop']); const m = /(\d+\.\d+\.\d+\.\d+)/.exec(o); return m ? m[1] : null; }
  return null;
}
async function natPmp(gw, port, lifetime = 7200) {
  const dgram = require('dgram');
  return new Promise((ok, bad) => {
    const s = dgram.createSocket('udp4'); const req = Buffer.alloc(12); req[0] = 0; req[1] = 2; req.writeUInt16BE(port, 4); req.writeUInt16BE(port, 6); req.writeUInt32BE(lifetime, 8);
    const t = setTimeout(() => { s.close(); bad(new Error('NAT-PMP: no answer from the router')); }, 3000);
    s.on('message', (m) => { clearTimeout(t); s.close(); const rc = m.readUInt16BE(2); if (rc !== 0) return bad(new Error('NAT-PMP: router refused (code ' + rc + ')')); ok({ method: 'NAT-PMP', externalPort: m.readUInt16BE(10), lifetime: m.readUInt32BE(12) }); });
    s.on('error', (e) => { clearTimeout(t); bad(e); }); s.send(req, 5351, gw);
  });
}
async function upnp(port, localIp, lifetime = 7200) {
  const dgram = require('dgram'); const http = require('http');
  const location = await new Promise((ok, bad) => {
    const s = dgram.createSocket('udp4'); const msg = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n';
    const t = setTimeout(() => { s.close(); bad(new Error('UPnP: no router answered (UPnP may be turned off on it)')); }, 3500);
    s.on('message', (m) => { const l = /LOCATION:\s*(\S+)/i.exec(m.toString()); if (l) { clearTimeout(t); s.close(); ok(l[1]); } });
    s.on('error', (e) => { clearTimeout(t); bad(e); }); s.bind(() => { s.setBroadcast(true); s.send(msg, 1900, '239.255.255.250'); });
  });
  const getText = (u) => new Promise((ok, bad) => http.get(u, { timeout: 5000 }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => ok(d)); }).on('error', bad));
  const desc = await getText(location); const base = new URL(location);
  const svc = /<serviceType>(urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/.exec(desc); if (!svc) throw new Error('UPnP: the router did not list a WAN connection service');
  const ctl = new URL(svc[3], base).toString(); const type = svc[1];
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:AddPortMapping xmlns:u="${type}"><NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>${port}</NewInternalPort><NewInternalClient>${localIp}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>ForgeAI</NewPortMappingDescription><NewLeaseDuration>${lifetime}</NewLeaseDuration></u:AddPortMapping></s:Body></s:Envelope>`;
  const res = await new Promise((ok, bad) => { const u = new URL(ctl); const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#AddPortMapping"`, 'content-length': Buffer.byteLength(body) }, timeout: 6000 }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => ok({ status: r.statusCode, body: d })); }); req.on('error', bad); req.end(body); });
  if (res.status !== 200) { const m = /<errorDescription>([^<]+)/.exec(res.body); throw new Error('UPnP: the router refused the port mapping' + (m ? ` (${m[1]})` : '')); }
  let external = null; try { const b2 = body.replace(/AddPortMapping/g, 'GetExternalIPAddress').replace(/<NewRemoteHost>[\s\S]*<\/NewLeaseDuration>/, ''); const r2 = await new Promise((ok, bad) => { const u = new URL(ctl); const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#GetExternalIPAddress"`, 'content-length': Buffer.byteLength(b2) }, timeout: 6000 }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => ok(d)); }); req.on('error', bad); req.end(b2); }); const m = /<NewExternalIPAddress>([^<]+)/.exec(r2); external = m ? m[1] : null; } catch {}
  return { method: 'UPnP', externalPort: port, lifetime, externalIp: external };
}
function localIpv4() { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address; return null; }
// Try NAT-PMP, then UPnP. Returns what worked or throws with both reasons.
async function openRouterPort(port) {
  const gw = await defaultGateway(); const errors = [];
  if (gw) { try { return { ...(await natPmp(gw, port)), gateway: gw }; } catch (e) { errors.push(e.message); } } else errors.push('Could not find the router address');
  try { return { ...(await upnp(port, localIpv4())), gateway: gw }; } catch (e) { errors.push(e.message); }
  throw new Error(errors.join('. ') + '. Next: open the port by hand in your router (“port forwarding”) to this computer, or use a ForgeAI Server on a small cloud machine as the hub.');
}

module.exports = { Mux, LinkHub, LinkSpoke, openRouterPort, defaultGateway, localIpv4 };
