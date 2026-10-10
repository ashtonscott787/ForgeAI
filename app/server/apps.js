'use strict';
// Finds and starts the model apps on this computer (Ollama, LM Studio) so models can be used without opening them by hand.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');

const run = (cmd, args, ms = 30000) => new Promise((ok) => execFile(cmd, args, { timeout: ms, windowsHide: true }, (e, so, se) => ok({ ok: !e, out: String(so || ''), err: String(se || (e && e.message) || '') })));
const portOpen = (port, host = '127.0.0.1', ms = 500) => new Promise((ok) => { const s = net.connect({ host, port, timeout: ms }, () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); s.on('timeout', () => { s.destroy(); ok(false); }); });
const first = (list) => list.find((p) => p && fs.existsSync(p)) || null;
const home = os.homedir();

function ollamaApp() {
  if (process.platform === 'darwin') return first(['/Applications/Ollama.app', path.join(home, 'Applications/Ollama.app')]);
  if (process.platform === 'win32') return first([path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe')]);
  return first(['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama']);
}
function lmsCli() {
  return first(process.platform === 'win32'
    ? [path.join(home, '.lmstudio', 'bin', 'lms.exe'), path.join(home, '.cache', 'lm-studio', 'bin', 'lms.exe')]
    : [path.join(home, '.lmstudio', 'bin', 'lms'), path.join(home, '.cache', 'lm-studio', 'bin', 'lms'), '/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms', path.join(home, 'Applications/LM Studio.app/Contents/Resources/app/.webpack/lms')]);
}
function lmStudioApp() {
  if (process.platform === 'darwin') return first(['/Applications/LM Studio.app', path.join(home, 'Applications/LM Studio.app')]);
  if (process.platform === 'win32') return first([path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'lm-studio', 'LM Studio.exe')]);
  return null;
}

async function waitPort(port, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 500)); } return false; }

// Start Ollama if it is installed but not running.
async function startOllama() {
  if (await portOpen(11434)) return { ok: true, already: true };
  const app = ollamaApp(); if (!app) throw new Error('Ollama is not installed on this computer. Next: use the ForgeAI Engine (no other apps needed), or install Ollama from Models → Engines.');
  if (process.platform === 'darwin') await run('open', ['-g', '-a', app]);
  else if (process.platform === 'win32') spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(app, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  if (!(await waitPort(11434, 45000))) throw new Error('Ollama was started but is not answering on port 11434 yet. Next: open Ollama yourself, then try again.');
  return { ok: true, started: true };
}
// Start LM Studio's local server (uses its "lms" command, which ships with LM Studio).
async function startLmStudio(port = 1234) {
  if (await portOpen(port)) return { ok: true, already: true };
  const cli = lmsCli();
  if (cli) { const r = await run(cli, ['server', 'start'], 60000); if (await waitPort(port, 30000)) return { ok: true, started: true }; throw new Error(`LM Studio's server did not start: ${(r.err || r.out).trim().split('\n').pop() || 'no answer on port ' + port}. Next: open LM Studio → Developer → Start Server.`); }
  const app = lmStudioApp();
  if (!app) throw new Error('LM Studio is not installed on this computer.');
  if (process.platform === 'darwin') await run('open', ['-g', '-a', app]); else spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
  if (await waitPort(port, 45000)) return { ok: true, started: true };
  throw new Error('LM Studio opened, but its server is off. Next: in LM Studio go to Developer and turn on “Start Server” (or “Start on login”).');
}
// LM Link (LM Studio's own device-to-device link). LM Studio does not report in its API which device runs a model,
// so ForgeAI can only show the link status the "lms" command prints.
async function lmLinkStatus() {
  const cli = lmsCli(); if (!cli) return { available: false, reason: 'LM Studio’s “lms” command was not found on this computer.' };
  const r = await run(cli, ['link', 'status'], 15000);
  const text = (r.out || r.err).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!r.ok && /unknown command|not a command|Unknown/i.test(text)) return { available: false, reason: 'This LM Studio version has no LM Link. Update LM Studio to use it.' };
  return { available: true, ok: r.ok, enabled: r.ok && !/disabled|not enabled|off\b/i.test(text), text: text.slice(0, 2000) };
}
function apps() {
  return { ollama: { installed: !!ollamaApp(), path: ollamaApp() }, lmstudio: { installed: !!(lmStudioApp() || lmsCli()), path: lmStudioApp(), cli: lmsCli() } };
}

module.exports = { startOllama, startLmStudio, lmLinkStatus, apps, portOpen };
