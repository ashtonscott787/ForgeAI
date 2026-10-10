'use strict';
/* Layout, navigation, sign-in and first-time setup */

function applyTheme() { const t = store('theme'); if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
function applyShell() {
  if (!S.shell) return;
  document.body.classList.add('is-desktop', 'is-' + S.shell);
}

async function loadMe() {
  S.me = await api('/api/me');
  S.orgs = S.me.orgs; S.platformName = S.me.platformName || 'ForgeAI'; S.brand = S.me.brand || S.brand;
  const saved = store('org');
  S.org = S.orgs.find((o) => o.id === (S.org && S.org.id)) || S.orgs.find((o) => o.id === saved) || S.orgs[0] || null;
  if (typeof applyStyle === 'function') applyStyle(); if (typeof applyLogo === 'function') applyLogo();
  if (S.org) applyAccent(S.org.color);
}
function switchOrg(id, hash) {
  S.org = S.orgs.find((o) => o.id === id) || S.org; store('org', S.org.id); applyAccent(S.org.color);
  CH.convId = null; CH.projectFilter = ''; CH.q = '';
  if (hash && location.hash !== hash) location.hash = hash; else route();
}
async function refreshCounts() {
  try {
    const aps = await api('/api/approvals');
    S.counts.approvals = aps.filter((a) => a.orgId === (S.org && S.org.id)).length; S.counts.allApprovals = aps.length;
    const b = document.querySelector('[data-count=approvals]'); if (b) { b.textContent = S.counts.approvals || ''; b.style.display = S.counts.approvals ? '' : 'none'; }
  } catch {}
}

// `core` items show in Everyday mode; the rest appear when Admin mode is on (platform admins only).
const NAV = [
  ['sec', 'Overview'],
  ['#/overview', 'grid', 'My organisations'],
  ['#/owner-ai', 'sparkles', 'Owner AI', () => isOwner()],
  ['sec', 'Workspace'],
  ['#/home', 'home', 'Home', null, null, { core: 1 }],
  ['#/chat', 'chat', 'AI Chat', null, null, { core: 1 }],
  ['#/mail', 'mail', 'Mail'],
  ['#/agents', 'agent', 'Agents', null, null, { core: 1 }],
  ['#/approvals', 'approve', 'Approvals', null, 'approvals'],
  ['#/tasks', 'tasks', 'Tasks'],
  ['#/files', 'folder', 'Files', null, null, { core: 1 }],
  ['#/artifacts', 'sparkles', 'Artifacts', null, null, { core: 1 }],
  ['#/scheduled', 'clock', 'Scheduled'],
  ['#/knowledge', 'book', 'Knowledge'],
  ['#/usage', 'chart', 'Usage'],
  ['#/org', 'sliders', 'Organisation'],
  ['sec', 'Platform'],
  ['#/models', 'cube', 'Models', null, null, { core: 1 }],
  ['#/topology', 'network', 'Computers', () => isPlatform(), null, { core: 1 }],
  ['#/network', 'monitor', 'Network settings', () => isPlatform()],
  ['#/security', 'shield', 'Security', () => isPlatform()],
  ['#/integrations', 'network', 'Integrations'],
  ['#/providers', 'key', 'AI providers'],
  ['#/perf', 'gauge', 'Performance', () => isPlatform()],
  ['#/train', 'school', 'Training', () => isPlatform()],
  ['#/vms', 'cube', 'Virtual machines', () => isPlatform()],
  ['#/health', 'heart', 'Model health', () => isPlatform()],
  ['#/settings', 'gear', 'Settings', null, null, { core: 1 }],
];

function layout(active) {
  const root = clear($('#root'));
  const appEl = h('div.app');
  const orgSel = h('select', { 'aria-label': 'Organisation', onchange: (e) => switchOrg(e.target.value, /^#\/(overview|models|providers|perf|train|health|settings|owner-ai|network|integrations|agent\/|mail\/)/.test(location.hash) ? '#/home' : location.hash.replace(/^(#\/[\w-]+).*/, '$1')) },
    S.orgs.map((o) => h('option', { value: o.id, selected: S.org && o.id === S.org.id }, o.name)));
  const admin = typeof adminMode === 'function' && adminMode();
  const nav = h('nav.nav');
  const addItem = (item) => {
    const [href, ic, label, cond, count] = item;
    if (cond && !cond()) return;
    nav.append(h('a' + (active === href.slice(2) ? '.on' : ''), { href, onclick: () => appEl.classList.remove('menu-open') }, icon(ic), h('span.lbl', null, label),
      count ? h('span.count.hot', { 'data-count': count, style: { display: S.counts[count] ? '' : 'none' } }, S.counts[count] || '') : null));
  };
  if (!admin) {
    for (const item of NAV) if (item[0] !== 'sec' && item[5] && item[5].core) addItem(item);
    if (isPlatform()) nav.append(h('button.more', { onclick: () => setMode('admin') }, icon('sliders', 'sm'), h('span', null, 'All tools')));
  } else {
    for (const item of NAV) { if (item[0] === 'sec') { nav.append(h('div.sec', null, item[1])); continue; } addItem(item); }
  }
  const u = S.me.user;
  const side = h('aside.side', null,
    h('div.brand', null, h('img.logo', { src: (typeof logoURL === 'function' ? logoURL(brandLogo()) : '/icon.svg'), alt: '' }), h('span.bname', null, S.platformName)),
    S.org ? h('div.orgpick', null, h('span.mono-dot', null, monogram(S.org)), orgSel, h('span.chev', null, icon('down', 'sm'))) : null,
    admin ? h('div.modebar', null, h('span', null, 'Admin tools'), h('button.btn.sm.ghost', { onclick: () => setMode('everyday') }, 'Done')) : null,
    nav,
    h('div.foot', null, h('button.btn.icon.ghost.bell', { title: 'Notifications', onclick: () => notificationsPanel() }, icon('info'), h('span.count.hot', { 'data-count': 'notes', style: { display: S.counts.notes ? '' : 'none' } }, S.counts.notes || '')), h('a', { href: '#/settings/account', title: 'Account' }, h('div.avatar', null, initials(u.displayName || u.username)),
      h('div.who', null, h('b', null, u.displayName || u.username), h('span', null, { owner: 'Platform owner', admin: 'Platform admin', none: S.org ? ROLE_NAMES[S.org.role] || '' : '' }[u.platformRole])))));
  const main = h('main.main');
  const mob = h('div.topbar-mobile', null, h('button.btn.sm.icon.ghost', { onclick: () => appEl.classList.toggle('menu-open'), 'aria-label': 'Menu' }, icon('menu')), S.org ? monogram(S.org) : null, h('span', null, S.org ? S.org.name : S.platformName));
  appEl.append(side, h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', height: '100vh' } }, mob, main));
  main.style.flex = '1';
  root.append(appEl, h('div.titlebar'));
  return main;
}

async function route() {
  clearTimeout(S.pageTimer);
  const hash = location.hash || (S.org ? '#/home' : '#/overview');
  const parts = hash.slice(2).split('/');
  const page = parts[0] || 'overview';
  if (page === 'login') return loginPage();
  if (!S.me) { try { await loadMe(); } catch { return; } }
  if (!S.org && !['overview', 'settings', 'models', 'providers', 'perf', 'train', 'health', 'network', 'topology', 'integrations', 'security', 'plans', 'artifacts'].includes(page)) { location.hash = '#/overview'; return; }
  if (page === 'mail') document.body.classList.add('wide-page'); else document.body.classList.remove('wide-page');
  const main = layout(page === 'agent' ? 'agents' : page);
  document.title = S.org && !['overview', 'models', 'providers', 'perf', 'train', 'health', 'settings', 'network', 'owner-ai'].includes(page) ? `${S.org.name} — ${S.platformName}` : S.platformName;
  try {
    switch (page) {
      case 'overview': await pageOverview(main); break;
      case 'home': await pageHome(main); break;
      case 'mail': await pageMail(main, parts[1], parts[2]); break;
      case 'owner-ai': await pageOwnerAI(main); break;
      case 'chat': await pageChat(main, parts[1]); break;
      case 'agents': await pageAgents(main); break;
      case 'agent': await pageAgent(main, parts[1], parts[2], parts[3]); break;
      case 'files': await pageFiles(main); break;
      case 'artifacts': await pageArtifacts(main); break;
      case 'security': await pageSecurity(main); break;
      case 'plans': location.hash = '#/settings'; return;
      case 'scheduled': await pageScheduled(main); break;
      case 'integrations': await pageIntegrations(main, parts[1]); break;
      case 'tasks': await pageTasks(main, parts[1]); break;
      case 'approvals': await pageApprovals(main, parts[1] === 'all'); break;
      case 'knowledge': await pageKnowledge(main); break;
      case 'usage': await pageUsage(main); break;
      case 'org': await pageOrg(main, parts[1]); break;
      case 'models': await pageModels(main); break;
      case 'network': await pageNetwork(main); break;
      case 'topology': await pageTopology(main); break;
      case 'vms': await pageVMs(main); break;
      case 'providers': await pageProviders(main); break;
      case 'perf': await pagePerf(main); break;
      case 'train': await pageTrain(main); break;
      case 'health': await pageHealth(main); break;
      case 'settings': await pageSettings(main, parts[1]); break;
      default: location.hash = '#/overview';
    }
  } catch (e) {
    main.append(h('div.page', null, note('warn', e.message)));
  }
  refreshCounts(); refreshNotes();
}

function authShell(card) { const root = clear($('#root')); root.append(h('div.auth', null, card), h('div.titlebar')); }

async function loginPage() {
  let st = {}; try { st = await api('/api/state', { noAuthRedirect: true }); } catch {}
  const u = h('input', { type: 'text', autocomplete: 'username', placeholder: 'Username' });
  const p = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const err = h('div.small', { style: { color: 'var(--red)', minHeight: '20px', margin: '2px' } });
  const go = async (e) => { e && e.preventDefault(); err.textContent = ''; try { await api('/api/login', { body: { username: u.value, password: p.value }, noAuthRedirect: true }); S.me = null; location.hash = '#/overview'; } catch (x) { err.textContent = x.message; } };
  authShell(h('form.card', { onsubmit: go }, h('div.orb'), h('h1', null, st.platformName || 'ForgeAI'),
    h('p.lead', null, st.host ? `Sign in to ${st.host}` : 'Sign in to continue'),
    field('Username', u), field('Password', p), err, h('button.btn.primary', { type: 'submit' }, 'Sign In')));
  u.focus();
}

function setupPage(needCode) {
  const name = h('input', { type: 'text', placeholder: 'Your name' });
  const u = h('input', { type: 'text', placeholder: 'e.g. ash', autocomplete: 'username' });
  const p = h('input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
  const orgs = h('textarea', { rows: 4, placeholder: 'Optional — one per line, e.g. a company or a project' });
  const code = h('input', { type: 'text', placeholder: 'Shown in the server log' });
  let personal = true;
  const err = h('div.small', { style: { color: 'var(--red)', minHeight: '20px' } });
  const go = async (e) => {
    e.preventDefault(); err.textContent = '';
    if (p.value !== p2.value) { err.textContent = 'Passwords do not match'; return; }
    try {
      await api('/api/setup', { body: { displayName: name.value, username: u.value, password: p.value, orgs: orgs.value.split('\n'), personal, setupCode: code.value || undefined }, noAuthRedirect: true });
      S.me = null; location.hash = '#/overview'; route();
    } catch (x) { err.textContent = x.message; }
  };
  authShell(h('form.card.wide', { onsubmit: go }, h('div.orb'), h('h1', null, 'Welcome'),
    h('p.lead', null, 'Create your account. You get a private Personal Workspace — nothing else to set up.'),
    field('Your name', name), h('div.grid.g2', { style: { gap: '12px' } }, field('Username', u), field('Password', p)), field('Repeat password', p2),
    h('details', { style: { margin: '6px 0 12px' } }, h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, 'Add a company or team workspace (optional)'),
      h('div', { style: { marginTop: '10px' } }, field('Workspaces', orgs, 'You get a private Personal Workspace either way. Add others now or any time later.'))),
    needCode ? field('Setup code', code, 'You are setting up from another computer. Enter the code printed when the server started.') : null,
    err, h('button.btn.primary', { type: 'submit' }, 'Create Platform')));
  name.focus();
}

(async function boot() {
  applyShell();
  window.addEventListener('hashchange', route);
  try {
    const st = await api('/api/state', { noAuthRedirect: true });
    S.platformName = st.platformName || 'ForgeAI'; S.brand = st.brand || S.brand;
    if (typeof applyStyle === 'function') applyStyle(); if (typeof applyLogo === 'function') applyLogo();
    if (st.setupNeeded) return setupPage(!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
    if (!st.user) { location.hash = '#/login'; return loginPage(); }
  } catch (e) { $('#root').textContent = 'Cannot reach ForgeAI: ' + e.message; return; }
  if (!location.hash || location.hash === '#/login') location.hash = '#/home';
  route();
  setInterval(() => { refreshCounts(); refreshNotes(); }, 20000);
})();
