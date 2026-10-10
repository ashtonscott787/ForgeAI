'use strict';
// Background priority and "your apps come first".
//
// 1. Priority: ForgeAI and every process it starts (llama.cpp, the engine, training) run at a lower CPU priority than
//    the programs you use, so the operating system always serves your apps first. Levels:
//      normal  – same as other apps
//      low     – below normal (default)            nice 10 / BELOW_NORMAL_PRIORITY_CLASS
//      lowest  – only spare CPU                     nice 19 / IDLE_PRIORITY_CLASS; on macOS also the "background" QoS
//                                                   (efficiency cores, throttled disk) via taskpolicy -b
//    Lowering always works. Raising again needs no admin rights for new processes, but already-running ones on
//    macOS/Linux can't be raised by a normal user — ForgeAI says so and applies it fully after a restart.
// 2. Yield: every few seconds ForgeAI measures how much CPU, memory and (NVIDIA) GPU memory OTHER programs are using.
//    When they need the computer, ForgeAI backs off: background work (agents, schedules, benchmarks, work lent to other
//    computers) waits, idle models are unloaded to give memory back, and other ForgeAI computers stop sending work here.
//    Chats you are actively having in ForgeAI keep going — that is you using the computer too.
// GPU time itself can't be prioritised by a normal program on any OS; ForgeAI frees GPU memory by unloading models.

const os = require('os'); const { execFile } = require('child_process'); const { EventEmitter } = require('events');
const sh = (c, a, ms = 6000) => new Promise((ok) => execFile(c, a, { timeout: ms, windowsHide: true, maxBuffer: 8 << 20 }, (e, out) => ok(e ? '' : String(out || ''))));
const GB = 2 ** 30;
const NICE = { normal: 0, low: 10, lowest: 19 };

class Priority extends EventEmitter {
  constructor({ store }) {
    super(); this.store = store; this.tracked = new Set(); this.applied = new Map(); this.state = { yielding: false, reason: null, since: null, others: null, own: null, at: 0 };
    this._prevOthers = new Map(); this._prevTotal = null;
  }
  settings() { return { level: 'low', yield: true, yieldCpu: 70, yieldMemPct: 12, yieldGpuPct: 80, ...this.store.getSetting('priority', {}) }; }
  save(b) {
    const cur = this.settings();
    const n = { level: ['normal', 'low', 'lowest'].includes(b.level) ? b.level : cur.level, yield: b.yield == null ? cur.yield : !!b.yield,
      yieldCpu: b.yieldCpu == null ? cur.yieldCpu : Math.max(20, Math.min(100, +b.yieldCpu || 70)), yieldMemPct: b.yieldMemPct == null ? cur.yieldMemPct : Math.max(3, Math.min(50, +b.yieldMemPct || 12)),
      yieldGpuPct: b.yieldGpuPct == null ? cur.yieldGpuPct : Math.max(20, Math.min(100, +b.yieldGpuPct || 80)) };
    const raising = NICE[n.level] < NICE[cur.level];
    this.store.setSetting('priority', n); this.applyAll().catch(() => {});
    return { ...n, note: raising && process.platform !== 'win32' ? 'Raising priority applies to models started from now on; restart ForgeAI to raise everything already running.' : null };
  }
  // Apply the level to one process (ours or a child). Never raises above what the OS allows; errors are ignored.
  async apply(pid, level = this.settings().level) {
    if (!pid) return;
    const nice = NICE[level] ?? 10;
    try { os.setPriority(pid, process.platform === 'win32' ? (level === 'lowest' ? os.constants.priority.PRIORITY_LOW : level === 'low' ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL) : nice); } catch {}
    if (process.platform === 'darwin') await sh('taskpolicy', [level === 'lowest' ? '-b' : '-B', '-p', String(pid)], 3000); // background QoS on/off
    this.applied.set(pid, level);
  }
  track(pid) { if (!pid) return; this.tracked.add(pid); this.apply(pid).catch(() => {}); }
  // This process, the desktop app's helper processes, and every descendant (found by walking the process table).
  async descendants(root = process.pid) {
    const table = await this.processTable(); const kids = new Map();
    for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
    const out = new Set(); const walk = (pid) => { for (const c of kids.get(pid) || []) if (!out.has(c)) { out.add(c); walk(c); } }; walk(root);
    return { pids: out, table };
  }
  async applyAll(extraPids = []) {
    const level = this.settings().level; const { pids } = await this.descendants();
    for (const pid of [process.pid, ...extraPids, ...this.tracked, ...pids]) { if (this.applied.get(pid) !== level) await this.apply(pid, level); }
    for (const pid of [...this.tracked]) { try { process.kill(pid, 0); } catch { this.tracked.delete(pid); this.applied.delete(pid); } }
  }
  // pid, ppid, cpu ticks or %, resident memory (bytes)
  async processTable() {
    if (process.platform === 'win32') {
      const o = await sh('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 } | Select-Object IDProcess,CreatingProcessID,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Csv -NoTypeInformation'], 15000);
      return o.split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [pid, ppid, cpu, ws] = l.replace(/"/g, '').split(','); return { pid: +pid, ppid: +ppid, cpuPct: (+cpu || 0) / os.cpus().length, rss: +ws || 0 }; });
    }
    const o = await sh('ps', ['-A', '-o', 'pid=,ppid=,%cpu=,rss=']);
    return o.split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 4).map(([pid, ppid, cpu, rss]) => ({ pid: +pid, ppid: +ppid, cpuPct: (+cpu || 0) / os.cpus().length, rss: (+rss || 0) * 1024 }));
  }
  async gpuOthers(ownPids) {
    const o = await sh('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], 4000);
    const t = await sh('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], 4000);
    if (!o && !t) return null;
    const total = t.split('\n').filter(Boolean).reduce((a, x) => a + (+x || 0), 0) * 2 ** 20; let others = 0;
    for (const l of o.split('\n').filter(Boolean)) { const [pid, mb] = l.split(',').map((x) => x.trim()); if (!ownPids.has(+pid)) others += (+mb || 0) * 2 ** 20; }
    return total ? { others, total, pct: Math.round(others / total * 100) } : null;
  }
  // Measure, decide whether to yield, and tell listeners when that changes.
  async tick(extraOwnPids = []) {
    const s = this.settings();
    const { pids, table } = await this.descendants(); const own = new Set([process.pid, ...extraOwnPids, ...pids]);
    let ownCpu = 0, ownMem = 0, otherCpu = 0;
    for (const p of table) { if (own.has(p.pid)) { ownCpu += p.cpuPct; ownMem += p.rss; } else otherCpu += p.cpuPct; }
    otherCpu = Math.min(100, otherCpu);
    const total = os.totalmem(); const free = this.freeMem ? await this.freeMem() : os.freemem();
    const gpu = s.yield ? await this.gpuOthers(own) : null;
    const reasons = [];
    if (s.yield) {
      if (otherCpu >= s.yieldCpu) reasons.push(`other apps are using ${Math.round(otherCpu)}% of the CPU`);
      if (free / total * 100 < s.yieldMemPct) reasons.push(`only ${(free / GB).toFixed(1)} GB of memory is free`);
      if (gpu && gpu.pct >= s.yieldGpuPct) reasons.push(`other apps are using ${gpu.pct}% of GPU memory`);
    }
    const yielding = reasons.length > 0;
    const prev = this.state.yielding;
    this.state = { yielding, reason: yielding ? reasons.join('; ') : null, since: yielding ? (prev ? this.state.since : Date.now()) : null, others: { cpuPct: Math.round(otherCpu), gpu }, own: { cpuPct: Math.round(ownCpu), memBytes: ownMem, processes: own.size }, mem: { free, total }, at: Date.now(), level: s.level, enabled: s.yield };
    if (prev !== yielding) this.emit('change', this.state);
    await this.applyAll(extraOwnPids);
    return this.state;
  }
  // Is background work allowed to start right now?
  blocked(priority) { return this.state.yielding && priority > 0; }
}

module.exports = { Priority, NICE };
