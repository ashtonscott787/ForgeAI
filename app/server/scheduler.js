'use strict';
// Request scheduler and model memory manager.
// Scheduler: each app/endpoint answers a limited number of requests at once; extra requests wait in a priority queue
// (chat before agents before benchmarks), can be cancelled while waiting, and their wait time is measured so the
// Performance page can show "queue time". Nothing here blocks the interface — the server stays responsive.
// Memory manager: decides which local models stay loaded (keep N, idle timeout) and never unloads one in use.

class Scheduler {
  constructor(store) { this.store = store; this.q = new Map(); this.active = new Map(); }
  blocked(priority, key) { return !!(this.gate && !/^cloud:/.test(key || '') && this.gate(priority)); }
  pumpAll() { for (const k of this.q.keys()) this.pump(k); }
  limitFor(key) { const s = this.store.getSetting('concurrency', {}); if (s[key]) return s[key]; if (/^cloud:/.test(key)) return s.cloudDefault || 8; if (/forgeai-engine/.test(key)) return s.engineDefault || 4; return s.localDefault || 2; }
  pending(key) { return (this.q.get(key) || []).length; }
  running(key) { return this.active.get(key) || 0; }
  snapshot() { const out = {}; for (const k of new Set([...this.q.keys(), ...this.active.keys()])) out[k] = { running: this.running(k), waiting: this.pending(k), limit: this.limitFor(k) }; return out; }
  acquire(key, { priority = 1, signal, onWait } = {}) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const grant = () => { this.active.set(key, this.running(key) + 1); let released = false; resolve({ waitMs: Date.now() - t0, release: () => { if (released) return; released = true; this.active.set(key, Math.max(0, this.running(key) - 1)); this.pump(key); } }); };
      if (this.running(key) < this.limitFor(key) && !this.pending(key) && !this.blocked(priority, key)) return grant();
      const item = { priority, grant, reject, at: t0 };
      const list = this.q.get(key) || []; list.push(item); list.sort((a, b) => a.priority - b.priority || a.at - b.at); this.q.set(key, list);
      onWait && onWait(list.indexOf(item) + this.running(key), this.blocked(priority, key) ? 'yield' : 'queue');
      if (signal) signal.addEventListener('abort', () => { const l = this.q.get(key) || []; const i = l.indexOf(item); if (i >= 0) { l.splice(i, 1); reject(Object.assign(new Error('Stopped while waiting in the queue'), { name: 'AbortError' })); } }, { once: true });
    });
  }
  pump(key) { const list = this.q.get(key) || []; while (list.length && this.running(key) < this.limitFor(key)) { const i = list.findIndex((x) => !this.blocked(x.priority, key)); if (i < 0) break; list.splice(i, 1)[0].grant(); } }
}

class MemoryManager {
  constructor({ store, cluster, engine, perf }) { this.store = store; this.cluster = cluster; this.engine = engine; this.perf = perf; this.pinned = new Set(store.getSetting('pinned_models', [])); this.log = []; }
  settings() { return { keep: 'auto', idleMinutes: 30, ...this.store.getSetting('memory', {}) }; }
  save(s) { const cur = this.settings(); const n = { keep: ['auto', 'max', 1, 2, 3, 4].includes(s.keep) ? s.keep : cur.keep, idleMinutes: s.idleMinutes == null ? cur.idleMinutes : Math.max(0, Math.min(1440, +s.idleMinutes || 0)) }; this.store.setSetting('memory', n); return n; }
  pin(id, on) { if (on) this.pinned.add(id); else this.pinned.delete(id); this.store.setSetting('pinned_models', [...this.pinned]); }
  note(t) { this.log.unshift({ at: Date.now(), text: t }); if (this.log.length > 50) this.log.pop(); }
  // Local models loaded right now, with how long since they were used and whether a request is using them.
  loaded() {
    const local = this.cluster.nodes().find((n) => n.is_local); if (!local) return [];
    const st = this.cluster.state.get(local.id); if (!st) return [];
    return st.models.filter((m) => m.loaded).map((m) => { const k = local.id + '|' + m.id; return { id: m.id, runtime: m.runtime, url: m._url, memBytes: m.memBytes || 0, inUse: this.cluster.modelInflight.get(k) || 0, lastUsed: this.cluster.lastUsed.get(k) || null, pinned: this.pinned.has(m.id), node: local }; });
  }
  async unload(m, why) {
    if (m.inUse > 0) return false; // never while a request is using it
    try {
      if (m.runtime === 'engine') await this.engine.unload(m.id);
      else if (m.runtime === 'ollama') await fetch((m.url || 'http://127.0.0.1:11434') + '/api/generate', { method: 'POST', body: JSON.stringify({ model: m.id, keep_alive: 0 }), signal: AbortSignal.timeout(15000) });
      else if (m.runtime === 'lmstudio') { const { adapter } = this.cluster.lmStudioFor(m.node.id); const list = await adapter.j('/api/v1/models', 8000); const it = (list.models || list.data || []).find((x) => (x.key || x.id) === m.id); for (const ins of (it && it.loaded_instances) || []) await adapter.oa._fetch(adapter.root + '/api/v1/models/unload', { method: 'POST', headers: adapter.oa.headers(), body: JSON.stringify({ instance_id: ins.id }) }); }
      else return false;
      this.note(`Unloaded ${m.id} (${m.runtime}): ${why}`); return true;
    } catch (e) { this.note(`Could not unload ${m.id}: ${e.message}`); return false; }
  }
  // Free enough memory for `bytes` by unloading idle, unpinned models (least recently used first). Returns bytes freed.
  async makeRoom(bytes, exceptId) {
    let freed = 0; const cands = this.loaded().filter((m) => m.id !== exceptId && !m.pinned && !m.inUse).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    for (const m of cands) { if (freed >= bytes) break; if (await this.unload(m, 'making room for another model')) freed += m.memBytes; }
    if (freed) await this.cluster.refreshAll().catch(() => {});
    return freed;
  }
  keepLimit() { const s = this.settings(); if (s.keep === 'max') return 99; if (s.keep === 'auto') { const total = require('os').totalmem(); return Math.max(1, Math.min(6, Math.floor(total / (12 * 2 ** 30)))); } return +s.keep; }
  // Periodic: idle timeout and keep-N (pinned and in-use models are never touched).
  async tick() {
    const s = this.settings(); const list = this.loaded().filter((m) => !m.pinned && !m.inUse && m.runtime !== 'llamacpp'); let changed = false;
    if (s.idleMinutes > 0) for (const m of list) if (m.lastUsed && Date.now() - m.lastUsed > s.idleMinutes * 60000) { if (await this.unload(m, `idle for ${s.idleMinutes} min`)) changed = true; }
    const still = this.loaded().filter((m) => !m.inUse); const limit = this.keepLimit();
    if (still.length > limit) { const victims = still.filter((m) => !m.pinned).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0)).slice(0, still.length - limit); for (const m of victims) if (await this.unload(m, `more than ${limit} models loaded`)) changed = true; }
    if (changed) await this.cluster.refreshAll().catch(() => {});
  }
}

module.exports = { Scheduler, MemoryManager };
