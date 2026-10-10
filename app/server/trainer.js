'use strict';
// Model training (LoRA fine-tuning) with Apple's MLX: teach a model your style, facts or formats from examples.
// Runs on Apple Silicon Macs (GPU) and Linux (NVIDIA GPU, or slowly on CPU). Not on Windows.
// ForgeAI sets up its own private Python (via "uv", downloaded once from GitHub), installs mlx-lm from PyPI,
// trains, shows live loss, and serves the result so it appears in every model menu.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { explainNet } = require('./net');

const sh = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { timeout: opts.ms || 15000, windowsHide: true, env: opts.env || process.env }, (e, so, se) => ok({ ok: !e, out: String(so || ''), err: String(se || (e && e.message) || '') })));
const freePort = (start) => new Promise((ok) => { const tryP = (p) => { const s = net.createServer(); s.once('error', () => tryP(p + 1)); s.listen(p, '127.0.0.1', () => s.close(() => ok(p))); }; tryP(start); });
let proxyDispatcher;
function dl(url, init = {}) {
  if (proxyDispatcher === undefined) { proxyDispatcher = null; if (process.env.HTTPS_PROXY || process.env.https_proxy) { try { const { EnvHttpProxyAgent } = require('undici'); proxyDispatcher = new EnvHttpProxyAgent(); } catch {} } }
  if (proxyDispatcher) { const { fetch: uf } = require('undici'); return uf(url, { ...init, dispatcher: proxyDispatcher }); }
  return fetch(url, init);
}
const UV_ASSET = () => ({ 'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz', 'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz', 'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz', 'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz' })[`${process.platform}-${process.arch}`];

const WRAPPER = `import json, sys, types
def emit(o):
    # mlx-lm's progress display captures sys.stdout, so write to the real stdout.
    sys.__stdout__.write("FORGE " + json.dumps(o) + "\\n"); sys.__stdout__.flush()
from mlx_lm import lora
from mlx_lm.tuner.callbacks import TrainingCallback
def clean(d):
    out = {}
    for k, v in d.items():
        try: out[k] = float(v) if not isinstance(v, (str, bool)) else v
        except Exception: pass
    return out
class CB(TrainingCallback):
    def on_train_loss_report(self, info): emit({"type": "train", **clean(info)})
    def on_val_loss_report(self, info): emit({"type": "val", **clean(info)})
cfg = json.load(open(sys.argv[1]))
args = dict(lora.CONFIG_DEFAULTS); args.update(cfg)
emit({"type": "start"})
a = types.SimpleNamespace(**args)
# lora.run() replaces the callback with its own reporters in some versions, so run the same steps directly.
if all(hasattr(lora, n) for n in ("load", "load_dataset", "train_model")):
    import numpy as np
    np.random.seed(a.seed)
    model, tokenizer = lora.load(a.model, tokenizer_config={"trust_remote_code": False})
    n = len(getattr(model, "layers", [])) or a.num_layers
    if a.num_layers > n: a.num_layers = n  # small models have fewer layers than asked for
    train_set, valid_set, test_set = lora.load_dataset(a, tokenizer)
    lora.train_model(a, model, train_set, valid_set, CB())
else:
    lora.run(a, training_callback=CB())
emit({"type": "done"})
`;

class Trainer {
  constructor({ dataDir, store }) {
    this.store = store; this.dir = path.join(dataDir, 'training'); fs.mkdirSync(this.dir, { recursive: true });
    this.envDir = path.join(dataDir, 'engines', 'train-env'); this.uvDir = path.join(dataDir, 'engines', 'uv');
    this.setup = { state: 'idle' }; this.procs = new Map(); this.servers = new Map();
    process.once('exit', () => { for (const p of [...this.procs.values(), ...this.servers.values()]) try { p.kill(); } catch {} });
  }
  supported() {
    if (process.platform === 'darwin' && process.arch === 'arm64') return { ok: true, device: 'Apple GPU (MLX)' };
    if (process.platform === 'darwin') return { ok: false, why: 'Training needs a Mac with Apple Silicon (M1 or newer). Intel Macs are not supported by MLX.' };
    if (process.platform === 'linux') return { ok: true, device: 'NVIDIA GPU or CPU (MLX)', note: 'Without an NVIDIA GPU training runs on the CPU and is very slow.' };
    return { ok: false, why: 'Training is not available on Windows yet. Train on a Mac with Apple Silicon or a Linux computer, then use the model from here.' };
  }
  py() { const p = process.env.FORGEAI_PYTHON_ENV ? path.join(process.env.FORGEAI_PYTHON_ENV, 'bin', 'python') : path.join(this.envDir, 'bin', 'python'); return fs.existsSync(p) ? p : null; }
  ready() { return !!this.py() && this.setup.state !== 'running' && (this.setup.state === 'done' || fs.existsSync(path.join(this.dir, 'forge_train.py'))); }

  // ---- one-time setup: uv (from GitHub) → private Python → mlx-lm (from PyPI)
  async install() {
    if (this.setup.state === 'running') return this.setup;
    const sup = this.supported(); if (!sup.ok) throw new Error(sup.why);
    this.setup = { state: 'running', status: 'Starting' };
    (async () => {
      try {
        let py = this.py();
        if (!py) {
          let uv = path.join(this.uvDir, 'uv'); if (!fs.existsSync(uv)) uv = await this.getUv();
          this.setup.status = 'Setting up a private Python for training (uv downloads it once)';
          let r = await sh(uv, ['venv', '--python', '3.12', this.envDir], { ms: 15 * 60000 });
          if (!r.ok) throw new Error('Could not create the Python environment: ' + (r.err || r.out).trim().split('\n').pop());
          py = this.py();
          const extra = process.platform === 'linux' ? ((await sh('nvidia-smi', ['-L'])).ok ? ',cuda12' : ',cpu') : '';
          this.setup.status = `Installing mlx-lm${extra ? ' (' + extra.slice(1) + ')' : ''} from pypi.org — this can take a few minutes`;
          r = await sh(uv, ['pip', 'install', '--python', py, `mlx-lm[train${extra}]`], { ms: 30 * 60000 });
          if (!r.ok) throw new Error('Could not install mlx-lm: ' + (r.err || r.out).trim().split('\n').slice(-2).join(' '));
        }
        fs.writeFileSync(path.join(this.dir, 'forge_train.py'), WRAPPER);
        const v = await sh(py, ['-c', 'import mlx_lm, mlx.core as mx; print(mlx_lm.__version__, mx.default_device())'], { ms: 120000 });
        if (!v.ok) throw new Error('mlx-lm is installed but does not start: ' + v.err.trim().split('\n').pop());
        this.setup = { state: 'done', status: 'Ready — mlx-lm ' + v.out.trim() };
      } catch (e) { this.setup = { state: 'error', status: e.message }; }
    })();
    return this.setup;
  }
  async getUv() {
    const asset = UV_ASSET(); if (!asset) throw new Error('No uv build for this computer.');
    const relUrl = 'https://api.github.com/repos/astral-sh/uv/releases/latest';
    this.setup.status = 'Downloading uv (Python manager) from github.com/astral-sh/uv';
    let rel; try { const r = await dl(relUrl, { headers: { 'user-agent': 'ForgeAI' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status }); rel = await r.json(); } catch (e) { throw explainNet(e, relUrl, 'Looking up uv'); }
    const a = (rel.assets || []).find((x) => x.name === asset); const sumA = (rel.assets || []).find((x) => x.name === asset + '.sha256');
    if (!a) throw new Error(`uv ${rel.tag_name} has no ${asset}`);
    const r = await dl(a.browser_download_url, { redirect: 'follow' }); if (!r.ok) throw explainNet(Object.assign(new Error('HTTP ' + r.status), { status: r.status }), a.browser_download_url, 'Downloading uv');
    const buf = Buffer.from(await r.arrayBuffer()); const got = crypto.createHash('sha256').update(buf).digest('hex');
    const want = sumA ? (await (await dl(sumA.browser_download_url, { redirect: 'follow' })).text()).trim().split(/\s+/)[0] : (/^sha256:(\w{64})$/.exec(a.digest || '') || [])[1];
    if (want && want !== got) throw new Error('The uv download is damaged or was changed (checksum mismatch). Nothing was installed.');
    fs.mkdirSync(this.uvDir, { recursive: true }); const tgz = path.join(this.uvDir, asset); fs.writeFileSync(tgz, buf);
    const x = await sh('tar', ['-xzf', tgz, '-C', this.uvDir, '--strip-components=1'], { ms: 60000 }); fs.rmSync(tgz, { force: true });
    if (!x.ok) throw new Error('Could not unpack uv: ' + x.err);
    const uv = path.join(this.uvDir, 'uv'); fs.chmodSync(uv, 0o755); return uv;
  }

  // ---- training data: JSONL lines in mlx-lm's chat / completions / text formats
  static validate(lines) {
    const ok = []; const bad = [];
    lines.forEach((l, i) => { let j; try { j = typeof l === 'string' ? JSON.parse(l) : l; } catch { bad.push(i + 1); return; }
      if (Array.isArray(j.messages) && j.messages.some((m) => m.role === 'assistant' && String(m.content || '').trim())) ok.push({ messages: j.messages.map((m) => ({ role: m.role, content: String(m.content || '') })) });
      else if (j.prompt != null && j.completion != null) ok.push({ prompt: String(j.prompt), completion: String(j.completion) });
      else if (j.text != null && String(j.text).trim()) ok.push({ text: String(j.text) });
      else bad.push(i + 1); });
    return { ok, bad };
  }
  runs() { return this.store.getSetting('training_runs', []); }
  saveRuns(l) { this.store.setSetting('training_runs', l); }
  patch(id, p) { const l = this.runs().map((r) => (r.id === id ? { ...r, ...p } : r)); this.saveRuns(l); return l.find((r) => r.id === id); }
  get(id) { return this.runs().find((r) => r.id === id); }

  start({ name, baseModel, examples, iters = 200, layers = 8, batch = 1, lr = 1e-5, maxSeq = 2048, maskPrompt = true }) {
    const bad400 = (m) => Object.assign(new Error(m), { status: 400 });
    if (!this.ready()) throw bad400('Set up training first (Training → Set Up Training).');
    if (!/^[\w.-]+\/[\w.-]+$/.test(baseModel || '') && !fs.existsSync(baseModel || '')) throw bad400('Choose a base model (an MLX model on Hugging Face, e.g. mlx-community/…, or a folder).');
    const { ok, bad } = Trainer.validate(examples || []);
    if (ok.length < 4) throw bad400(`Training needs at least 4 good examples (found ${ok.length}${bad.length ? `; ${bad.length} could not be used` : ''}). 50–500 is typical.`);
    fs.writeFileSync(path.join(this.dir, 'forge_train.py'), WRAPPER); // always the version that ships with this ForgeAI
    const id = 'tr_' + crypto.randomBytes(5).toString('hex'); const dir = path.join(this.dir, id); const data = path.join(dir, 'data'); fs.mkdirSync(data, { recursive: true });
    const shuffled = ok.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const nVal = Math.max(1, Math.round(shuffled.length * 0.1));
    fs.writeFileSync(path.join(data, 'valid.jsonl'), shuffled.slice(0, nVal).map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(data, 'train.jsonl'), shuffled.slice(nVal).map((x) => JSON.stringify(x)).join('\n') + '\n');
    const cfg = { model: baseModel, train: true, data, adapter_path: path.join(dir, 'adapters'), iters: Math.max(10, Math.min(20000, +iters || 200)), num_layers: Math.max(1, Math.min(64, +layers || 8)), batch_size: Math.max(1, Math.min(16, +batch || 1)),
      learning_rate: Math.max(1e-7, Math.min(1e-2, +lr || 1e-5)), max_seq_length: Math.max(256, Math.min(16384, +maxSeq || 2048)), mask_prompt: !!maskPrompt && ok.every((x) => !x.text), grad_checkpoint: true, steps_per_report: 5, steps_per_eval: 50, val_batches: 5, save_every: 100, fine_tune_type: 'lora', seed: 0 };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    const run = { id, name: String(name || 'My trained model').slice(0, 60), baseModel, examples: ok.length, skipped: bad.length, train: shuffled.length - nVal, valid: nVal, config: cfg, state: 'running', status: 'Loading the base model (downloads from huggingface.co the first time)', created: new Date().toISOString(), points: [], val: [], log: [] };
    this.saveRuns([run, ...this.runs()]);
    const p = spawn(this.py(), [path.join(this.dir, 'forge_train.py'), path.join(dir, 'config.json')], { cwd: dir, env: { ...process.env, PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' } });
    if (this.onSpawn) try { this.onSpawn(p.pid, 'python'); } catch {}
    this.procs.set(id, p); const t0 = Date.now(); let tail = [];
    const onLine = (line) => {
      tail.push(line.slice(0, 300)); if (tail.length > 60) tail.shift();
      const m = /^FORGE (\{.*\})$/.exec(line.trim()); if (!m) { if (/Fetching|Downloading|download/i.test(line)) this.patch(id, { status: 'Downloading the base model from huggingface.co' }); return; }
      let e; try { e = JSON.parse(m[1]); } catch { return; }
      const r = this.get(id); if (!r) return;
      if (e.type === 'start') this.patch(id, { status: 'Training started' });
      if (e.type === 'train') { const pts = [...r.points, { it: e.iteration, loss: e.train_loss, tps: e.tokens_per_second, mem: e.peak_memory, t: Date.now() - t0 }].slice(-2000); const left = e.iteration ? (Date.now() - t0) / e.iteration * (r.config.iters - e.iteration) : null; this.patch(id, { points: pts, status: `Training · step ${e.iteration} of ${r.config.iters}`, progress: e.iteration / r.config.iters, etaMs: left }); }
      if (e.type === 'val') this.patch(id, { val: [...r.val, { it: e.iteration, loss: e.val_loss }].slice(-500) });
      if (e.type === 'done') this.patch(id, { status: 'Finished', progress: 1 });
    };
    let buf = ''; const feed = (d) => { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); parts.forEach(onLine); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('exit', (code) => {
      this.procs.delete(id); const r = this.get(id); if (!r) return;
      const ok = code === 0 && fs.existsSync(path.join(dir, 'adapters', 'adapters.safetensors'));
      const errLine = (tail.filter((l) => /^\s*\w*(Error|Exception):/.test(l)).slice(-1)[0] || tail.filter((l) => /out of memory|Killed/i.test(l)).slice(-1)[0] || '').trim();
      this.patch(id, { state: r.state === 'stopped' ? 'stopped' : ok ? 'done' : 'error', status: r.state === 'stopped' ? 'Stopped' : ok ? 'Finished — ready to use' : `Training failed: ${errLine || 'exit code ' + code}${/memory/i.test(errLine) ? '. Use a smaller base model, fewer layers or a shorter max length.' : ''}`, finished: new Date().toISOString(), log: tail.slice(-30) });
    });
    return this.get(id);
  }
  stop(id) { const p = this.procs.get(id); if (p) { this.patch(id, { state: 'stopped' }); p.kill(); } return this.get(id); }
  // Serve a finished model (base + what it learned) with mlx-lm's OpenAI-compatible server.
  async serve(id) {
    const r = this.get(id); if (!r || r.state !== 'done') throw new Error('Train the model first');
    if (this.servers.has(id)) return { url: this.get(id).url };
    const port = await freePort(8740);
    const p = spawn(this.py(), ['-m', 'mlx_lm', 'server', '--model', r.baseModel, '--adapter-path', r.config.adapter_path, '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    if (this.onSpawn) try { this.onSpawn(p.pid, 'python'); } catch {}
    const log = []; p.stderr.on('data', (d) => { log.push(String(d)); if (log.length > 40) log.shift(); }); p.stdout.on('data', (d) => { log.push(String(d)); if (log.length > 40) log.shift(); });
    this.servers.set(id, p); p.on('exit', () => { this.servers.delete(id); this.patch(id, { serving: false }); });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 240; i++) { try { const x = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(1000) }); if (x.ok) { this.patch(id, { serving: true, url }); return { url }; } } catch {} if (!this.servers.has(id)) break; await new Promise((ok) => setTimeout(ok, 500)); }
    try { p.kill(); } catch {}
    throw new Error('The trained model did not start: ' + log.join('').trim().split('\n').slice(-2).join(' · '));
  }
  unserve(id) { const p = this.servers.get(id); if (p) p.kill(); this.patch(id, { serving: false }); return { ok: true }; }
  remove(id) { this.stop(id); this.unserve(id); const dir = path.join(this.dir, id); if (dir.startsWith(this.dir) && id.startsWith('tr_')) fs.rmSync(dir, { recursive: true, force: true }); this.saveRuns(this.runs().filter((r) => r.id !== id)); return { ok: true }; }
  status() { return { supported: this.supported(), ready: this.ready(), setup: this.setup, runs: this.runs().map((r) => ({ ...r, points: r.points.filter((_, i, a) => a.length < 400 || i % Math.ceil(a.length / 400) === 0) })) }; }
}

module.exports = { Trainer };
