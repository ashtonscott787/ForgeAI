'use strict';
// ForgeAI Relay — lets a hub and its spokes reach each other without anyone opening a port.
// Both sides connect OUT to the relay (TLS). The relay only moves bytes; everything inside the tunnel is
// still end-to-end between the spoke and the hub, with the hub's certificate pinned at pairing. If the relay
// is replaced, the fingerprint check fails and the spoke refuses to connect. So the relay cannot read or
// modify what passes through it — it only knows "spoke A asked to reach hub H".
//
// Wire format (relay <-> hub, relay <-> spoke): same TLS + Mux as link.js, with a tiny control message:
//   REGISTER { hubId, token } → hub tells the relay "I serve this hub id"
//   CONNECT  { hubId }        → spoke asks the relay to reach a hub
// On a CONNECT the relay opens a stream to the hub (mux.open({ relay_connect: true, from })); the hub pipes
// it to its own link listener (as if a spoke had connected directly). The spoke uses that stream as its own
// link transport and runs the normal pairing/connect handshake inside.

const tls = require('tls'); const crypto = require('crypto'); const { EventEmitter } = require('events'); const { Mux } = require('./link_mux');

class RelayServer extends EventEmitter {
  constructor({ cert, key, hubTokens = {}, log }) { super(); this.hubs = new Map(); this.hubTokens = hubTokens; this.log = log || (() => {}); this.server = tls.createServer({ cert, key }, (sock) => this.onSock(sock)); }
  listen(port, host = '0.0.0.0') { return new Promise((ok, bad) => { this.server.once('error', bad); this.server.listen(port, host, () => ok(this.server.address())); }); }
  stop() { try { this.server.close(); } catch {} for (const m of this.hubs.values()) try { m.close(); } catch {} this.hubs.clear(); }
  onSock(sock) {
    sock.setNoDelay(true); sock.setKeepAlive(true, 15000);
    const mux = new Mux(sock, { even: true });
    mux.ctrl = async (req, body) => mux._ctrl(req, body); // not used, kept for API parity
    mux.on('ctrl', async (m, reply) => {
      if (m.req === 'REGISTER') {
        const id = String((m.body || {}).hubId || '').slice(0, 128); const token = String((m.body || {}).token || '');
        const want = this.hubTokens[id]; if (!want || token.length !== want.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want))) { reply(null, new Error('Hub id or token unknown')); return mux.close(new Error('Register refused')); }
        const old = this.hubs.get(id); if (old) try { old.close(new Error('Replaced')); } catch {}
        this.hubs.set(id, mux); this.emit('register', { hubId: id }); mux.once('close', () => { if (this.hubs.get(id) === mux) { this.hubs.delete(id); this.emit('unregister', { hubId: id }); } }); reply({ ok: true });
      } else if (m.req === 'CONNECT') {
        const id = String((m.body || {}).hubId || ''); const hub = this.hubs.get(id); if (!hub) return reply(null, new Error('That hub is not connected to the relay right now'));
        // Open a stream to the hub, pipe this spoke's stream through it.
        hub.open({ relay_connect: true, from: 'spoke', hubId: id }).then((toHub) => {
          const spokeStream = mux.open({ relay_assigned: true }).then((toSpoke) => { // reserved — spoke doesn't initiate here
            toSpoke.pipe(toHub).pipe(toSpoke);
          });
          reply({ ok: true });
          // The ctrl reply pairs this mux's control-channel pending request. The actual data flow is:
          // spoke's existing data on this mux is what we want to tunnel. For simplicity, this server supports
          // one connect per mux: once connected, the whole mux pipes through to the hub.
          sock.pipe(hub.sock, { end: false });
          hub.sock.pipe(sock, { end: false });
        }).catch((e) => reply(null, e));
      } else reply(null, new Error('Unknown request'));
    });
    mux.on('close', () => { try { sock.destroy(); } catch {} });
  }
}

// Spoke helper: open a mux to the relay, send CONNECT, return the mux the caller can then use as a transport.
async function dialThroughRelay({ host, port, hubId, servername }) {
  const sock = await new Promise((ok, bad) => { const s = tls.connect({ host, port, servername: servername || host, rejectUnauthorized: false, timeout: 15000 }); s.once('secureConnect', () => ok(s)); s.once('error', bad); s.once('timeout', () => bad(new Error('Relay did not answer'))); });
  const mux = new Mux(sock, { even: false }); const r = await mux.ctrl('CONNECT', { hubId }, 15000); return { mux, sock, server_response: r };
}
// Hub helper: open a mux to the relay and REGISTER as a hub; the mux's "open" events are incoming spoke connections.
async function registerWithRelay({ host, port, hubId, token, servername }) {
  const sock = await new Promise((ok, bad) => { const s = tls.connect({ host, port, servername: servername || host, rejectUnauthorized: false, timeout: 15000 }); s.once('secureConnect', () => ok(s)); s.once('error', bad); s.once('timeout', () => bad(new Error('Relay did not answer'))); });
  const mux = new Mux(sock, { even: false }); const r = await mux.ctrl('REGISTER', { hubId, token }, 15000); return { mux, sock, server_response: r };
}

module.exports = { RelayServer, dialThroughRelay, registerWithRelay };
