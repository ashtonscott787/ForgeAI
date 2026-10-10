'use strict';
/* Agent control centre: overview, agent page (activity, live browser, files, settings), task timeline, agent editor */

const CAP_ICON = { files: 'folder', documents: 'doc', code: 'bolt', web: 'globe', browser: 'monitor', email: 'chat', shell: 'server', schedule: 'clock', memory: 'bulb', agents: 'users' };
const CAP_NAME = { files: 'Files', documents: 'Documents', code: 'Code & data', web: 'Web research', browser: 'Web browser', email: 'Email', shell: 'Computer commands', schedule: 'Schedules', memory: 'Memory', agents: 'Teamwork' };
const TOOL_ICON = (t) => ({ create_document: 'doc', create_chart: 'chart', convert_file: 'doc', run_javascript: 'bolt', run_command: 'server', web_search: 'search', fetch_url: 'globe', schedule_task: 'clock', notify_user: 'info', remember: 'bulb', ask_agent: 'users' }[t] || (/^browser_/.test(t || '') ? 'monitor' : /^email_/.test(t || '') ? 'chat' : /file/.test(t || '') ? 'folder' : /__/.test(t || '') ? 'network' : 'bolt'));
function agentAvatar(a, cls = '') { const el = h('div.avatar' + (cls ? '.' + cls : ''), { style: { background: `linear-gradient(145deg, color-mix(in srgb, ${a.color || '#0071e3'} 75%, #fff), ${a.color || '#0071e3'})` } }, initials(a.name)); return el; }
function agentStatus(a) {
  if (!a.enabled) return h('span.badge', null, 'Paused');
  if (a.waiting) return h('span.badge.warn', null, h('span.dot'), 'Needs you');
  if (a.busy) return h('span.badge.info', null, h('span.spinner', { style: { width: '10px', height: '10px', borderWidth: '1.5px' } }), 'Working');
  return h('span.badge.ok', null, h('span.dot'), 'Ready');
}

// ---------------- control centre
async function pageAgents(root) {
  const [agents, caps] = await Promise.all([orgApi('/agents'), api('/api/capabilities')]);
  const pg = h('div.page'); root.append(pg);
  const add = canOrg('agents') ? h('button.btn.primary', { onclick: () => agentEditor(null, agents, caps) }, icon('plus', 'sm'), 'New Agent') : null;
  pg.append(pageHead('Agents', `Your AI team at ${S.org.name}. Give them names, email addresses and abilities — then hand them work.`, add));
  if (!agents.length) {
    pg.append(emptyState('agent', 'Build your first agent', 'For example: “Mia — Inbox Assistant” with her own email address, or “Sam — Social Media” with a web browser.', canOrg('agents') ? h('button.btn.primary', { onclick: () => agentEditor(null, agents, caps) }, 'Create an Agent') : null));
    return;
  }
  const working = agents.filter((a) => a.busy).length, waiting = agents.filter((a) => a.waiting).length;
  const done = agents.reduce((n, a) => n + (a.stats ? a.stats.done : 0), 0);
  pg.append(h('div.grid.g4', { style: { marginBottom: '24px' } }, kpi('agent', agents.length, 'Agents'), kpi('bolt', working, 'Working now'), kpi('approve', waiting, 'Waiting for you', waiting ? 'Review approvals' : 'Nothing waiting', waiting ? '#/approvals' : null), kpi('check', done, 'Tasks done this week')));
  const grid = h('div.grid.gauto'); pg.append(grid);
  for (const a of agents) {
    grid.append(h('div.card.orgcard', { style: { '--org': a.color || 'var(--accent)' }, onclick: () => { location.hash = '#/agent/' + a.id; } },
      h('div.row.between.nowrap', { style: { position: 'relative' } }, h('div.row.nowrap', { style: { gap: '12px' } }, agentAvatar(a, 'lg'), h('div', { style: { minWidth: 0 } }, h('div.name', null, a.name), h('div.kind', null, a.title || a.description || 'Agent'))), agentStatus(a)),
      h('div.small', { style: { marginTop: '14px', minHeight: '38px', color: 'var(--text-2)' } }, a.activeTask ? (a.activeTask.current || a.activeTask.title) : a.lastTask ? `Last: ${a.lastTask.title}` : 'No work yet'),
      a.emails && a.emails.length ? h('div.row', { style: { gap: '6px', marginTop: '6px' } }, a.emails.map((e) => h('span.chip', null, icon('chat', 'sm'), e))) : null,
      h('div.foot', null, h('div.row', { style: { gap: '8px' } }, (a.tools || []).slice(0, 8).map((t) => h('span', { title: CAP_NAME[t] || t, style: { color: 'var(--accent)' } }, icon(CAP_ICON[t] || 'bolt', 'sm')))), h('span', null, a.stats ? `${a.stats.done} done · 7 days` : ''))));
  }
  S.pageTimer = setTimeout(() => location.hash === '#/agents' && !document.querySelector('.modal') && route(), 4000);
}

// ---------------- agent page
async function pageAgent(root, id, tab = 'activity', taskId) {
  const [a, agents, caps] = await Promise.all([id === 'assistant' ? null : orgApi('/agents/' + id), orgApi('/agents'), api('/api/capabilities')]);
  if (!a) { location.hash = '#/agents'; return; }
  const pg = h('div.page'); root.append(pg);
  pg.append(h('div.phead', null, h('div.row.nowrap', { style: { gap: '16px' } }, agentAvatar(a, 'xl'), h('div', null, h('div.row', { style: { gap: '10px' } }, h('h1', null, a.name), agentStatus(a)), h('div.sub', { style: { marginTop: '4px' } }, [a.title, ...(a.emails || [])].filter(Boolean).join(' · ') || 'Agent'))),
    h('div.row', null, h('a.btn', { href: '#/agents' }, 'All Agents'), canOrg('agents') ? h('button.btn', { onclick: () => agentEditor(a, agents, caps) }, icon('sliders', 'sm'), 'Settings') : null)));
  // give a task
  if (canOrg('tasks')) {
    const ta = h('textarea', { rows: 2, placeholder: `Give ${a.name} a task… e.g. “Check the inbox and draft replies to anything urgent”` });
    const go = guard(async () => { if (!ta.value.trim()) return; const r = await orgApi(`/agents/${a.id}/run`, { body: { input: ta.value } }); ta.value = ''; location.hash = `#/agent/${a.id}/activity/${r.taskId}`; });
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    pg.append(h('div.composer', { style: { padding: '0 0 22px' } }, h('div.box', { style: { maxWidth: 'none' } }, ta, h('div.tools', null, h('span.grow.small.faint', null, a.autonomy === 'full' ? 'Fully autonomous' : a.autonomy === 'ask_all' ? 'Asks before every action' : 'Asks before sending, posting, buying or deleting'), h('button.btn.primary.send', { onclick: go, title: 'Start' }, icon('up'))))));
  }
  const tabs = [['activity', 'Activity'], ...(a.browser && (a.tools || []).includes('browser') ? [['browser', 'Browser']] : []), ['files', 'Files']];
  pg.append(h('div.tabs', null, tabs.map(([k, l]) => h('a' + (tab === k ? '.on' : ''), { href: `#/agent/${a.id}/${k}` }, l))));
  const body = h('div'); pg.append(body);
  if (tab === 'activity') {
    if (taskId) { await taskTimeline(body, taskId, a); return; }
    const tasks = (await orgApi('/tasks')).filter((t) => t.agent_id === a.id);
    if (!tasks.length) body.append(emptyState('tasks', 'No work yet', `Give ${a.name} a task above.`));
    else body.append(h('div.list', null, tasks.slice(0, 40).map((t) => h('div.li.click', { onclick: () => { location.hash = `#/agent/${a.id}/activity/${t.id}`; } }, h('div', { style: { color: 'var(--accent)' } }, icon(t.status === 'done' ? 'check' : t.status === 'failed' ? 'warn' : 'clock')), h('div.t', null, h('b', null, t.title), h('span', null, `${t.created_by} · ${ago(t.created_at)}${t.output ? ' · ' + t.output.slice(0, 90) : t.error ? ' · ' + t.error.slice(0, 90) : ''}`)), statusBadge(t.status)))));
    if (a.busy) S.pageTimer = setTimeout(() => location.hash === `#/agent/${a.id}` && route(), 3000);
  }
  if (tab === 'browser') liveBrowser(body, a);
  if (tab === 'files') filesBrowser(body, 'workspace:' + a.id);
}

// ---------------- task timeline (live)
async function taskTimeline(box, taskId, a) {
  let since = 0; let t;
  const head = h('div'); const list = h('div.list'); const out = h('div');
  box.append(head, list, out);
  const stepRow = (s) => {
    const openable = s.content && s.content.length > 160;
    const det = h('div.small.mono', { style: { whiteSpace: 'pre-wrap', display: 'none', marginTop: '6px', color: 'var(--text-2)', maxHeight: '300px', overflow: 'auto' } }, s.content || '');
    const label = s.kind === 'call' ? s.content : s.kind === 'result' ? (s.content || '').split('\n')[0].slice(0, 160) : s.kind === 'approval' ? s.content : s.kind === 'declined' ? 'Declined: ' + (s.tool || '') : s.kind === 'thought' ? s.content.slice(0, 200) : s.content;
    return h('div.li' + (openable ? '.click' : ''), { style: { alignItems: 'flex-start', paddingLeft: s.kind === 'result' ? '44px' : '' }, onclick: () => { if (openable) det.style.display = det.style.display === 'none' ? '' : 'none'; } },
      h('div', { style: { color: s.kind === 'error' ? 'var(--red)' : s.kind === 'approval' ? 'var(--orange)' : s.kind === 'result' ? 'var(--text-3)' : 'var(--accent)', marginTop: '2px' } }, icon(s.kind === 'result' ? 'right' : s.kind === 'approval' ? 'lock' : s.kind === 'error' ? 'warn' : s.kind === 'thought' ? 'bulb' : TOOL_ICON(s.tool), 'sm')),
      h('div.t', null, h('span', { style: { color: s.kind === 'result' ? 'var(--text-2)' : 'var(--text)', fontSize: s.kind === 'result' ? '12.5px' : '13.5px' } }, label), s.files ? h('div.row', { style: { gap: '6px', marginTop: '6px' } }, s.files.map((f) => fileChip(f, a ? a.id : 'assistant'))) : null, det),
      h('span.faint.small', null, s.created_at ? new Date(s.created_at).toLocaleTimeString() : ''));
  };
  const load = async () => {
    t = await orgApi(`/tasks/${taskId}?since=${since}`);
    clear(head).append(h('div.row.between', { style: { marginBottom: '12px' } }, h('div', null, h('h2', { style: { margin: 0 } }, t.title), h('div.small.muted', null, `${t.created_by} · ${ago(t.created_at)}${t.model_used ? ' · ' + t.model_used : ''}`)),
      h('div.row', null, statusBadge(t.status), ['running', 'awaiting_approval', 'queued'].includes(t.status) && canOrg('tasks') ? h('button.btn.sm.danger', { onclick: guard(async () => { await orgApi(`/tasks/${taskId}/stop`, { body: {} }); load(); }) }, icon('stop', 'sm'), 'Stop') : null,
        ['done', 'failed'].includes(t.status) && canOrg('tasks') ? h('button.btn.sm', { onclick: guard(async () => { since = 0; clear(list); await orgApi(`/tasks/${taskId}/run`, { body: {} }); setTimeout(load, 800); }) }, icon('refresh', 'sm'), 'Run Again') : null)));
    if (t.status === 'running' && t.current) head.append(h('div.note.info', { style: { marginBottom: '12px' } }, h('span.spinner'), h('div', null, t.current)));
    if (!since && !t.steps.length) list.append(h('div.li', null, h('div.t', null, h('span', null, 'Starting…'))));
    if (!since && t.steps.length) clear(list);
    for (const s of t.steps) { list.append(stepRow(s)); since = Math.max(since, s.id); }
    clear(out);
    if (t.status === 'awaiting_approval') {
      const aps = (await orgApi('/approvals')).filter((x) => x.status === 'pending' && (x.payload || '').includes(taskId));
      for (const ap of aps) out.append(approvalCard(ap, load));
    }
    if (t.output) out.append(h('div.card', { style: { marginTop: '14px' } }, h('div.md', { html: md(t.output) }), t.files && t.files.length ? h('div.row', { style: { gap: '6px', marginTop: '12px' } }, t.files.map((f) => fileChip(f, a ? a.id : 'assistant'))) : null));
    if (t.error) out.append(h('div', { style: { marginTop: '12px' } }, note('warn', t.error)));
    if (['running', 'queued'].includes(t.status) && document.body.contains(list)) S.pageTimer = setTimeout(load, 1500);
  };
  await load();
}
function approvalCard(ap, after) {
  let p = {}; try { p = JSON.parse(ap.payload || '{}'); } catch {}
  return h('div.card', { style: { marginTop: '14px', borderColor: ap.kind === 'payment' ? 'var(--red)' : 'var(--orange)' } },
    h('div.row', null, icon(ap.kind === 'payment' ? 'warn' : 'lock'), h('b.grow', null, ap.title)),
    ap.kind === 'payment' ? h('div.small', { style: { color: 'var(--red)', margin: '6px 0' } }, 'This may spend money. Check the details in the agent’s browser before approving.') : null,
    ap.detail ? h('div.md.small', { style: { marginTop: '8px' }, html: md(ap.detail) }) : null,
    canOrg('approve') ? h('div.row', { style: { marginTop: '12px' } },
      h('button.btn.primary', { onclick: guard(async () => { await orgApi(`/approvals/${ap.id}/decide`, { body: { approve: true } }); toast('Approved'); refreshCounts(); setTimeout(after, 600); }) }, icon('check', 'sm'), 'Approve'),
      h('button.btn.danger', { onclick: guard(async () => { await orgApi(`/approvals/${ap.id}/decide`, { body: { approve: false } }); toast('Declined'); refreshCounts(); setTimeout(after, 600); }) }, 'Decline'),
      p.tool && /^browser_/.test(p.tool) ? h('span.small.muted', null, 'Tip: open the Browser tab to see the page.') : null) : h('div.small.muted', { style: { marginTop: '8px' } }, 'A manager must approve this.'));
}

// ---------------- live browser with take-control
function liveBrowser(box, a) {
  const url = h('input', { type: 'text', placeholder: 'Type a web address and press Enter' });
  const img = h('img', { style: { width: '100%', display: 'block', borderRadius: '0 0 12px 12px', cursor: 'crosshair', background: '#fff', minHeight: '200px' }, alt: 'Agent browser' });
  const status = h('span.small.faint');
  const typeBox = h('input', { type: 'text', placeholder: 'Type text into the page (e.g. to sign in) and press Enter' });
  const act = async (b) => { try { await orgApi(`/agents/${a.id}/browser`, { body: b }); } catch (e) { toast(e.message, true); } refresh(); };
  url.onkeydown = (e) => { if (e.key === 'Enter' && url.value.trim()) act({ action: 'open', url: url.value.trim() }); };
  typeBox.onkeydown = (e) => { if (e.key === 'Enter') { act({ action: 'type', text: typeBox.value }); typeBox.value = ''; } };
  img.onclick = (e) => { const r = img.getBoundingClientRect(); const scale = img.naturalWidth / r.width; act({ action: 'click', x: Math.round((e.clientX - r.left) * scale), y: Math.round((e.clientY - r.top) * scale) }); };
  box.append(note('info', `This is ${a.name}’s own browser — it keeps its own sign-ins. Sign in to the sites ${a.name} should use (webmail, social media, shops…) by clicking on the picture and typing below. ${S.shell ? '' : 'Or open the window on the server computer.'}`),
    h('div.card.pad0', { style: { marginTop: '14px' } },
      h('div.row.nowrap', { style: { padding: '10px 12px', gap: '8px', borderBottom: '1px solid var(--sep)' } },
        h('button.btn.sm.icon.ghost', { title: 'Back', onclick: () => act({ action: 'back' }) }, h('span', { style: { transform: 'rotate(180deg)', display: 'inline-flex' } }, icon('right', 'sm'))),
        h('div.grow', null, url), h('button.btn.sm.icon.ghost', { title: 'Scroll up', onclick: () => act({ action: 'scroll', direction: 'up' }) }, h('span', { style: { transform: 'rotate(180deg)', display: 'inline-flex' } }, icon('down', 'sm'))),
        h('button.btn.sm.icon.ghost', { title: 'Scroll down', onclick: () => act({ action: 'scroll', direction: 'down' }) }, icon('down', 'sm')),
        h('button.btn.sm', { title: 'Open the real window on the server computer', onclick: () => act({ action: 'show' }) }, 'Open Window')),
      img,
      h('div.row.nowrap', { style: { padding: '10px 12px', gap: '8px', borderTop: '1px solid var(--sep)' } }, h('div.grow', null, typeBox),
        ['Enter', 'Tab', 'Escape'].map((k) => h('button.btn.sm', { onclick: () => act({ action: 'key', key: k }) }, k)))),
    h('div.row.between', { style: { marginTop: '10px' } }, status, canOrg('manage') ? h('button.btn.sm.ghost', { onclick: guard(async () => { if (await confirmBox('Sign Out Everywhere?', `Clear all of ${a.name}’s browser sign-ins and cookies?`, 'Clear', true)) act({ action: 'clear' }); }) }, 'Clear sign-ins') : null));
  let busy = false;
  const refresh = async () => {
    if (busy || !document.body.contains(img)) return; busy = true;
    try {
      const r = await fetch(`/api/orgs/${S.org.id}/agents/${a.id}/browser?t=${Date.now()}`, { credentials: 'same-origin' });
      if (r.status === 204) status.textContent = 'The browser opens the first time it is used. Type an address above to start.';
      else if (r.ok) { const blob = await r.blob(); const old = img.src; img.src = URL.createObjectURL(blob); if (old.startsWith('blob:')) URL.revokeObjectURL(old); const u = decodeURIComponent(r.headers.get('x-page-url') || ''); if (document.activeElement !== url) url.value = u; status.textContent = decodeURIComponent(r.headers.get('x-page-title') || ''); }
    } catch {}
    busy = false;
  };
  refresh(); const iv = setInterval(() => { if (!document.body.contains(img)) return clearInterval(iv); refresh(); }, 1500);
}

// ---------------- agent editor
async function agentEditor(a, all, caps) {
  const [folders, mailboxes, connectors, mopts] = await Promise.all([orgApi('/folders').catch(() => []), orgApi('/mailboxes').catch(() => []), orgApi('/connectors').catch(() => []), orgApi('/model-options').catch(() => ({ local: [], cloud: [], profiles: [] }))]);
  a = a || { name: '', title: '', description: '', instructions: '', model_mode: 'auto', sensitivity: 'normal', schedule: { type: 'none' }, schedule_prompt: '', can_talk_to: ['*'], requires_approval: 0, enabled: 1, color: ['#0071e3', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa'][Math.floor(Math.random() * 6)], autonomy: 'ask_risky', tools: ['files', 'documents', 'code', 'web', 'memory', 'agents'], folders: [], mailboxes: [], mcp: [], max_steps: 30, confirm_payments: 1, inbox_watch: { enabled: false } };
  const st = { ...a, tools: new Set(a.tools || []), folders: new Map((a.folders || []).map((f) => [f.id || f, f.mode || 'readwrite'])), mailboxes: new Set(a.mailboxes || []), mcp: new Set(a.mcp || []), inbox: { minutes: 5, instruction: '', ...(a.inbox_watch || {}) } };
  const f = {
    name: h('input', { type: 'text', value: a.name, placeholder: 'e.g. Mia' }), title: h('input', { type: 'text', value: a.title || '', placeholder: 'e.g. Inbox Assistant' }),
    color: h('input', { type: 'color', value: a.color || '#0071e3' }),
    description: h('input', { type: 'text', value: a.description, placeholder: 'What this agent looks after' }),
    instructions: h('textarea', { rows: 5, value: a.instructions, placeholder: 'How to work, tone of voice, what to check, what never to do…' }),
    mode: modelPicker({ ...mopts, pipelines: [] }, a.model_mode || 'auto', () => {}, { raw: true, noPipelines: true }), sens: sel(Object.entries(SENS_NAMES), a.sensitivity),
    place: sel((mopts.places || [{ value: 'auto', label: 'Anywhere (automatic)' }]).map((p) => [p.value, p.label]).concat(a.place && !(mopts.places || []).some((p) => p.value === a.place) ? [[a.place, a.place + ' (not available now)']] : []), a.place || 'auto'),
    stype: sel([['none', 'Only when given work'], ['interval', 'Every few minutes'], ['daily', 'Daily at a set time']], (a.schedule || {}).type || 'none'),
    minutes: h('input', { type: 'number', min: 5, value: (a.schedule || {}).minutes || 60 }), time: h('input', { type: 'time', value: (a.schedule || {}).time || '08:00' }),
    sprompt: h('textarea', { rows: 2, value: a.schedule_prompt, placeholder: 'What to do each time' }),
    steps: h('input', { type: 'number', min: 3, max: 100, value: a.max_steps || 30, style: { width: '100px' } }),
    runs: h('input', { type: 'number', min: 0, value: a.runs_per_day || 0, style: { width: '100px' } }), budget: h('input', { type: 'number', min: 0, step: '0.5', value: a.budget_month || 0, style: { width: '100px' } }),
    inboxMin: h('input', { type: 'number', min: 2, value: st.inbox.minutes, style: { width: '90px' } }), inboxIns: h('input', { type: 'text', value: st.inbox.instruction || '', placeholder: 'e.g. Reply to routine questions; flag anything about money to me' }),
  };
  const li = (title, sub, ctl) => h('div.li', null, h('div.t', null, h('b', null, title), sub ? h('span', null, sub) : null), ctl);
  const capRows = Object.keys(caps.capabilities).map((k) => li(h('span', null, icon(CAP_ICON[k] || 'bolt', 'sm'), ' ', CAP_NAME[k] || k), caps.capabilities[k] + (k === 'browser' && !caps.browser ? ' — available in the ForgeAI desktop app' : k === 'shell' ? ' — full access to this computer; each command needs approval unless fully autonomous' : ''), toggle(st.tools.has(k), (v) => (v ? st.tools.add(k) : st.tools.delete(k)))));
  const folderRows = folders.length ? folders.map((fd) => { const cur = st.folders.get(fd.id); const s2 = sel([['', 'No access'], ['read', 'Read only'], ...(fd.mode === 'readwrite' ? [['readwrite', 'Read & write']] : [])], cur || '', { style: { width: '150px' }, onchange: (e) => (e.target.value ? st.folders.set(fd.id, e.target.value) : st.folders.delete(fd.id)) }); return li(h('span', null, icon('folder', 'sm'), ' ', fd.name), fd.path + (fd.exists ? '' : ' (missing)'), s2); })
    : [li('No folders shared yet', isPlatform() ? 'Share folders with this organisation in Organisation → Folders.' : 'Ask the platform owner to share folders with this organisation.', null)];
  const mbRows = mailboxes.length ? mailboxes.map((m) => li(h('span', null, icon('chat', 'sm'), ' ', m.email), m.name || m.status_detail || '', toggle(st.mailboxes.has(m.id), (v) => (v ? st.mailboxes.add(m.id) : st.mailboxes.delete(m.id))))) : [li('No mailboxes yet', 'Add one in Integrations → Mailboxes (1st Domains, Gmail, Outlook…).', h('a.btn.sm', { href: '#/integrations/mail' }, 'Add'))];
  const mcpRows = connectors.length ? connectors.map((c) => li(h('span', null, icon('network', 'sm'), ' ', c.name), `${c.tools.length} tools · ${c.status || ''}`, toggle(st.mcp.has(c.id), (v) => (v ? st.mcp.add(c.id) : st.mcp.delete(c.id))))) : [li('No connectors yet', 'Connect outside tools and AIs in Integrations → Connectors.', h('a.btn.sm', { href: '#/integrations/connectors' }, 'Add'))];
  let autonomy = a.autonomy || 'ask_risky';
  const autoSeg = h('div.seg', null, [['ask_all', 'Ask every step'], ['ask_risky', 'Ask for risky actions'], ['full', 'Fully autonomous']].map(([k, l]) => h('button' + (autonomy === k ? '.on' : ''), { type: 'button', onclick: (e) => { autonomy = k; autoSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
  let confirmPay = a.confirm_payments !== 0, reqApproval = !!a.requires_approval, enabled = a.enabled !== 0;
  const schedArea = h('div'); const drawSched = () => { clear(schedArea); const t = f.stype.value; if (t === 'interval') schedArea.append(field('Every (minutes)', f.minutes)); if (t === 'daily') schedArea.append(field('Time', f.time)); if (t !== 'none') schedArea.append(field('Instruction for each run', f.sprompt)); };
  f.stype.onchange = drawSched; drawSched();
  const sec = (t) => h('div.section-title', null, t);
  const body = h('div', null,
    sec('Identity'), h('div.grid.g3', { style: { gap: '12px' } }, field('Name', f.name), field('Job title', f.title), field('Colour', f.color)), field('Responsible for', f.description), field('Instructions', f.instructions),
    sec('Abilities'), h('div.list', null, capRows),
    sec('Folders it can use'), h('div.list', null, li(h('span', null, icon('folder', 'sm'), ' Workspace'), 'Its own folder for everything it creates — always available', h('span.badge.ok', null, 'Read & write')), ...folderRows),
    sec('Email'), h('div.list', null, mbRows, mailboxes.length ? li('Watch the inbox', 'Handle new email automatically', h('div.row.nowrap', null, f.inboxMin, h('span.small.muted', null, 'min'), toggle(st.inbox.enabled, (v) => { st.inbox.enabled = v; }))) : null), mailboxes.length ? field('When new email arrives', f.inboxIns) : null,
    sec('Connectors'), h('div.list', null, mcpRows),
    sec('Independence'), h('div.list', null, li('How much to ask you', 'Risky = sending, posting, buying, deleting, running commands, changing shared files.', autoSeg), li('Always confirm payments', 'Even when fully autonomous.', toggle(confirmPay, (v) => { confirmPay = v; })), li('Results need approval', 'Hold finished work for review.', toggle(reqApproval, (v) => { reqApproval = v; })), li('Most steps per task', null, f.steps), li('Enabled', null, toggle(enabled, (v) => { enabled = v; }))),
    sec('Model'), h('div.grid.g2', { style: { gap: '12px' } }, field('Model', f.mode, 'Tools need a model that supports them: Claude, OpenAI, Gemini, or a local model like Qwen 3.'), field('Data', f.sens)),
    field('Runs on', f.place, 'Which computer or cluster this agent uses by default. It can also move itself to another computer while it works (it sees which ones are free).'),
    sec('Schedule'), field('Runs', f.stype), schedArea,
    sec('Limits'), h('div.list', null, li('Tasks per day', '0 = no limit. Scheduled runs and inbox checks count too.', f.runs), li('Cloud budget per month (US$)', '0 = no limit. Estimated from list prices.', f.budget)));
  modal(a.id ? a.name : 'New Agent', body, [
    a.id ? { label: 'Delete', danger: true, onClick: async () => { if (!(await confirmBox('Delete Agent?', `Delete ${a.name}? Its work history is kept.`, 'Delete', true))) return false; await orgApi('/agents/' + a.id, { method: 'DELETE' }); location.hash = '#/agents'; route(); } } : null,
    { label: 'Cancel', onClick: () => {} },
    { label: 'Save', primary: true, onClick: async () => {
      if (!f.name.value.trim()) throw new Error('Give the agent a name');
      const payload = { name: f.name.value, title: f.title.value, color: f.color.value, description: f.description.value, instructions: f.instructions.value, model_mode: f.mode.getValue(), sensitivity: f.sens.value, place: f.place.value,
        schedule: f.stype.value === 'interval' ? { type: 'interval', minutes: +f.minutes.value } : f.stype.value === 'daily' ? { type: 'daily', time: f.time.value } : { type: 'none' }, schedule_prompt: f.sprompt.value,
        can_talk_to: a.can_talk_to || ['*'], requires_approval: reqApproval, enabled, autonomy, confirm_payments: confirmPay, max_steps: +f.steps.value,
        tools: [...st.tools], folders: [...st.folders].map(([id, mode]) => ({ id, mode })), mailboxes: [...st.mailboxes], mcp: [...st.mcp],
        inbox_watch: { enabled: st.inbox.enabled, minutes: +f.inboxMin.value, instruction: f.inboxIns.value }, runs_per_day: +f.runs.value, budget_month: +f.budget.value };
      if (a.id) await orgApi('/agents/' + a.id, { method: 'PUT', body: payload }); else { const r = await orgApi('/agents', { body: payload }); location.hash = '#/agent/' + r.id; }
      toast('Saved'); route();
    } }].filter(Boolean), { wide: true });
}

function agentModelSelect(o, value) {
  const s = h('select', null,
    (o.profiles || []).length ? h('optgroup', { label: 'My models' }, o.profiles.map((p) => h('option', { value: 'profile:' + p.id }, p.name))) : null,
    h('optgroup', { label: 'Automatic' }, ['auto', 'local_fast', 'local_powerful', 'claude', 'openai', 'google'].map((k) => h('option', { value: k }, MODE_NAMES[k]))),
    (o.local || []).length ? h('optgroup', { label: 'On your computers' }, o.local.map((m) => h('option', { value: 'local:' + m.id }, m.name || m.id))) : null,
    ...(o.cloud || []).map((c) => h('optgroup', { label: c.name }, c.models.slice(0, 80).map((m) => h('option', { value: `cloud:${c.providerId}:${m}` }, m)))));
  s.value = value || 'auto'; if (s.value !== (value || 'auto')) s.value = 'auto';
  return s;
}
