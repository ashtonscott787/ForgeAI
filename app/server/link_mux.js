'use strict';
// Shared frame mux used by link.js and relay.js — see link.js for the frame format.
const net = require('net');
const { Duplex, EventEmitter } = require('stream');

const T = { OPEN: 1, OPEN_OK: 2, OPEN_FAIL: 3, DATA: 4, END: 5, RST: 6, PING: 7, PONG: 8, CTRL: 9 };
const HDR = 9; const MAX_FRAME = 1 << 20;

class MuxStream extends Duplex {
  constructor(mux, id) { super({ allowHalfOpen: true }); this.mux = mux; this.id = id; this.opened = false; this.remoteEnded = false; }
  _read() {}
  _write(chunk, enc, cb) { if (!this.mux.sock || this.mux.sock.destroyed) return cb(new Error('Link closed')); for (let i = 0; i < chunk.length; i += MAX_FRAME) this.mux.frame(T.DATA, this.id, chunk.subarray(i, i + MAX_FRAME)); if (this.mux.sock.writableNeedDrain) this.mux.sock.once('drain', () => cb()); else cb(); }
  _final(cb) { this.mux.frame(T.END, this.id); cb(); }
  _destroy(err, cb) { if (!this.remoteEnded && this.mux.sock && !this.mux.sock.destroyed) this.mux.frame(T.RST, this.id); this.mux.streams.delete(this.id); cb(err); }
}

class Mux extends EventEmitter {
  constructor(sock, { even }) { super(); this.sock = sock; this.next = even ? 2 : 1; this.streams = new Map(); this.buf = Buffer.alloc(0); this.ctrlId = 0; this.ctrlWaiting = new Map(); this.alive = true;
    sock.on('data', (d) => this.onData(d)); sock.on('close', () => this.close(new Error('Link closed'))); sock.on('error', (e) => this.close(e));
    this.pingTimer = setInterval(() => { if (!this.alive) return this.close(new Error('Link timed out (no reply to keep-alive)')); this.alive = false; this.frame(T.PING, 0); }, 20000);
    this.pingTimer.unref && this.pingTimer.unref(); }
  frame(type, id, payload) { if (!this.sock || this.sock.destroyed) return; const p = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(payload)) : Buffer.alloc(0); const h = Buffer.alloc(HDR); h[0] = type; h.writeUInt32BE(id >>> 0, 1); h.writeUInt32BE(p.length, 5); this.sock.write(p.length ? Buffer.concat([h, p]) : h); }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= HDR) {
      const type = this.buf[0], id = this.buf.readUInt32BE(1), len = this.buf.readUInt32BE(5);
      if (len > MAX_FRAME) return this.close(new Error('Bad frame on link'));
      if (this.buf.length < HDR + len) break;
      const payload = this.buf.subarray(HDR, HDR + len); this.buf = this.buf.subarray(HDR + len);
      this.handle(type, id, payload);
    }
  }
  handle(type, id, p) {
    const s = this.streams.get(id);
    switch (type) {
      case T.PING: this.frame(T.PONG, 0); break;
      case T.PONG: this.alive = true; break;
      case T.OPEN: { let hdr = {}; try { hdr = JSON.parse(p.toString()); } catch {} const st = new MuxStream(this, id); st.opened = true; this.streams.set(id, st); this.emit('open', hdr, st, (err) => { if (err) { this.frame(T.OPEN_FAIL, id, JSON.stringify({ error: String(err.message || err) })); this.streams.delete(id); st.destroy(); } else this.frame(T.OPEN_OK, id); }); break; }
      case T.OPEN_OK: if (s && s.onOpen) { s.opened = true; s.onOpen(); } break;
      case T.OPEN_FAIL: if (s) { let e = 'refused'; try { e = JSON.parse(p.toString()).error; } catch {} this.streams.delete(id); if (s.onOpen) s.onOpen(new Error(e)); s.destroy(new Error(e)); } break;
      case T.DATA: if (s) s.push(Buffer.from(p)); break;
      case T.END: if (s) { s.remoteEnded = true; s.push(null); } break;
      case T.RST: if (s) { s.remoteEnded = true; this.streams.delete(id); s.destroy(); } break;
      case T.CTRL: { let m = {}; try { m = JSON.parse(p.toString()); } catch {} if (m.res != null && this.ctrlWaiting.has(m.res)) { const w = this.ctrlWaiting.get(m.res); this.ctrlWaiting.delete(m.res); clearTimeout(w.t); m.error ? w.bad(new Error(m.error)) : w.ok(m.body); } else if (m.req) this.emit('ctrl', m, (body, error) => this.frame(T.CTRL, 0, JSON.stringify({ res: m.id, body, error: error ? String(error.message || error) : undefined }))); break; }
    }
  }
  // Open a stream to {host, port} on the other side (or, through a hub, {via: spokeId, host, port}). Resolves once the far end accepted it.
  open(hdr) {
    return new Promise((ok, bad) => {
      const id = this.next; this.next += 2; const st = new MuxStream(this, id); this.streams.set(id, st);
      const t = setTimeout(() => { if (!st.opened) { this.streams.delete(id); st.destroy(); bad(new Error('Opening the stream timed out')); } }, 15000);
      st.onOpen = (err) => { clearTimeout(t); st.onOpen = null; err ? bad(err) : ok(st); };
      this.frame(T.OPEN, id, JSON.stringify(hdr));
    });
  }
  ctrl(req, body, ms = 15000) { return new Promise((ok, bad) => { const id = ++this.ctrlId; const t = setTimeout(() => { this.ctrlWaiting.delete(id); bad(new Error('No reply from the other side')); }, ms); this.ctrlWaiting.set(id, { ok, bad, t }); this.frame(T.CTRL, 0, JSON.stringify({ req, id, body })); }); }
  close(err) { if (!this.sock) return; clearInterval(this.pingTimer); const sock = this.sock; this.sock = null; for (const s of this.streams.values()) s.destroy(err); this.streams.clear(); for (const w of this.ctrlWaiting.values()) { clearTimeout(w.t); w.bad(err || new Error('Link closed')); } this.ctrlWaiting.clear(); try { sock.destroy(); } catch {} this.emit('close', err); }
}

// Pipe a local TCP listener into mux streams: every connection to 127.0.0.1:<port> becomes a stream to `target` on the far side.
function forwardListener(openStream, onError) {
  const srv = net.createServer((c) => {
    c.pause();
    openStream().then((st) => { c.pipe(st).pipe(c); c.resume(); st.on('error', () => c.destroy()); c.on('error', () => st.destroy()); st.on('close', () => c.destroy()); c.on('close', () => st.destroy()); }).catch((e) => { onError && onError(e); c.destroy(); });
  });
  return srv;
}

// ---------------------------------------------------------------- Hub

module.exports = { Mux, MuxStream, T, HDR, MAX_FRAME, forwardListener };
