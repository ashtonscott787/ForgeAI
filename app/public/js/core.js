'use strict';
/* Shared UI helpers: DOM builder, API client, streaming, modal, toast, markdown, formatting. */
// append() ignores null/false so optional pieces never render as the text "null".
(() => { for (const P of [Element.prototype, DocumentFragment.prototype]) { const o = P.append; P.append = function (...a) { return o.apply(this, a.filter((x) => x != null && x !== false)); }; } })();
const APP_SHELL = (/[?&]app=(mac|win|desktop)/.exec(location.search) || [])[1] || null;
const S = { me: null, org: null, orgs: [], counts: {}, shell: APP_SHELL, platformName: 'ForgeAI' };

function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with md() output, which escapes input
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

// ---------- icons (original line icons, 24×24, drawn with currentColor)
const gearPath = (() => { const pts = []; const n = 8; for (let i = 0; i < n * 2; i++) { const a = (Math.PI * i) / n - Math.PI / 2; const r = i % 2 ? 7 : 9.2; const w = Math.PI / n * 0.42; pts.push([12 + r * Math.cos(a - w), 12 + r * Math.sin(a - w)], [12 + r * Math.cos(a + w), 12 + r * Math.sin(a + w)]); } return 'M' + pts.map((p) => p.map((v) => v.toFixed(2)).join(' ')).join('L') + 'Z'; })();
const ICONS = {
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5.5l-3 13"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9v5.5H5.5A1.5 1.5 0 0 1 4 19z"/>',
  gauge: '<path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="M12 13l3.5-4"/><circle cx="12" cy="13.5" r="1.2"/>',
  send: '<path d="M4 12l16-7.5-5.5 16-3-6.5z"/><path d="M11.5 14l3.5-3.5"/>',
  reply: '<path d="M10 6.5L4.5 12l5.5 5.5"/><path d="M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19"/>',
  inbox: '<path d="M4 13.5l2.2-7A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.5l2.2 7V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  sparkles: '<path d="M11 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  chat: '<path d="M20 12c0 4.1-3.6 7.3-8 7.3-1.2 0-2.3-.2-3.3-.6L4 20l1.2-3.7C4.4 15.1 4 13.6 4 12c0-4.1 3.6-7.3 8-7.3s8 3.2 8 7.3z"/>',
  agent: '<rect x="4.5" y="7.5" width="15" height="12" rx="3.5"/><path d="M12 4.5v3M9.5 16h5"/><circle cx="12" cy="3.8" r="0.9"/><circle cx="9.3" cy="12.5" r="1.1"/><circle cx="14.7" cy="12.5" r="1.1"/>',
  tasks: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.8 6.5l1.4 1.4 2.4-2.6M3.8 12l1.4 1.4 2.4-2.6M3.8 17.5l1.4 1.4 2.4-2.6"/>',
  approve: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.5 2.5 5-5.2"/>',
  book: '<path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 0 2 1h12v-3"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="12" width="3" height="6" rx="1"/><rect x="10.5" y="7" width="3" height="11" rx="1"/><rect x="15.5" y="10" width="3" height="8" rx="1"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.2 2.2M13.8 9.2l1.6 1.6"/>',
  gear: '<path d="' + gearPath + '"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  clip: '<path d="M20 11.3l-7.9 7.9a5 5 0 0 1-7.1-7.1l8.2-8.2a3.4 3.4 0 0 1 4.9 4.9l-8.1 8.1a1.8 1.8 0 0 1-2.6-2.6l7.3-7.3"/>',
  up: '<path d="M12 19V5M6.5 10.5L12 5l5.5 5.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/>',
  edit: '<path d="M4 20h4.2L19.3 8.9a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z"/><path d="M13.5 6.5l4 4"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3"/>',
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.2h8A1.5 1.5 0 0 1 20.5 9.2v9.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  right: '<path d="M9.5 6l6 6-6 6"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c1.3-3.6 4.2-5.5 7.5-5.5s6.2 1.9 7.5 5.5"/>',
  users: '<circle cx="9" cy="9" r="3.3"/><path d="M3 19.5c1-3 3.3-4.5 6-4.5s5 1.5 6 4.5"/><path d="M15.5 5.8a3.2 3.2 0 0 1 0 6.3M17.5 15.3c1.7.6 2.9 2 3.5 4.2"/>',
  building: '<path d="M4.5 20.5V5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15M15.5 9.5h2a2 2 0 0 1 2 2v9M3 20.5h18M8.5 7.5h3M8.5 11.5h3M8.5 15.5h3"/>',
  bolt: '<path d="M13 3L5 13.5h6.2L10.5 21l8-10.5h-6.2z"/>',
  shield: '<path d="M12 3l7 3v5.2c0 4.7-3 8.3-7 9.8-4-1.5-7-5.1-7-9.8V6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  network: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.3" r="0.9" fill="currentColor"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.8"/><path d="M2.5 19h19"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  warn: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.2M12 16.9h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  doc: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.4 10.9c.6.5.9 1.1.9 1.8V16h5v-.3c0-.7.3-1.3.9-1.8A6 6 0 0 0 12 3z"/>',
  logout: '<path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5M10 16.5L14.5 12 10 7.5M14.5 12H3.5"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
  wand: '<path d="M4 20L15 9M13 7l4 4"/><path d="M18 3.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6zM8 3.5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>',
  pause: '<rect x="7" y="5.5" width="3.2" height="13" rx="1"/><rect x="13.8" y="5.5" width="3.2" height="13" rx="1"/>',
};
function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ic ' + cls); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.info;
  return svg;
}
function initials(name) { const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/); return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : (w[0] || '')[1] || '')).toUpperCase(); }
function monogram(org, cls = '') {
  const c = (org && org.color) || '#0071e3';
  const el = h('div.monogram' + (cls ? '.' + cls : ''), { style: { background: `linear-gradient(145deg, color-mix(in srgb, ${c} 78%, #fff), ${c} 55%, color-mix(in srgb, ${c} 80%, #000))` } });
  if (org && org.logo) el.append(h('img', { src: org.logo, alt: '' })); else el.textContent = initials(org && org.name);
  return el;
}
function emptyState(ic, title, text, action) { return h('div.card.empty', null, h('div.big', null, icon(ic)), h('h2', null, title), text ? h('div', null, text) : null, action ? h('div', { style: { marginTop: '16px' } }, action) : null); }
function note(kind, ...kids) { return h('div.note' + (kind ? '.' + kind : ''), null, icon(kind === 'warn' ? 'warn' : 'info'), h('div', null, ...kids)); }
const $ = (s, r = document) => r.querySelector(s);
const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { 'x-aicore': '1' }, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 && !opts.noAuthRedirect) { location.hash = '#/login'; throw new Error('Please sign in'); }
  if (!r.ok) throw new Error((j && j.error) || `Request failed (${r.status})`);
  return j;
}
const orgApi = (p, opts) => api(`/api/orgs/${S.org.id}${p}`, opts);

// POST and read a server-sent-events stream. handlers: { eventName: fn(data) }
async function stream(path, body, handlers, signal) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicore': '1' }, body: JSON.stringify(body), signal });
  if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} throw new Error(j.error || `Request failed (${r.status})`); }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const line of block.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
      if (data && handlers[ev]) handlers[ev](JSON.parse(data));
    }
  }
}

function toast(msg, bad) {
  const t = h('div.toast' + (bad ? '.bad' : ''), null, icon(bad ? 'warn' : 'check', 'sm'), msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

function modal(title, body, actions = [], opts = {}) {
  const root = $('#modal-root');
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const foot = actions.length ? h('div.mf', null, actions.map((a) => h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), { onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await a.onClick(close); if (r !== false) close(); } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
  } }, a.label))) : null;
  const bg = h('div.modal-bg', { onmousedown: (e) => { if (e.target === bg) close(); } },
    h('div.modal' + (opts.wide ? '.wide' : ''), null, h('div.mh', null, h('h2', null, title), h('button.btn.ghost.sm.icon', { onclick: close, title: 'Close' }, icon('x'))), h('div.mb', null, body), foot));
  document.addEventListener('keydown', esc);
  root.append(bg);
  const f = bg.querySelector('input,textarea,select'); if (f) setTimeout(() => f.focus(), 30);
  return close;
}
function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((res) => modal(title, h('p', null, text), [{ label: 'Cancel', onClick: () => res(false) }, { label: okLabel, primary: !danger, danger, onClick: () => res(true) }]));
}

// form helpers
const field = (label, input, help) => h('div.field', null, h('label.f', null, label), input, help ? h('div.help', null, help) : null);
const sel = (options, value, attrs = {}) => h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const toggle = (checked, onchange, attrs = {}) => h('label.switch', attrs, h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onchange(e.target.checked) }), h('span'));
const checkRow = (label, checked, onchange, help) => h('label.check', null, h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onchange(e.target.checked) }), h('div', null, h('div', null, label), help ? h('div.help', null, help) : null));

// formatting
const money = (n) => '$' + (n || 0).toFixed((n || 0) < 10 ? 2 : 0);
const num = (n) => (n || 0).toLocaleString();
const bytes = (b) => !b ? '—' : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : b >= 2 ** 20 ? (b / 2 ** 20).toFixed(0) + ' MB' : (b / 1024).toFixed(0) + ' KB';
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 0) { const f = -s; return 'in ' + (f < 3600 ? Math.round(f / 60) + 'm' : f < 86400 ? Math.round(f / 3600) + 'h' : Math.round(f / 86400) + 'd'); }
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
const statusBadge = (s) => h('span.badge.' + ({ done: 'ok', approved: 'ok', connected: 'ok', partial: 'warn', online: 'ok', Healthy: 'ok', running: 'info', queued: 'info', pending: 'warn', awaiting_approval: 'warn', checking: 'info', Attention: 'warn', failed: 'bad', rejected: 'bad', error: 'bad', offline: 'bad' }[s] || 'x'), null, h('span.dot'), String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
const ROLE_NAMES = { org_owner: 'Organisation owner', org_admin: 'Organisation admin', manager: 'Manager', user: 'User', read_only: 'Read only' };
const MODE_NAMES = { auto: 'Auto', fastest: 'Fastest', best_quality: 'Best quality', best_local: 'Best local', best_coding: 'Best coding', best_reasoning: 'Best reasoning', best_vision: 'Best vision', cheapest: 'Cheapest', private: 'Private (local only)', local_fast: 'Local fast', local_powerful: 'Local powerful', cloud: 'Cloud (best)', openai: 'OpenAI', claude: 'Claude', google: 'Google', other: 'Other…' };
const SENS_NAMES = { normal: 'Normal', confidential: 'Confidential', finance: 'Finance', research: 'Research' };

// Minimal, safe markdown: input is HTML-escaped first; only our own tags are produced.
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  const ph = []; const keep = (x) => { ph.push(x); return `\u0000${ph.length - 1}\u0000`; };
  const a = (u, t) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return s
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => a(u, t))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + a(u, u))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => ph[+i]);
}
function md(src) {
  const lines = esc(src || '').split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const lang = (/^```\s*([\w-]+)/.exec(l) || [])[1] || ''; const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push(`<pre data-lang="${lang.toLowerCase()}"><code>${code.join('\n')}</code></pre>`); continue; }
    if (/^#{1,4}\s/.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n + 1}>${inline(l.replace(/^#+\s/, ''))}</h${n + 1}>`); i++; continue; }
    if (/^\s*([-*•]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>`);
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    if (/^&gt;\s?/.test(l)) { const q = []; while (i < lines.length && /^&gt;\s?/.test(lines[i])) q.push(inline(lines[i++].replace(/^&gt;\s?/, ''))); out.push(`<blockquote>${q.join('<br>')}</blockquote>`); continue; }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(l.trim())) { out.push('<hr>'); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+\.)\s+|&gt;|\|)/.test(lines[i])) p.push(inline(lines[i++]));
    if (!p.length) p.push(inline(lines[i++]));
    out.push(`<p>${p.join('<br>')}</p>`);
  }
  return out.join('');
}

function readFileB64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
}
function applyAccent(color) { document.documentElement.style.setProperty('--accent', color || '#4f7cff'); }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
function download(name, text, type = 'text/plain') { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); }
const isOwner = () => S.me && S.me.user.platformRole === 'owner';
const isPlatform = () => S.me && S.me.user.platformRole !== 'none';
const canOrg = (action) => { const rank = { read_only: 1, user: 2, manager: 3, org_admin: 4, org_owner: 5 }[S.org && S.org.role] || 0; return rank >= { view: 1, chat: 2, tasks: 2, approve: 3, agents: 3, manage: 4, own: 5 }[action]; };
