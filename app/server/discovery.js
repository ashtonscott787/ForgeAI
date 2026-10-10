'use strict';
// LAN discovery so Macs and Windows PCs find each other without typing addresses.
// A server with remote access on answers "who is there?" broadcasts on UDP 45678.
// Beacons are only hints (they are unauthenticated): connecting still needs a login or a node token,
// and HTTPS certificates are pinned on first use.
const dgram = require('dgram');
const os = require('os');

const PORT = 45678;
const MAGIC = 'aicore/1';

function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
  }
  return [...out];
}

class Discovery {
  constructor(getInfo) { this.getInfo = getInfo; this.sock = null; this.timer = null; }
  start() {
    if (this.sock) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => { try { s.close(); } catch {} this.sock = null; });
    s.on('message', (buf, rinfo) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.magic !== MAGIC || m.type !== 'discover') return;
      const info = this.getInfo(); if (!info) return;
      const reply = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'here', ...info }));
      s.send(reply, rinfo.port, rinfo.address);
    });
    s.bind(PORT, () => { try { s.setBroadcast(true); } catch {} });
    this.sock = s;
  }
  stop() { if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; } }
}

// Ask the network who is there. Resolves with a de-duplicated list after `ms`.
function scan(ms = 1500, selfId) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { s.close(); } catch {} resolve([...found.values()]); };
    s.on('error', done);
    s.on('message', (buf, rinfo) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.magic !== MAGIC || m.type !== 'here' || m.id === selfId) return;
      const url = `${m.https ? 'https' : 'http'}://${rinfo.address}:${m.port}`;
      found.set(m.id + url, { id: m.id, name: m.name, host: m.host, os: m.os, url, https: !!m.https, fingerprint: m.fp || null, worker: !!m.worker, version: m.version });
    });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch {}
      const q = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'discover' }));
      for (const addr of broadcastAddrs()) s.send(q, PORT, addr, () => {});
      setTimeout(done, ms);
    });
  });
}

module.exports = { Discovery, scan, PORT };
