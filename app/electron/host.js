'use strict';
// Desktop capabilities offered to the ForgeAI server: an agent browser (one per agent, with its own logins),
// PDF rendering, notifications and opening links. Only used by the Mac/Windows app.
const { BrowserWindow, Notification, shell, app, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-fai-ref]').forEach((e) => e.removeAttribute('data-fai-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],summary,[onclick]';
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const els = [...document.querySelectorAll(sel)].filter(vis);
  const inView = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  els.sort((a, b) => (inView(b) - inView(a)));
  const out = []; let n = 0;
  for (const e of els.slice(0, 220)) {
    n++; e.setAttribute('data-fai-ref', String(n));
    const tag = e.tagName.toLowerCase(); const type = (e.getAttribute('type') || e.getAttribute('role') || '').toLowerCase();
    let label = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') || (e.querySelector('img') && e.querySelector('img').alt) || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    if (type === 'password') label = (e.getAttribute('placeholder') || 'password') + ' (password field)';
    const extra = tag === 'a' ? ' → ' + (e.getAttribute('href') || '').slice(0, 80) : (tag === 'input' || tag === 'textarea') && e.value && type !== 'password' ? ' = "' + String(e.value).slice(0, 40) + '"' : tag === 'select' ? ' = "' + (e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : '') + '"' : e.checked ? ' [checked]' : '';
    out.push('[' + n + '] ' + (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (type || 'text') : tag) + ' "' + label + '"' + extra + (inView(e) ? '' : ' (below)'));
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 7000);
  return { title: document.title, url: location.href, text, elements: out.join('\\n'), scroll: Math.round(scrollY) + '/' + Math.round(document.documentElement.scrollHeight) };
})()`;

const KEYMAP = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', arrowdown: 'Down', arrowup: 'Up', arrowleft: 'Left', arrowright: 'Right', down: 'Down', up: 'Up', left: 'Left', right: 'Right', pagedown: 'PageDown', pageup: 'PageUp', home: 'Home', end: 'End', space: 'Space' };

class AgentBrowser {
  constructor(key, label) {
    const part = 'persist:agent-' + key.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.win = new BrowserWindow({ show: false, width: 1280, height: 860, title: `${label || 'Agent'} — ForgeAI browser`, backgroundColor: '#ffffff', webPreferences: { partition: part, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    this.wc = this.win.webContents;
    this.wc.setWindowOpenHandler(({ url }) => { this.wc.loadURL(url); return { action: 'deny' }; });
    this.win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); this.win.hide(); } });
    this.wc.session.on('will-download', (_e, item) => { item.setSavePath(path.join(app.getPath('downloads'), item.getFilename())); });
  }
  async settle(ms = 900) { await new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 20 && this.wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 250)); }
  async open(url) {
    url = String(url || '').trim(); if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    if (!/^https?:/i.test(url)) throw new Error('Only web addresses (http/https) can be opened');
    try { await Promise.race([this.wc.loadURL(url), new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), 30000))]); } catch (e) { if (!/ERR_ABORTED|timeout/.test(e.message)) return 'Could not open the page: ' + e.message; }
    await this.settle(); return this.read();
  }
  async snap() { return this.wc.executeJavaScript(SNAPSHOT, true); }
  async read() {
    const s = await this.snap();
    return `Page: ${s.title}\nURL: ${s.url}\nScroll: ${s.scroll}\n\n--- Page text ---\n${s.text}\n\n--- Things you can use (numbers for browser_click / browser_type) ---\n${s.elements || '(none)'}`;
  }
  async describe(ref) { return this.wc.executeJavaScript(`(() => { const e = document.querySelector('[data-fai-ref="${Number(ref)}"]'); if (!e) return ''; return (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || e.getAttribute('placeholder') || '').replace(/\\s+/g,' ').trim().slice(0,120) + ' ' + (e.closest('form') ? (e.closest('form').getAttribute('action') || '') : ''); })()`, true); }
  async center(ref) {
    const r = await this.wc.executeJavaScript(`(() => { const e = document.querySelector('[data-fai-ref="${Number(ref)}"]'); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`, true);
    if (!r) throw new Error(`Element ${ref} not found — use browser_read to refresh the numbers.`);
    await new Promise((res) => setTimeout(res, 150)); return r;
  }
  mouse(x, y) { for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) this.wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); }
  async click(ref) { const p = await this.center(ref); this.mouse(p.x, p.y); await this.settle(1200); return 'Clicked. ' + (await this.read()); }
  async clickAt(x, y) { const [w] = this.win.getContentSize(); const f = w / (this.lastShotWidth || w); this.mouse(Math.round(x * f), Math.round(y * f)); await this.settle(600); }
  async type(ref, text, submit) {
    const p = await this.center(ref); this.mouse(p.x, p.y); await new Promise((r) => setTimeout(r, 150));
    this.wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await this.wc.insertText(String(text));
    if (submit) await this.press('Enter');
    await this.settle(submit ? 1500 : 300);
    return 'Typed. ' + (submit ? await this.read() : '');
  }
  async insert(text) { await this.wc.insertText(text); }
  async press(key) {
    const k = KEYMAP[String(key).toLowerCase()] || String(key);
    this.wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    if (k === 'Enter') this.wc.sendInputEvent({ type: 'char', keyCode: '\r' }); else if (k.length === 1) this.wc.sendInputEvent({ type: 'char', keyCode: k });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    await this.settle(700); return `Pressed ${k}.`;
  }
  async scroll(dir) { await this.wc.executeJavaScript(`window.scrollBy(0, ${dir === 'up' ? -1 : 1} * innerHeight * 0.8)`); await new Promise((r) => setTimeout(r, 300)); return 'Scrolled ' + dir + '. ' + (await this.read()); }
  async back() { if (this.wc.navigationHistory ? this.wc.navigationHistory.canGoBack() : this.wc.canGoBack()) { this.wc.navigationHistory ? this.wc.navigationHistory.goBack() : this.wc.goBack(); await this.settle(); } return this.read(); }
  async screenshot(width = 1024) {
    const img = await this.wc.capturePage(); const s = img.getSize(); const out = s.width > width ? img.resize({ width }) : img;
    this.lastShotWidth = out.getSize().width;
    return { mime: 'image/jpeg', b64: out.toJPEG(72).toString('base64') };
  }
  async pdf() { return this.wc.printToPDF({ printBackground: true }); }
  async info() { const u = this.wc.getURL(); let host = ''; try { host = new URL(u).host; } catch {} return { url: u, title: this.wc.getTitle(), host }; }
  show() { this.win.show(); this.win.focus(); }
  async clearData() { await this.wc.session.clearStorageData(); await this.wc.session.clearCache(); }
}

function createHost() {
  const browsers = new Map();
  return {
    browser(key, opts = {}) {
      if (!browsers.has(key)) { if (opts.create === false) return null; browsers.set(key, new AgentBrowser(key, opts.label)); }
      return browsers.get(key);
    },
    async htmlToPdf(html) {
      const tmp = path.join(os.tmpdir(), `forgeai-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(tmp, html);
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
      try { await w.loadFile(tmp); return await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } }); }
      finally { w.destroy(); fs.rm(tmp, () => {}); }
    },
    notify(title, body) { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); },
    openExternal(url) { if (/^https?:\/\//.test(url)) shell.openExternal(url); },
    appPids() { try { return app.getAppMetrics().map((m) => m.pid); } catch { return []; } },
    applyDesktop(n) { if (module.exports.onDesktop) module.exports.onDesktop(n); },
    idleSeconds() { try { return powerMonitor.getSystemIdleTime(); } catch { return null; } },
    onBattery() { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } },
  };
}

module.exports = { createHost };
