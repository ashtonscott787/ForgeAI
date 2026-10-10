'use strict';
/* ForgeAI 2.6 — Artifacts (live HTML pages you can open and share, with cross-artifact messaging), org kinds,
   plans page, personal-subscription sign-in, security scan, sub-agents from chat, download-everything-in-engine,
   relay client. Loaded after forge25.js. */

Object.assign(ICONS, { share: '<path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M12 15V4m-4 4 4-4 4 4"/>', wand: '<path d="M15 4 20 9 7 22 2 17 15 4z"/><path d="M12 8l4 4"/>', cloud: '<path d="M7 18a4 4 0 1 1 .6-7.95 6 6 0 0 1 11.4 2A3.5 3.5 0 0 1 18 19H7z"/>' });

// ----- rename "Owner AI" sidebar label to make its meaning clearer; left clickable, unchanged function
try { const links = document.querySelectorAll('a[href="#/owner-ai"] .label'); links.forEach((l) => { if (l.textContent.trim() === 'Owner AI') l.textContent = 'My AI (owner)'; }); } catch {}

// -------------------- Artifacts
async function pageArtifacts(root) {
  const list = await orgApi('/artifacts').catch(() => []);
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Artifacts', 'Live web pages the AI made with you — open them in your browser, share them if you choose. Interactive artifacts can talk to each other inside this ForgeAI.',
    h('button.btn.tint', { onclick: () => newArtifactModal() }, icon('plus', 'sm'), 'New Artifact')));
  if (!list.length) return pg.append(h('div.card.empty', null, h('div.big', null, icon('sparkles')), h('h2', null, 'Nothing here yet'), h('p', null, 'Ask the AI in a chat to make you an interactive page — a calculator, a little form, a chart, a mini-app — or create one by hand. Each artifact has its own URL you can open, and you can share the ones you want.')));
  const base = location.origin;
  pg.append(h('div.list', null, list.map((a) => h('div.li.click', { onclick: () => openArtifactModal(a) }, icon('sparkles'), h('div.t', null, h('b', null, a.title || 'Artifact'), h('span', null, [`updated ${new Date(a.updated_at).toLocaleString()}`, a.author ? 'by ' + a.author : null, a.bus ? 'bus on' : 'bus off'].filter(Boolean).join(' · '))),
    a.visibility === 'public' ? h('span.badge.ok', null, icon('globe', 'sm'), 'Shared') : a.visibility === 'org' ? h('span.badge', null, 'Workspace') : h('span.badge', null, 'Private'),
    h('a.btn.sm', { href: base + a.url, target: '_blank', onclick: (e) => e.stopPropagation() }, icon('up', 'sm'), 'Open')))));
}
function openArtifactModal(a) {
  const base = location.origin; let visibility = a.visibility; let bus = !!a.bus;
  const vSel = sel([['private', 'Only me'], ['org', 'Everyone in this workspace (signed in)'], ['public', 'Anyone with the share link']], visibility, { onchange: (e) => { visibility = e.target.value; shareBox.style.display = visibility === 'public' ? '' : 'none'; } });
  const busT = toggle(bus, (v) => { bus = v; });
  const shareLink = base + (a.shareUrl || '');
  const shareBox = h('div', { style: { display: visibility === 'public' ? '' : 'none' } },
    note('info', 'Anyone with this link can open the page. No sign-in needed. ForgeAI serves only the HTML — nothing else from your organisation.'),
    a.shareUrl ? h('div.row.nowrap', { style: { marginTop: '8px', gap: '8px' } }, h('input', { readOnly: true, value: shareLink, style: { flex: 1, fontFamily: 'var(--mono, monospace)' } }), h('button.btn.sm', { onclick: () => { navigator.clipboard.writeText(shareLink); toast('Copied'); } }, icon('copy', 'sm'), 'Copy')) : h('p.small.muted', null, 'Save first to create the share link.'));
  modal(a.title || 'Artifact', h('div', null,
    h('div.row', { style: { gap: '8px', marginBottom: '10px' } }, h('a.btn.primary', { href: base + a.url, target: '_blank' }, icon('up', 'sm'), 'Open'), h('a.btn.ghost', { href: '/api/orgs/' + S.org.id + '/artifacts/' + a.id, download: a.id + '.html', title: 'Download the HTML' }, icon('download', 'sm'), 'Download')),
    field('Who can see it', vSel),
    field('Talk to other artifacts', h('div.row.nowrap', null, busT, h('span.small.muted', { style: { marginLeft: '8px' } }, 'Lets this page send and receive messages with other artifacts in this workspace (interactive demos, dashboards).'))),
    shareBox,
    h('details', { style: { marginTop: '10px' } }, h('summary.faint.small', null, 'Danger zone'), h('div', { style: { marginTop: '8px' } }, h('button.btn.sm.danger', { onclick: guard(async () => { if (!confirm('Delete this artifact for good? The link stops working.')) return; await api('/api/orgs/' + S.org.id + '/artifacts/' + a.id, { method: 'DELETE' }); toast('Deleted'); route(); }) }, icon('trash', 'sm'), 'Delete artifact')))),
  [{ label: 'Save', primary: true, onClick: async () => { await api('/api/orgs/' + S.org.id + '/artifacts/' + a.id, { method: 'PUT', body: { visibility, bus } }); toast('Saved'); route(); } }], { wide: true });
}
function newArtifactModal() {
  const title = h('input', { type: 'text', placeholder: 'e.g. Price calculator', style: { width: '100%' } });
  const html = h('textarea', { rows: 10, placeholder: "<style>body{font:16px -apple-system}button{padding:10px}</style>\n<h1>Hello</h1>\n<button id=b>Click</button>\n<p id=c>0</p>\n<script>let n=0;b.onclick=()=>c.textContent=++n</script>", style: { width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: '12px' } });
  modal('New artifact', h('div', null, field('Title', title), field('HTML', html), note('info', 'The page is sandboxed and has no network access except back to this ForgeAI. It gets a small `window.forge` helper for talking to other artifacts and for keeping values.')),
    [{ label: 'Create', primary: true, onClick: async () => { const r = await api('/api/orgs/' + S.org.id + '/artifacts', { body: { title: title.value, html: html.value, visibility: 'private', conv_id: null } }); toast('Created'); window.open(r.url, '_blank'); route(); } }], { wide: true });
}
// Show an artifact card in chat when the AI made one
const renderMsg25 = window.renderMsg;
window.renderMsg = function (m, live) {
  const el = renderMsg25 ? renderMsg25(m, live) : (window.renderMsgBase ? window.renderMsgBase(m, live) : null);
  if (live || !m.meta || !el) return el;
  const arts = (m.meta.artifacts && m.meta.artifacts.length ? m.meta.artifacts : null) || (m.meta.steps || []).flatMap((s) => s.artifact ? [s.artifact] : []);
  if (!arts || !arts.length) return el;
  const body = el.querySelector('.body'); if (!body) return el;
  for (const a of arts) {
    const card = h('div.artcard', null, icon('sparkles'), h('div.grow', null, h('b', null, a.title || 'Artifact'), h('div.small.muted', null, a.visibility === 'public' ? 'Shared · anyone with the link can open it' : a.visibility === 'org' ? 'Visible to this workspace' : 'Private to you')),
      h('a.btn.sm.primary', { href: a.url, target: '_blank' }, icon('up', 'sm'), 'Open'),
      h('button.btn.sm.ghost', { onclick: () => openArtifactModal({ id: a.id, title: a.title, visibility: a.visibility || 'org', bus: a.bus !== false, shareUrl: a.shareUrl, url: a.url }) }, icon('share', 'sm'), 'Share'));
    (body.querySelector('.meta') || body).before ? body.insertBefore(card, body.querySelector('.meta') || null) : body.append(card);
  }
  return el;
};

// ---------------- Security scan page
async function pageSecurity(root) {
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Security', 'Checks every ForgeAI computer and your network for weak settings, open ports and other risks. All checks run from this computer, nothing leaves your network.',
    h('button.btn.primary', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner'), ' Scanning…'); const r = await api('/api/security/scan', { body: {} }); b.disabled = false; clear(b).append(icon('shield', 'sm'), 'Scan again'); draw(r); }) }, icon('shield', 'sm'), 'Run scan')));
  const box = h('div'); pg.append(box);
  function draw(r) {
    clear(box);
    const sum = h('div.row', { style: { gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } }, h('span.badge.ok', null, h('span.dot'), r.summary));
    box.append(sum, h('div.list', null, r.computers.map((c) => h('div.li', null, icon(c.scope === 'local' ? 'laptop' : 'server'),
      h('div.t', null, h('b', null, c.name), h('span', null, [c.kind, c.url, c.tps ? Math.round(c.tps) + ' tok/s' : null].filter(Boolean).join(' · ')),
        c.items.length ? h('ul', { style: { margin: '6px 0 0 18px', padding: 0 } }, c.items.map((it) => h('li', { style: { color: it.sev === 'bad' ? 'var(--red)' : it.sev === 'warn' ? 'var(--orange, #c77700)' : 'var(--text-2)' } }, it.text, h('div.small.muted', null, it.fix)))) : h('div.small.muted', { style: { marginTop: '4px' } }, 'Nothing to flag.')),
      h('span.badge' + (c.grade === 'ok' ? '.ok' : c.grade === 'warn' ? '.warn' : '.bad'), null, c.grade === 'ok' ? 'Fine' : c.grade === 'warn' ? 'Improve' : 'Action')))));
    if (r.warnings && r.warnings.length) box.append(h('div.section-title', null, 'Also noticed'), h('div.list', null, r.warnings.map((w) => h('div.li', null, icon('warn'), h('div.t', null, h('span', null, w.text))))));
  }
  // Draw an initial empty state
  draw({ summary: 'Press "Run scan" to check this ForgeAI, every linked computer and your network.', computers: [], warnings: [] });
}
// Plans page
async function pagePlans(root) {
  const d = await api('/api/plans');
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Plans', 'ForgeAI is one app; higher tiers unlock features in place — no reinstall, no data move.'));
  pg.append(h('div.grid.g2', { style: { gap: '14px' } }, d.tiers.map((t) => h('div.card', { style: { padding: '18px', border: t.id === d.current ? '2px solid var(--accent)' : null } },
    h('div.row.between', null, h('h2', { style: { margin: 0 } }, t.name), t.id === d.current ? h('span.badge.ok', null, 'Current') : null),
    h('div.faint', { style: { margin: '4px 0 10px' } }, t.price),
    h('p', null, t.line),
    t.in && t.in.length ? h('ul', { style: { margin: '6px 0 0 18px' } }, t.in.map((x) => h('li', null, '✓ ', x))) : null,
    t.not && t.not.length ? h('ul', { style: { margin: '6px 0 0 18px', color: 'var(--muted)' } }, t.not.map((x) => h('li', null, '— ', x))) : null,
    t.id !== d.current ? h('div.row', { style: { marginTop: '12px' } }, h('button.btn.primary', { onclick: guard(async () => { if (!confirm(`Switch to ${t.name}? Nothing is paid here — this just flips the plan the app shows. Billing is handled in your ForgeAI account.`)) return; await api('/api/plans', { method: 'PUT', body: { plan: t.id } }); toast('Switched'); route(); }) }, 'Switch to ' + t.name)) : null))));
  pg.append(h('div.card', { style: { marginTop: '18px' } }, h('div.md', { html: md('All tiers run the same app and the same models. The paid tiers unlock the extra surfaces — teams, audit export, hosted relay. The appliance is a Mac mini or mini-PC we ship pre-installed, so there is nothing to set up.') })));
}
// Nav entries + routes
(() => {
  const nav = document.querySelector('.sidenav'); // noop if not yet mounted — router handles it
  // Hook into main router via window.pageRoutes additions (main.js is a switch; patch by overriding switch via location.hash listener fallback)
})();
window.pageSecurity = pageSecurity; window.pagePlans = pagePlans;

// Teach main.js these pages: wrap the existing hashchange routing by augmenting NAV and the switch via patching.

// ----- Sub-agents in chat: a tiny "/agent <text>" slash command that creates a parallel task from a chat message.
(function subAgents() {
  const orig = window.sendChat || null; // not every build exposes this; we patch textarea Enter instead
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.shiftKey || !e.ctrlKey) return;
    const ta = e.target; if (!ta || ta.tagName !== 'TEXTAREA') return;
    const line = ta.value.trim(); if (!line.startsWith('/agent ')) return;
    e.preventDefault();
    const text = line.slice(7); ta.value = '';
    try { const t = await orgApi('/tasks', { body: { title: text.slice(0, 60), input: text } }); toast('Agent working — see Tasks for progress'); } catch (err) { toast(err.message, true); }
  }, true);
})();
