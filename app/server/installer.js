'use strict';
// Installs Ollama (the free local-model runtime) from ollama.com without the Terminal.
// macOS: download Ollama.dmg → mount → copy Ollama.app to /Applications (or ~/Applications) → open it.
// Windows: download OllamaSetup.exe → run the official installer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const URLS = { darwin: 'https://ollama.com/download/Ollama.dmg', win32: 'https://ollama.com/download/OllamaSetup.exe' };
const run = (cmd, args) => new Promise((ok, bad) => execFile(cmd, args, { timeout: 180000 }, (e, so, se) => (e ? bad(new Error((se || e.message).toString().trim())) : ok(String(so)))));

function installedPath() {
  if (process.platform === 'darwin') return ['/Applications/Ollama.app', path.join(os.homedir(), 'Applications/Ollama.app')].find((p) => fs.existsSync(p)) || null;
  if (process.platform === 'win32') { const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe'); return fs.existsSync(p) ? p : null; }
  return null;
}

async function download(url, dest, onProgress, signal) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0; let done = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) { done += chunk.length; if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); onProgress({ status: 'Downloading Ollama', completed: done, total }); }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (done < 1e6) throw new Error('Download looks incomplete');
}

async function installOllama(onProgress = () => {}, signal) {
  const url = URLS[process.platform];
  if (!url) throw new Error('Automatic install is available on macOS and Windows. On Linux see ollama.com/download.');
  const existing = installedPath();
  if (existing) {
    onProgress({ status: 'Ollama is already installed — starting it' });
    if (process.platform === 'darwin') await run('open', ['-a', existing]); else spawn(existing, [], { detached: true, stdio: 'ignore' }).unref();
    return { started: true, path: existing };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeai-ollama-'));
  const file = path.join(tmp, path.basename(url));
  await download(url, file, onProgress, signal);
  if (process.platform === 'darwin') {
    const mnt = path.join(tmp, 'mnt'); fs.mkdirSync(mnt);
    onProgress({ status: 'Opening the installer' });
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, file]);
    let dest;
    try {
      const appSrc = path.join(mnt, 'Ollama.app'); if (!fs.existsSync(appSrc)) throw new Error('Ollama.app not found in the download');
      onProgress({ status: 'Copying Ollama to Applications' });
      try { dest = '/Applications/Ollama.app'; await run('ditto', [appSrc, dest]); }
      catch { dest = path.join(os.homedir(), 'Applications', 'Ollama.app'); fs.mkdirSync(path.dirname(dest), { recursive: true }); await run('ditto', [appSrc, dest]); }
    } finally { await run('hdiutil', ['detach', mnt, '-quiet']).catch(() => {}); }
    onProgress({ status: 'Starting Ollama' });
    await run('open', ['-a', dest]);
    fs.rm(tmp, { recursive: true, force: true }, () => {});
    return { installed: true, path: dest };
  }
  // Windows: the official installer (per-user, no admin). It starts Ollama when finished.
  onProgress({ status: 'Running the Ollama installer — follow the window that opens' });
  await new Promise((ok, bad) => { const p = spawn(file, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' }); p.on('error', bad); p.on('exit', (c) => (c === 0 ? ok() : bad(new Error('The installer exited with code ' + c)))); });
  const p = installedPath(); if (p) spawn(p, [], { detached: true, stdio: 'ignore' }).unref();
  return { installed: true, path: p };
}

module.exports = { installOllama, installedPath };
