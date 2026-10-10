'use strict';
// Desktop wrapper for macOS and Windows.
// Two modes, chosen on first launch (and changeable from the tray / app menu):
//   • Server — this computer runs ForgeAI (agents, models, data). Other computers can connect to it.
//   • Connect — this computer is only a window onto an ForgeAI server elsewhere on the network (Mac or Windows).
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, safeStorage, dialog, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
let core = null, win = null, tray = null, quitting = false;
let cfgFile, cfg = {};

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
if (IS_WIN) app.setAppUserModelId('local.forgeai.app');

const loadCfg = () => { try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { cfg = {}; } };
const saveCfg = () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const shellParam = () => (IS_MAC ? 'mac' : IS_WIN ? 'win' : 'desktop');
const brand = () => (core ? core.platformName() : cfg.serverName || 'ForgeAI');

// ---------------- background behaviour (menu-bar / tray icon, Dock, start at login)
// Default: an icon in the menu bar (Mac) or notification area (Windows); no Dock or taskbar entry while ForgeAI runs in
// the background with its window closed. Settings → This computer can hide the icon completely — open ForgeAI again
// (Launchpad, Applications, Start menu) to bring the window back.
const desktop = () => ({ showIcon: true, startAtLogin: false, startHidden: false, ...((core && core.store.getSetting('desktop', {})) || cfg.desktop || {}) });
function applyDesktop(n) {
  n = n || desktop(); cfg.desktop = n; saveCfg();
  try { app.setLoginItemSettings({ openAtLogin: !!n.startAtLogin, openAsHidden: true, args: ['--hidden'] }); } catch {}
  buildTray();
  syncDock();
}
function syncDock() { if (!IS_MAC || !app.dock) return; const visible = win && !win.isDestroyed() && win.isVisible(); if (visible) app.dock.show(); else app.dock.hide(); }
// Silent installs drop a setup.json (from the installer switches) next to the app or in a machine-wide folder.
function findSetup() {
  const c = [path.join(path.dirname(process.execPath), 'setup.json'), path.join(path.dirname(process.execPath), '..', 'Resources', 'setup.json'), path.join(app.getPath('userData'), 'setup.json'),
    IS_MAC ? '/Library/Application Support/ForgeAI/setup.json' : IS_WIN ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ForgeAI', 'setup.json') : '/etc/forgeai/setup.json'];
  for (const f of c) { try { if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const id = require('crypto').createHash('sha256').update(JSON.stringify(j)).digest('hex').slice(0, 16); if (cfg.setupApplied === id) return null; return { file: f, id, setup: j }; } } catch {} }
  return null;
}
require('./host').onDesktop = (n) => applyDesktop(n);

// ---------------- server mode
async function startServer() {
  if (core) return;
  const { createApp } = require('../server');
  const { safeStorageBackend } = require('../server/vault');
  const backend = safeStorage.isEncryptionAvailable() ? safeStorageBackend(safeStorage) : undefined;
  core = createApp({ dataDir: path.join(app.getPath('userData'), 'data'), vaultBackend: backend, version: app.getVersion(), host: require('./host').createHost() });
  await core.start();
  core.onRelisten = async () => { await setLocalCookie(); buildTray(); if (win && !win.isDestroyed()) win.loadURL(dashboardUrl()); };
  await setLocalCookie();
  if (core.priority) core.priority.on('change', () => { try { buildTray(); } catch {} });
}
async function setLocalCookie() {
  const token = core.localSession(); if (!token) return;
  const info = core.listenInfo;
  await session.defaultSession.cookies.set({ url: info.localUrl, name: core.COOKIE, value: token, httpOnly: true, sameSite: 'strict', secure: info.https, expirationDate: Math.floor(Date.now() / 1000) + 7 * 86400 });
}
function dashboardUrl() {
  const base = cfg.mode === 'client' ? cfg.url : core.listenInfo.localUrl;
  return `${base}/?app=${shellParam()}`;
}
const ownOrigin = () => (cfg.mode === 'client' ? new URL(cfg.url).origin : core && new URL(core.listenInfo.localUrl).origin);

// ---------------- connect mode helpers
// Reachability check that accepts ForgeAI's self-signed certificate and returns its fingerprint for pinning.
function probe(url) {
  return new Promise((resolve) => {
    let u; try { u = new URL('/api/state', url); } catch { return resolve({ ok: false, error: 'That address is not valid' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, agent: false, timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch {}
        if (!j || !('setupNeeded' in j)) return resolve({ ok: false, error: 'Something answered, but it is not ForgeAI' });
        const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
        resolve({ ok: true, name: j.platformName || 'ForgeAI', host: j.host, setupNeeded: j.setupNeeded, fingerprint: cert && cert.raw ? 'sha256/' + require('crypto').createHash('sha256').update(cert.raw).digest('base64') : null });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'No answer — check the address, that remote access is on, and the firewall' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'Connection refused — is remote access turned on at that computer?' : e.message }));
  });
}

// ---------------- windows
function winOptions(extra) {
  const o = {
    width: 1400, height: 900, minWidth: 940, minHeight: 620, title: brand(), show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
    ...extra,
  };
  if (IS_MAC) Object.assign(o, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' });
  if (IS_WIN) Object.assign(o, { titleBarStyle: 'hidden', titleBarOverlay: overlayColors(), backgroundMaterial: 'mica', icon: path.join(__dirname, 'icon.png') });
  return o;
}
function overlayColors() { const d = nativeTheme.shouldUseDarkColors; return { color: '#00000000', symbolColor: d ? '#f5f5f7' : '#1d1d1f', height: 44 }; }
nativeTheme.on('updated', () => { if (IS_WIN && win && !win.isDestroyed()) try { win.setTitleBarOverlay(overlayColors()); } catch {} });

let startHiddenOnce = false;
function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); syncDock(); return; }
  win = new BrowserWindow(winOptions());
  win.once('ready-to-show', () => { if (!startHiddenOnce) { win.show(); syncDock(); } startHiddenOnce = false; });
  win.on('show', syncDock); win.on('hide', syncDock);
  if (!cfg.mode) win.loadFile(path.join(__dirname, 'launcher.html'), { query: { os: shellParam() } });
  else win.loadURL(dashboardUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(ownOrigin() || '#')) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url.startsWith('file:')) return; const o = ownOrigin(); if (o && !url.startsWith(o)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (cfg.mode === 'client' && code !== -3) win.loadFile(path.join(__dirname, 'launcher.html'), { query: { os: shellParam(), error: `Could not reach ${cfg.serverName || url}: ${desc}` } });
  });
  win.on('close', (e) => { if (!quitting && cfg.mode === 'server') { e.preventDefault(); win.hide(); } });
  // Spellcheck suggestions and the usual edit actions on right-click (the prompt box can turn spellcheck off).
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    for (const w of (p.dictionarySuggestions || []).slice(0, 6)) items.push({ label: w, click: () => win.webContents.replaceMisspelling(w) });
    if (p.misspelledWord) { if (!items.length) items.push({ label: 'No suggestions', enabled: false }); items.push({ label: 'Add to Dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' }); }
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// Only accept a self-signed certificate for our own server, and (in connect mode) only the pinned one.
app.on('certificate-error', (event, _wc, url, _err, cert, cb) => {
  if (core && core.listenInfo && url.startsWith(core.listenInfo.localUrl)) { event.preventDefault(); return cb(true); }
  if (cfg.mode === 'client' && url.startsWith(new URL(cfg.url).origin) && cfg.fingerprint && cert.fingerprint === cfg.fingerprint) { event.preventDefault(); return cb(true); }
  cb(false);
});

function buildTray() {
  if (cfg.mode !== 'server' || !desktop().showIcon) { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) {
    const img = IS_MAC ? nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png')) : nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    if (IS_MAC) img.setTemplateImage(true);
    tray = new Tray(img); tray.setToolTip(brand());
    tray.on('click', () => { if (IS_WIN) showWindow(); }); tray.on('double-click', showWindow);
  }
  const info = core.listenInfo;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ' + brand(), click: showWindow },
    { type: 'separator' },
    { label: info.remote ? 'Network access: on' : 'Network access: this computer only', enabled: false },
    { label: `Port ${info.port}${info.https ? ' · HTTPS' : ''}`, enabled: false },
    { type: 'separator' },
    { label: core.priority && core.priority.state.yielding ? 'Paused for your apps: ' + core.priority.state.reason : 'Running in the background (' + ({ low: 'low', lowest: 'lowest', normal: 'normal' }[(core.priority && core.priority.settings().level) || 'low']) + ' priority)', enabled: false },
    { type: 'separator' },
    { label: 'Start when I log in', type: 'checkbox', checked: !!desktop().startAtLogin, click: (i) => { const n = { ...desktop(), startAtLogin: i.checked }; core.store.setSetting('desktop', n); applyDesktop(n); } },
    { label: 'Hide this icon', click: async () => { const r = await dialog.showMessageBox({ type: 'info', buttons: ['Hide icon', 'Cancel'], defaultId: 0, cancelId: 1, message: 'Hide the ForgeAI icon?', detail: 'ForgeAI keeps running in the background. To open it again, open ForgeAI from Applications / the Start menu. You can bring the icon back in Settings → This computer.' }); if (r.response === 0) { const n = { ...desktop(), showIcon: false }; core.store.setSetting('desktop', n); applyDesktop(n); } } },
    { label: 'Show data folder', click: () => shell.openPath(core.dataDir) },
    { label: 'Connect to another ForgeAI instead…', click: switchToLauncher },
    { type: 'separator' },
    { label: `Quit ${brand()} (stops agents)`, click: () => { quitting = true; app.quit(); } },
  ]));
}
function switchToLauncher() {
  cfg = { ...cfg, mode: null }; saveCfg();
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'launcher.html'), { query: { os: shellParam(), switching: '1' } });
  else showWindow();
}
function buildMenu() {
  const extra = { label: 'Connection', submenu: [
    { label: 'Connect to another ForgeAI…', click: switchToLauncher },
    ...(cfg.mode === 'client' ? [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(dashboardUrl()) }] : []),
  ] };
  const help = { role: 'help', submenu: [
    { label: 'Download Ollama (free local models)', click: () => shell.openExternal('https://ollama.com/download') },
    { label: 'Download Tailscale (access from anywhere)', click: () => shell.openExternal('https://tailscale.com/download') },
  ] };
  Menu.setApplicationMenu(Menu.buildFromTemplate(IS_MAC
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, extra, { role: 'windowMenu' }, help]
    : [{ label: 'File', submenu: [{ label: 'Quit', click: () => { quitting = true; app.quit(); } }] }, { role: 'editMenu' }, { role: 'viewMenu' }, extra, help]));
  if (IS_WIN && win && !win.isDestroyed()) win.setMenuBarVisibility(false);
}

// ---------------- launcher IPC (first-run choice screen)
ipcMain.handle('aicore:discover', async () => { const { scan } = require('../server/discovery'); return scan(1800, core ? core.instanceId : null); });
ipcMain.handle('aicore:probe', (_e, url) => probe(url));
ipcMain.handle('aicore:runServer', async () => {
  cfg = { mode: 'server' }; saveCfg();
  await startServer(); buildTray(); buildMenu();
  win.loadURL(dashboardUrl());
  return true;
});
ipcMain.handle('aicore:connect', async (_e, url) => {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  if (!/:\d+$/.test(new URL(url).host)) url += ':4545';
  const p = await probe(url);
  if (!p.ok) return p;
  cfg = { mode: 'client', url, fingerprint: p.fingerprint, serverName: p.name, serverHost: p.host }; saveCfg();
  if (core) { core.stop(); core = null; buildTray(); }
  buildMenu();
  win.setTitle(p.name);
  win.loadURL(dashboardUrl());
  return { ok: true };
});
// Folder picker for granting folders — only for this computer's own ForgeAI dashboard.
ipcMain.handle('forge:pickFolder', async (e) => {
  const from = e.senderFrame && e.senderFrame.url;
  if (!core || !from || !from.startsWith(core.listenInfo.localUrl)) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder to share with an organisation' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('forge:reveal', async (e, p) => {
  const from = e.senderFrame && e.senderFrame.url;
  if (!core || !from || !from.startsWith(core.listenInfo.localUrl) || !p || !fs.existsSync(p)) return false;
  shell.showItemInFolder(p); return true;
});
ipcMain.handle('aicore:info', () => ({ os: process.platform, mode: cfg.mode || null, previous: cfg.url || null, version: app.getVersion() }));

app.whenReady().then(async () => {
  try {
    cfgFile = path.join(app.getPath('userData'), 'mode.json');
    loadCfg();
    // Existing installs from v1 (data folder present, no mode file) keep running as a server.
    if (!cfg.mode && fs.existsSync(path.join(app.getPath('userData'), 'data', 'platform.sqlite'))) { cfg = { mode: 'server' }; saveCfg(); }
    const setup = findSetup();
    if (setup && !cfg.mode) { cfg.mode = 'server'; saveCfg(); }
    if (cfg.mode === 'server') await startServer();
    if (setup && core) { try { await core.applySetup(setup.setup); cfg.setupApplied = setup.id; saveCfg(); } catch (e) { console.error('setup.json', e.message); } }
    const launchedHidden = process.argv.includes('--hidden') || (app.getLoginItemSettings().wasOpenedAsHidden) || (cfg.mode === 'server' && desktop().startHidden) || (setup && setup.setup.silent);
    buildMenu(); if (cfg.mode === 'server') applyDesktop(desktop());
    if (launchedHidden && cfg.mode === 'server') { startHiddenOnce = true; showWindow(); syncDock(); } else showWindow();
  } catch (e) {
    dialog.showErrorBox('ForgeAI could not start', String((e && e.stack) || e));
    app.exit(1);
  }
});
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; app.isQuitting = true; if (core) core.stop(); });
app.on('window-all-closed', () => { if (cfg.mode !== 'server') app.quit(); });
