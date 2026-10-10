'use strict';
/* Overview, Agents, Tasks, Approvals, Knowledge, Usage, Owner AI */

function pageHead(title, sub, ...actions) { return h('div.phead', null, h('div', null, h('h1', null, title), sub ? h('div.sub', null, sub) : null), h('div.row', null, actions)); }
function kpi(ic, v, l, sub, href) { return h(href ? 'a.card.kpi' : 'div.card.kpi', href ? { href } : null, h('div.l', null, icon(ic, 'sm'), l), h('div.v', null, v), sub ? h('div.s', null, sub) : null); }
const orgBadge = (a) => h('span.badge', { style: { background: `color-mix(in srgb, ${a.orgColor} 16%, transparent)`, color: a.orgColor } }, a.orgName);

// ---------------- OVERVIEW
async function pageOverview(root) {
  const d = await api('/api/dashboard');
  const pg = h('div.page'); root.append(pg);
  const online = d.nodes.filter((n) => n.status === 'online').length;
  const hour = new Date().getHours();
  pg.append(pageHead(`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${(S.me.user.displayName || S.me.user.username).split(' ')[0]}`, 'Everything across your organisations, at a glance.',
    isPlatform() ? h('button.btn.tint', { onclick: () => newOrgModal() }, icon('plus', 'sm'), 'Organisation') : null));
  pg.append(h('div.grid.g4', { style: { marginBottom: '28px' } },
    kpi('agent', d.totals.agents, 'Agents active'), kpi('approve', d.totals.approvals, 'Waiting for you', d.totals.approvals ? 'Review approvals' : 'All clear', d.totals.approvals ? '#/approvals/all' : null),
    kpi('chart', money(d.totals.spend), 'Cloud AI this month', 'Local models are free'), kpi('server', `${online} of ${d.nodes.length}`, 'Computers online', null, '#/network')));
  pg.append(h('div.section-title', null, 'Organisations'));
  if (!d.orgs.length) pg.append(emptyState('building', 'No organisations yet', 'Create one to get started.'));
  pg.append(h('div.grid.gauto', null, d.orgs.map((o) => h('div.card.orgcard', { style: { '--org': o.color }, onclick: () => switchOrg(o.id, '#/chat') },
    h('div.row.between.nowrap', { style: { position: 'relative' } }, h('div.row.nowrap', { style: { gap: '12px' } }, monogram(o, 'lg'), h('div', null, h('div.name', null, o.name), h('div.kind', null, o.kind === 'personal' ? 'Personal workspace' : 'Organisation'))), statusBadge(o.health)),
    h('div.stats', null,
      h('div', null, h('b', null, o.running), h('span', null, 'Agents running')),
      h('div', null, h('b', { style: { color: o.approvals ? 'var(--orange)' : '' } }, o.approvals), h('span', null, o.approvals === 1 ? 'Approval' : 'Approvals')),
      h('div', null, h('b', { style: { color: o.overdue ? 'var(--red)' : '' } }, o.overdue), h('span', null, 'Overdue'))),
    h('div.foot', null, h('span', null, o.alerts ? `${o.alerts} alert${o.alerts > 1 ? 's' : ''}` : 'No alerts'), h('span', null, `${money(o.spend)}${o.budget ? ' of ' + money(o.budget) : ''} cloud`))))));

  const aps = await api('/api/approvals').catch(() => []);
  pg.append(h('div.grid.g2', { style: { marginTop: '28px' } },
    h('div', null, h('div.row.between', null, h('div.section-title', { style: { margin: '0 4px 10px' } }, 'Waiting for approval'), h('a.small', { href: '#/approvals/all' }, 'See all')),
      aps.length ? h('div.list', null, aps.slice(0, 5).map((a) => h('div.li.click', { onclick: () => { location.hash = '#/approvals/all'; } }, h('div.t', null, h('b', null, a.title), h('span', null, `${a.orgName} · ${ago(a.created_at)}`)), icon('right', 'sm'))))
        : h('div.list', null, h('div.li', null, icon('check'), h('div.t', null, h('b', null, 'Nothing waiting'), h('span', null, 'You are all caught up.'))))),
    h('div', null, h('div.row.between', null, h('div.section-title', { style: { margin: '0 4px 10px' } }, 'Computers'), h('a.small', { href: '#/network' }, 'Manage')),
      h('div.list', null, d.nodes.map((n) => h('div.li', null, icon(n.name === 'This Mac' || n.name === 'This computer' ? 'laptop' : 'server'), h('div.t', null, h('b', null, n.name), h('span', null, `${n.modelCount} models${n.ram_gb ? ' · ' + n.ram_gb + ' GB' : ''} · ${n.inflight ? n.inflight + ' running' : 'idle'}`)), statusBadge(n.status)))),
      !d.providers.length && isPlatform() ? h('div', { style: { marginTop: '10px' } }, note('info', 'No cloud providers connected. ', h('a', { href: '#/providers' }, 'Connect OpenAI, Claude or Gemini'))) : null)));
}

const ORG_KIND = { business: ['Business', 'Full organisation: people, roles, budgets, audit, backups.'], project: ['Project', 'Lighter: a focused space for one job or client. You can turn it into a Business later.'], personal: ['Personal', 'Just you. No teams, no audit, no cloud budget.'] };
function newOrgModal() {
  const name = h('input', { type: 'text', placeholder: 'e.g. My company' });
  let kind = 'business';
  const seg = h('div.seg', null, Object.entries(ORG_KIND).map(([k, [l]]) => h('button' + (k === kind ? '.on' : ''), { type: 'button', onclick: (e) => { kind = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); detail.textContent = ORG_KIND[k][1]; } }, l)));
  const detail = h('div.small.muted', { style: { marginTop: '4px' } }, ORG_KIND[kind][1]);
  const color = h('input', { type: 'color', value: '#0071e3' });
  modal('New workspace', h('div', null, field('Name', name), field('Type', h('div', null, seg, detail)), field('Colour', color),
    note('info', 'Each workspace has its own database, files, agents, memory, policies, budgets and activity log. Nothing is shared unless you grant it.')),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => { const o = await api('/api/orgs', { body: { name: name.value, kind, color: color.value } }); await loadMe(); switchOrg(o.id, '#/org'); } }]);
}

// ---------------- TASKS
async function pageTasks(root, taskId) {
  const [tasks, agents] = await Promise.all([orgApi('/tasks'), orgApi('/agents')]);
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Tasks', 'Work given to agents — by people, schedules or other agents.', canOrg('tasks') && agents.length ? h('button.btn.primary', { onclick: () => taskModal(agents) }, icon('plus', 'sm'), 'New Task') : null));
  let filter = 'all';
  const holder = h('div'); const tabs = h('div.tabs');
  const draw = () => {
    clear(tabs); clear(holder);
    const counts = { all: tasks.length, running: tasks.filter((t) => t.status === 'running' || t.status === 'queued').length, overdue: tasks.filter((t) => t.overdue).length, awaiting_approval: tasks.filter((t) => t.status === 'awaiting_approval').length, failed: tasks.filter((t) => t.status === 'failed').length };
    for (const [k, l] of [['all', 'All'], ['running', 'Running'], ['overdue', 'Overdue'], ['awaiting_approval', 'Awaiting approval'], ['failed', 'Failed']]) tabs.append(h('a' + (filter === k ? '.on' : ''), { href: '#', onclick: (e) => { e.preventDefault(); filter = k; draw(); } }, `${l}${counts[k] ? ' ' + counts[k] : ''}`));
    const rows = tasks.filter((t) => filter === 'all' || (filter === 'running' ? ['running', 'queued'].includes(t.status) : filter === 'overdue' ? t.overdue : t.status === filter));
    if (!rows.length) { holder.append(emptyState('tasks', 'No tasks here')); return; }
    holder.append(h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['Task', 'Agent', 'Status', 'From', 'Due', 'Created'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((t) => h('tr.click', { onclick: () => (t.agent_id ? (location.hash = `#/agent/${t.agent_id}/activity/${t.id}`) : taskDetail(t)) }, h('td', null, h('b', null, t.title), t.parent_task ? h('div.small.faint', null, 'Agent-to-agent') : null), h('td.muted', null, t.agent_name || '—'), h('td', null, statusBadge(t.status), t.overdue ? h('span.badge.bad', { style: { marginLeft: '4px' } }, 'Overdue') : null), h('td.muted.small', null, t.created_by), h('td.muted.small', null, t.due_at ? new Date(t.due_at).toLocaleDateString() : ''), h('td.faint.small', null, ago(t.created_at)))))))));
  };
  pg.append(tabs, holder); draw();
  if (taskId) { const t = tasks.find((x) => x.id === taskId); if (t && t.agent_id) { location.hash = `#/agent/${t.agent_id}/activity/${t.id}`; return; } if (t) taskDetail(t); }
  if (tasks.some((t) => t.status === 'running' || t.status === 'queued')) S.pageTimer = setTimeout(() => location.hash.startsWith('#/tasks') && !document.querySelector('.modal') && route(), 4000);
}
function taskModal(agents) {
  const ag = sel(agents.map((a) => [a.id, a.name]), agents[0] && agents[0].id);
  const title = h('input', { type: 'text', placeholder: 'e.g. Prepare the weekly sales report' });
  const input = h('textarea', { rows: 5, placeholder: 'Details and instructions' });
  const due = h('input', { type: 'datetime-local' });
  let runNow = true;
  modal('New Task', h('div', null, field('Agent', ag), field('Title', title), field('Instructions', input), field('Due', due, 'Optional. Shown as overdue on the dashboard if not done in time.'), checkRow('Start now', true, (v) => runNow = v)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => { await orgApi('/tasks', { body: { agent_id: ag.value, title: title.value, input: input.value || title.value, due_at: due.value ? new Date(due.value).toISOString() : null, run: runNow } }); route(); } }]);
}
function taskDetail(t) {
  let r = []; try { r = JSON.parse(t.route || '[]'); } catch {}
  modal(t.title, h('div.stack', null,
    h('div.row', null, statusBadge(t.status), h('span.muted.small', null, `${t.agent_name || ''} · from ${t.created_by} · ${ago(t.created_at)}`), t.model_used ? h('span.badge', { title: r.join('\n') }, icon('cube', 'sm'), t.model_used) : null),
    h('div', null, h('label.f', null, 'Request'), h('div.note', { style: { whiteSpace: 'pre-wrap', display: 'block' } }, t.input)),
    t.error ? note('warn', t.error) : null,
    t.output ? h('div', null, h('label.f', null, 'Result'), h('div.md.card.flat', { html: md(t.output) })) : t.status === 'running' ? h('div.muted', null, h('span.spinner'), ' Working…') : null),
  [canOrg('tasks') && ['failed', 'done', 'queued', 'rejected'].includes(t.status) ? { label: 'Run Again', onClick: async () => { await orgApi(`/tasks/${t.id}/run`, { body: {} }); route(); } } : null,
    t.output ? { label: 'Copy Result', onClick: () => { navigator.clipboard.writeText(t.output); toast('Copied'); return false; } } : null,
    { label: 'Done', primary: true, onClick: () => { if (location.hash !== '#/tasks') history.replaceState(null, '', location.search + '#/tasks'); } }].filter(Boolean), { wide: true });
}

// ---------------- APPROVALS
async function pageApprovals(root, allOrgs) {
  const pg = h('div.page', { style: { maxWidth: '900px' } }); root.append(pg);
  const list = allOrgs ? await api('/api/approvals') : (await orgApi('/approvals')).map((a) => ({ ...a, orgId: S.org.id, orgName: S.org.name, orgColor: S.org.color, canDecide: canOrg('approve') }));
  pg.append(pageHead('Approvals', allOrgs ? 'Everything waiting for a decision, across your organisations.' : `Decisions waiting in ${S.org.name}.`,
    h('div.seg', null, h('button' + (!allOrgs ? '.on' : ''), { onclick: () => { location.hash = '#/approvals'; } }, S.org.name), h('button' + (allOrgs ? '.on' : ''), { onclick: () => { location.hash = '#/approvals/all'; } }, 'All organisations'))));
  const pending = list.filter((a) => a.status === 'pending');
  if (!pending.length) pg.append(emptyState('approve', 'All caught up', 'Nothing is waiting for approval.'));
  for (const a of pending) {
    let p = {}; try { p = JSON.parse(a.payload || '{}'); } catch {}
    pg.append(h('div.card', { style: { marginBottom: '14px' } },
      h('div.row.between', null, h('div.row', null, allOrgs ? orgBadge(a) : null, h('b', null, a.title)), h('span.faint.small', null, `${a.requested_by} · ${ago(a.created_at)}`)),
      h('div.small.muted', { style: { margin: '6px 0 10px' } }, { external_model: 'Send finance data to an external AI model', agent_output: 'Agent result held for review' }[a.kind] || a.kind),
      a.detail ? h('div.md.note', { style: { maxHeight: '280px', overflow: 'auto', display: 'block' }, html: md(a.detail) }) : null,
      a.canDecide ? h('div.row', { style: { marginTop: '14px' } },
        h('button.btn.primary', { onclick: guard(async () => { await api(`/api/orgs/${a.orgId}/approvals/${a.id}/decide`, { body: { approve: true } }); toast('Approved'); refreshCounts(); route(); }) }, icon('check', 'sm'), 'Approve'),
        h('button.btn.danger', { onclick: guard(async () => { await api(`/api/orgs/${a.orgId}/approvals/${a.id}/decide`, { body: { approve: false } }); toast('Rejected'); refreshCounts(); route(); }) }, 'Reject'),
        p.convId ? h('a.small', { href: '#/chat/' + p.convId, onclick: () => a.orgId !== S.org.id && switchOrg(a.orgId, '#/chat/' + p.convId) }, 'Open conversation') : null)
        : h('div.small.muted', { style: { marginTop: '10px' } }, 'A manager or admin must decide this.')));
  }
  const done = list.filter((a) => a.status !== 'pending');
  if (done.length) pg.append(h('div.section-title', null, 'History'), h('div.list', null, done.slice(0, 50).map((a) => h('div.li', null, h('div.t', null, h('b', null, a.title), h('span', null, `${a.decided_by || ''} · ${ago(a.decided_at)}`)), statusBadge(a.status)))));
}

// ---------------- KNOWLEDGE
async function pageKnowledge(root) {
  const [docs, mem, projects] = await Promise.all([orgApi('/documents'), orgApi('/memory'), orgApi('/projects')]);
  const pg = h('div.page'); root.append(pg);
  const fileIn = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: guard(async (e) => {
    for (const f of e.target.files) await orgApi('/documents', { body: { name: f.name, mime: f.type, data: await readFileB64(f) } });
    toast('Uploaded'); route();
  }) });
  pg.append(pageHead('Knowledge', `Documents, memory and projects that belong to ${S.org.name} only.`, canOrg('tasks') ? h('button.btn.primary', { onclick: () => fileIn.click() }, icon('share', 'sm'), 'Upload') : null, fileIn));
  pg.append(h('div.section-title', null, 'Documents'));
  pg.append(docs.length ? h('div.list', null, docs.map((d) => h('div.li', null, icon('doc'), h('div.t', null, h('b', null, d.name), h('span', null, `${bytes(d.size)} · ${d.chars ? num(d.chars) + ' characters readable' : 'not readable'} · ${ago(d.created_at)}`)),
    h('label.lbl.small.muted', { style: { display: 'flex', gap: '8px', alignItems: 'center' }, title: 'Let the Owner AI read this document' }, 'Owner AI', canOrg('manage') ? toggle(d.share_owner_ai, guard(async (v) => { await orgApi('/documents/' + d.id, { method: 'PUT', body: { share_owner_ai: v } }); })) : h('span', null, d.share_owner_ai ? 'Yes' : 'No')),
    canOrg('tasks') ? h('button.btn.sm.icon.ghost', { title: 'Delete', onclick: guard(async () => { await orgApi('/documents/' + d.id, { method: 'DELETE' }); route(); }) }, icon('trash')) : null)))
    : emptyState('doc', 'No documents yet', 'PDF, Word, text, Markdown, CSV and code files are read automatically.'));
  const memIn = h('input', { type: 'text', placeholder: 'e.g. Our financial year ends 31 March' });
  pg.append(h('div.grid.g2', { style: { marginTop: '8px' } },
    h('div', null, h('div.section-title', null, 'Memory'), h('div.card', null, h('p.small.muted', { style: { marginTop: 0 } }, 'Facts every chat and agent in this organisation will know.'),
      canOrg('chat') ? h('div.row.nowrap', { style: { marginBottom: '8px' } }, h('div.grow', null, memIn), h('button.btn.tint', { onclick: guard(async () => { if (!memIn.value.trim()) return; await orgApi('/memory', { body: { content: memIn.value } }); route(); }) }, 'Add')) : null,
      mem.length ? mem.map((m) => h('div.row.nowrap', { style: { padding: '8px 0', borderTop: '1px solid var(--sep)' } }, icon('bulb', 'sm'), h('div.grow', null, m.content, h('div.faint.small', null, `${m.source} · ${ago(m.created_at)}`)), canOrg('chat') ? h('button.btn.sm.icon.ghost', { onclick: guard(async () => { await orgApi('/memory/' + m.id, { method: 'DELETE' }); route(); }) }, icon('x', 'sm')) : null)) : h('div.faint.small', null, 'Nothing remembered yet.'))),
    h('div', null, h('div.section-title', null, 'Projects'), projects.length ? h('div.list', null, projects.map((p) => h('div.li' + (canOrg('chat') ? '.click' : ''), { onclick: () => canOrg('chat') && projectModal(p) }, icon('folder'), h('div.t', null, h('b', null, p.name), h('span', null, (p.instructions || 'No instructions').slice(0, 100))), icon('right', 'sm')))) : h('div.card', null, h('div.faint.small', null, 'No projects yet. Create one from the chat sidebar.')))));
}
function projectModal(p) {
  const name = h('input', { type: 'text', value: p.name }); const ins = h('textarea', { rows: 6, value: p.instructions || '' });
  modal('Project', h('div', null, field('Name', name), field('Instructions', ins)), [
    { label: 'Delete', danger: true, onClick: async () => { await orgApi('/projects/' + p.id, { method: 'DELETE' }); route(); } },
    { label: 'Save', primary: true, onClick: async () => { await orgApi('/projects/' + p.id, { method: 'PUT', body: { name: name.value, instructions: ins.value } }); route(); } }]);
}

// ---------------- USAGE
async function pageUsage(root) {
  const u = await orgApi('/usage');
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Usage', `${S.org.name} this month. Cloud costs are estimates from the price table.`));
  const pct = u.budget ? Math.min(100, u.month.cost / u.budget * 100) : 0;
  pg.append(h('div.grid.g4', { style: { marginBottom: '16px' } },
    h('div.card.kpi', null, h('div.l', null, icon('chart', 'sm'), 'Cloud spend'), h('div.v', null, money(u.month.cost)), h('div.s', null, u.budget ? `of ${money(u.budget)} budget` : 'No budget set'), u.budget ? h('div.bar' + (pct > 90 ? '.bad' : pct > 75 ? '.warn' : ''), { style: { marginTop: '8px' } }, h('i', { style: { width: pct + '%' } })) : null),
    kpi('bolt', num(u.month.requests), 'Requests', `${num(u.today.requests)} today`),
    kpi('cube', num(u.month.input_tokens + u.month.output_tokens), 'Tokens'),
    kpi('warn', num(u.month.failures), 'Failed requests')));
  pg.append(h('div.card', { style: { marginBottom: '16px' } }, h('div.row.between', null, h('h2', null, 'Last 30 days'), h('div.small.muted', null, h('span.legend-dot', { style: { background: 'var(--accent)' } }), 'Cloud cost   ', h('span.legend-dot', { style: { background: '#34c759' } }), 'Local requests')), dailyChart(u.daily)));
  pg.append(h('div.grid.g2', null,
    h('div.card.pad0', null, h('h2', { style: { padding: '18px 20px 4px' } }, 'By model'), u.byModel.length ? h('table.t', null, h('thead', null, h('tr', null, ['Model', '', 'Requests', 'Cost'].map((x) => h('th', null, x)))), h('tbody', null, u.byModel.map((m) => h('tr', null, h('td.mono', null, m.model), h('td', null, m.provider === 'local' ? h('span.badge.ok', null, 'Local') : h('span.badge.info', null, m.provider)), h('td', null, num(m.requests)), h('td', null, money(m.cost)))))) : h('div.muted', { style: { padding: '0 20px 20px' } }, 'No usage yet.')),
    h('div.card.pad0', null, h('h2', { style: { padding: '18px 20px 4px' } }, 'Recent errors'), u.errors.length ? h('table.t', null, h('tbody', null, u.errors.map((e) => h('tr', null, h('td.faint.small', null, ago(e.ts)), h('td.small', null, h('b', null, e.model), h('div.muted', null, e.error)))))) : h('div.muted', { style: { padding: '0 20px 20px' } }, 'No errors.'))));
}
function dailyChart(daily) {
  const W = 700, H = 150, days = []; const map = new Map(daily.map((d) => [d.day, d]));
  for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push(map.get(d) || { day: d, cost: 0, local: 0 }); }
  const maxC = Math.max(0.01, ...days.map((d) => d.cost)), maxL = Math.max(1, ...days.map((d) => d.local));
  const bw = W / days.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 16}`); svg.setAttribute('class', 'chart'); svg.setAttribute('preserveAspectRatio', 'none');
  days.forEach((d, i) => {
    const mk = (cls, x, val, max) => { const r = document.createElementNS(svg.namespaceURI, 'rect'); const hh = Math.max(val ? 2 : 0, val / max * (H - 10)); r.setAttribute('class', cls); r.setAttribute('x', x); r.setAttribute('width', bw / 2 - 3); r.setAttribute('y', H - hh); r.setAttribute('height', hh); r.setAttribute('rx', 2.5); const t = document.createElementNS(svg.namespaceURI, 'title'); t.textContent = `${d.day}: ${money(d.cost)} cloud · ${d.local} local requests`; r.append(t); return r; };
    svg.append(mk('c', i * bw + 2, d.cost, maxC), mk('l', i * bw + bw / 2, d.local, maxL));
    if (i % 7 === 0) { const tx = document.createElementNS(svg.namespaceURI, 'text'); tx.setAttribute('x', i * bw + 2); tx.setAttribute('y', H + 13); tx.textContent = new Date(d.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); svg.append(tx); }
  });
  return svg;
}

// ---------------- OWNER AI
async function pageOwnerAI(root) {
  const [d, grants] = await Promise.all([api('/api/owner-ai'), api('/api/grants')]);
  const og = grants.filter((g) => g.kind === 'owner_ai');
  const wrap = h('div.chatmain', { style: { height: '100vh' } }); root.append(wrap);
  wrap.append(h('div.chathead', null, h('div.title', null, 'Owner AI'),
    h('span.lbl', null, og.length ? `Can read: ${og.map((g) => g.targetName).join(', ')}` : 'No organisations shared yet'),
    h('button.btn.sm', { onclick: () => ownerAccessModal(og) }, icon('key', 'sm'), 'Access'),
    h('button.btn.sm', { onclick: () => ownerSettingsModal(d.settings) }, icon('gear', 'sm'), 'Settings'),
    d.messages.length ? h('button.btn.sm.icon.ghost', { title: 'Clear conversation', onclick: guard(async () => { await api('/api/owner-ai/messages', { method: 'DELETE' }); route(); }) }, icon('trash')) : null));
  const msgs = h('div.msgs'); wrap.append(msgs);
  if (!d.messages.length) msgs.append(h('div.welcome', null, h('div.orb'), h('h1', null, 'Your Owner AI'),
    h('p', null, og.length ? `Private to you. It reads only what you have shared: ${og.map((g) => g.targetName).join(', ')}.` : 'Private to you. Choose which organisations it may read with Access.'),
    h('div.sugg', null, [['building', 'Which companies need my attention today?'], ['approve', 'Show me outstanding approvals across everything.'], ['chart', 'Summarise this week’s agent reports.'], ['bolt', 'Where are we spending the most on cloud AI?']].map(([ic, s]) => h('button', { onclick: () => go(s) }, icon(ic), s)))));
  d.messages.forEach((m) => msgs.append(renderMsg({ ...m, meta: m.meta || {} })));
  const ta = h('textarea', { rows: 1, placeholder: 'Ask across your companies', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } } });
  const btn = h('button.btn.primary.send', { onclick: () => go(), title: 'Send' }, icon('up'));
  wrap.append(h('div.composer', null, h('div.box', null, ta, h('div.tools', null, h('span.grow.small.faint', null, d.settings.cloud_allowed ? 'Local first · cloud allowed' : 'Local models only'), btn))));
  scrollDown(msgs, true);
  async function go(q) {
    const text = (q || ta.value).trim(); if (!text) return; ta.value = ''; btn.disabled = true;
    if (msgs.querySelector('.welcome')) clear(msgs);
    msgs.append(renderMsg({ role: 'user', content: text, meta: {} }));
    const live = renderMsg({ role: 'assistant', content: '', meta: {} }, true); msgs.append(live); scrollDown(msgs, true);
    const body = live.querySelector('.md'); let acc = '';
    try {
      await stream('/api/owner-ai/messages', { text }, {
        route: (x) => { clear(live.querySelector('.routeinfo')).append(h('span.spinner'), x.label); },
        delta: (x) => { acc += x.d; body.innerHTML = md(acc); scrollDown(msgs); },
        done: (x) => live.replaceWith(renderMsg({ ...x.message, meta: { ...x.message.meta, agent: null } })),
      });
    } catch (e) { body.classList.remove('cursor'); body.innerHTML = md(e.message); }
    btn.disabled = false; scrollDown(msgs, true);
  }
}
function ownerAccessModal(og) {
  const scopesAll = [['overview', 'Overview', 'Agent counts, approvals, overdue tasks, spend'], ['reports', 'Agent reports', 'Recent task results'], ['documents', 'Shared documents', 'Documents marked “Owner AI”'], ['memory', 'Memory', 'Organisation facts']];
  const state = new Map(og.map((g) => [g.target_org, new Set(g.scopes)]));
  const body = h('div', null, h('p.muted', { style: { marginTop: 0 } }, 'Choose the organisations and information the Owner AI may read. Each access is recorded in that organisation’s activity log.'),
    S.orgs.map((o) => {
      const on = state.has(o.id); const scopes = state.get(o.id) || new Set(['overview']);
      const sub = h('div', { style: { display: on ? '' : 'none', padding: '4px 16px 12px 58px' } }, scopesAll.map(([k, l, dsc]) => h('label.check', null, h('input', { type: 'checkbox', checked: scopes.has(k), onchange: (e) => { e.target.checked ? scopes.add(k) : scopes.delete(k); } }), h('div', null, l, h('div.help', { style: { margin: 0 } }, dsc)))));
      return h('div.list', { style: { marginBottom: '10px' } }, h('div.li', null, monogram(o), h('div.t', null, h('b', null, o.name)), toggle(on, (v) => { if (v) state.set(o.id, scopes); else state.delete(o.id); sub.style.display = v ? '' : 'none'; })), sub);
    }));
  modal('Owner AI Access', body, [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => {
    for (const g of og) if (!state.has(g.target_org)) await api('/api/grants/' + g.id, { method: 'DELETE' });
    for (const [orgId, scopes] of state) {
      const cur = og.find((g) => g.target_org === orgId);
      if (!cur || [...scopes].sort().join() !== cur.scopes.slice().sort().join()) await api('/api/grants', { body: { kind: 'owner_ai', target_org: orgId, scopes: [...scopes] } });
    }
    toast('Access updated'); route();
  } }], { wide: true });
}
function ownerSettingsModal(s) {
  let cloud = !!s.cloud_allowed; const budget = h('input', { type: 'number', min: 0, value: s.budget || 0 });
  modal('Owner AI Settings', h('div', null,
    h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Allow cloud models'), h('span', null, 'Off keeps everything on your own computers. If any shared organisation is “local only”, the Owner AI stays local.')), toggle(cloud, (v) => cloud = v))),
    h('div', { style: { marginTop: '14px' } }, field('Monthly cloud budget (USD, 0 = none)', budget))),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => { await api('/api/owner-ai/settings', { method: 'PUT', body: { cloud_allowed: cloud, budget: +budget.value } }); route(); } }]);
}
