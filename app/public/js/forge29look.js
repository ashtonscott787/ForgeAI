'use strict';
/* ForgeAI 2.9 — look and feel: logo styles, app styles, Everyday/Admin mode, Appearance settings. */

const LOGOS = {
  orb: { name: 'Orb', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="bg" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#2b2d35"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient><linearGradient id="ba" x1="0" y1="0" x2=".5" y2="1"><stop offset="0" stop-color="#5e5ce6"/><stop offset="1" stop-color="#0a84ff"/></linearGradient><radialGradient id="p" cx=".78" cy=".3" r=".55"><stop offset="0" stop-color="#ff375f"/><stop offset="1" stop-color="#ff375f" stop-opacity="0"/></radialGradient><radialGradient id="o" cx=".8" cy=".78" r=".5"><stop offset="0" stop-color="#ff9f0a"/><stop offset="1" stop-color="#ff9f0a" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" rx="14.5" fill="url(#bg)"/><g transform="translate(17.5 17.5)"><circle cx="14.5" cy="14.5" r="14.5" fill="url(#ba)"/><circle cx="14.5" cy="14.5" r="14.5" fill="url(#p)"/><circle cx="14.5" cy="14.5" r="14.5" fill="url(#o)"/></g></svg>' },
  mesh: { name: 'Mesh', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14.5" fill="#0c1730"/><g stroke="#3f7dff" stroke-width="2.2"><line x1="32" y1="14" x2="15" y2="44"/><line x1="32" y1="14" x2="49" y2="44"/><line x1="15" y1="44" x2="49" y2="44"/><line x1="32" y1="14" x2="32" y2="33"/><line x1="15" y1="44" x2="32" y2="33"/><line x1="49" y1="44" x2="32" y2="33"/></g><g fill="#4cb4ff"><circle cx="32" cy="14" r="5.5"/><circle cx="15" cy="44" r="5.5"/><circle cx="49" cy="44" r="5.5"/></g><circle cx="32" cy="33" r="7" fill="#fff"/></svg>' },
  forge: { name: 'Forge', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#7a3cff"/></linearGradient></defs><rect width="64" height="64" rx="14.5" fill="url(#f)"/><rect x="18" y="15" width="25" height="7" rx="3.5" fill="#fff"/><rect x="18" y="15" width="7" height="34" rx="3.5" fill="#fff"/><rect x="18" y="29" width="18" height="7" rx="3.5" fill="#fff"/><circle cx="45" cy="44" r="5" fill="#ffd166"/></svg>' },
  grid: { name: 'Cluster', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14.5" fill="#15181c"/><g fill="#3a4150"><rect x="13" y="13" width="10" height="10" rx="3"/><rect x="27" y="13" width="10" height="10" rx="3"/><rect x="13" y="27" width="10" height="10" rx="3"/><rect x="13" y="41" width="10" height="10" rx="3"/><rect x="41" y="41" width="10" height="10" rx="3"/></g><g fill="#2fd19a"><rect x="41" y="13" width="10" height="10" rx="3"/><rect x="41" y="27" width="10" height="10" rx="3"/><rect x="27" y="41" width="10" height="10" rx="3"/></g><rect x="27" y="27" width="10" height="10" rx="3" fill="#fff"/></svg>' },
  mono: { name: 'Mono', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14.5" fill="#fff"/><rect x=".75" y=".75" width="62.5" height="62.5" rx="13.75" fill="none" stroke="#d9dde3" stroke-width="1.5"/><path d="M21 48V16h22v6.5H28.5v6.3H41v6.4H28.5V48z" fill="#16191d"/><circle cx="46" cy="44" r="4.5" fill="#0a6cff"/></svg>' },
};
const logoURL = (k) => 'data:image/svg+xml;utf8,' + encodeURIComponent((LOGOS[k] || LOGOS.orb).svg);
const brandLogo = () => (S.brand && S.brand.logo) || 'orb';
function applyLogo() {
  const url = logoURL(brandLogo());
  document.querySelectorAll('img.logo').forEach((i) => { i.src = url; });
  const fav = document.querySelector('link[rel="icon"]'); if (fav) fav.href = url;
}

const APP_STYLES = [
  ['auto', 'Automatic', 'Follows your computer', ['#fbfcfd', '#f4f6f8', '#0a6cff', '#c9d1dc']],
  ['daylight', 'Daylight', 'Bright and clean', ['#fbfcfd', '#f4f6f8', '#0a6cff', '#c9d1dc']],
  ['graphite', 'Graphite', 'Calm dark grey', ['#181a1d', '#141618', '#3d8bff', '#3a4046']],
  ['midnight', 'Midnight', 'Deep blue', ['#0e1626', '#0b1220', '#22c3e6', '#2c3b55']],
  ['studio', 'Studio', 'Soft light, violet', ['#fbfaff', '#f6f5fa', '#6b4eff', '#d6d1e4']],
];
const appStyle = () => store('appStyle') || (S.brand && S.brand.style) || 'auto';
function applyStyle() {
  const st = appStyle(); const el = document.documentElement;
  if (st === 'auto') { delete el.dataset.style; applyTheme(); }
  else { el.dataset.style = st; el.setAttribute('data-theme', ['graphite', 'midnight'].includes(st) ? 'dark' : 'light'); }
  if (S.org) applyAccent(S.org.color);
}
// Named styles keep their own accent unless you choose organisation colours.
function applyAccent(color) {
  const el = document.documentElement; const useOrg = !el.dataset.style || store('accentFrom') === 'org';
  if (useOrg) el.style.setProperty('--accent', color || '#0a6cff'); else el.style.removeProperty('--accent');
}

// Everyday shows five places. Admin adds the management tools (platform admins only).
const adminMode = () => isPlatform() && store('uiMode') === 'admin';
function setMode(m) { store('uiMode', m); route(); }

function pageAppearance(body) {
  const draw = () => {
    clear(body);
    const styles = h('div.styles', null, APP_STYLES.map(([k, name, sub, c]) => h('button.stile' + (appStyle() === k ? '.on' : ''), { type: 'button', onclick: () => { store('appStyle', k); applyStyle(); draw(); } },
      h('div.prev', null, h('div.ps', { style: { background: c[0] } }, h('i', { style: { background: c[3] } }), h('i', { style: { background: c[2] } }), h('i', { style: { background: c[3] } })),
        h('div.pm', { style: { background: c[1] } }, h('i', { style: { background: c[3], width: '70%' } }), h('i', { style: { background: c[3], width: '45%' } }), h('i', { style: { background: c[2], width: '30%' } }))),
      h('b', null, name), h('span', null, sub))));
    const logos = h('div.logos', null, Object.entries(LOGOS).map(([k, l]) => h('button.ltile' + (brandLogo() === k ? '.on' : ''), { type: 'button', disabled: !isOwner(), onclick: guard(async () => { const r = await api('/api/settings/brand', { method: 'PUT', body: { logo: k } }); S.brand = r; applyLogo(); draw(); toast('Logo changed for everyone'); }) },
      h('img', { src: logoURL(k), alt: '' }), h('span', null, l.name))));
    const accent = h('div.seg', null, [['style', 'Style colour'], ['org', 'Organisation colour']].map(([v, l]) => h('button' + ((store('accentFrom') || 'style') === v ? '.on' : ''), { onclick: () => { store('accentFrom', v); applyStyle(); draw(); } }, l)));
    const mode = h('div.seg', null, [['everyday', 'Everyday'], ['admin', 'Admin']].map(([v, l]) => h('button' + ((adminMode() ? 'admin' : 'everyday') === v ? '.on' : ''), { onclick: () => setMode(v) }, l)));
    body.append(
      h('div.section-title', null, 'App style'), styles, h('div.small.muted', { style: { margin: '8px 0 22px' } }, 'Just for you, on this device.'),
      h('div.section-title', null, 'ForgeAI logo'), logos, h('div.small.muted', { style: { margin: '8px 0 22px' } }, isOwner() ? 'Shown to everyone on this platform — sidebar, sign-in page and browser tab.' : 'Chosen by the platform owner.'),
      h('div.list', null,
        h('div.li', null, h('div.t', null, h('b', null, 'Accent colour'), h('span', null, 'Use the style’s colour, or each organisation’s brand colour.')), h('div.ctl', null, accent)),
        isPlatform() ? h('div.li', null, h('div.t', null, h('b', null, 'Interface'), h('span', null, 'Everyday shows Chat, Apps, Models, Computers and Settings. Admin adds agents, mail, usage, providers and the rest.')), h('div.ctl', null, mode)) : null));
  };
  draw();
}

// ---------------------------------------------------------------- Security checks that explain themselves (2.10)
window.pageSecurity = async function (root) {
  const pg = h('div.page'); root.append(pg);
  const scanBtn = h('button.btn', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner'), ' Scanning the network…'); try { const r = await api('/api/security/scan', { body: {} }); drawScan(r); } finally { b.disabled = false; clear(b).append(icon('network', 'sm'), 'Run a network scan'); } }) }, icon('network', 'sm'), 'Run a network scan');
  pg.append(pageHead('Security', 'What ForgeAI checks, and what it found — each check shows exactly what it looked at. Everything runs on this computer; nothing leaves your network.', scanBtn));
  const checksEl = h('div'); const scanEl = h('div'); pg.append(checksEl, scanEl);
  const ICN = { pass: ICONS.check, warn: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', fail: '<path d="M18 6 6 18M6 6l12 12"/>', na: '<path d="M5 12h14"/>', pending: '<path d="M12 6v6l4 2"/>' };
  const STATE = { pass: 'Passed', warn: 'Warning', fail: 'Action needed', na: 'Not applicable', pending: 'In progress' };
  const draw = (d) => {
    clear(checksEl);
    checksEl.append(h('div.secsum', null,
      h('span.pill.pass', null, iconRaw(ICN.pass, 'pass'), h('span.n', null, String(d.summary.pass)), ' passed'),
      d.summary.warn ? h('span.pill.warn', null, iconRaw(ICN.warn, 'warn'), h('span.n', null, String(d.summary.warn)), ' to improve') : null,
      d.summary.fail ? h('span.pill.fail', null, iconRaw(ICN.fail, 'fail'), h('span.n', null, String(d.summary.fail)), ' need action') : null,
      h('span.pill', null, h('span.n', null, String(d.summary.na)), ' not applicable')));
    for (const cat of d.categories) checksEl.append(h('div.seccat', null, h('h3', null, cat.category),
      h('div.list', null, cat.checks.map((c) => h('details.scheck', { open: c.state === 'fail' || c.state === 'warn' },
        h('summary', null, h('span.ind.' + c.state, null, iconRaw(ICN[c.state] || ICN.na)), h('span.nm', null, c.name), h('span.stt.' + c.state, null, STATE[c.state] || c.state), icon('down', 'chev sm')),
        h('div.det', null, c.detail || '', c.evidence ? h('div.ev', null, 'Checked: ' + c.evidence) : null, h('div.when', null, 'Verified ' + new Date(c.at).toLocaleString())))))));
  };
  const drawScan = (r) => { clear(scanEl); scanEl.append(h('div.section-title', { style: { marginTop: '8px' } }, 'Network scan'),
    h('div.card', null, h('div.md', { html: md('**' + (r.summary || '') + '**') })),
    (r.warnings && r.warnings.length) ? h('div.list', { style: { marginTop: '10px' } }, r.warnings.map((w) => h('div.li', null, icon('warn'), h('div.t', null, h('span', null, w.text))))) : h('p.small.muted', { style: { marginTop: '8px' } }, 'No surprises found on your network.')); };
  try { draw(await api('/api/security/checks')); } catch (e) { checksEl.append(note('warn', e.message)); }
};
function iconRaw(path, cls) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.4'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('class', 'ic ' + (cls || '')); s.innerHTML = path; return s; }
