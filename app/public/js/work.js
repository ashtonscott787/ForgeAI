'use strict';
/* Files, Integrations (mailboxes, connectors, web search, API), Scheduled, Notifications, rich chat blocks */

const PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp|svg|txt|md|csv|json|html?)$/i;
const fileIcon = (n) => (/\.(png|jpe?g|gif|webp|svg)$/i.test(n) ? 'image' : /\.(xlsx|csv)$/i.test(n) ? 'chart' : /\.(pptx)$/i.test(n) ? 'grid' : 'doc');
function wsRef(f, agentKey) { const m = /^Workspace\/(.+)$/.exec(f.path || ''); return m ? { root: 'workspace:' + (agentKey || 'assistant'), path: m[1] } : null; }
const rawUrl = (root, p, inline) => `/api/orgs/${S.org.id}/files/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
function fileChip(f, agentKey) {
  const r = wsRef(f, agentKey);
  if (!r) return h('span.chip', null, icon('doc', 'sm'), f.path || f.name);
  return h('a.chip', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); previewFile(r.root, r.path); }, title: 'Open' }, icon(fileIcon(f.name || r.path), 'sm'), f.name || r.path.split('/').pop());
}
function previewFile(root, p) {
  const name = p.split('/').pop();
  const dl = h('a.btn', { href: rawUrl(root, p), download: name }, icon('download', 'sm'), 'Download');
  const reveal = window.forgeDesktop && root.startsWith('workspace:') ? h('button.btn', { onclick: () => toast('Saved on the server computer in the ForgeAI data folder') }, 'Where is it?') : null;
  let view;
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) view = h('img', { src: rawUrl(root, p, true), style: { maxWidth: '100%', borderRadius: '10px' } });
  else if (PREVIEWABLE.test(name)) view = h('iframe', { src: rawUrl(root, p, true), style: { width: '100%', height: '65vh', border: '0', borderRadius: '10px', background: '#fff' }, sandbox: /\.(html?|svg)$/i.test(name) ? 'allow-scripts' : undefined });
  else view = h('div.empty', null, h('div.big', null, icon(fileIcon(name))), h('h2', null, name), h('div', null, 'Download to open it in Word, PowerPoint, Excel or another app.'));
  modal(name, view, [{ label: 'Close', onClick: () => {} }, { label: 'Download', primary: true, onClick: () => { dl.click(); return false; } }], { wide: true });
  void reveal;
}

// ---------------- file browser
async function filesBrowser(box, root, sub = '') {
  const load = async (p) => {
    const d = await orgApi(`/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`);
    clear(box);
    const crumbs = h('div.row', { style: { gap: '6px', marginBottom: '10px' } }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(''); } }, d.root), ...p.split('/').filter(Boolean).map((seg, i, arr) => [h('span.faint', null, '/'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(arr.slice(0, i + 1).join('/')); } }, seg)]).flat());
    const up = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: guard(async (e) => { for (const f of e.target.files) await orgApi(`/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`, { body: { name: f.name, data: await readFileB64(f) } }); toast('Uploaded'); load(p); }) });
    box.append(h('div.row.between', null, crumbs, d.canWrite ? h('div', null, up, h('button.btn.sm', { onclick: () => up.click() }, icon('share', 'sm'), 'Upload')) : null));
    if (!d.items.length) { box.append(emptyState('folder', 'Nothing here yet', 'Files the agent creates appear here.')); return; }
    box.append(h('div.list', null, d.items.map((it) => h('div.li.click', { onclick: () => (it.dir ? load((p ? p + '/' : '') + it.name) : previewFile(root, (p ? p + '/' : '') + it.name)) },
      h('div', { style: { color: 'var(--accent)' } }, icon(it.dir ? 'folder' : fileIcon(it.name))), h('div.t', null, h('b', null, it.name), h('span', null, it.dir ? 'Folder' : `${bytes(it.size)} · ${ago(it.modified)}`)),
      !it.dir ? h('a.btn.sm.icon.ghost', { href: rawUrl(root, (p ? p + '/' : '') + it.name), download: it.name, title: 'Download', onclick: (e) => e.stopPropagation() }, icon('download', 'sm')) : null,
      d.canWrite ? h('button.btn.sm.icon.ghost', { title: 'Delete', onclick: guard(async (e) => { e.stopPropagation(); if (!(await confirmBox('Delete?', `Delete ${it.name}?`, 'Delete', true))) return; await orgApi(`/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent((p ? p + '/' : '') + it.name)}`, { method: 'DELETE' }); load(p); }) }, icon('trash', 'sm')) : null))));
  };
  await load(sub);
}
async function pageFiles(root) {
  const [agents, folders] = await Promise.all([orgApi('/agents'), orgApi('/folders').catch(() => [])]);
  const pg = h('div.page'); root.append(pg);
  const roots = [['workspace:assistant', `${S.platformName} assistant`], ...agents.map((a) => ['workspace:' + a.id, a.name]), ...(canOrg('manage') ? folders.map((f) => [f.id, `${f.name} (shared folder)`]) : [])];
  let cur = store('filesRoot') || 'workspace:assistant'; if (!roots.find((r) => r[0] === cur)) cur = roots[0][0];
  const box = h('div');
  const pick = sel(roots, cur, { style: { width: 'auto', minWidth: '240px' }, onchange: (e) => { store('filesRoot', e.target.value); filesBrowser(box, e.target.value); } });
  pg.append(pageHead('Files', 'Everything your assistant and agents have made, plus the folders you shared with them.', pick));
  pg.append(box); filesBrowser(box, cur);
}

// ---------------- scheduled tasks
async function pageScheduled(root) {
  const [jobs, agents] = await Promise.all([orgApi('/jobs'), orgApi('/agents')]);
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Scheduled', 'Reminders and recurring work — like a daily brief. Results arrive in chat and as notifications. You can also just ask in chat: “every weekday at 8am, brief me on…”.',
    canOrg('tasks') ? h('button.btn.primary', { onclick: () => jobModal(agents) }, icon('plus', 'sm'), 'Schedule') : null));
  if (!jobs.length) { pg.append(emptyState('clock', 'Nothing scheduled', 'Try: “Every weekday at 8am, give me a brief of today’s calendar, unread email and approvals.”')); return; }
  const rep = { once: 'Once', hourly: 'Every hour', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week' };
  pg.append(h('div.list', null, jobs.map((j) => h('div.li', null, h('div', { style: { color: 'var(--accent)' } }, icon('clock')), h('div.t', null, h('b', null, j.title), h('span', null, `${rep[j.repeat.type] || ''} · ${j.enabled ? 'next ' + new Date(j.next_run).toLocaleString() : 'paused'} · ${j.agent_name || S.platformName}${j.last_run ? ' · last ran ' + ago(j.last_run) : ''}`)),
    j.conv_id ? h('a.btn.sm.ghost', { href: '#/chat/' + j.conv_id }, 'Results') : null,
    canOrg('tasks') ? h('button.btn.sm', { onclick: guard(async () => { await orgApi(`/jobs/${j.id}/run`, { body: {} }); toast('Started'); setTimeout(route, 800); }) }, 'Run Now') : null,
    canOrg('tasks') ? toggle(j.enabled, guard(async (v) => { await orgApi('/jobs/' + j.id, { method: 'PUT', body: { enabled: v } }); })) : null,
    canOrg('tasks') ? h('button.btn.sm.icon.ghost', { onclick: guard(async () => { await orgApi('/jobs/' + j.id, { method: 'DELETE' }); route(); }) }, icon('trash', 'sm')) : null))));
}
function jobModal(agents) {
  const title = h('input', { type: 'text', placeholder: 'e.g. Morning brief' });
  const ins = h('textarea', { rows: 4, placeholder: 'What should happen, e.g. “Summarise unread email, today’s approvals and anything overdue.”' });
  const when = h('input', { type: 'datetime-local', value: new Date(Date.now() + 3600e3 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) });
  const repeat = sel([['once', 'Once'], ['hourly', 'Every hour'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week']], 'daily');
  const who = sel([['', S.platformName + ' assistant'], ...agents.map((a) => [a.id, a.name])], '');
  modal('Schedule', h('div', null, field('Title', title), field('Instruction', ins), h('div.grid.g3', { style: { gap: '12px' } }, field('First run', when), field('Repeat', repeat), field('Who does it', who))),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Schedule', primary: true, onClick: async () => { await orgApi('/jobs', { body: { title: title.value, instruction: ins.value, when: new Date(when.value).toISOString(), repeat: repeat.value, agent_id: who.value || null } }); route(); } }]);
}

// ---------------- integrations
async function pageIntegrations(root, tab = 'mail') {
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Integrations', 'Connect email accounts, outside tools and other AIs — and choose where agents search the web.'));
  const tabs = [['mail', 'Mailboxes'], ['connectors', 'Connectors'], ['search', 'Web Search'], ['api', 'API for other AIs']];
  pg.append(h('div.tabs', null, tabs.map(([k, l]) => h('a' + (tab === k ? '.on' : ''), { href: '#/integrations/' + k }, l))));
  const body = h('div'); pg.append(body);
  if (tab === 'mail') {
    const list = await orgApi('/mailboxes');
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, `Email accounts for ${S.org.name}. Passwords are encrypted and never shown to agents. Give mailboxes to agents in each agent’s settings.`), canOrg('manage') ? h('button.btn.primary.sm', { onclick: () => mailboxWizard() }, icon('plus', 'sm'), 'Connect Mailbox') : null));
    body.append(list.length ? h('div.list', null, list.map((m) => h('div.li', null, icon('mail'), h('div.t', null, h('b', null, m.email), h('span', null, `${m.name ? m.name + ' · ' : ''}${m.imap_host}`), h('span', { style: { whiteSpace: 'normal', color: m.status === 'connected' ? '' : 'var(--orange)' } }, m.status === 'connected' ? 'Reading and sending work' : `Reading ${m.read_ok ? 'works' : 'fails'} · Sending ${m.send_ok ? 'works' : 'fails'} — ${m.status_detail || ''}`)), statusBadge(m.status),
      h('a.btn.sm', { href: '#/mail/' + m.id }, 'Open'),
      canOrg('manage') && m.send_ok ? h('button.btn.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await sendTestEmail(m); }) }, 'Send Test') : null,
      canOrg('manage') ? h('button.btn.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; const r = await orgApi(`/mailboxes/${m.id}/test`, { body: {} }); toast(r.status === 'connected' ? 'Reading and sending work' : r.status_detail, r.status !== 'connected'); route(); }) }, 'Test') : null,
      canOrg('manage') ? h('button.btn.sm.ghost', { onclick: () => mailboxWizard(m) }, 'Settings') : null))) : emptyState('mail', 'No mailboxes yet', 'Connect an address like hello@yourcompany.co.nz — just the address and password.', canOrg('manage') ? h('button.btn.primary', { onclick: () => mailboxWizard() }, 'Connect Mailbox') : null));
  }
  if (tab === 'connectors') {
    const list = await orgApi('/connectors');
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, 'Connectors use the Model Context Protocol (MCP) — the open standard many apps and AI services offer. Each connector adds tools that you can give to agents.'), canOrg('manage') ? h('button.btn.primary.sm', { onclick: () => connectorModal() }, icon('plus', 'sm'), 'Add Connector') : null));
    body.append(list.length ? h('div.list', null, list.map((c) => h('div.li', { style: { alignItems: 'flex-start' } }, icon('network'), h('div.t', null, h('b', null, c.name, c.orgName ? '' : h('span.badge', { style: { marginLeft: '6px' } }, 'All organisations')), h('span', null, `${c.transport === 'stdio' ? 'Runs: ' + c.command + ' ' + c.args.join(' ') : c.url} · ${c.tools.length} tools${c.status_detail ? ' · ' + c.status_detail : ''}`),
        c.tools.length ? h('span', { style: { marginTop: '4px' } }, c.tools.slice(0, 12).map((t) => t.name).join(', ') + (c.tools.length > 12 ? '…' : '')) : null, c.signInUrl ? h('a', { href: c.signInUrl, target: '_blank' }, 'Sign in to connect →') : null),
      statusBadge(c.status === 'needs_sign_in' ? 'pending' : c.status), h('button.btn.sm', { onclick: guard(async () => { await api(`/api/connectors/${c.id}/refresh`, { body: {} }); route(); }) }, 'Reconnect'),
      h('button.btn.sm.icon.ghost', { title: 'Remove', onclick: guard(async () => { if (!(await confirmBox('Remove Connector?', `Remove ${c.name}?`, 'Remove', true))) return; await api('/api/connectors/' + c.id, { method: 'DELETE' }); route(); }) }, icon('trash', 'sm'))))) : emptyState('network', 'No connectors yet', 'Add any MCP server by web address or as a program on the server computer.'));
    body.append(h('div', { style: { marginTop: '14px' } }, note('info', h('b', null, 'About Canva, Figma and other big apps: '), 'some official connectors only accept a short list of approved apps (Figma’s does, for example). If one refuses to connect, give the agent the Web browser ability instead — it can sign in and work on the website directly — or use the app’s developer API through a connector that supports keys.')));
  }
  if (tab === 'search') {
    if (!isPlatform()) { body.append(emptyState('lock', 'Platform admins only')); return; }
    const s = await api('/api/settings/search');
    const prov = sel([['auto', 'Automatic — use a connected Claude, OpenAI or Gemini account'], ['brave', 'Brave Search API'], ['tavily', 'Tavily'], ['searxng', 'SearXNG (self-hosted)']], s.provider);
    const key = h('input', { type: 'password', placeholder: s.hasKey ? 'Key saved — paste to replace' : 'API key' }); const url = h('input', { type: 'url', value: s.url, placeholder: 'https://search.example.com' });
    body.append(h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Search with'), h('span', null, 'Used by the Web research ability. Research answers include their sources.')), h('div.ctl', null, prov)),
      h('div.li', null, h('div.t', null, h('b', null, 'API key'), h('span', null, 'For Brave or Tavily.')), h('div.ctl', null, key)), h('div.li', null, h('div.t', null, h('b', null, 'SearXNG address')), h('div.ctl', null, url))),
    h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: guard(async () => { await api('/api/settings/search', { method: 'PUT', body: { provider: prov.value, key: key.value || undefined, url: url.value } }); toast('Saved'); }) }, 'Save')));
  }
  if (tab === 'api') {
    if (!canOrg('manage')) { body.append(emptyState('lock', 'Admins only')); return; }
    const keys = await orgApi('/api-keys');
    const base = location.origin;
    body.append(note('info', h('div', null, 'Other apps and AIs can use ', h('b', null, S.org.name), '’s assistant and agents through an OpenAI-compatible API. Base URL: ', h('span.mono', null, base + '/v1'), ' · model: ', h('span.mono', null, 'assistant'), ' or ', h('span.mono', null, 'agent:<name>'), '. Approvals still apply.')),
      h('div.row.between', { style: { margin: '16px 0 10px' } }, h('div.section-title', { style: { margin: 0 } }, 'API keys'), h('button.btn.primary.sm', { onclick: guard(async () => { const n = prompt('Name for this key (e.g. Zapier)'); if (!n) return; const r = await orgApi('/api-keys', { body: { name: n } }); modal('Copy Your Key', h('div', null, h('p', null, 'This key is shown only once.'), h('input.mono', { type: 'text', readonly: true, value: r.key, onclick: (e) => e.target.select() })), [{ label: 'Done', primary: true, onClick: () => route() }]); }) }, icon('plus', 'sm'), 'New Key')),
      keys.length ? h('div.list', null, keys.map((k) => h('div.li', null, icon('key'), h('div.t', null, h('b', null, k.name), h('span', null, `${k.hint} · by ${k.created_by} · ${k.last_used ? 'used ' + ago(k.last_used) : 'never used'}`)), h('button.btn.sm.danger', { onclick: guard(async () => { await orgApi('/api-keys/' + k.id, { method: 'DELETE' }); route(); }) }, 'Revoke')))) : h('div.card', null, h('span.muted', null, 'No keys yet.')));
  }
}
function connectorModal() {
  let kind = 'http';
  const name = h('input', { type: 'text', placeholder: 'e.g. Supabase, GitHub, Notion' });
  const url = h('input', { type: 'url', placeholder: 'https://example.com/mcp' });
  const bearer = h('input', { type: 'password', placeholder: 'API key / token (optional — leave empty to sign in instead)' });
  const cmd = h('input', { type: 'text', placeholder: 'e.g. npx' }); const args = h('input', { type: 'text', placeholder: 'e.g. -y @some/mcp-server --flag' });
  const env = h('textarea', { rows: 3, class: 'mono', placeholder: 'SECRET_NAME=value (one per line, stored encrypted)' });
  const scope = sel([...(isPlatform() ? [['', 'All organisations']] : []), [S.org.id, 'Only ' + S.org.name]], isPlatform() ? '' : S.org.id);
  const area = h('div');
  const draw = () => { clear(area); if (kind === 'http') area.append(field('Web address', url), field('Access key', bearer, 'Without a key, ForgeAI opens a sign-in window on the server computer if the connector supports it.')); else area.append(note('warn', 'This runs a program on the server computer with your account’s permissions. Only add programs you trust. It usually needs Node.js or Python installed.'), h('div', { style: { height: '12px' } }), h('div.grid.g2', { style: { gap: '12px' } }, field('Command', cmd), field('Arguments', args)), field('Secrets', env)); };
  const seg = h('div.seg', null, [['http', 'Web address'], ['stdio', 'Program on this computer']].map(([k, l]) => h('button' + (k === kind ? '.on' : ''), { type: 'button', onclick: (e) => { kind = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, l)));
  draw();
  modal('Add Connector', h('div', null, field('Name', name), field('Type', seg), area, field('Available to', scope)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Connect', primary: true, onClick: async () => {
      const r = await api('/api/connectors', { body: { name: name.value, transport: kind, url: url.value, bearer: bearer.value, command: cmd.value, args: args.value, env: env.value, org_id: scope.value || null } });
      toast(r.status === 'connected' ? `Connected — ${r.tools.length} tools` : r.status === 'needs_sign_in' ? 'Finish signing in in the window that opened' : 'Saved — ' + (r.status_detail || r.status), r.status === 'error'); route();
    } }], { wide: true });
}

// ---------------- notifications
async function notificationsPanel() {
  const list = await api('/api/notifications');
  api('/api/notifications/read', { body: {} }).then(() => { S.counts.notes = 0; const b = document.querySelector('[data-count=notes]'); if (b) b.style.display = 'none'; });
  modal('Notifications', list.length ? h('div.list', null, list.map((n) => h('div.li' + (n.link ? '.click' : ''), { onclick: () => { if (n.link) { document.querySelector('.modal-bg').remove(); if (n.orgId !== S.org.id) switchOrg(n.orgId, n.link); else location.hash = n.link; } } }, h('div', { style: { color: n.read ? 'var(--text-3)' : 'var(--accent)' } }, icon('info', 'sm')), h('div.t', null, h('b', null, n.title), h('span', null, `${n.orgName} · ${ago(n.created_at)} — ${n.body}`))))) : emptyState('check', 'No notifications'), []);
}
async function refreshNotes() {
  try { const list = await api('/api/notifications'); S.counts.notes = list.filter((n) => !n.read).length; const b = document.querySelector('[data-count=notes]'); if (b) { b.textContent = S.counts.notes; b.style.display = S.counts.notes ? '' : 'none'; } } catch {}
}

// ---------------- rich blocks inside chat messages: charts, diagrams, mini web pages
function chartFromSpec(spec) {
  const W = 640, H = 300, P = { l: 48, r: 16, t: spec.title ? 34 : 12, b: 44 };
  const colors = ['var(--accent)', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa'];
  const labels = spec.labels || []; const series = (spec.series || []).map((s) => ({ name: s.name || '', values: (s.values || []).map(Number) }));
  const svgNS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.style.height = 'auto';
  const el = (t, a, txt) => { const e = document.createElementNS(svgNS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt != null) e.textContent = txt; svg.append(e); return e; };
  if (spec.title) el('text', { x: P.l, y: 20, 'font-size': 14, 'font-weight': 600, fill: 'currentColor' }, spec.title);
  if (spec.type === 'pie') {
    const vals = (series[0] || { values: [] }).values; const tot = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1; let a0 = -Math.PI / 2; const cx = 160, cy = (H + P.t) / 2, r = 110;
    vals.forEach((v, i) => { const a1 = a0 + (Math.max(0, v) / tot) * 2 * Math.PI; el('path', { d: `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`, fill: colors[i % colors.length], stroke: 'var(--surface)', 'stroke-width': 2 }); el('rect', { x: 320, y: P.t + 14 + i * 24, width: 12, height: 12, rx: 3, fill: colors[i % colors.length] }); el('text', { x: 340, y: P.t + 24 + i * 24, 'font-size': 12, fill: 'currentColor' }, `${labels[i] || ''} — ${Math.round((v / tot) * 1000) / 10}%`); a0 = a1; });
    return svg;
  }
  const all = series.flatMap((s) => s.values); const max = Math.max(0, ...all) || 1, min = Math.min(0, ...all); const iw = W - P.l - P.r, ih = H - P.t - P.b; const Y = (v) => P.t + ih - ((v - min) / (max - min || 1)) * ih; const n = Math.max(1, labels.length);
  for (let k = 0; k <= 4; k++) { const v = min + ((max - min) * k) / 4; el('line', { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), stroke: 'var(--sep)' }); el('text', { x: P.l - 6, y: Y(v) + 4, 'font-size': 10, 'text-anchor': 'end' }, Math.round(v * 100) / 100); }
  labels.forEach((lb, i) => el('text', { x: P.l + (iw / n) * (i + 0.5), y: H - P.b + 16, 'font-size': 10, 'text-anchor': 'middle' }, String(lb).slice(0, 12)));
  series.forEach((s, si) => { const c = colors[si % colors.length];
    if (spec.type === 'line') { el('polyline', { fill: 'none', stroke: c, 'stroke-width': 2.5, points: s.values.map((v, i) => `${P.l + (iw / n) * (i + 0.5)},${Y(v)}`).join(' ') }); s.values.forEach((v, i) => el('circle', { cx: P.l + (iw / n) * (i + 0.5), cy: Y(v), r: 3.5, fill: c })); }
    else { const bw = ((iw / n) * 0.7) / series.length; s.values.forEach((v, i) => el('rect', { x: P.l + (iw / n) * i + (iw / n) * 0.15 + bw * si, y: Math.min(Y(v), Y(0)), width: Math.max(1, bw - 2), height: Math.abs(Y(v) - Y(0)), rx: 3, fill: c })); } });
  if (series.length > 1) series.forEach((s, si) => { el('rect', { x: P.l + si * 130, y: H - 18, width: 10, height: 10, rx: 2, fill: colors[si % colors.length] }); el('text', { x: P.l + si * 130 + 16, y: H - 9, 'font-size': 11, fill: 'currentColor' }, s.name); });
  return svg;
}
let mermaidLoading = null;
function loadMermaid() { if (window.mermaid) return Promise.resolve(); if (!mermaidLoading) mermaidLoading = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/vendor/mermaid.min.js'; s.onload = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' }); ok(); }; s.onerror = bad; document.head.append(s); }); return mermaidLoading; }
function enhanceBlocks(root) {
  root.querySelectorAll('pre > code').forEach(async (code) => {
    const pre = code.parentElement; const first = code.textContent.split('\n')[0].trim(); const lang = pre.dataset.lang || '';
    if (lang === 'chart') { try { const spec = JSON.parse(code.textContent); const box = h('div.card.flat', { style: { padding: '12px', margin: '8px 0' } }); box.append(chartFromSpec(spec)); pre.replaceWith(box); } catch {} }
    else if (lang === 'mermaid') { try { await loadMermaid(); const id = 'm' + Math.random().toString(36).slice(2); const { svg } = await window.mermaid.render(id, code.textContent); const box = h('div.card.flat', { style: { padding: '12px', margin: '8px 0', overflow: 'auto' } }); box.innerHTML = svg; pre.replaceWith(box); } catch {} }
    else if (lang === 'html' && code.textContent.length > 40) {
      const btn = h('button.btn.sm.tint', { onclick: guard(async () => { const r = await api('/api/render', { body: { html: code.textContent } }); const frame = h('iframe', { src: r.url, sandbox: 'allow-scripts', style: { width: '100%', height: '420px', border: '0', borderRadius: '12px', background: '#fff', boxShadow: 'var(--shadow-sm)' } }); btn.replaceWith(frame); }) }, icon('play', 'sm'), 'Run this page');
      pre.after(h('div', { style: { margin: '6px 0 12px' } }, btn));
    }
    void first;
  });
}
