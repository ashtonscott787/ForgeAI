'use strict';
// Live performance: requests in flight, recent request timings, machine metrics, and plain-English bottlenecks.
const os = require('node:os');
const { execFile } = require('node:child_process');

const sh = (cmd, args, ms = 3000) => new Promise((ok) => execFile(cmd, args, { timeout: ms }, (e, out) => ok(e ? '' : String(out))));

class Perf {
  constructor() { this.live = new Map(); this.recent = []; this.seq = 0; this.machine = null; this._cpu = os.cpus(); }

  // ---- requests
  start(info) { const id = ++this.seq; this.live.set(id, { id, startedAt: Date.now(), firstTokenAt: null, outChars: 0, stage: info.stage || null, ...info, trace: (info.trace || []).map((t) => ({ t: 0, text: t })) }); return id; }
  set(id, patch) { const r = this.live.get(id); if (r) Object.assign(r, patch); }
  trace(id, text) { const r = this.live.get(id); if (!r) return; r.trace.push({ t: Date.now() - r.startedAt, text: String(text) }); if (r.trace.length > 200) r.trace.shift(); }
  token(id, chars) { const r = this.live.get(id); if (!r) return; if (!r.firstTokenAt) r.firstTokenAt = Date.now(); r.outChars += chars || 0; }
  stage(id, stage) { const r = this.live.get(id); if (r) r.stage = stage; }
  progress(id, pg) { const r = this.live.get(id); if (!r) return; r.progress = { ...pg, at: Date.now() }; if (pg.phase === 'loaded' && pg.ms) r.loadMs = pg.ms; if (pg.phase === 'prompt') r.prompt = { processed: pg.processed, total: pg.total }; }
  finish(id, res) {
    const r = this.live.get(id); if (!r) return null; this.live.delete(id);
    const end = Date.now(); const total = end - r.startedAt; const ttft = r.firstTokenAt ? r.firstTokenAt - r.startedAt : null;
    const out = res && res.outputTokens || Math.round(r.outChars / 4);
    const genMs = ttft != null ? total - ttft : total;
    const rec = { ...r, finishedAt: end, totalMs: total, ttftMs: ttft, genMs, inputTokens: res && res.inputTokens || 0, outputTokens: out, tps: out > 3 && genMs > 150 ? out / (genMs / 1000) : null, ok: !(res && res.error), error: res && res.error || null, stop: res && res.stop || null, serverTimings: res && res.serverTimings || null };
    rec.bottleneck = this.bottleneck(rec);
    this.recent.unshift(rec); if (this.recent.length > 300) this.recent.length = 300;
    return rec;
  }
  liveList() {
    const now = Date.now();
    return [...this.live.values()].map((r) => { const el = now - r.startedAt; const genMs = r.firstTokenAt ? now - r.firstTokenAt : 0; const toks = Math.round(r.outChars / 4);
      return { id: r.id, model: r.model, provider: r.provider, node: r.node, endpoint: r.endpoint, scope: r.scope, org: r.org, kind: r.kind, stage: r.stage, elapsedMs: el, phase: r.firstTokenAt ? 'writing' : r.progress ? r.progress.phase : 'waiting for first token', step: r.firstTokenAt ? `Writing · ${toks} tokens` : r.progress ? (r.progress.phase === 'prompt' && r.progress.total ? `Reading the prompt · ${r.progress.processed} of ${r.progress.total} tokens` : r.progress.text || r.progress.phase) : 'Waiting for the first words', pct: !r.firstTokenAt && r.progress ? (r.progress.phase === 'prompt' && r.progress.total ? r.progress.processed / r.progress.total : r.progress.pct ?? null) : null, loadMs: r.loadMs || null, ttftMs: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null, tokens: toks, tps: genMs > 300 && toks > 3 ? toks / (genMs / 1000) : null }; });
  }

  // Where did the time go? One plain sentence.
  bottleneck(r) {
    const st = r.serverTimings || {};
    if (!r.ok) {
      if (/429|rate limit/i.test(r.error || '')) return { kind: 'rate_limit', text: 'The provider is rate-limiting you — requests are being refused until the limit resets.' };
      if (/timed out|timeout|no response/i.test(r.error || '')) return { kind: 'network', text: `No answer from ${r.endpoint || 'the server'} in time — network or server problem.` };
      return { kind: 'error', text: 'The request failed: ' + String(r.error || '').slice(0, 120) };
    }
    if (st.load_ms > 1500 && st.load_ms > 0.35 * r.totalMs) return { kind: 'model_load', text: `Loading the model into memory took ${(st.load_ms / 1000).toFixed(1)}s (cold start). Keep it loaded, or use a smaller model.` };
    if (st.prompt_ms > 2000 && st.prompt_ms > 0.4 * r.totalMs) return { kind: 'prefill', text: `Reading the prompt took ${(st.prompt_ms / 1000).toFixed(1)}s — long context. Shorter history or a faster machine helps.` };
    if (r.ttftMs != null && st.prompt_ms != null) {
      const overhead = r.ttftMs - (st.prompt_ms || 0) - (st.load_ms || 0);
      if (overhead > 1500 && overhead > 0.4 * r.totalMs) return { kind: r.queueMs > 500 ? 'queue' : 'network', text: `${(overhead / 1000).toFixed(1)}s passed before the server started — waiting in its queue or on the network.` };
    }
    if (r.queueMs > 1000 && r.queueMs > 0.3 * r.totalMs) return { kind: 'queue', text: `Waited ${(r.queueMs / 1000).toFixed(1)}s for ${r.node || 'the computer'} — it was busy with other requests.` };
    if (r.ttftMs != null && r.ttftMs > 4000 && r.ttftMs > 0.5 * r.totalMs) return { kind: r.scope === 'internet' ? 'provider' : 'prefill', text: r.scope === 'internet' ? `The provider took ${(r.ttftMs / 1000).toFixed(1)}s to start answering.` : `${(r.ttftMs / 1000).toFixed(1)}s before the first word — prompt processing or loading on ${r.node || 'the server'}.` };
    if (r.tps != null && r.tps < 8 && r.outputTokens > 40) return { kind: 'generation', text: `Writing is slow (${r.tps.toFixed(1)} tokens/s) — the model is large for ${r.node || 'this machine'}, or it is running partly on the CPU.` };
    if (r.stop === 'length') return { kind: 'limit', text: 'The answer hit the length limit — use Continue, or raise the answer length.' };
    return { kind: 'none', text: 'No bottleneck — this request ran normally.' };
  }

  // ---- this computer
  async sampleMachine() {
    const cpus = os.cpus(); let idle = 0, total = 0;
    cpus.forEach((c, i) => { const p = this._cpu[i] || c; const t = (x) => x.user + x.nice + x.sys + x.idle + x.irq; total += t(c.times) - t(p.times); idle += c.times.idle - p.times.idle; });
    this._cpu = cpus;
    const m = { at: Date.now(), host: os.hostname(), os: process.platform, arch: process.arch, cpuModel: cpus[0] && cpus[0].model, cores: cpus.length, cpuPct: total > 0 ? Math.round((1 - idle / total) * 100) : null,
      memTotal: os.totalmem(), memFree: os.freemem(), memSource: 'os', gpu: [], temps: null, notes: [] };
    if (process.platform === 'darwin') {
      const vm = await sh('vm_stat', []); const page = +((/page size of (\d+)/.exec(vm) || [])[1] || 16384);
      const g = (k) => +(((new RegExp(k + ':\\s+(\\d+)')).exec(vm) || [])[1] || 0) * page;
      if (vm) { m.memFree = g('Pages free') + g('Pages inactive') + g('Pages speculative') + g('Pages purgeable'); m.memSource = 'vm_stat'; }
      const io = await sh('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
      const util = /"Device Utilization %"=(\d+)/.exec(io); const used = /"In use system memory"=(\d+)/.exec(io);
      if (util || used) m.gpu.push({ name: 'Apple GPU (unified memory)', utilPct: util ? +util[1] : null, memUsed: used ? +used[1] : null, memTotal: null, tempC: null, source: 'ioreg' });
      m.notes.push('GPU shares system memory on Apple Silicon. Temperature needs administrator access on macOS, so it is not shown.');
    }
    const smi = await sh('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
    for (const line of smi.trim().split('\n').filter(Boolean)) { const [name, u, mu, mt, t] = line.split(',').map((x) => x.trim()); m.gpu.push({ name, utilPct: +u, memUsed: +mu * 2 ** 20, memTotal: +mt * 2 ** 20, tempC: +t, source: 'nvidia-smi' }); }
    if (process.platform === 'linux') {
      const t = await sh('cat', ['/sys/class/thermal/thermal_zone0/temp']); if (t.trim()) m.temps = { cpuC: Math.round(+t.trim() / 1000), source: 'thermal_zone0' };
      const mi = await sh('cat', ['/proc/meminfo']); const av = /MemAvailable:\s+(\d+)/.exec(mi); if (av) { m.memFree = +av[1] * 1024; m.memSource = 'meminfo'; }
    }
    this.machine = m; return m;
  }
}

module.exports = { Perf };
