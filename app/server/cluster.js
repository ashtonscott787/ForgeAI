'use strict';
// Compute cluster: physical Macs (nodes) and the local model runtimes on them.
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
// Organisations never pick a node; the scheduler does (pick()).
const { OllamaAdapter, LocalCompatRuntime, WorkerNodeAdapter, OpenAIAdapter, PRESET_NAMES } = require('./providers');
const apps = require('./apps');
const { networkScope, explainNet } = require('./net');
const { uid, now } = require('./db');

const DEFAULT_LOCAL_RUNTIMES = [
  { runtime: 'ollama', url: 'http://127.0.0.1:11434' },
  { runtime: 'lmstudio', url: 'http://127.0.0.1:1234' },
  { runtime: 'mlx', url: 'http://127.0.0.1:8080' },
];

class Cluster {
  constructor(store, vault) {
    this.store = store; this.vault = vault;
    this.state = new Map();   // nodeId -> { status, error, models, checkedAt }
    this.inflight = new Map(); // nodeId -> count
    this.orgRam = new Map();   // orgId -> bytes currently in use by in-flight jobs
    this.speed = new Map();    // nodeId|model -> tokens/sec (EMA)
    this.ttft = new Map();     // nodeId|model -> time to first token ms (EMA)
    this.modelInflight = new Map(); // nodeId|model -> requests using it right now (never unload while > 0)
    this.lastUsed = new Map();      // nodeId|model -> last request time
    this.metrics = new Map();       // nodeId -> last machine metrics seen (workers)
    if (!store.get('SELECT id FROM nodes WHERE is_local=1')) {
      store.run('INSERT INTO nodes(id,name,kind,url,ram_gb,enabled,is_local,created_at) VALUES(?,?,?,?,?,?,?,?)',
        uid('node_'), process.platform === 'darwin' ? 'This Mac' : process.platform === 'win32' ? 'This PC' : 'This computer', 'local', '', Math.round(require('os').totalmem() / 2 ** 30), 1, 1, now());
    }
  }
  localRuntimes() { return this.store.getSetting('local_runtimes', DEFAULT_LOCAL_RUNTIMES); }
  nodes() { return this.store.all('SELECT * FROM nodes ORDER BY is_local DESC, name'); }

  // Connection options for a self-hosted server: API key, extra headers, TLS mode, timeout.
  netFor(node) {
    let headers = {}; try { headers = node.headers_ref ? JSON.parse(this.vault.reveal(node.headers_ref) || '{}') : {}; } catch {}
    return { headers, tlsMode: node.tls_mode || 'verify', pin: node.cert_pin || null, timeoutMs: node.timeout_ms || 0 };
  }
  keyFor(node) { return node.api_key_ref ? this.vault.reveal(node.api_key_ref) : node.apiKey || null; }
  runtimesFor(node) {
    if (node.kind === 'local') {
      const list = this.localRuntimes().map((r) => ({ ...r, adapter: r.runtime === 'ollama' ? new OllamaAdapter({ baseUrl: r.url }) : new LocalCompatRuntime({ baseUrl: r.url, runtime: r.runtime, preset: r.runtime, apiKey: r.runtime === 'lmstudio' ? this.lmStudioToken() : null }) }));
      if (this.engine) list.unshift({ runtime: 'engine', url: 'forgeai-engine://local', adapter: new EngineRuntime(this.engine) });
      return list;
    }
    const net = node._net || this.netFor(node); const apiKey = node._key !== undefined ? node._key : this.keyFor(node);
    if (node.kind === 'ollama') return [{ runtime: 'ollama', url: node.url, adapter: new OllamaAdapter({ baseUrl: node.url, net, apiKey }) }];
    if (node.kind === 'compat') return [{ runtime: node.preset || 'openai-compatible', url: node.url, adapter: new LocalCompatRuntime({ baseUrl: node.url, preset: node.preset || 'generic', runtime: node.preset || 'openai-compatible', apiKey, net }) }];
    if (node.kind === 'worker') return [{ runtime: 'worker', url: node.url, adapter: new WorkerNodeAdapter({ baseUrl: node.url, token: this.vault.reveal(node.secret_ref), pin: node.cert_pin, onPin: (fp) => this.store.run('UPDATE nodes SET cert_pin=? WHERE id=?', fp, node.id) }) }];
    return [];
  }

  async refreshNode(node) {
    const models = []; const errors = []; let anyOk = false; const endpoints = [];
    for (const rt of this.runtimesFor(node)) {
      const t0 = Date.now();
      try {
        const ms = await rt.adapter.discover();
        anyOk = true; endpoints.push({ url: rt.url, runtime: rt.runtime, ok: true, latencyMs: Date.now() - t0, models: ms.length });
        for (const m of ms) models.push({ ...m, runtime: m.runtime || rt.runtime, _url: rt.url });
        if (node.kind === 'local' && ['ollama', 'lmstudio'].includes(rt.runtime) && ms.length) this.remember(rt.url, ms);
      } catch (e) {
        endpoints.push({ url: rt.url, runtime: rt.runtime, ok: false, latencyMs: null, error: explainNet(e, rt.url, 'Listing models').message });
        if (node.kind !== 'local') errors.push(explainNet(e, rt.url, 'Listing models').message);
        // The app is installed but not running: keep its models listed — ForgeAI starts the app when one is used.
        else if (['ollama', 'lmstudio'].includes(rt.runtime) && this.appInstalled(rt.runtime)) {
          const mem = (this.store.getSetting('runtime_memory', {})[rt.url] || []);
          if (mem.length) { anyOk = true; endpoints[endpoints.length - 1].startable = true; for (const m of mem) models.push({ ...m, runtime: rt.runtime, _url: rt.url, loaded: false, offline: true, startable: true }); }
        }
      }
    }
    if (node.kind === 'worker' && anyOk) { try { const rt = this.runtimesFor(node)[0]; const m = await rt.adapter.get('/node/metrics', 4000); if (m && m.machine) this.metrics.set(node.id, { ...m.machine, at: Date.now(), availability: m.availability || null, lend: m.lend || null }); } catch {} }
    const prev = this.state.get(node.id);
    const loadedNow = new Set(models.filter((m) => m.loaded).map((m) => m.id));
    const changes = prev && prev.models ? [...loadedNow].filter((id) => !prev.models.some((m) => m.id === id && m.loaded)).map((id) => ({ id, change: 'loaded' }))
      .concat(prev.models.filter((m) => m.loaded && !loadedNow.has(m.id)).map((m) => ({ id: m.id, change: 'unloaded' }))) : [];
    const st = { status: anyOk ? 'online' : 'offline', error: errors.join('; ') || (anyOk ? '' : 'No local model runtime found'), models, endpoints, checkedAt: now(), changes: changes.length ? changes : prev && prev.changes || [], changedAt: changes.length ? now() : prev && prev.changedAt };
    this.state.set(node.id, st);
    return st;
  }
  // Try a server configuration without saving it: reachable? authenticated? how many models? how fast?
  async testConfig(cfg) {
    const node = { id: 'test', kind: cfg.kind, url: String(cfg.url || '').replace(/\/+$/, ''), preset: cfg.preset, _key: cfg.apiKey || null, _net: { headers: cfg.headers || {}, tlsMode: cfg.tls_mode || 'verify', pin: cfg.cert_pin || null, timeoutMs: cfg.timeout_ms || 8000 } };
    const t0 = Date.now();
    try {
      const rt = this.runtimesFor(node)[0]; if (!rt) throw new Error('Unknown server type');
      const ms = await rt.adapter.discover();
      return { reachable: true, authenticated: true, modelCount: ms.length, latencyMs: Date.now() - t0, models: ms.slice(0, 500).map((m) => ({ id: m.id, loaded: m.loaded, quant: m.quant, context: m.context })), scope: networkScope(node.url) };
    } catch (e) {
      const status = e.status || (e.cause && e.cause.status);
      const x = explainNet(e, node.url, 'Connecting');
      return { reachable: !!status, authenticated: status ? !(status === 401 || status === 403) : null, modelCount: null, latencyMs: status ? Date.now() - t0 : null, error: x.message, code: x.code, scope: networkScope(node.url) };
    }
  }
  remember(url, ms) { const all = this.store.getSetting('runtime_memory', {}); all[url] = ms.slice(0, 400).map((m) => ({ ...m, loaded: false, _url: undefined })); this.store.setSetting('runtime_memory', all); }
  // LM Studio on this computer can require an API token (Developer → Server Settings). Saved encrypted.
  lmStudioToken() { const ref = this.store.getSetting('lmstudio_token_ref', null); return ref ? this.vault.reveal(ref) : null; }
  // The LM Studio connection for a computer: this one (with its saved token) or an LM Studio server you added.
  lmStudioFor(nodeId) {
    const node = this.store.get('SELECT * FROM nodes WHERE id=?', nodeId); if (!node) throw new Error('Computer not found');
    const rt = this.runtimesFor(node).find((r) => r.runtime === 'lmstudio' || (node.kind === 'compat' && node.preset === 'lmstudio'));
    if (!rt && node.kind === 'local') return { node, adapter: new LocalCompatRuntime({ baseUrl: 'http://127.0.0.1:1234', runtime: 'lmstudio', preset: 'lmstudio', apiKey: this.lmStudioToken() }) };
    if (!rt) throw new Error(`${node.name} has no LM Studio connection.`);
    return { node, adapter: rt.adapter };
  }
  appInstalled(rt) { try { const a = apps.apps(); return rt === 'ollama' ? a.ollama.installed : rt === 'lmstudio' ? a.lmstudio.installed : false; } catch { return false; } }
  // Before a request: start the app if needed and load the model, reporting each step.
  async ensureReady(p, onProgress = () => {}, signal) {
    const m = p.model; const rt = m.runtime;
    // Preflight: will it fit? Only when a load is needed on this computer and the free memory is known.
    if (!m.loaded && p.node.kind === 'local' && ['engine', 'ollama', 'lmstudio'].includes(rt) && this.memory && m.memBytes) {
      const { memoryNeeded } = require('./caps'); const need = memoryNeeded(m, Math.min(m.context || 8192, 8192)); const machine = this.memory.perf && this.memory.perf.machine; let free = machine ? machine.memFree : null;
      if (free != null && need.bytes > free * 1.05) {
        onProgress({ phase: 'memory', text: `Freeing memory for ${m.alias || m.id}` });
        const freed = this.store.getSetting('memory', {}).autoUnload === false ? 0 : await this.memory.makeRoom(need.bytes - free, m.id);
        free += freed; try { await this.memory.perf.sampleMachine(); free = this.memory.perf.machine.memFree; } catch {}
        if (need.bytes > free * 1.05) {
          const GB = 2 ** 30; const loaded = this.memory.loaded().filter((x) => x.id !== m.id);
          const e = new Error(`${m.alias || m.id} needs about ${(need.bytes / GB).toFixed(1)} GB to load (file ${(m.memBytes / GB).toFixed(1)} GB + context, estimated) but ${p.node.name} has ${(free / GB).toFixed(1)} GB free.`);
          e.info = { kind: 'OUT_OF_MEMORY', title: 'Not enough memory for this model', text: e.message, causes: loaded.length ? [`${loaded.length} other model${loaded.length > 1 ? 's are' : ' is'} loaded: ${loaded.map((x) => x.id + (x.inUse ? ' (in use)' : x.pinned ? ' (pinned)' : '')).join(', ')}`] : ['The model is too big for this computer'],
            next: 'Unload other models (Models → Loaded right now), lower the context length, use a smaller quantisation, run it on another computer, or split it across computers as a cluster.', options: ['unload_idle', 'smaller_context', 'smaller_quant', 'other_machine', 'cluster', 'cloud'], raw: '' };
          throw e;
        }
      }
    }
    if (rt === 'engine') return this.engine.ensureLoaded(m.id, onProgress, signal);
    // LM Studio on another computer: load the model through its API (needs the server's key if it has one).
    if (rt === 'lmstudio' && p.node.kind !== 'local' && !m.loaded && p.adapter && p.adapter.oa) {
      const t0 = Date.now(); onProgress({ phase: 'loading', pct: null, text: `LM Studio on ${p.node.name} is loading ${m.alias || m.id}` });
      const r = await p.adapter.oa._fetch(p.adapter.root + '/api/v1/models/load', { method: 'POST', headers: p.adapter.oa.headers(), body: JSON.stringify({ model: m.id }), signal }).catch(() => null);
      if (r && r.ok) { await r.text(); onProgress({ phase: 'loaded', pct: 1, ms: Date.now() - t0, text: `Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s` }); }
      return null;
    }
    if (p.node.kind !== 'local') return null;
    const port = (() => { try { return +new URL(m._url).port; } catch { return 0; } })();
    if (rt === 'ollama') {
      if (m.offline || !(await apps.portOpen(port || 11434))) { onProgress({ phase: 'starting', text: 'Starting Ollama' }); await apps.startOllama(); }
      if (!m.loaded) {
        const t0 = Date.now(); onProgress({ phase: 'loading', pct: null, text: `Ollama is loading ${m.alias || m.id} into memory` });
        const r = await fetch((m._url || 'http://127.0.0.1:11434') + '/api/generate', { method: 'POST', body: JSON.stringify({ model: m.id, prompt: '', keep_alive: '30m' }), signal });
        if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Ollama could not load ${m.id}: ${t.slice(0, 200)}`); }
        await r.text(); onProgress({ phase: 'loaded', pct: 1, ms: Date.now() - t0, text: `Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
      }
      return null;
    }
    if (rt === 'lmstudio') {
      if (m.offline || !(await apps.portOpen(port || 1234))) { onProgress({ phase: 'starting', text: 'Starting LM Studio’s server' }); await apps.startLmStudio(port || 1234); }
      if (!m.loaded) {
        const t0 = Date.now(); onProgress({ phase: 'loading', pct: null, text: `LM Studio is loading ${m.alias || m.id}` });
        const ad = p.adapter && p.adapter.oa ? p.adapter : this.runtimesFor(p.node).find((x) => x.runtime === 'lmstudio').adapter;
        const r = await ad.oa._fetch(ad.root + '/api/v1/models/load', { method: 'POST', headers: ad.oa.headers(), body: JSON.stringify({ model: m.id }), signal }).catch(() => null);
        if (r && (r.status === 401 || r.status === 403)) throw new Error('LM Studio refused the request — its server requires an API token. Next: Models → Engines → LM Studio → API token (create one in LM Studio → Developer → Server Settings → Manage Tokens).');
        // Older LM Studio versions load on first request ("just in time") — that is fine too.
        if (r && r.ok) { await r.text(); onProgress({ phase: 'loaded', pct: 1, ms: Date.now() - t0, text: `Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s` }); }
      }
    }
    return null;
  }
  async refreshAll() {
    await Promise.all(this.nodes().filter((n) => n.enabled).map((n) => this.refreshNode(n).catch(() => {})));
  }

  // Flat list of local models across all nodes (used by router and UI).
  catalog() {
    const out = []; const al = this.store.getSetting('model_aliases', {});
    for (const n of this.nodes()) {
      if (!n.enabled) continue;
      const st = this.state.get(n.id);
      if (!st || st.status !== 'online') continue;
      for (const m of st.models) out.push({ ...m, alias: al[m.id] || null, nodeId: n.id, nodeName: n.name, tps: this.speed.get(n.id + '|' + m.id) || null, ttft: this.ttft.get(n.id + '|' + m.id) || null, inflight: this.inflight.get(n.id) || 0,
        endpoint: this.endpointOf(n, m) });
    }
    return out;
  }
  // Where a model runs, in words: the app that serves it and the computer it is on.
  endpointOf(n, m) {
    const url = m._url || n.url || 'http://127.0.0.1';
    const app = n.kind === 'local' || n.kind === 'worker' ? m.runtime : n.kind === 'ollama' ? 'ollama' : n.preset || 'generic';
    const appName = PRESET_NAMES[app] || app || 'Model server';
    const name = n.kind === 'local' ? appName : n.kind === 'worker' ? `${appName} on ${n.name}` : /\(cluster\)$/.test(n.name) ? `Cluster ${n.name.replace(/ \(cluster\)$/, '')}` : n.name === appName ? appName : `${appName} on ${n.name}`;
    return { url, runtime: m.runtime, app, appName, preset: app, name, node: n.name, nodeKind: n.kind, cluster: /\(cluster\)$/.test(n.name), scope: networkScope(url), viaLink: app === 'lmstudio' ? 'lmlink-possible' : null };
  }
  // Distinct models (a model may exist on several nodes).
  distinctModels() {
    const by = new Map();
    for (const m of this.catalog()) {
      const k = m.id;
      const cur = by.get(k);
      if (!cur) by.set(k, { ...m, nodes: [m.nodeName], endpoints: [m.endpoint], anyLoaded: m.loaded });
      else { cur.nodes.push(m.nodeName); cur.endpoints.push(m.endpoint); cur.anyLoaded = cur.anyLoaded || m.loaded; }
    }
    return [...by.values()];
  }

  // Scheduler: choose the best node for a model. Prefers a node where it is already loaded, then the least busy.
  // A computer may be shared with only some organisations (its org_ids). NULL/empty = shared with all.
  nodeOrgIds(nodeId) { const n = this.store.get('SELECT org_ids FROM nodes WHERE id=?', nodeId); const a = n && n.org_ids ? safeJSON(n.org_ids, []) : []; return Array.isArray(a) ? a : []; }
  nodeAllowsOrg(nodeId, orgId) { if (!orgId) return true; const a = this.nodeOrgIds(nodeId); return !a.length || a.includes(orgId); }
  pick(modelId, { noInternet = false, where = null, orgId = null } = {}) {
    const localName = (this.nodes().find((n) => n.is_local) || {}).name;
    let cands = this.catalog().filter((m) => m.id === modelId && (!noInternet || m.endpoint.scope !== 'internet'));
    if (where) { const w = cands.filter((m) => where === 'local' ? m.nodeName === localName : where === 'cluster' ? !!m.endpoint.cluster : m.nodeName === where || m.endpoint.name === where); if (w.length) cands = w; }
    // Drop computers not shared with this organisation. Flag the reason so the caller can explain it.
    if (orgId) { const before = cands.length; cands = cands.filter((m) => this.nodeAllowsOrg(m.nodeId, orgId)); this._lastPickOrgBlocked = before > 0 && cands.length === 0; }
    if (!cands.length) return null;
    // Lent-when-idle computers that are in use right now go last (a manual pick on a single busy computer still runs there).
    const busy = (x) => { const mt = this.metrics.get(x.nodeId); return mt && mt.availability && mt.availability.available === false ? 1 : 0; };
    cands.sort((a, b) => (busy(a) - busy(b)) || (b.loaded - a.loaded) || (a.inflight - b.inflight) || ((b.tps || 0) - (a.tps || 0)));
    const c = cands[0];
    const node = this.nodes().find((n) => n.id === c.nodeId);
    const rt = this.runtimesFor(node).find((r) => r.url === c._url) || this.runtimesFor(node)[0];
    return { node, model: c, adapter: rt.adapter };
  }

  begin(nodeId, orgId, memBytes, modelId) {
    this.inflight.set(nodeId, (this.inflight.get(nodeId) || 0) + 1);
    if (modelId) { const k = nodeId + '|' + modelId; this.modelInflight.set(k, (this.modelInflight.get(k) || 0) + 1); this.lastUsed.set(k, Date.now()); }
    if (orgId) this.orgRam.set(orgId, (this.orgRam.get(orgId) || 0) + (memBytes || 0));
  }
  end(nodeId, orgId, memBytes, outTokens, ms, modelId, ttftMs) {
    this.inflight.set(nodeId, Math.max(0, (this.inflight.get(nodeId) || 1) - 1));
    if (modelId) { const k = nodeId + '|' + modelId; this.modelInflight.set(k, Math.max(0, (this.modelInflight.get(k) || 1) - 1)); this.lastUsed.set(k, Date.now()); }
    if (orgId) this.orgRam.set(orgId, Math.max(0, (this.orgRam.get(orgId) || 0) - (memBytes || 0)));
    const k = nodeId + '|' + modelId;
    // Generation speed counts only the writing phase when the time to first token is known.
    const genMs = ttftMs != null ? ms - ttftMs : ms;
    if (outTokens > 3 && genMs > 200) { const tps = outTokens / (genMs / 1000), prev = this.speed.get(k); this.speed.set(k, prev ? prev * 0.7 + tps * 0.3 : tps); }
    if (ttftMs != null) { const prev = this.ttft.get(k); this.ttft.set(k, prev ? prev * 0.7 + ttftMs * 0.3 : ttftMs); }
  }
}

// The built-in ForgeAI Engine as a runtime: lists its models (loaded or not) and loads on demand.
class EngineRuntime {
  constructor(engine) { this.engine = engine; }
  async discover() {
    const ms = await this.engine.models();
    return ms.filter((m) => m.caps.chat).map((m) => ({ id: m.id, runtime: 'engine', family: m.arch || '', params: m.params || '', quant: m.quant || '', sizeBytes: m.sizeBytes, memBytes: Math.round(m.sizeBytes * 1.15),
      context: m.context, loadedContext: null, loaded: m.status === 'loaded', state: m.status, vision: !!m.caps.vision, tools: m.caps.tools !== false, file: m.file, origin: m.origin, from: m.from,
      caps: { chat: true, vision: !!m.caps.vision, tools: m.caps.tools !== false, reasoning: !!m.caps.reasoning },
      source: { params: m.params ? 'reported' : 'unknown', quant: m.quant ? 'reported' : 'unknown', context: m.context ? 'reported' : 'unknown', size: 'measured', caps: 'reported' } }));
  }
  oa() { return new OpenAIAdapter({ baseUrl: this.engine.url + '/v1', compat: true, label: 'ForgeAI Engine', apiKey: this.engine.key, progress: true }); }
  async chat(o) { await this.engine.ensureLoaded(o.model, o.onProgress, o.signal); return this.oa().chat(o); }
  async chatTools(o) { await this.engine.ensureLoaded(o.model, o.onProgress, o.signal); return this.oa().chatTools(o); }
}

module.exports = { Cluster, DEFAULT_LOCAL_RUNTIMES, EngineRuntime };
