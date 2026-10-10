'use strict';
// ForgeAI Engine: runs models with no other apps installed.
// It is llama.cpp's llama-server in "router" mode, managed by ForgeAI: several models can be loaded at once,
// each loads automatically on its first request, and idle ones are put to sleep to free memory.
// Models are GGUF files downloaded from Hugging Face (source shown and checksum checked), or files
// you already have from LM Studio / Ollama (used in place, not copied).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { readGGUF } = require('./gguf');
const { explainNet } = require('./net');

const HF = () => (process.env.FORGEAI_HF_BASE || 'https://huggingface.co').replace(/\/$/, '');
const freePort = (start) => new Promise((ok) => { const tryP = (p) => { const s = net.createServer(); s.once('error', () => tryP(p + 1)); s.listen(p, '127.0.0.1', () => s.close(() => ok(p))); }; tryP(start); });
const safeName = (s) => String(s).replace(/[^\w.+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'model';
let proxyDispatcher;
function dl(url, init = {}) {
  if (proxyDispatcher === undefined) { proxyDispatcher = null; if (process.env.HTTPS_PROXY || process.env.https_proxy) { try { const { EnvHttpProxyAgent } = require('undici'); proxyDispatcher = new EnvHttpProxyAgent(); } catch {} } }
  if (proxyDispatcher) { const { fetch: uf } = require('undici'); return uf(url, { ...init, dispatcher: proxyDispatcher }); }
  return fetch(url, init);
}

class ForgeEngine {
  constructor({ dataDir, kit, store, vault }) {
    this.kit = kit; this.store = store; this.vault = vault;
    this.modelsDir = path.join(dataDir, 'models'); fs.mkdirSync(this.modelsDir, { recursive: true });
    this.presetFile = path.join(dataDir, 'engine-models.ini');
    this.port = null; this.url = null; this.starting = null; this.downloads = new Map(); this.metaCache = new Map();
    let k = store.getSetting('engine_key_ref', null); if (!k) { k = vault.put(crypto.randomBytes(18).toString('hex')); store.setSetting('engine_key_ref', k); }
    this.key = vault.reveal(k);
  }
  settings() { return { maxLoaded: 0, ctx: 8192, sleepMinutes: 30, autoStart: true, ...this.store.getSetting('engine', {}) }; }
  saveSettings(s) { const cur = this.settings(); const n = { maxLoaded: Math.max(0, Math.min(16, +s.maxLoaded || 0)), ctx: Math.max(1024, Math.min(262144, +s.ctx || cur.ctx)), sleepMinutes: Math.max(0, Math.min(1440, s.sleepMinutes == null ? cur.sleepMinutes : +s.sleepMinutes)), autoStart: s.autoStart == null ? cur.autoStart : !!s.autoStart }; this.store.setSetting('engine', n); return n; }
  // How many models may be loaded at once: the setting, or by memory (about one per 12 GB, at least 1, at most 6).
  maxLoaded() { const s = this.settings(); return s.maxLoaded || Math.max(1, Math.min(6, Math.floor(os.totalmem() / (12 * 2 ** 30)))); }
  installed() { return !!this.kit.exe('llama-server'); }
  running() { return !!(this.kit.procs.engine && this.url); }

  // ---- the model list ForgeAI gives the engine: downloaded files + files linked from LM Studio / Ollama
  links() { return this.store.getSetting('engine_links', []); }
  files() {
    const out = [];
    const walk = (dir, depth = 0) => { let l = []; try { l = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const ggufs = l.filter((e) => e.isFile() && /\.gguf$/i.test(e.name) && !/\.part$/.test(e.name));
      if (depth > 0 && ggufs.length) { // a folder = one model (shards and/or a vision projector)
        const proj = ggufs.find((e) => /^mmproj/i.test(e.name)); const mains = ggufs.filter((e) => e !== proj).sort((a, b) => a.name.localeCompare(b.name));
        if (mains.length) out.push({ id: path.basename(dir), path: path.join(dir, mains[0].name), mmproj: proj ? path.join(dir, proj.name) : null, shards: mains.length, source: 'downloaded' });
        return;
      }
      for (const e of ggufs) out.push({ id: e.name.replace(/\.gguf$/i, ''), path: path.join(dir, e.name), mmproj: null, shards: 1, source: 'downloaded' });
      if (depth === 0) for (const e of l) if (e.isDirectory()) walk(path.join(dir, e.name), 1);
    };
    walk(this.modelsDir);
    for (const L of this.links()) if (fs.existsSync(L.path)) out.push({ id: L.id, path: L.path, mmproj: L.mmproj && fs.existsSync(L.mmproj) ? L.mmproj : null, shards: 1, source: L.from || 'linked', from: L.from });
    const seen = new Set(); return out.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  }
  meta(file) { let st; try { st = fs.statSync(file); } catch { return null; } const k = file + '|' + st.mtimeMs; if (!this.metaCache.has(k)) this.metaCache.set(k, readGGUF(file)); return this.metaCache.get(k); }
  writePresets() {
    const s = this.settings(); const ngl = (this.kit.cpuForced && this.kit.cpuForced()) ? 0 : 999; const lines = ['version = 1', '', '[*]', `c = ${s.ctx}`, `n-gpu-layers = ${ngl}`, ''];
    for (const f of this.files()) {
      const m = this.meta(f.path) || {}; const ctx = m.contextLength ? Math.min(s.ctx, m.contextLength) : s.ctx;
      lines.push(`[${f.id}]`, `model = ${f.path}`, `c = ${ctx}`); if (f.mmproj) lines.push(`mmproj = ${f.mmproj}`); lines.push('');
    }
    fs.writeFileSync(this.presetFile, lines.join('\n'));
  }

  // ---- process
  async start() {
    if (this.running()) return this.status();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.installed()) throw new Error('The ForgeAI Engine is not installed yet. Next: Models → Engines → Install (downloads llama.cpp once from github.com/ggml-org/llama.cpp).');
      this.writePresets();
      this.port = await freePort(+this.store.getSetting('engine_port', 39281) || 39281);
      const s = this.settings();
      const args = ['--host', '127.0.0.1', '--port', String(this.port), '--models-preset', this.presetFile, '--models-max', String(this.maxLoaded()), '--api-key', this.key, '-lv', '3'];
      if (s.sleepMinutes > 0) args.push('--sleep-idle-seconds', String(s.sleepMinutes * 60));
      this.kit.spawnBin('engine', 'llama-server', args);
      const url = `http://127.0.0.1:${this.port}`;
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) { this.url = url; return this.status(); } } catch {}
        if (!this.kit.procs.engine) throw new Error('The ForgeAI Engine stopped while starting: ' + (this.kit.logs.engine || []).slice(-3).join(' · '));
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('The ForgeAI Engine did not start in time. Open Models → Engines → Logs.');
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }
  stop() { this.kit.stop('engine'); this.url = null; return { ok: true }; }
  // The GPU (Vulkan/CUDA) build sometimes starts but can't create a compute context on a given computer
  // (weak/integrated GPU, flaky driver). When a model load fails that way, switch this computer to the CPU
  // build for good and restart. Returns true if it switched (caller should retry once).
  _gpuLoadFailed() {
    const log = (this.kit.logs.engine || []).join(' ');
    return /create_context|failed to load model|ggml_vulkan|ggml_backend|vk_|vulkan|device lost|out of device memory|cudaMalloc|exiting due to model loading error/i.test(log);
  }
  async _fallbackToCpu() {
    const cur = this.kit.installed && this.kit.installed();
    if (!cur || cur.source !== 'bundled' || cur.gpu === 'cpu' || !this.kit.forceCpu) return false;
    if (this.kit.cpuForced && this.kit.cpuForced()) return false;
    this.kit.forceCpu('model load failed on the ' + cur.gpu + ' build');
    try { this.stop(); } catch {}
    await new Promise((r) => setTimeout(r, 600));
    try { this.store.audit('engine', 'engine.cpu_fallback', null, { from: cur.gpu }); } catch {}
    return true;
  }
  async api(p, body, ms = 10000) {
    if (!this.running()) await this.start();
    const r = await fetch(this.url + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`ForgeAI Engine: ${(j.error && (j.error.message || j.error)) || 'error ' + r.status}`); return j;
  }
  async reload() { this.writePresets(); if (this.running()) await this.api('/models?reload=1').catch(() => {}); }
  // Everything the engine can run, with what it is and whether it is loaded.
  async models() {
    const files = this.files(); let live = [];
    if (this.running()) { try { live = (await this.api('/models')).data || []; } catch {} }
    return files.map((f) => {
      const m = this.meta(f.path) || {}; const L = live.find((x) => x.id === f.id); const st = (L && L.status) || { value: this.running() ? 'unloaded' : 'stopped' };
      let size = 0; try { size = fs.statSync(f.path).size * (f.shards || 1); } catch {}
      return { id: f.id, file: f.path, mmproj: f.mmproj, source: f.source, from: f.from || null, sizeBytes: size, arch: m.arch, name: m.name, params: m.sizeLabel, quant: m.fileType, context: m.contextLength,
        caps: { chat: !m.isProjector, vision: !!f.mmproj, tools: m.tools, reasoning: m.reasoning }, status: st.value, failed: !!st.failed, progress: st.progress || null, origin: (this.store.getSetting('engine_origins', {}))[f.id] || null };
    });
  }
  load(id) { return this.api('/models/load', { model: id }, 15000); }
  unload(id) { return this.api('/models/unload', { model: id }, 15000); }
  // Wait until a model is loaded, reporting progress (0..1) as it goes.
  async ensureLoaded(id, onProgress = () => {}, signal) {
    try { return await this._ensureLoaded(id, onProgress, signal); }
    catch (e) {
      if (this._gpuLoadFailed() && await this._fallbackToCpu()) {
        onProgress({ phase: 'starting', text: 'The GPU engine could not load this model — switching this computer to the CPU engine and retrying' });
        return await this._ensureLoaded(id, onProgress, signal);
      }
      throw e;
    }
  }
  async _ensureLoaded(id, onProgress = () => {}, signal) {
    if (!this.running()) { onProgress({ phase: 'starting', text: 'Starting the ForgeAI Engine' }); await this.start(); }
    let list = (await this.api('/models')).data || []; let m = list.find((x) => x.id === id);
    if (!m) { await this.reload(); list = (await this.api('/models')).data || []; m = list.find((x) => x.id === id); }
    if (!m) throw new Error(`${id} is not in the ForgeAI Engine. Next: download it again from Models → Get Models.`);
    if (m.status && m.status.value === 'loaded') return { alreadyLoaded: true };
    const t0 = Date.now(); onProgress({ phase: 'loading', pct: 0, text: `Loading ${id} into memory` });
    if (!m.status || m.status.value !== 'loading') await this.load(id).catch(() => {});
    for (;;) {
      if (signal && signal.aborted) throw new Error('Stopped');
      await new Promise((r) => setTimeout(r, 300));
      const x = ((await this.api('/models')).data || []).find((y) => y.id === id); const s = (x && x.status) || {};
      if (s.value === 'loaded' || s.value === 'sleeping') { onProgress({ phase: 'loaded', pct: 1, ms: Date.now() - t0, text: `Loaded ${id} in ${((Date.now() - t0) / 1000).toFixed(1)}s` }); return { loadMs: Date.now() - t0 }; }
      if (s.failed || (s.value === 'unloaded' && Date.now() - t0 > 3000)) {
        const log = (this.kit.logs.engine || []).filter((l) => /error|failed|out of memory|unable/i.test(l)).slice(-2).join(' · ');
        throw new Error(`${id} could not be loaded${log ? ': ' + log : ''}. ${/memory|alloc/i.test(log) ? 'It does not fit in memory — unload other models or use a smaller one.' : 'Open Models → Engines → Logs.'}`);
      }
      if (s.progress && s.progress.value != null) onProgress({ phase: 'loading', pct: s.progress.value, text: `Loading ${id} into memory` });
      if (Date.now() - t0 > 20 * 60000) throw new Error(`${id} took too long to load.`);
    }
  }
  async remove(id) {
    const f = this.files().find((x) => x.id === id); if (!f) throw new Error('Not found');
    if (this.running()) await this.unload(id).catch(() => {});
    if (f.source === 'downloaded') { const dir = path.dirname(f.path); if (dir !== this.modelsDir && dir.startsWith(this.modelsDir)) fs.rmSync(dir, { recursive: true, force: true }); else fs.rmSync(f.path, { force: true }); }
    else this.store.setSetting('engine_links', this.links().filter((x) => x.id !== id));
    await this.reload(); return { ok: true };
  }

  // ---- models you already have (LM Studio, Ollama): used where they are, nothing copied
  findExisting() {
    const home = os.homedir(); const found = [];
    const lmRoots = [path.join(home, '.lmstudio', 'models'), path.join(home, '.cache', 'lm-studio', 'models')];
    for (const root of lmRoots) {
      const walk = (d, depth) => { let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        const g = l.filter((e) => e.isFile() && /\.gguf$/i.test(e.name)); const proj = g.find((e) => /^mmproj/i.test(e.name));
        for (const e of g) if (e !== proj && !/-0000[2-9]-of-|-000[1-9]\d-of-/.test(e.name)) found.push({ id: safeName(e.name.replace(/\.gguf$/i, '')), path: path.join(d, e.name), mmproj: proj ? path.join(d, proj.name) : null, from: 'LM Studio', label: path.relative(root, path.join(d, e.name)) });
        if (depth < 3) for (const e of l) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1); };
      walk(root, 0);
    }
    const oroot = process.env.OLLAMA_MODELS || path.join(home, '.ollama', 'models'); const mroot = path.join(oroot, 'manifests');
    const walkM = (d, parts) => { let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of l) { const p = path.join(d, e.name); if (e.isDirectory()) walkM(p, [...parts, e.name]); else {
        try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); const lay = (t) => (j.layers || []).find((x) => x.mediaType === t); const mdl = lay('application/vnd.ollama.image.model'); const pj = lay('application/vnd.ollama.image.projector');
          if (!mdl) continue; const blob = (x) => path.join(oroot, 'blobs', x.digest.replace(':', '-'));
          const name = (parts[parts.length - 1] || '') + ':' + e.name; const reg = parts.slice(0, -1);
          found.push({ id: safeName('ollama-' + name.replace(':', '-')), path: blob(mdl), mmproj: pj ? blob(pj) : null, from: 'Ollama', label: (reg.length > 2 ? reg.slice(1).join('/') + '/' : '') + name });
        } catch {} } } };
    walkM(mroot, []);
    const linked = new Set(this.links().map((l) => l.path));
    return found.filter((f) => fs.existsSync(f.path)).map((f) => { let size = 0; try { size = fs.statSync(f.path).size; } catch {} return { ...f, sizeBytes: size, linked: linked.has(f.path) }; });
  }
  async link(items) {
    const L = this.links(); const have = new Set(L.map((x) => x.path)); const added = [];
    for (const it of items) { if (!it.path || have.has(it.path) || !fs.existsSync(it.path)) continue; const m = readGGUF(it.path); if (!m.ok) continue; const id = safeName(it.id || path.basename(it.path)); L.push({ id, path: it.path, mmproj: it.mmproj || null, from: it.from || 'linked' }); added.push(id); }
    this.store.setSetting('engine_links', L); await this.reload(); return { added };
  }

  // ---- Hugging Face: search, list files, download (with the source shown and the checksum checked)
  hfHeaders() { const t = this.store.getSetting('hf_token_ref', null); const tok = t ? this.vault.reveal(t) : null; return { 'user-agent': 'ForgeAI', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }; }
  async hfJSON(p) {
    const url = HF() + p; let r;
    try { r = await dl(url, { headers: this.hfHeaders(), signal: AbortSignal.timeout(20000) }); } catch (e) { throw explainNet(e, url, 'Searching Hugging Face'); }
    if (r.status === 401 || r.status === 403) throw new Error('Hugging Face refused access (' + r.status + '). This model may need you to accept its licence on huggingface.co and add a Hugging Face token in Models → Engines.');
    if (!r.ok) throw explainNet(Object.assign(new Error('HTTP ' + r.status), { status: r.status }), url, 'Searching Hugging Face');
    return r.json();
  }
  async search(q, { author, limit = 30 } = {}) {
    const p = new URLSearchParams({ search: q || '', filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(limit) }); if (author) p.set('author', author);
    const list = await this.hfJSON('/api/models?' + p);
    return list.map((m) => ({ repo: m.id || m.modelId, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified || null, gated: !!m.gated, tags: (m.tags || []).filter((t) => !/^(gguf|region:|endpoints|autotrain|license:)/.test(t)).slice(0, 8), url: `${HF()}/${m.id || m.modelId}` }));
  }
  // Pick a well-known publisher's GGUF for a model name (looked up live, never assumed).
  async resolve(q) {
    for (const author of ['ggml-org', 'unsloth', 'bartowski', 'lmstudio-community', null]) {
      const r = await this.search(q, { author, limit: 5 }).catch(() => []); if (r.length) return { ...r[0], via: author ? `top result from ${author}` : 'most-downloaded result' };
    }
    return null;
  }
  async repoFiles(repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Use the form publisher/repository, e.g. ggml-org/gemma-3-4b-it-GGUF');
    const list = await this.hfJSON(`/api/models/${repo}/tree/main?recursive=true`);
    const files = list.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path)).map((f) => ({ path: f.path, size: (f.lfs && f.lfs.size) || f.size || 0, sha256: f.lfs && f.lfs.oid || null }));
    // Group shards (-00001-of-00003) into one choice; note vision projectors.
    const groups = new Map(); const proj = files.filter((f) => /mmproj/i.test(path.basename(f.path)));
    for (const f of files.filter((x) => !proj.includes(x))) { const key = f.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf'); const g = groups.get(key) || { name: path.basename(key), files: [], size: 0 }; g.files.push(f); g.size += f.size; groups.set(key, g); }
    const quant = (n) => (/(IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|F16|BF16|F32|MXFP4|Q8_0)/i.exec(n) || [])[1] || '';
    return { repo, url: `${HF()}/${repo}`, choices: [...groups.values()].map((g) => ({ ...g, quant: quant(g.name).toUpperCase(), shards: g.files.length })).sort((a, b) => a.size - b.size), projectors: proj };
  }
  download({ repo, files, mmproj, id }) {
    const dlId = 'dl_' + crypto.randomBytes(5).toString('hex');
    const name = safeName(id || files[0].path.split('/').pop().replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, ''));
    const all = [...files, ...(mmproj ? [mmproj] : [])];
    const folder = all.length > 1 ? path.join(this.modelsDir, name) : this.modelsDir; fs.mkdirSync(folder, { recursive: true });
    const job = { id: dlId, model: name, repo, from: `${HF()}/${repo}`, files: all.map((f) => f.path), total: all.reduce((a, f) => a + (f.size || 0), 0), done: 0, state: 'running', status: 'Starting', ctl: new AbortController(), startedAt: Date.now() };
    this.downloads.set(dlId, job);
    (async () => {
      try {
        for (const f of all) {
          const url = `${HF()}/${repo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`; job.current = url;
          const dest = path.join(folder, all.length > 1 ? path.basename(f.path) : name + '.gguf'); const part = dest + '.part';
          job.status = `Downloading ${path.basename(f.path)} from huggingface.co`;
          let r; try { r = await dl(url, { headers: this.hfHeaders(), redirect: 'follow', signal: job.ctl.signal }); } catch (e) { throw explainNet(e, url, 'Downloading from Hugging Face'); }
          if (r.status === 401 || r.status === 403) throw new Error(`Hugging Face refused the download (${r.status}). Accept the model's licence on ${HF()}/${repo} and add your Hugging Face token in Models → Engines.`);
          if (!r.ok) throw explainNet(Object.assign(new Error('HTTP ' + r.status), { status: r.status }), url, 'Downloading from Hugging Face');
          const out = fs.createWriteStream(part); const hash = crypto.createHash('sha256');
          for await (const c of r.body) { hash.update(c); job.done += c.length; if (!out.write(c)) await new Promise((ok) => out.once('drain', ok)); }
          await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
          const got = hash.digest('hex');
          if (f.sha256 && f.sha256 !== got) { fs.rmSync(part, { force: true }); throw new Error(`${path.basename(f.path)} is damaged or was changed (checksum mismatch). Nothing was kept — try again.`); }
          fs.renameSync(part, dest);
        }
        const origins = this.store.getSetting('engine_origins', {}); origins[name] = { repo, url: `${HF()}/${repo}`, files: all.map((f) => f.path), verified: all.every((f) => !!f.sha256), at: new Date().toISOString() }; this.store.setSetting('engine_origins', origins);
        job.state = 'done'; job.status = all.every((f) => !!f.sha256) ? 'Ready — checksum verified' : 'Ready';
        await this.reload();
      } catch (e) {
        job.state = job.ctl.signal.aborted ? 'cancelled' : 'error'; job.status = job.ctl.signal.aborted ? 'Cancelled' : e.message;
        for (const f of all) { try { fs.rmSync(path.join(folder, (all.length > 1 ? path.basename(f.path) : name + '.gguf') + '.part'), { force: true }); } catch {} }
      }
    })();
    return this.pub(job);
  }
  pub(j) { return { id: j.id, model: j.model, repo: j.repo, from: j.from, current: j.current || null, files: j.files, total: j.total, done: j.done, state: j.state, status: j.status, startedAt: j.startedAt }; }
  downloadsList() { return [...this.downloads.values()].map((j) => this.pub(j)).reverse(); }
  cancel(id) { const j = this.downloads.get(id); if (j && j.state === 'running') j.ctl.abort(); return { ok: true }; }

  status() {
    return { installed: this.installed(), version: (this.kit.installed() || {}).tag || null, running: this.running(), url: this.url, port: this.port, modelsDir: this.modelsDir, maxLoaded: this.maxLoaded(), settings: this.settings(),
      install: this.kit.install, logs: (this.kit.logs.engine || []).slice(-40), hfToken: !!this.store.getSetting('hf_token_ref', null), downloads: this.downloadsList().slice(0, 20) };
  }
}

module.exports = { ForgeEngine };
