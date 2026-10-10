'use strict';
// Multi-computer clusters with llama.cpp RPC: one coordinator runs llama-server, every other computer runs ggml-rpc-server.
// ForgeAI downloads the official llama.cpp build for each computer, starts/stops the processes, measures links and speed.
// exo, MLX distributed and vLLM+Ray are detected and connected (they manage their own splitting).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');

const crypto = require('node:crypto');
const { explainNet } = require('./net');
// Respect HTTPS_PROXY / HTTP_PROXY (company networks) for the one-time download.
let proxyDispatcher;
function dl(url, init = {}) {
  if (proxyDispatcher === undefined) { proxyDispatcher = null; if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) { try { const { EnvHttpProxyAgent } = require('undici'); proxyDispatcher = new EnvHttpProxyAgent(); } catch {} } }
  if (proxyDispatcher) { const { fetch: uf } = require('undici'); return uf(url, { ...init, dispatcher: proxyDispatcher }); }
  return fetch(url, init);
}
// Errors for the one-time download: what, where, next action. Offers the offline route.
const OFFLINE = 'Or download the llama.cpp release file on another computer and use “Install from file”.';
function dlError(e, url, what) {
  if (e && e.status) { let host = url; try { host = new URL(url).host; } catch {}
    const why = e.status === 403 ? 'access denied (403) — usually a GitHub rate limit or a network filter' : e.status === 404 ? 'the file was not found (404)' : e.status === 429 ? 'rate limited (429)' : 'server error ' + e.status;
    return new Error(`${what} failed at ${host}: ${why}. Try again in a few minutes. ${OFFLINE}`); }
  const x = explainNet(e, url, what); x.message += ' ' + OFFLINE; return x;
}
const sh = (cmd, args, ms = 5000) => new Promise((ok) => execFile(cmd, args, { timeout: ms, windowsHide: true }, (e, out, err) => ok(e ? '' : String(out || err || ''))));
const portOpen = (host, port, ms = 600) => new Promise((ok) => { const s = net.connect({ host, port, timeout: ms }, () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); s.on('timeout', () => { s.destroy(); ok(false); }); });

// Which official release file fits this computer.
function assetPattern(gpu) {
  const a = process.arch, p = process.platform;
  if (p === 'darwin') return a === 'arm64' ? /bin-macos-arm64\.(tar\.gz|zip)$/ : /bin-macos-x64\.(tar\.gz|zip)$/;
  if (p === 'win32') { if (gpu === 'cuda') return a === 'arm64' ? /bin-win-cuda-[\d.]+-arm64\.zip$/ : /bin-win-cuda-12\.[\d.]+-x64\.zip$/; if (gpu === 'vulkan') return a === 'arm64' ? /bin-win-vulkan-arm64\.zip$/ : /bin-win-vulkan-x64\.zip$/; return a === 'arm64' ? /bin-win-cpu-arm64\.zip$/ : /bin-win-cpu-x64\.zip$/; }
  if (p === 'linux') { if (gpu === 'vulkan') return a === 'arm64' ? /bin-ubuntu-vulkan-arm64\.tar\.gz$/ : /bin-ubuntu-vulkan-x64\.tar\.gz$/; if (gpu === 'cuda') return a === 'arm64' ? /bin-ubuntu-cuda-[\d.]+-arm64\.tar\.gz$/ : /bin-ubuntu-cuda-12\.[\d.]+-x64\.tar\.gz$/; return a === 'arm64' ? /bin-ubuntu-arm64\.tar\.gz$/ : /bin-ubuntu-x64\.tar\.gz$/; }
  return null;
}

class LlamaCluster {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'engines', 'llama.cpp'); fs.mkdirSync(this.dir, { recursive: true });
    this.procs = { rpc: null, server: null }; this.logs = { rpc: [], server: [] }; this.install = { state: 'idle' };
    // Never leave llama.cpp running after ForgeAI quits.
    const cleanup = () => { for (const p of Object.values(this.procs)) if (p) { try { p.kill(); } catch {} } };
    process.once('exit', cleanup);
  }
  exe(name) { const v = this.installed(); if (!v) return null; const n = process.platform === 'win32' ? name + '.exe' : name; const p = path.join(v.dir, n); return fs.existsSync(p) ? p : null; }
  installed() {
    try { const m = JSON.parse(fs.readFileSync(path.join(this.dir, 'current.json'), 'utf8')); if (fs.existsSync(m.dir)) return m; } catch {}
    return this.bundled();
  }
  // llama.cpp builds shipped inside ForgeAI (app/engines/<variant>) — no download needed. The GPU build (Vulkan) is tried
  // first and only used if it actually starts on this computer (it needs a Vulkan driver); otherwise the CPU build.
  cpuForced() { try { return fs.existsSync(path.join(this.dir, 'cpu-only')); } catch { return false; } }
  // Remember that the GPU build couldn't load models on this computer, so later starts use the CPU build straight away.
  forceCpu(reason) { try { fs.writeFileSync(path.join(this.dir, 'cpu-only'), String(reason || 'gpu load failed') + '\n' + new Date().toISOString()); } catch {} this._bundled = undefined; }
  clearCpuForce() { try { fs.unlinkSync(path.join(this.dir, 'cpu-only')); } catch {} this._bundled = undefined; }
  bundled() {
    if (this._bundled !== undefined) return this._bundled;
    const root = path.join(__dirname, '..', 'engines'); const p = process.platform, a = process.arch;
    let order = p === 'darwin' ? [a === 'arm64' ? 'macos-arm64' : 'macos-x64'] : p === 'win32' ? (a === 'arm64' ? ['win-vulkan-arm64', 'win-cpu-arm64'] : ['win-vulkan-x64', 'win-cpu-x64']) : p === 'linux' ? (a === 'arm64' ? ['ubuntu-arm64'] : ['ubuntu-vulkan-x64', 'ubuntu-x64']) : [];
    if (this.cpuForced()) order = order.filter((v) => !/vulkan|cuda/.test(v));  // GPU ruled out on this computer
    const ext = p === 'win32' ? '.exe' : ''; const { execFileSync } = require('child_process');
    for (const v of order) {
      const dir = path.join(root, v); const srv = path.join(dir, 'llama-server' + ext); if (!fs.existsSync(srv)) continue;
      try { execFileSync(srv, ['--version'], { timeout: 15000, windowsHide: true, stdio: 'ignore', cwd: dir, env: { ...process.env, LD_LIBRARY_PATH: dir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') } }); }
      catch (e) { if (e.status == null || e.status > 1) continue; } // could not start (e.g. no Vulkan driver) → next build
      const rpcName = fs.existsSync(path.join(dir, 'ggml-rpc-server' + ext)) ? 'ggml-rpc-server' : 'rpc-server';
      let tag = 'bundled'; try { tag = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || tag; } catch {}
      this._bundled = { tag, asset: v, gpu: /vulkan/.test(v) ? 'vulkan' : p === 'darwin' && a === 'arm64' ? 'metal' : 'cpu', dir, rpcName, coordinator: true, source: 'bundled', verified: true };
      return this._bundled;
    }
    this._bundled = null; return null;
  }
  // Download and unpack the official build (needs internet once).
  async ensure({ gpu = 'cpu', onProgress = () => {} } = {}) {
    const have = this.installed(); if (have && (have.gpu === gpu || (have.source === 'bundled' && gpu !== 'cuda'))) return have;
    this.install = { state: 'running', status: 'Finding the latest llama.cpp release' };
    try {
      // llama.cpp now publishes builds as numbered pre-releases (b12345); "latest" can be an empty placeholder. Scan the recent ones.
      const relUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15';
      let rel; try { const r = await dl(relUrl, { headers: { 'user-agent': 'ForgeAI' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status }); const list = await r.json(); rel = (Array.isArray(list) ? list : [list]).filter((x) => !x.draft).find((x) => (x.assets || []).some((as) => assetPattern(gpu) && assetPattern(gpu).test(as.name))) || (Array.isArray(list) ? list[0] : list); } catch (e) { throw dlError(e, relUrl, 'Looking up the latest llama.cpp release'); }
      const re = assetPattern(gpu); const asset = (rel.assets || []).find((x) => re && re.test(x.name));
      if (!asset) throw new Error(`No llama.cpp build for ${process.platform}/${process.arch}${gpu !== 'cpu' ? ' with ' + gpu : ''} in release ${rel.tag_name}`);
      const dest = path.join(this.dir, rel.tag_name + '-' + gpu); fs.mkdirSync(dest, { recursive: true });
      const file = path.join(this.dir, asset.name);
      let res; try { res = await dl(asset.browser_download_url, { redirect: 'follow' }); if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status }); } catch (e) { throw dlError(e, asset.browser_download_url, 'Downloading llama.cpp'); }
      const total = +res.headers.get('content-length') || asset.size || 0; let done = 0; const out = fs.createWriteStream(file); const hash = crypto.createHash('sha256');
      for await (const c of res.body) { done += c.length; hash.update(c); if (!out.write(c)) await new Promise((r) => out.once('drain', r)); this.install = { state: 'running', status: `Downloading ${asset.name}`, completed: done, total }; onProgress(this.install); }
      await new Promise((r) => out.end(r));
      // GitHub publishes a SHA-256 for each release file; refuse a file that doesn't match.
      const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || ''); const got = hash.digest('hex');
      if (want && want[1] !== got) { fs.rmSync(file, { force: true }); throw new Error(`Downloaded llama.cpp file is damaged or was changed (checksum mismatch). Nothing was installed — try again.`); }
      const meta = await this.installArchive(file, { tag: rel.tag_name, asset: asset.name, sha256: got, verified: !!want, gpu, dest });
      fs.rmSync(file, { force: true });
      return meta;
    } catch (e) { this.install = { state: 'error', status: e.message }; throw e; }
  }
  // Unpack a release archive (downloaded here, or copied over by hand for computers without internet).
  async installArchive(file, info = {}) {
    if (!fs.existsSync(file)) throw new Error(`No file at ${file} — check the path on this computer`);
    const dest = info.dest || path.join(this.dir, 'manual-' + Date.now()); fs.mkdirSync(dest, { recursive: true });
    this.install = { state: 'running', status: 'Unpacking' };
    await new Promise((ok, bad) => execFile('tar', ['-xf', file, '-C', dest], { timeout: 180000, windowsHide: true }, (e) => (e ? bad(new Error(`Unpacking ${path.basename(file)} failed: ${e.message.split('\n')[0]}. Make sure it is a llama.cpp release .zip or .tar.gz for this computer.`)) : ok())));
    return this.useFolder(dest, { ...info, asset: info.asset || path.basename(file), dest: undefined });
  }
  // Use llama.cpp binaries that are already on this computer (your own build, Homebrew, or an unpacked release).
  async useFolder(dir, info = {}) {
    if (!dir || !fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
    const isBin = (f) => /^(ggml-rpc-server|rpc-server)(\.exe)?$/.test(f);
    const find = (d, depth = 0) => { let list; try { list = fs.readdirSync(d); } catch { return null; } if (list.some(isBin)) return d; if (depth < 3) for (const f of list) { const p = path.join(d, f); try { if (fs.statSync(p).isDirectory()) { const r = find(p, depth + 1); if (r) return r; } } catch {} } return null; };
    const binDir = find(dir);
    const ext = process.platform === 'win32' ? '.exe' : '';
    if (!binDir) throw new Error(`No llama.cpp RPC server (ggml-rpc-server${ext}) in ${dir}. Use an official release build, or build llama.cpp with -DGGML_RPC=ON.`);
    if (!fs.existsSync(path.join(binDir, 'llama-server' + ext))) this.install = { state: 'running', status: 'Note: llama-server is missing — this computer can be a worker but not the coordinator' };
    if (process.platform !== 'win32') for (const f of fs.readdirSync(binDir)) { try { const p = path.join(binDir, f); if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755); } catch {} }
    if (process.platform === 'darwin') await sh('xattr', ['-dr', 'com.apple.quarantine', binDir]);
    const rpcName = fs.existsSync(path.join(binDir, 'ggml-rpc-server' + ext)) ? 'ggml-rpc-server' : 'rpc-server';
    const ver = (fs.existsSync(path.join(binDir, 'llama-server' + ext)) ? await sh(path.join(binDir, 'llama-server' + ext), ['--version'], 8000) : '').match(/version: (\d+) \(([0-9a-f]+)\)/);
    const meta = { tag: info.tag || (ver ? 'b' + ver[1] : 'custom'), asset: info.asset || null, sha256: info.sha256 || null, verified: !!info.verified, gpu: info.gpu || 'cpu', dir: binDir, at: new Date().toISOString(), rpcName, coordinator: fs.existsSync(path.join(binDir, 'llama-server' + ext)), source: info.asset ? 'release' : 'folder' };
    fs.writeFileSync(path.join(this.dir, 'current.json'), JSON.stringify(meta));
    this.install = { state: 'done', status: `llama.cpp ${meta.tag} ready${meta.coordinator ? '' : ' (worker only — llama-server missing)'}` };
    return meta;
  }
  log(kind, line) {
    const l = this.logs[kind]; l.push(String(line).slice(0, 400)); if (l.length > 400) l.shift();
    // Where the model's layers ended up — shown in the cluster view.
    if (kind === 'server') { const m = /(?:load_tensors|llama_kv_cache):\s+(\S+?(?:\[[^\]]+\])?) (model|KV) buffer size =\s+([\d.]+) MiB/.exec(line);
      if (m) { const L = (this.devices = this.devices || []); let d = L.find((x) => x.device === m[1]); if (!d) L.push((d = { device: m[1], mib: 0, kvMib: 0 })); if (m[2] === 'model') d.mib += +m[3]; else d.kvMib += +m[3]; }
      const o = /offloaded (\d+)\/(\d+) layers/.exec(line); if (o) this.offload = { layers: +o[1], of: +o[2] }; }
  }
  spawnBin(kind, name, args, env = {}) {
    const exe = this.exe(name); if (!exe) throw new Error(`${name} is not installed on this computer yet — run “Install llama.cpp” first`);
    if (this.procs[kind]) { try { this.procs[kind].kill(); } catch {} }
    const libEnv = process.platform === 'linux' ? { LD_LIBRARY_PATH: path.dirname(exe) + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') } : process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: path.dirname(exe) } : {};
    const p = spawn(exe, args, { cwd: path.dirname(exe), env: { ...process.env, ...libEnv, ...env }, windowsHide: true });
    if (this.onSpawn) try { this.onSpawn(p.pid, kind); } catch {}
    this.logs[kind] = []; if (kind === 'server') { this.devices = []; this.offload = null; } this.log(kind, '$ ' + name + ' ' + args.map((a) => (/api-key/.test(a) ? a : a)).join(' ').replace(/(--api-key )\S+/, '$1••••'));
    p.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((x) => this.log(kind, x)));
    p.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((x) => this.log(kind, x)));
    p.on('exit', (c) => { this.log(kind, `exited (${c})`); if (this.procs[kind] === p) this.procs[kind] = null; });
    this.procs[kind] = p; p.startedAt = Date.now(); p.args = args;
    return p;
  }
  // Worker role. Binds only to the given address (never all interfaces) — llama.cpp warns RPC must not be exposed.
  async startRpc({ host = '127.0.0.1', port = 50052, threads, device, cache = true } = {}) {
    const meta = this.installed(); if (!meta) throw new Error('Install llama.cpp on this computer first');
    if (host === '0.0.0.0' || host === '::') throw new Error('For safety the RPC server is bound to one network address, not all of them. Choose this computer’s LAN, VPN or Thunderbolt address.');
    if (this.procs.rpc) { this.stop('rpc'); for (let i = 0; i < 20 && await portOpen(host, port, 200); i++) await new Promise((r) => setTimeout(r, 150)); }
    if (await portOpen(host, port, 400)) throw new Error(`Port ${port} on ${host} is already in use on this computer — another RPC server or program is using it. Stop it, or choose another port.`);
    const args = ['-H', host, '-p', String(port), '-t', String(threads || Math.max(1, os.cpus().length - 1))];
    if (device) args.push('-d', device); if (cache) args.push('-c');
    this.spawnBin('rpc', meta.rpcName, args);
    for (let i = 0; i < 30; i++) { if (await portOpen(host, port, 300)) return { ok: true, host, port }; if (!this.procs.rpc) break; await new Promise((r) => setTimeout(r, 300)); }
    throw new Error(`The RPC worker did not start on ${os.hostname()} at ${host}:${port}: ${this.logs.rpc.slice(-3).join(' · ')}. Check that ${host} is an address of this computer and the port is free.`);
  }
  // Coordinator role: llama-server with the model split across local devices and the RPC workers.
  async startServer({ model, hf, rpc = [], split, port = 8090, host = '127.0.0.1', ctx = 8192, apiKey, ngl = 999, alias } = {}) {
    if (!this.installed()) throw new Error('Install llama.cpp on this computer first');
    if (this.procs.server) { this.stop('server'); for (let i = 0; i < 20 && await portOpen(host === '0.0.0.0' ? '127.0.0.1' : host, port, 200); i++) await new Promise((r) => setTimeout(r, 150)); }
    if (await portOpen(host === '0.0.0.0' ? '127.0.0.1' : host, port, 400)) throw new Error(`Port ${port} on ${host} is already in use — another llama-server or program is using it. Stop it, or choose another port for the cluster.`);
    const args = ['--host', host, '--port', String(port), '-c', String(ctx), '-ngl', String(ngl), '--metrics', '-lv', '4'];
    if (!hf && model && !fs.existsSync(model)) throw new Error(`Model file not found on ${os.hostname()}: ${model}. Check the path on the coordinator computer.`);
    if (hf) args.push('-hf', hf); else if (model) args.push('-m', model); else throw new Error('Choose a model');
    if (rpc.length) args.push('--rpc', rpc.join(','));
    if (split && split.length) args.push('-ts', split.join(','));
    if (apiKey) args.push('--api-key', apiKey);
    if (alias) args.push('--alias', String(alias).slice(0, 120));
    this.spawnBin('server', 'llama-server', args);
    for (let i = 0; i < 600; i++) { // loading a split model can take minutes
      try { const r = await fetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return { ok: true, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}` }; } catch {}
      if (!this.procs.server) {
        const errs = this.logs.server.filter((x) => /\bE \w+|error|failed|out of memory|unable/i.test(x) && !/cleaning up/.test(x)).slice(-3).map((x) => x.replace(/^[\d.]+\s+[EWI]\s+\w+\s+/, '').trim());
        const oom = errs.some((x) => /out of memory|alloc|unable to allocate/i.test(x));
        throw new Error(`llama-server could not start on ${os.hostname()}: ${errs.join(' · ') || 'it exited'}. ${oom ? 'The model does not fit — add a computer, lower the context length or use a smaller quantisation.' : 'Open Logs on the cluster for details.'}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('llama-server did not become ready in time');
  }
  stop(kind) { for (const k of kind ? [kind] : ['rpc', 'server']) { const p = this.procs[k]; if (p) { try { p.kill(); } catch {} this.procs[k] = null; } } return { ok: true }; }
  status() {
    const s = (k) => (this.procs[k] ? { running: true, pid: this.procs[k].pid, since: this.procs[k].startedAt, args: this.procs[k].args.map((a, i, l) => (l[i - 1] === '--api-key' ? '••••' : a)) } : { running: false });
    return { installed: this.installed(), install: this.install, rpc: s('rpc'), server: s('server'), devices: this.devices || [], offload: this.offload || null, logs: { rpc: this.logs.rpc.slice(-60), server: this.logs.server.slice(-60) } };
  }

  // What this computer can do in a cluster.
  async capabilities() {
    const c = { os: process.platform, arch: process.arch, host: os.hostname(), cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, memTotal: os.totalmem(), memFree: os.freemem(), gpu: [], interfaces: [], backends: {}, osVersion: os.release() };
    const smi = await sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits']);
    for (const line of smi.trim().split('\n').filter(Boolean)) { const [name, t, u] = line.split(',').map((x) => x.trim()); c.gpu.push({ name, vramTotal: +t * 2 ** 20, vramUsed: +u * 2 ** 20, kind: 'nvidia' }); }
    if (process.platform === 'darwin') { const v = await sh('sw_vers', ['-productVersion']); c.osVersion = v.trim(); if (process.arch === 'arm64') c.gpu.push({ name: 'Apple GPU (shares system memory)', vramTotal: null, kind: 'apple' }); }
    if (process.platform === 'linux') { const mi = await sh('cat', ['/proc/meminfo']); const av = /MemAvailable:\s+(\d+)/.exec(mi); if (av) c.memFree = +av[1] * 1024; const model = await sh('cat', ['/proc/device-tree/model']); if (/raspberry/i.test(model)) c.board = model.replace(/\0/g, '').trim(); }
    // Network links: Ethernet / Wi-Fi / Thunderbolt / USB4 and the speed the OS reports.
    const ifs = os.networkInterfaces();
    let tbNames = new Set(); const wifiNames = new Set(); let speeds = {};
    if (process.platform === 'darwin') {
      const hw = await sh('networksetup', ['-listallhardwareports']);
      for (const blk of hw.split(/\n\n/)) { const port = /Hardware Port: (.+)/.exec(blk), dev = /Device: (\S+)/.exec(blk); if (port && dev && /thunderbolt/i.test(port[1])) tbNames.add(dev[1]); if (port && dev && /wi-?fi|airport/i.test(port[1])) wifiNames.add(dev[1]); }
    }
    if (process.platform === 'linux') { for (const n of Object.keys(ifs)) { if (/^thunderbolt/.test(n)) tbNames.add(n); const sp = (await sh('cat', [`/sys/class/net/${n}/speed`])).trim(); if (+sp > 0) speeds[n] = +sp; } }
    if (process.platform === 'win32') {
      const ps = await sh('powershell', ['-NoProfile', '-Command', 'Get-NetAdapter | Select-Object Name,InterfaceDescription,LinkSpeed,Status | ConvertTo-Json'], 8000);
      try { const arr = [].concat(JSON.parse(ps || '[]')); for (const a of arr) { if (/usb4|thunderbolt/i.test(a.InterfaceDescription || '')) tbNames.add(a.Name); if (/wi-?fi|wireless|802\.11/i.test((a.InterfaceDescription || '') + ' ' + a.Name)) wifiNames.add(a.Name); const m = /([\d.]+)\s*(G|M)bps/i.exec(a.LinkSpeed || ''); if (m) speeds[a.Name] = +m[1] * (m[2].toUpperCase() === 'G' ? 1000 : 1); } } catch {}
    }
    for (const [name, list] of Object.entries(ifs)) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tb = tbNames.has(name) || (process.platform === 'darwin' && /^bridge\d/.test(name) && tbNames.size);
      c.interfaces.push({ name, address: a.address, kind: tb ? 'thunderbolt' : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) ? 'vpn' : (wifiNames.has(name) || /^(wl|wlan|Wi-?Fi)/i.test(name)) ? 'wifi' : 'ethernet', mbps: speeds[name] || null });
    }
    // Backends.
    const lc = this.installed();
    c.backends.llamacpp = { supported: ['darwin', 'win32', 'linux'].includes(process.platform), installed: !!lc, version: lc && lc.tag };
    const exoPath = (await sh(process.platform === 'win32' ? 'where' : 'which', ['exo'])).trim();
    c.backends.exo = { supported: process.platform === 'darwin' || process.platform === 'linux', gpu: process.platform === 'darwin' ? 'Apple GPU' : 'CPU only on Linux (GPU support in development)', installed: !!exoPath, running: await portOpen('127.0.0.1', 52415) };
    if (process.platform === 'darwin') { const [maj, min] = c.osVersion.split('.').map(Number); c.backends.exo.rdmaPossible = maj > 26 || (maj === 26 && min >= 2); }
    const mlx = process.platform === 'darwin' && process.arch === 'arm64' ? (await sh('python3', ['-c', 'import mlx.core as m; print(m.__version__)'])).trim() : '';
    c.backends.mlx = { supported: process.platform === 'darwin' && process.arch === 'arm64', installed: !!mlx, version: mlx || null };
    const vllm = process.platform === 'linux' ? (await sh('python3', ['-c', 'import vllm; print(vllm.__version__)'], 15000)).trim() : '';
    c.backends.vllm = { supported: process.platform === 'linux' && c.gpu.some((g) => g.kind === 'nvidia'), installed: !!vllm, version: vllm || null, note: process.platform === 'win32' ? 'Use WSL2 with an NVIDIA GPU' : null };
    return c;
  }
}

// Link speed between two computers: download a block of data and time round trips. get(path) returns a fetch-like response.
async function measureLink(get, mb = 32) {
  const rtts = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); try { const r = await get('/node/net/ping'); if (r.text) await r.text(); rtts.push(performance.now() - t); } catch {} }
  const t0 = performance.now(); let bytes = 0;
  const r = await get('/node/net/blob?mb=' + mb);
  if (!r.ok) throw new Error('Link test refused: ' + r.status);
  for await (const c of r.body) bytes += c.length;
  const sec = (performance.now() - t0) / 1000;
  rtts.sort((x, y) => x - y);
  return { mbps: bytes * 8 / 1e6 / sec, rttMs: rtts.length ? rtts[Math.floor(rtts.length / 2)] : null, bytes };
}

module.exports = { LlamaCluster, measureLink, portOpen };
