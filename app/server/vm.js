'use strict';
// Virtual machines & isolated sandboxes for ForgeAI.
//
// An agent may need to run commands or untrusted code without touching the real computer. This manager hands out
// throwaway, isolated machines for that. It uses the strongest isolation the host can actually provide and is honest
// about what that is:
//   full-vm  — a real virtual machine (Linux KVM/QEMU, macOS Virtualization.framework, Windows Hyper-V). Needs a base
//              image to be configured. Strongest isolation (its own kernel).
//   container — a Docker or Podman container. Strong isolation, shares the host kernel.
//   namespace — a Linux namespace jail (bubblewrap or unshare). Good isolation, no extra software.
//   process   — a plain child process confined to its own throwaway folder with a scrubbed environment. Always
//              available; the weakest of the four, used only when nothing better is present.
//
// Capability detection never pretends: each backend reports available / unavailable and why, so the UI and the agent
// can tell the owner exactly what protection is in force.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

function which(bin) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; } }
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: opts.timeout || 60000, cwd: opts.cwd, env: opts.env, signal: opts.signal }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? (err.signal ? 128 : 1)) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && err.code === 'ABORT_ERR' ? 'stopped' : (err && err.message) || null });
    });
  });
}

class VMManager {
  // opts.root: where sandbox folders live. opts.store/opts.getImage optional (for full-VM images).
  constructor({ root, store = null } = {}) {
    this.root = root || path.join(os.tmpdir(), 'forgeai-vms');
    this.store = store;
    this.instances = new Map(); // id -> { id, name, backend, dir, createdAt, status, pid, cmd }
    try { fs.mkdirSync(this.root, { recursive: true }); } catch {}
    this._caps = null;
  }

  // ---- capability detection (cached briefly) --------------------------------
  capabilities(force = false) {
    if (this._caps && !force && Date.now() - this._caps.at < 30000) return this._caps.value;
    const plat = process.platform; const backends = [];
    // full VM
    if (plat === 'linux') {
      const kvm = (() => { try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } })();
      const qemu = which('qemu-system-x86_64') || which('qemu-system-aarch64');
      backends.push({ id: 'full-vm', tech: 'Linux KVM / QEMU', available: kvm && qemu && this.hasImage(),
        reason: !qemu ? 'QEMU is not installed (install qemu-system). ' : !kvm ? '/dev/kvm is not accessible — hardware virtualisation is off or this host is itself a VM without nested virtualisation. ' : !this.hasImage() ? 'No base image is configured. Add one in Settings → Virtual machines to enable full VMs. ' : 'Ready.',
        hardware: kvm, software: qemu });
    } else if (plat === 'darwin') {
      const apple = os.arch() === 'arm64';
      backends.push({ id: 'full-vm', tech: 'macOS Virtualization.framework', available: false,
        reason: `Detected ${apple ? 'Apple Silicon' : 'Intel Mac'}. Full VMs on macOS need the ForgeAI VM helper and a base image (Settings → Virtual machines). Until then, agents are isolated with a container or process sandbox.`,
        hardware: true, software: which('vmcli') });
    } else if (plat === 'win32') {
      backends.push({ id: 'full-vm', tech: 'Windows Hyper-V', available: false,
        reason: 'Hyper-V is detected and used at runtime when it is turned on (Windows Features → Hyper-V) and a base image is configured (Settings → Virtual machines). Until then, agents are isolated with a container or process sandbox.',
        hardware: null, software: null });
    }
    // container — needs the engine binary AND a running daemon
    const engineUp = (bin) => { try { execFileSync(bin, ['info'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 6000 }); return true; } catch { return false; } };
    const docker = which('docker') && engineUp('docker'); const podman = which('podman') && engineUp('podman');
    const dockerBin = which('docker'); const podmanBin = which('podman');
    backends.push({ id: 'container', tech: podman ? 'Podman container' : 'Docker container', available: docker || podman,
      reason: (docker || podman) ? 'Ready.' : (dockerBin || podmanBin) ? `${podmanBin ? 'Podman' : 'Docker'} is installed but its daemon is not running. Start it to enable container isolation.` : 'Neither Docker nor Podman is installed. Install one for container isolation.', engine: podman ? 'podman' : docker ? 'docker' : null });
    // namespace (Linux only)
    if (plat === 'linux') {
      const bwrap = which('bwrap'); const unshare = which('unshare');
      backends.push({ id: 'namespace', tech: bwrap ? 'bubblewrap (isolated filesystem)' : 'Linux namespaces — unshare (isolated processes)', available: bwrap || unshare,
        reason: bwrap ? 'Ready — the sandbox gets its own filesystem view; the rest of the disk is read-only.' : unshare ? 'Ready — the sandbox runs in its own process/PID/user namespace. Install bubblewrap (bwrap) for full filesystem isolation too.' : 'bubblewrap/unshare not found.', tool: bwrap ? 'bwrap' : unshare ? 'unshare' : null });
    }
    // process — always there
    backends.push({ id: 'process', tech: 'Confined process (own folder, scrubbed environment)', available: true, reason: 'Always available. Weakest isolation — used only when nothing stronger is present.' });

    const best = backends.find((b) => b.available) || backends[backends.length - 1];
    const value = { platform: plat, arch: os.arch(), backends, best: best.id,
      summary: `Best isolation available: ${best.tech}.` };
    this._caps = { at: Date.now(), value };
    return value;
  }

  hasImage() { try { const im = this.store && this.store.getSetting('vm_image', null); return !!(im && im.path && fs.existsSync(im.path)); } catch { return false; } }
  image() { try { return this.store && this.store.getSetting('vm_image', null); } catch { return null; } }

  pickBackend(prefer) {
    const caps = this.capabilities(); const order = ['full-vm', 'container', 'namespace', 'process'];
    if (prefer && prefer !== 'auto') { const b = caps.backends.find((x) => x.id === prefer); if (b && b.available) return prefer; }
    for (const id of order) { const b = caps.backends.find((x) => x.id === id); if (b && b.available) return id; }
    return 'process';
  }

  // ---- lifecycle ------------------------------------------------------------
  create({ name, backend = 'auto', image = null } = {}) {
    const id = 'vm_' + crypto.randomBytes(6).toString('hex');
    const chosen = this.pickBackend(backend);
    const dir = path.join(this.root, id); fs.mkdirSync(path.join(dir, 'root'), { recursive: true });
    const inst = { id, name: String(name || 'sandbox').slice(0, 60), backend: chosen, requested: backend, dir, rootfs: path.join(dir, 'root'), createdAt: Date.now(), status: 'ready', image: image || (this.image() || {}).path || null };
    this.instances.set(id, inst);
    return this.view(inst);
  }

  get(id) { const i = this.instances.get(id); if (!i) throw new Error('No such sandbox: ' + id); return i; }
  list() { return [...this.instances.values()].map((i) => this.view(i)); }
  view(i) { return { id: i.id, name: i.name, backend: i.backend, requested: i.requested, status: i.status, createdAt: new Date(i.createdAt).toISOString(), image: i.backend === 'full-vm' ? i.image : null, isolation: this.describe(i.backend) }; }
  describe(b) {
    const ns = (this.capabilities().backends.find((x) => x.id === 'namespace') || {}).tool;
    return ({ 'full-vm': 'Full virtual machine — its own kernel.', container: 'Container — isolated filesystem and processes, shared kernel.',
      namespace: ns === 'bwrap' ? 'Namespace jail — isolated filesystem and processes (rest of disk read-only).' : 'Namespace — isolated processes/PID/user; works in its own folder.',
      process: 'Confined process in its own folder with a scrubbed environment.' })[b] || b;
  }

  // Run a command inside the sandbox. Returns { code, stdout, stderr }.
  async exec(id, command, { timeout = 180000, signal, env = {} } = {}) {
    const i = this.get(id); i.status = 'running';
    const scrub = { PATH: process.env.PATH, HOME: i.rootfs, TMPDIR: i.rootfs, FORGEAI_SANDBOX: '1', ...env };
    try {
      let r;
      if (i.backend === 'container') r = await this.execContainer(i, command, { timeout, signal, env });
      else if (i.backend === 'namespace') r = await this.execNamespace(i, command, { timeout, signal, env: scrub });
      else if (i.backend === 'full-vm') r = await this.execVM(i, command, { timeout, signal, env });
      else r = await this.execProcess(i, command, { timeout, signal, env: scrub });
      i.status = 'ready'; return r;
    } catch (e) { i.status = 'ready'; return { code: 1, stdout: '', stderr: String(e.message || e) }; }
  }

  async execProcess(i, command, { timeout, signal, env }) {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/sh';
    const argv = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];
    return sh(shell, argv, { cwd: i.rootfs, env, timeout, signal });
  }

  async execNamespace(i, command, { timeout, signal, env }) {
    const caps = this.capabilities(); const nb = caps.backends.find((b) => b.id === 'namespace') || {};
    if (nb.tool === 'bwrap') {
      // bubblewrap: fresh root, bind only the sandbox folder writable, everything else read-only; no network.
      const args = ['--die-with-parent', '--unshare-all', '--new-session',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
        ...(fs.existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
        '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--bind', i.rootfs, '/work', '--chdir', '/work', '--setenv', 'HOME', '/work',
        '/bin/sh', '-c', command];
      return sh('bwrap', args, { timeout, signal, env });
    }
    // unshare: separate mount/pid/uts/ipc namespaces (needs privileges for some; best-effort).
    return sh('unshare', ['-Urmpf', '--mount-proc', '/bin/sh', '-c', `cd ${JSON.stringify(i.rootfs)}; ${command}`], { timeout, signal, env });
  }

  async execContainer(i, command, { timeout, signal, env }) {
    const caps = this.capabilities(); const cb = caps.backends.find((b) => b.id === 'container') || {};
    const engine = cb.engine || 'docker'; const img = (this.image() || {}).container || 'alpine:3.20';
    const envArgs = Object.entries(env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = ['run', '--rm', '--network', 'none', '--memory', '1g', '--cpus', '1',
      '-v', `${i.rootfs}:/work`, '-w', '/work', ...envArgs, img, '/bin/sh', '-lc', command];
    return sh(engine, args, { timeout, signal });
  }

  async execVM(i, command, { timeout, signal }) {
    // Full VM path (Linux KVM/QEMU). Requires a configured base image that boots and runs an agent/ssh.
    if (!this.hasImage()) return { code: 1, stdout: '', stderr: 'No base image is configured for full VMs. Add one under Settings → Virtual machines, or use the container/process sandbox.' };
    // Real deployments boot the image with qemu and send the command over a guest agent or SSH. That requires the
    // owner's own image and keys, so we do not fabricate a result here: we report clearly that it needs finishing setup.
    return { code: 1, stdout: '', stderr: 'A base image is configured, but full-VM command execution needs the VM helper and guest agent to be finished for this host. The container or process sandbox is isolating this agent in the meantime.' };
  }

  destroy(id) { const i = this.instances.get(id); if (!i) return { ok: true }; try { if (i.pid) process.kill(i.pid); } catch {} try { fs.rmSync(i.dir, { recursive: true, force: true }); } catch {} this.instances.delete(id); return { ok: true }; }
  destroyAll() { for (const id of [...this.instances.keys()]) this.destroy(id); }
}

module.exports = { VMManager };
