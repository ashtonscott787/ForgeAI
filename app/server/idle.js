'use strict';
// Lend-when-idle: is anyone using this computer right now? Other ForgeAI computers only send work here while nobody is.
// Idle time comes from the OS (seconds since the last key press / mouse move); the desktop app reports it through
// Electron, servers through ioreg (macOS), GetLastInputInfo (Windows) or xprintidle (Linux desktops; headless Linux has
// no user input at all, so it counts as idle). Battery and CPU load are extra guards so a laptop is never drained and a
// busy machine never slowed down further.
const { execFile } = require('child_process'); const fs = require('fs'); const os = require('os');
const sh = (c, a, ms = 4000) => new Promise((ok) => execFile(c, a, { timeout: ms, windowsHide: true }, (e, out) => ok(e ? '' : String(out || ''))));

async function idleSeconds(host) {
  if (process.env.FORGEAI_FAKE_IDLE) return +process.env.FORGEAI_FAKE_IDLE; // tests only
  if (host && host.idleSeconds) { try { const v = host.idleSeconds(); if (v != null) return v; } catch {} }
  if (process.platform === 'darwin') { const o = await sh('ioreg', ['-c', 'IOHIDSystem', '-d', '4']); const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(o); return m ? Math.round(+m[1] / 1e9) : null; }
  if (process.platform === 'win32') { const o = await sh('powershell', ['-NoProfile', '-Command', 'Add-Type @"\nusing System;using System.Runtime.InteropServices;public class I{[StructLayout(LayoutKind.Sequential)]public struct L{public uint s;public uint t;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L l);public static uint Idle(){L l=new L();l.s=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return ((uint)Environment.TickCount-l.t)/1000;}}\n"@; [I]::Idle()'], 8000); const m = /(\d+)/.exec(o); return m ? +m[1] : null; }
  if (process.platform === 'linux') { if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Infinity; const o = await sh('xprintidle', []); const m = /(\d+)/.exec(o); return m ? Math.round(+m[1] / 1000) : null; }
  return null;
}
async function onBattery(host) {
  if (host && host.onBattery) { try { return !!host.onBattery(); } catch {} }
  if (process.platform === 'darwin') { const o = await sh('pmset', ['-g', 'batt']); return /Battery Power/i.test(o); }
  if (process.platform === 'linux') { try { for (const d of fs.readdirSync('/sys/class/power_supply')) { const t = fs.readFileSync(`/sys/class/power_supply/${d}/status`, 'utf8'); if (/Discharging/i.test(t)) return true; } } catch {} return false; }
  if (process.platform === 'win32') { const o = await sh('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery).BatteryStatus']); return /^\s*1\s*$/m.test(o); }
  return false;
}

class Lender {
  constructor({ store, perf, host, inflight }) { this.store = store; this.perf = perf; this.host = host; this.inflight = inflight || (() => 0); this.last = { available: true, reason: 'always', at: 0 }; }
  settings() { return { mode: 'always', idleMinutes: 10, maxCpu: 60, notOnBattery: true, ...this.store.getSetting('lend', {}) }; }
  save(s) { const cur = this.settings(); const n = { mode: ['always', 'idle', 'never'].includes(s.mode) ? s.mode : cur.mode, idleMinutes: s.idleMinutes == null ? cur.idleMinutes : Math.max(1, Math.min(720, +s.idleMinutes || 1)), maxCpu: s.maxCpu == null ? cur.maxCpu : Math.max(10, Math.min(100, +s.maxCpu || 60)), notOnBattery: s.notOnBattery == null ? cur.notOnBattery : !!s.notOnBattery }; this.store.setSetting('lend', n); return n; }
  // Sampled every few seconds; cheap to read anywhere.
  async sample() {
    const s = this.settings(); const m = this.perf && this.perf.machine || {};
    const out = { mode: s.mode, at: Date.now(), idleSec: null, cpuPct: m.cpuPct ?? null, onBattery: null, available: true, reason: 'always' };
    if (s.mode === 'never') { out.available = false; out.reason = 'not lent (Settings on that computer)'; this.last = out; return out; }
    const y = this.yieldState ? this.yieldState() : null; // your own apps always come first, whatever the lending mode
    if (y && y.yielding) { out.available = false; out.reason = 'its owner\'s apps need it right now (' + y.reason + ')'; this.last = out; return out; }
    if (s.mode === 'always') { this.last = out; return out; }
    out.idleSec = await idleSeconds(this.host); out.onBattery = s.notOnBattery ? await onBattery(this.host) : false;
    const busyNow = this.inflight() > 0; // our own lent work raises the CPU — don't count that as "someone is using it"
    if (out.onBattery) { out.available = false; out.reason = 'on battery'; }
    else if (out.idleSec != null && out.idleSec < s.idleMinutes * 60) { out.available = false; out.reason = out.idleSec < 120 ? 'someone is using it' : `used ${Math.round(out.idleSec / 60)} min ago (lent after ${s.idleMinutes} min idle)`; }
    else if (out.cpuPct != null && out.cpuPct > s.maxCpu && !busyNow) { out.available = false; out.reason = `busy (${out.cpuPct}% CPU)`; }
    else if (out.idleSec == null) { out.available = true; out.reason = 'idle time unknown on this system — lent'; }
    else { out.available = true; out.reason = out.idleSec === Infinity ? 'headless server' : `idle ${Math.round(out.idleSec / 60)} min`; }
    this.last = out; return out;
  }
}

module.exports = { Lender, idleSeconds, onBattery };
