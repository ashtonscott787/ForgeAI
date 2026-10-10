'use strict';
/* Models, Computers & network, AI providers, Organisation settings, Platform settings */

const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const osIcon = (os) => (os === 'win32' ? 'monitor' : os === 'darwin' ? 'laptop' : 'server');
const MODEL_SUGGESTIONS = [
  ['llama3.2:3b', 'Small and quick', '≈2 GB'], ['qwen3:8b', 'Great all-rounder', '≈5 GB'], ['llama3.1:8b', 'Reliable general model', '≈5 GB'],
  ['gemma3:12b', 'Strong writing, sees images', '≈8 GB'], ['qwen3:14b', 'Powerful, fits 32 GB', '≈9 GB'], ['qwen3:32b', 'Very capable, needs 64 GB', '≈20 GB'],
];
const manageableNodes = (c) => c.nodes.filter((n) => ['local', 'ollama', 'worker'].includes(n.kind) && n.enabled && n.status === 'online');

// ---------------- MODELS
async function pageModels(root) {
  const [c, jobs] = await Promise.all([api('/api/cluster'), isPlatform() ? api('/api/jobs').catch(() => []) : []]);
  const pg = h('div.page'); root.append(pg);
  const can = c.canManage;
  pg.append(pageHead('Models', 'Models that run privately on your own computers. Download them here and give them any name you like.',
    h('button.btn', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/cluster/refresh', { body: {} }); route(); }) }, icon('refresh', 'sm'), 'Refresh'),
    can ? h('button.btn.primary', { onclick: () => catalogModal(c) }, icon('download', 'sm'), 'Get More Models') : null));
  const local = c.nodes.find((n) => n.is_local);
  if (local && local.status !== 'online' && can) await ollamaCard(pg);
  if (isPlatform()) await myModelsSection(pg);
  if (isPlatform()) await pipelinesSection(pg);
  pg.append(h('div.section-title', { style: { marginTop: '30px' } }, 'Downloaded models'));

  const jobsBox = h('div'); pg.append(jobsBox);
  const drawJobs = (list) => {
    clear(jobsBox); if (!list.length) return;
    jobsBox.append(h('div.section-title', null, 'Downloads'), h('div.card.pad0', null, list.slice(0, 6).map((j) => {
      const pct = j.total ? Math.round(j.completed / j.total * 100) : null;
      return h('div.job', null, h('div', { style: { color: j.state === 'error' ? 'var(--red)' : 'var(--accent)' } }, icon(j.state === 'done' ? 'check' : j.state === 'error' ? 'warn' : j.kind === 'create' ? 'wand' : 'download')),
        h('div.grow', null, h('div', null, h('b', null, j.displayName || j.finalName), j.displayName ? h('span.faint.small', null, '  ' + j.finalName) : null, h('span.faint.small', null, ' · ' + j.nodeName)),
          j.state === 'running' ? h('div', null, h('div.bar', { style: { margin: '6px 0 4px' } }, h('i', { style: { width: (pct || 2) + '%' } })), h('div.progress', null, `${j.status}${j.total ? ` · ${bytes(j.completed)} of ${bytes(j.total)} · ${pct}%` : ''}`))
            : h('div.small', { style: { color: j.state === 'error' ? 'var(--red)' : 'var(--text-2)' } }, j.state === 'done' ? 'Ready to use' : j.error || j.state)),
        j.state === 'running' ? h('button.btn.sm', { onclick: guard(async () => { await api(`/api/jobs/${j.id}/cancel`, { body: {} }); }) }, 'Cancel') : null);
    })));
  };
  drawJobs(jobs);
  if (jobs.some((j) => j.state === 'running')) {
    const poll = async () => {
      if (!location.hash.startsWith('#/models') || !document.body.contains(jobsBox)) return;
      const js = await api('/api/jobs').catch(() => []); drawJobs(js);
      if (js.some((j) => j.state === 'running')) S.pageTimer = setTimeout(poll, 1500); else route();
    };
    S.pageTimer = setTimeout(poll, 1500);
  }

  for (const n of c.nodes) {
    const models = n.models || [];
    pg.append(h('div.row.between', { style: { margin: '26px 4px 10px' } },
      h('div.row', null, icon(n.is_local ? osIcon(S.me.os) : 'server'), h('b', { style: { fontSize: '15px' } }, n.name), statusBadge(n.enabled ? n.status : 'disabled'), h('span.small.muted', null, `${models.length} model${models.length === 1 ? '' : 's'}${n.ram_gb ? ' · ' + n.ram_gb + ' GB memory' : ''}`)),
      can && ['local', 'ollama', 'worker'].includes(n.kind) && n.status === 'online' ? h('div.row', null, h('button.btn.sm.ghost', { onclick: () => createModelModal(c) }, icon('wand', 'sm'), 'Ollama Model'), h('button.btn.sm.ghost', { onclick: () => catalogModal(c, n.id) }, icon('download', 'sm'), 'Download here')) : null));
    if (!models.length) { pg.append(h('div.card', null, h('div.muted.small', null, n.status === 'online' ? 'No models yet.' : n.error || 'Not reachable.'))); continue; }
    const manage = can && ['local', 'ollama', 'worker'].includes(n.kind);
    pg.append(h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null,
      h('thead', null, h('tr', null, ['Model', 'Served by', 'Parameters', 'Memory', 'Context', 'Speed', 'Status', ''].map((x) => h('th', null, x)))),
      h('tbody', null, models.map((m) => { const ollamaModel = manage && (m.runtime === 'ollama' || n.kind === 'worker'); return h('tr', null,
        h('td', null, h('div.row.nowrap', { style: { gap: '10px' } }, h('div.monogram', { style: { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)', boxShadow: 'none' } }, icon('cube', 'sm')),
          h('div', null, h('b', null, m.alias || m.id), m.vision ? h('span.badge.info', { style: { marginLeft: '6px' } }, 'Vision') : null, h('div.small.faint.mono', null, m.alias ? m.id : [m.quant, m.runtime].filter(Boolean).join(' · '))))),
        h('td.small', null, ({ ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', mlx: 'MLX', vllm: 'vLLM', exo: 'exo', generic: 'OpenAI-compatible', 'openai-compatible': 'OpenAI-compatible', worker: 'ForgeAI' })[m.runtime] || m.runtime, h('div.faint.mono', null, (() => { try { return new URL(m.endpointUrl || n.url).host; } catch { return ''; } })())),
        h('td.muted', null, m.params || '—'), h('td.muted', null, bytes(m.memBytes)), h('td.muted', null, m.context ? num(m.context) : '—'), h('td.muted', null, m.tps ? m.tps.toFixed(0) + ' tok/s' : '—'),
        h('td', null, m.loaded ? h('span.badge.ok', null, h('span.dot'), 'Loaded') : h('span.badge', null, 'Idle')),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, can ? h('button.btn.sm.icon.ghost', { title: 'Rename', onclick: () => renameModal(n, m, ollamaModel) }, icon('tag')) : null,
          ollamaModel ? h('button.btn.sm.ghost', { onclick: guard(async (e) => { e.currentTarget.disabled = true; clear(e.currentTarget).append(h('span.spinner')); await api(`/api/nodes/${n.id}/load`, { body: { model: m.id, unload: m.loaded } }); route(); }) }, m.loaded ? 'Unload' : 'Load') : null,
          ollamaModel && isOwner() ? h('button.btn.sm.icon.ghost', { title: 'Delete from ' + n.name, onclick: guard(async () => { if (!(await confirmBox('Delete Model?', `Remove ${m.alias || m.id} from ${n.name}? You can download it again later.`, 'Delete', true))) return; await api(`/api/nodes/${n.id}/delete-model`, { body: { model: m.id } }); route(); }) }, icon('trash')) : null)); }))))));
  }
  if (can) await guideSection(pg);
  if (can) pg.append(h('details', { style: { marginTop: '26px' } }, h('summary.section-title', { style: { cursor: 'pointer' } }, 'Advanced — model runtimes on this computer'),
    h('div.card', null, h('p.small.muted', { style: { marginTop: 0 } }, 'Where ForgeAI looks for model servers here. Ollama (11434), LM Studio (1234) and MLX / llama.cpp servers (8080) are checked by default.'),
      h('div.list', { style: { boxShadow: 'none' } }, c.runtimes.map((r) => h('div.li', null, h('div.t', null, h('b', null, r.runtime), h('span.mono', null, r.url))))),
      h('button.btn.sm', { style: { marginTop: '12px' }, onclick: () => runtimesModal(c.runtimes) }, 'Edit Runtimes'))));
}
function nodePicker(c, selected) {
  const nodes = manageableNodes(c);
  if (!nodes.length) throw new Error('No computer with Ollama is online. Install Ollama, open it, then Refresh.');
  return sel(nodes.map((n) => [n.id, n.name + (n.is_local ? ' (this computer)' : '')]), selected || nodes[0].id);
}
function downloadModal(c, nodeId) {
  let nodeSel; try { nodeSel = nodePicker(c, nodeId); } catch (e) { return toast(e.message, true); }
  const model = h('input', { type: 'text', placeholder: 'e.g. qwen3:14b', autocomplete: 'off' });
  const display = h('input', { type: 'text', placeholder: 'e.g. Fast helper, Research Brain' });
  const saveAs = h('input', { type: 'text', placeholder: 'e.g. fast-helper', autocomplete: 'off' });
  const picks = h('div.grid.g3', { style: { gap: '8px' } }, MODEL_SUGGESTIONS.map(([id, dsc, size]) => h('button.card', { type: 'button', style: { textAlign: 'left', padding: '10px 12px', cursor: 'pointer' }, onclick: (e) => { model.value = id; picks.querySelectorAll('button').forEach((b) => { b.style.boxShadow = ''; }); e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent)'; } },
    h('div.mono', { style: { fontWeight: 600 } }, id), h('div.small.muted', null, dsc), h('div.small.faint', null, size))));
  const body = h('div', null,
    field('Computer', nodeSel),
    field('Choose a model', picks),
    field('Or type any model name', model, h('span', null, 'Anything from ', h('a', { href: 'https://ollama.com/search', target: '_blank' }, 'ollama.com/search'), ', or Hugging Face GGUF models as hf.co/<user>/<repo>. Sizes are approximate.')),
    h('div.grid.g2', { style: { gap: '12px' } }, field('Name it', display, 'What everyone sees in menus and chat.'), field('Save as (optional)', saveAs, 'Also renames the model itself on that computer.')));
  modal('Download Model', body, [{ label: 'Cancel', onClick: () => {} }, { label: 'Download', primary: true, onClick: async () => {
    if (!model.value.trim()) throw new Error('Choose or type a model');
    await api(`/api/nodes/${nodeSel.value}/pull`, { body: { model: model.value.trim(), displayName: display.value, saveAs: saveAs.value } });
    toast('Download started'); route();
  } }], { wide: true });
}
function renameModal(n, m, canRenameFile) {
  const display = h('input', { type: 'text', value: m.alias || '', placeholder: m.id });
  const file = h('input', { type: 'text', value: m.id, autocomplete: 'off' });
  modal('Rename Model', h('div', null,
    field('Display name', display, 'Shown everywhere in ForgeAI. Leave empty to use the original name.'),
    canRenameFile ? field('Model name on ' + n.name, file, 'Changing this renames the model itself. Other apps that use the old name will need the new one.') : null),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => {
    let id = m.id;
    if (canRenameFile && file.value.trim() && file.value.trim() !== m.id) { await api(`/api/nodes/${n.id}/rename-model`, { body: { model: m.id, newName: file.value.trim() } }); id = file.value.trim().toLowerCase(); }
    await api('/api/models/alias', { method: 'PUT', body: { model: id, name: display.value } });
    toast('Renamed'); route();
  } }]);
}
function createModelModal(c) {
  let nodeSel; try { nodeSel = nodePicker(c); } catch (e) { return toast(e.message, true); }
  const baseSel = h('select');
  const fillBase = () => { const n = c.nodes.find((x) => x.id === nodeSel.value); clear(baseSel).append(...(n.models || []).map((m) => h('option', { value: m.id }, m.alias ? `${m.alias} (${m.id})` : m.id))); };
  nodeSel.onchange = fillBase; fillBase();
  const name = h('input', { type: 'text', placeholder: 'e.g. freight-expert' });
  const display = h('input', { type: 'text', placeholder: 'e.g. Freight Expert' });
  const system = h('textarea', { rows: 6, placeholder: 'e.g. You are a freight expert. Be concise and always put container numbers in bold.' });
  modal('Create Custom Model', h('div', null, note('info', 'Makes a new named model from one you already have, with its own built-in instructions. It shares storage with the original, so it uses almost no extra space.'),
    h('div', { style: { height: '14px' } }), h('div.grid.g2', { style: { gap: '12px' } }, field('Computer', nodeSel), field('Based on', baseSel)),
    h('div.grid.g2', { style: { gap: '12px' } }, field('Model name', name, 'Letters, numbers and dashes.'), field('Display name', display)), field('Built-in instructions', system)),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => {
    if (!baseSel.value) throw new Error('That computer has no models yet — download one first');
    await api(`/api/nodes/${nodeSel.value}/create-model`, { body: { name: name.value, from: baseSel.value, displayName: display.value, system: system.value } });
    toast('Creating model'); route();
  } }], { wide: true });
}
function runtimesModal(list) {
  const ta = h('textarea', { rows: 6, class: 'mono', value: list.map((r) => `${r.runtime} ${r.url}`).join('\n') });
  modal('Model Runtimes', h('div', null, field('One per line: name and address', ta, '“ollama” uses the Ollama API. Any other name is treated as an OpenAI-compatible server (mlx, llamacpp, lmstudio…).')),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => { const runtimes = ta.value.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([runtime, url]) => ({ runtime, url })); await api('/api/settings/local-runtimes', { method: 'PUT', body: { runtimes } }); await api('/api/cluster/refresh', { body: {} }); route(); } }]);
}

// ---------------- COMPUTERS & NETWORK
async function pageNetwork(root) {
  const [s, c] = await Promise.all([isOwner() ? api('/api/settings/access') : null, api('/api/cluster')]);
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Computers & Network', 'Run ForgeAI on one computer and use it from any Mac or Windows PC on your network — or add more computers to share the work.'));
  if (s) {
    const L = s.listening || {}; const proto = L.https ? 'https' : 'http';
    let remote = s.remote, httpsOn = s.https;
    const port = h('input', { type: 'number', value: s.port, min: 1024, max: 65535, style: { width: '110px' } });
    const addrs = s.addresses.map((a) => `${proto}://${a.address}:${L.port}`);
    pg.append(h('div.section-title', { style: { marginTop: 0 } }, 'This computer'));
    pg.append(h('div.list', null,
      h('div.li', null, icon(osIcon(S.me.os), 'lg'), h('div.t', null, h('b', null, S.me.host || 'This computer'), h('span', null, `${OS_NAME[S.me.os] || S.me.os} · ${L.remote ? 'Other computers can connect' : 'Only this computer can use ForgeAI'}`)), L.remote ? h('span.badge.ok', null, h('span.dot'), 'Serving') : h('span.badge', null, 'Private')),
      h('div.li', null, h('div.t', null, h('b', null, 'Allow other computers to connect'), h('span', null, 'Macs, Windows PCs, phones and tablets on your network or VPN sign in with a username and password.')), toggle(remote, (v) => { remote = v; })),
      h('div.li', null, h('div.t', null, h('b', null, 'Encrypt connections (HTTPS)'), h('span', null, 'Recommended on shared networks. Browsers warn once about the self-signed certificate; the ForgeAI app handles it for you.')), toggle(httpsOn, (v) => { httpsOn = v; })),
      h('div.li', null, h('div.t', null, h('b', null, 'Port')), port),
      h('div.li', null, h('div.t', null, h('b', null, 'Apply changes'), h('span', null, 'The dashboard reconnects automatically.')),
        h('button.btn.primary', { onclick: guard(async () => { await api('/api/settings/access', { method: 'PUT', body: { remote, https: httpsOn, port: +port.value } }); toast('Applying…'); setTimeout(() => location.reload(), 2500); }) }, 'Apply')),
      L.remote ? h('div.li', null, h('div.t', null, h('b', null, 'Connect from another computer'), h('span', null, 'Open ForgeAI on that Mac or PC and choose “Connect to a server” — this computer appears automatically. Or open one of these in any browser:'),
        addrs.length ? addrs.map((a, i) => h('div.row', { style: { gap: '8px', marginTop: '6px' } }, h('span.mono', null, a), s.addresses[i].tailscale ? h('span.badge.ok', null, 'Tailscale') : h('span.faint.small', null, s.addresses[i].iface), h('button.btn.sm.icon.ghost', { title: 'Copy', onclick: () => { navigator.clipboard.writeText(a); toast('Copied'); } }, icon('copy', 'sm')))) : h('span', null, 'No network connection found.'))) : null,
      L.fingerprint ? h('div.li', null, h('div.t', null, h('b', null, 'Certificate fingerprint'), h('span.mono', { style: { wordBreak: 'break-all' } }, L.fingerprint))) : null));
    if (L.remote && S.me.os === 'win32') pg.append(h('div', { style: { marginTop: '10px' } }, note('info', 'Windows may ask whether ForgeAI can use the network. Choose “Allow” for private networks.')));

    pg.append(h('div.section-title', null, 'Share this computer’s models'));
    pg.append(h('div.list', null,
      h('div.li', null, h('div.t', null, h('b', null, 'Work for another ForgeAI'), h('span', null, 'Lets your main ForgeAI run jobs on this computer’s local models. Needs “Allow other computers to connect”.')), toggle(s.worker.enabled, guard(async (v) => { await api('/api/settings/worker', { method: 'PUT', body: { enabled: v } }); route(); }))),
      s.worker.enabled ? h('div.li', null, h('div.t', null, h('b', null, 'Computer token'), h('span.mono', { style: { wordBreak: 'break-all' } }, s.worker.token)), h('div.row.nowrap', null, h('button.btn.sm', { onclick: () => { navigator.clipboard.writeText(s.worker.token); toast('Copied'); } }, icon('copy', 'sm'), 'Copy'), h('button.btn.sm.ghost', { onclick: guard(async () => { await api('/api/settings/worker', { method: 'PUT', body: { enabled: true, regenerate: true } }); route(); }) }, 'New Token'))) : null));
  }

  pg.append(h('div.row.between', { style: { margin: '28px 4px 10px' } }, h('div.section-title', { style: { margin: 0 } }, 'Computers doing the work'), c.canManage ? h('button.btn.sm.tint', { onclick: () => nodeModal() }, icon('plus', 'sm'), 'Add Computer') : null));
  pg.append(h('div.list', null, c.nodes.map((n) => h('div.li' + (c.canManage ? '.click' : ''), { onclick: () => c.canManage && nodeModal(n) }, icon(n.is_local ? osIcon(S.me.os) : 'server'),
    h('div.t', null, h('b', null, n.name), h('span', null, [{ local: 'This computer', ollama: 'Ollama on another computer', compat: 'OpenAI-compatible server', worker: 'ForgeAI computer' }[n.kind], n.link_id ? 'via remote link' : n.url, `${(n.models || []).length} models`, n.inflight ? `${n.inflight} running` : null].filter(Boolean).join(' · ')), n.error && n.status !== 'online' ? h('span', { style: { color: 'var(--red)' } }, n.error) : null),
    n.lend === 'idle' ? (n.availability && n.availability.available === false ? h('span.badge.warn', { title: n.availability.reason }, 'In use') : h('span.badge.ok', { title: n.availability ? n.availability.reason : '' }, icon('moon', 'sm'), 'Idle — lent')) : n.lend === 'never' ? h('span.badge', null, 'Not lent') : null,
    statusBadge(n.enabled ? n.status : 'disabled'), c.canManage ? icon('right', 'sm') : null))));

  if (isPlatform()) {
    const found = h('div.list');
    const scanNet = async () => {
      clear(found).append(h('div.li', null, h('span.spinner'), h('div.t', null, h('span', null, 'Looking for ForgeAI on your network…'))));
      const list = await api('/api/discover').catch(() => []);
      clear(found);
      if (!list.length) return found.append(h('div.li', null, icon('network'), h('div.t', null, h('b', null, 'No other ForgeAI found'), h('span', null, 'Other computers appear here when “Allow other computers to connect” is on. Some networks (guest Wi-Fi, some offices) block discovery — you can still add a computer by its address.'))));
      for (const d of list) {
        const added = c.nodes.some((n) => n.url && n.url.replace(/\/$/, '') === d.url);
        found.append(h('div.li', null, icon(osIcon(d.os)), h('div.t', null, h('b', null, d.host || d.name), h('span', null, [d.name, OS_NAME[d.os] || d.os, d.url, d.worker ? 'shares its models' : null].filter(Boolean).join(' · '))),
          h('a.btn.sm', { href: d.url, target: '_blank' }, 'Open'),
          c.canManage && d.worker && !added ? h('button.btn.sm.tint', { onclick: () => nodeModal(null, { url: d.url, name: d.host || d.name }) }, 'Add') : added ? h('span.badge.ok', null, 'Added') : null));
      }
    };
    pg.append(h('div.row.between', { style: { margin: '28px 4px 10px' } }, h('div.section-title', { style: { margin: 0 } }, 'Found on your network'), h('button.btn.sm.ghost', { onclick: () => scanNet() }, icon('refresh', 'sm'), 'Scan Again')), found);
    scanNet();
    if (isOwner()) await clusterSection(pg);
  }

  pg.append(h('div.section-title', null, 'From anywhere in the world'));
  pg.append(h('div.card', null, h('div.md', { html: md(`**Tailscale** (a free private network) is the simplest and safest way:
1. Install Tailscale on this computer and on your laptop or phone, and sign in with the same account.
2. Turn on **Allow other computers to connect** above.
3. From anywhere, use the address marked **Tailscale** — in a browser, or in the ForgeAI app with **Connect to a server**.

Nothing is exposed to the public internet. For a public web address use Cloudflare Tunnel or Tailscale Funnel. Never forward the port on your router.`) })));
}
function nodeModal(n, prefill) {
  const isNew = !n; n = n || { kind: 'worker', name: (prefill && prefill.name) || '', url: (prefill && prefill.url) || '', ram_gb: 0, enabled: 1 };
  const kind = sel([['worker', 'Another computer running ForgeAI (recommended)'], ['ollama', 'Another computer running Ollama'], ['compat', 'OpenAI-compatible model server']], n.kind, { disabled: !isNew });
  const name = h('input', { type: 'text', value: n.name, placeholder: 'e.g. Mac mini 2, Office PC' });
  const url = h('input', { type: 'url', value: n.url || '', placeholder: 'https://192.168.1.21:4545', disabled: !!n.is_local });
  const token = h('input', { type: 'password', placeholder: isNew ? 'From that computer: Computers & Network → Computer token' : 'Leave empty to keep the current token' });
  const ram = h('input', { type: 'number', value: n.ram_gb || 0 });
  let enabled = !!n.enabled;
  const hint = h('div');
  const tokF = field('Computer token', token);
  const upd = () => { clear(hint).append(note(kind.value === 'ollama' ? 'warn' : 'info', kind.value === 'worker' ? 'On that Mac or PC: open ForgeAI → Computers & Network, turn on “Allow other computers to connect” and “Work for another ForgeAI”, then copy its token.' : kind.value === 'ollama' ? 'Ollama’s network access has no password or encryption. Use it only on a trusted network or VPN — an ForgeAI computer is safer.' : 'Enter the server address, e.g. http://192.168.1.22:8080 for mlx_lm.server or llama-server.')); tokF.style.display = kind.value === 'worker' ? '' : 'none'; };
  kind.onchange = upd;
  // Shared with: which organisations may run on this computer. Empty = all of them. Owner only.
  let shareAll = !(n.org_ids && n.org_ids.length); const shareSet = new Set(n.org_ids || []);
  const shareList = h('div.list', { style: { marginTop: '8px', display: shareAll ? 'none' : '' } },
    (S.orgs || []).map((o) => h('div.li', null, monogram(o), h('div.t', null, h('b', null, o.name)), toggle(shareSet.has(o.id), (v) => { if (v) shareSet.add(o.id); else shareSet.delete(o.id); }))));
  // People who can manage this computer: load/unload models and restart it, without being a platform admin.
  const mgrSet = new Set(n.managers || []); const mgrBox = h('div');
  const loadManagers = async () => { let users = []; try { users = await api('/api/users'); } catch {} const pickable = users.filter((u) => u.platform_role === 'none');
    clear(mgrBox); if (!pickable.length) { mgrBox.append(h('div.small.muted', { style: { padding: '6px 0' } }, 'Only platform owners and admins exist yet. Add people under Settings → People to grant per-computer access.')); return; }
    mgrBox.append(h('div.list', null, pickable.map((u) => h('div.li', null, h('div.avatar', null, initials(u.display_name || u.username)), h('div.t', null, h('b', null, u.display_name || u.username), h('span', null, u.username)), toggle(mgrSet.has(u.id), (v) => { if (v) mgrSet.add(u.id); else mgrSet.delete(u.id); }))))); };
  const shareBox = (n.is_local || isNew || !isOwner()) ? null : h('div', { style: { marginTop: '14px' } },
    h('div.section-title', { style: { marginBottom: '6px' } }, 'Organisations that can use this computer'),
    h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'All organisations'), h('span', null, 'Every workspace on this hub can run work here.')), toggle(shareAll, (v) => { shareAll = v; shareList.style.display = v ? 'none' : ''; }))),
    shareList, note('info', 'Turn this off to pick exactly which organisations may use this computer. The others never route work here.'),
    h('div.section-title', { style: { marginBottom: '6px', marginTop: '16px' } }, 'People who can manage this computer'),
    mgrBox, h('div.small.muted', { style: { marginTop: '6px' } }, 'They can load, unload and restart — without being a platform admin. Only the owner can change settings, sharing or uninstall.'));
  if (shareBox) loadManagers();
  const body = h('div', null, n.is_local ? null : field('Type', kind), field('Name', name), n.is_local ? null : field('Address', url), n.is_local ? null : tokF, field('Memory (GB)', ram, 'For planning which models fit.'),
    h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Use this computer'), h('span', null, 'The scheduler may send work here.')), toggle(enabled, (v) => { enabled = v; }))), shareBox, n.is_local ? null : h('div', { style: { marginTop: '12px' } }, hint));
  if (!n.is_local) upd();
  modal(isNew ? 'Add Computer' : n.name, body, [
    !isNew && !n.is_local ? { label: 'Remove', danger: true, onClick: async () => { await api('/api/nodes/' + n.id, { method: 'DELETE' }); route(); } } : null,
    !isNew && n.kind === 'worker' && isOwner() ? { label: 'Uninstall…', danger: true, onClick: () => { setTimeout(() => uninstallNode(n), 50); } } : null,
    { label: 'Cancel', onClick: () => {} },
    { label: isNew ? 'Add' : 'Save', primary: true, onClick: async () => {
      const b = { name: name.value, url: url.value, ram_gb: +ram.value, enabled, kind: kind.value }; if (token.value) b.token = token.value;
      if (isNew) await api('/api/nodes', { body: b }); else await api('/api/nodes/' + n.id, { method: 'PUT', body: b });
      if (!n.is_local && !isNew && isOwner()) await api('/api/nodes/' + n.id + '/grants', { method: 'PUT', body: { org_ids: shareAll ? [] : [...shareSet], managers: [...mgrSet] } });
      route();
    } }].filter(Boolean));
}

// ---------------- AI PROVIDERS
function pricesEditor(prices) {
  const ta = h('textarea', { rows: 10, class: 'mono', value: prices.map((p) => `${p.pattern}, ${p.input_per_m}, ${p.output_per_m}`).join('\n') });
  return h('div', null, ta, h('button.btn.sm', { style: { marginTop: '10px' }, onclick: guard(async () => {
    const rows = ta.value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((r) => r.length === 3 && r[0]).map(([pattern, i, o]) => ({ pattern, input_per_m: +i, output_per_m: +o }));
    await api('/api/prices', { method: 'PUT', body: { prices: rows } }); toast('Prices saved');
  }) }, 'Save Prices'));
}
function providerEdit(p) {
  const label = h('input', { type: 'text', value: p.label });
  const budget = h('input', { type: 'number', min: 0, value: p.budget_month || 0 });
  const opts = [['', 'Automatic'], ...p.models.map((m) => [m, m])];
  const def = sel(opts, p.default_model); const fast = sel(opts, p.fast_model);
  const key = h('input', { type: 'password', placeholder: 'Paste a new key to replace the current one', autocomplete: 'off' });
  modal(p.label, h('div', null, field('Label', label), h('div.grid.g2', { style: { gap: '12px' } }, field('Model for complex work', def), field('Model for quick work', fast)), field('Monthly budget (USD, 0 = none)', budget), field('Replace key', key)), [
    { label: 'Disconnect', danger: true, onClick: async () => { if (!(await confirmBox('Disconnect?', 'The key is deleted from the vault.', 'Disconnect', true))) return false; await api('/api/providers/' + p.id, { method: 'DELETE' }); route(); } },
    { label: 'Cancel', onClick: () => {} },
    { label: 'Save', primary: true, onClick: async () => { await api('/api/providers/' + p.id, { method: 'PUT', body: { label: label.value, budget_month: +budget.value, default_model: def.value, fast_model: fast.value, apiKey: key.value || undefined } }); route(); } }]);
}

// ---------------- ORGANISATION
async function pageOrg(root, tab = 'policy') {
  const pg = h('div.page'); root.append(pg);
  const o = await orgApi('');
  pg.append(h('div.phead', null, h('div.row.nowrap', { style: { gap: '14px' } }, monogram(o, 'lg'), h('div', null, h('h1', null, o.name), h('div.sub', { style: { marginTop: '2px' } }, `Your role: ${ROLE_NAMES[o.role] || o.role}`)))));
  const tabs = [['policy', 'AI Policy'], ['assistant', 'Assistant'], ['folders', 'Folders'], ['quotas', 'Limits'], ['members', 'People'], ['branding', 'Branding'], ['backups', 'Backups'], ['audit', 'Activity']];
  pg.append(h('div.tabs', null, tabs.map(([k, l]) => h('a' + (tab === k ? '.on' : ''), { href: '#/org/' + k }, l))));
  const body = h('div'); pg.append(body);
  const manage = canOrg('manage');
  const li = (title, sub, ctl) => h('div.li', null, h('div.t', null, h('b', null, title), sub ? h('span', null, sub) : null), h('div.ctl', null, ctl));
  if (tab === 'policy') {
    const v = { ...(await orgApi('/policy')) }; const pipes = await api('/api/pipelines').catch(() => []); v.remote_as_own = String(!!v.remote_as_own); v.strict_caps = v.strict_caps !== false; v.task_models = { ...(v.task_models || {}) };
    const mo = await orgApi('/model-options').catch(() => ({ local: [], cloud: [] })); const modelOpts = [['', 'Automatic'], ...(mo.local || []).map((m) => ['local:' + m.id, `${m.name || m.id} · ${((m.endpoints || [])[0] || {}).node || 'this computer'}`]), ...(mo.cloud || []).flatMap((c) => (c.models || []).map((x) => ['cloud:' + c.providerId + ':' + x.id, `${x.id} · ${c.name} (paid)`]))];
    const tm = (k) => sel(modelOpts, v.task_models[k] || '', { disabled: !manage, onchange: (e) => { if (e.target.value) v.task_models[k] = e.target.value; else delete v.task_models[k]; } });
    const s = (k, opts) => sel(opts, v[k], { disabled: !manage, onchange: (e) => { v[k] = e.target.value; } });
    const t = (k) => toggle(v[k], (x) => { v[k] = x; }, { style: manage ? {} : { pointerEvents: 'none', opacity: 0.5 } });
    body.append(h('div.section-title', { style: { marginTop: 0 } }, 'Where work may go'), h('div.list', null,
      li('Routing', 'Where Auto may send work. Anything that leaves your network is always marked.', s('default_mode', [['local_only', 'Local only — nothing leaves your computers'], ['local_first', 'Prefer local — cloud only when local can’t do it'], ['ask_cloud', 'Ask before cloud — every cloud request needs approval'], ['cloud_allowed', 'Cloud allowed — best model for the job, wherever it is'], ['cloud_first', 'Prefer cloud — local only as a backup'], ['hybrid', 'Custom pipeline — stages you define']])),
      li('Hybrid pipeline', 'Used when Routing is Hybrid (edit pipelines on the Models page).', sel((pipes || []).map((p) => [p.id, p.name]), v.pipeline || (pipes[0] || {}).id, { disabled: !manage, onchange: (e) => { v.pipeline = e.target.value; } })),
      li('Prefer local under', 'Requests smaller than this many tokens stay on your computers when a local model can do it (0 = off).', h('input', { type: 'number', min: 0, step: 1000, value: v.prefer_local_under_tokens || 0, disabled: !manage, style: { width: '120px' }, oninput: (e) => { v.prefer_local_under_tokens = +e.target.value; } })),
      li('Avoid slow models', 'Auto avoids local models measured slower than this (tokens per second, 0 = off).', h('input', { type: 'number', min: 0, value: v.avoid_slow_tps || 0, disabled: !manage, style: { width: '120px' }, oninput: (e) => { v.avoid_slow_tps = +e.target.value; } })),
      li('Your servers outside this network', 'Servers reached over the internet (not this computer, your network or a VPN). Treat them like cloud when a rule says local only?', s('remote_as_own', [['false', 'Follow cloud rules (safer)'], ['true', 'Treat as my own']])),
      li('Confidential data', 'Chats and agents marked Confidential.', s('confidential', [['local_only', 'Local only'], ['allowed', 'Cloud allowed']])),
      li('Finance data', null, s('finance', [['local_only', 'Local only'], ['approval', 'Cloud only with approval'], ['allowed', 'Cloud allowed']])),
      li('General research', null, s('research', [['cloud_allowed', 'Cloud allowed'], ['local_only', 'Local only']])),
      li('Speed first', 'Auto prefers the fastest loaded model on your computers.', t('speed_critical')),
      li('Strict capability checks', 'Auto only sends images or tool work to models whose app reported that ability (or that you confirmed under Model health). Never guesses from a name.', t('strict_caps'))),
    h('div.section-title', null, 'Preferred model for each kind of work'), h('div.list', null,
      h('div.li', null, h('div.t', null, h('span', null, 'Auto uses these first when they can do the request; otherwise it chooses as usual and says why. Leave on Automatic to let ForgeAI decide.'))),
      li('Chat and writing', null, tm('chat')), li('Coding', null, tm('code')), li('Reasoning and analysis', null, tm('reasoning')), li('Images', null, tm('vision')), li('Long documents', null, tm('long'))),
    h('div.section-title', null, 'Cloud providers'), h('div.list', null, li('OpenAI', null, t('allow_openai')), li('Anthropic Claude', null, t('allow_anthropic')), li('Google Gemini', null, t('allow_google')), li('Web search', 'Cloud models may search the web when asked.', t('allow_web_search'))),
    h('div.row', { style: { marginTop: '16px' } }, manage ? h('button.btn.primary', { onclick: guard(async () => { const rest = { ...v, remote_as_own: v.remote_as_own === 'true' }; delete rest.backup; await orgApi('/policy', { method: 'PUT', body: rest }); toast('Policy saved'); }) }, 'Save Policy') : h('span.help', null, 'Only organisation admins can change the policy.'), h('span.help', null, 'Order: platform → organisation → agent → conversation. The monthly budget is under Limits.')));
  }
  if (tab === 'assistant') {
    const [cfg, caps, folders, mbs, cons] = await Promise.all([orgApi('/assistant'), api('/api/capabilities'), orgApi('/folders').catch(() => []), orgApi('/mailboxes').catch(() => []), orgApi('/connectors').catch(() => [])]);
    const tools = new Set(cfg.tools), fmap = new Map((cfg.folders || []).map((f) => [f.id, f.mode])), mset = new Set(cfg.mailboxes || []), cset = new Set(cfg.mcp || []);
    let autonomy = cfg.autonomy; const ins = h('textarea', { rows: 4, value: cfg.instructions || '', placeholder: 'e.g. Always write in NZ English. Keep answers short.', disabled: !manage });
    const dis = manage ? {} : { style: { pointerEvents: 'none', opacity: 0.5 } };
    const autoSeg = h('div.seg', null, [['ask_all', 'Ask every step'], ['ask_risky', 'Ask for risky actions'], ['full', 'Fully autonomous']].map(([k, l]) => h('button' + (autonomy === k ? '.on' : ''), { type: 'button', onclick: (e) => { autonomy = k; autoSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
    body.append(note('info', `What ${S.platformName} can do in AI Chat for ${o.name}. Agents have their own settings.`),
      h('div.section-title', null, 'Abilities'), h('div.list', null, Object.keys(caps.capabilities).map((k) => li(CAP_NAME[k] || k, caps.capabilities[k], toggle(tools.has(k), (v) => (v ? tools.add(k) : tools.delete(k)), dis)))),
      h('div.section-title', null, 'Folders'), h('div.list', null, li('Workspace', 'Its own folder for everything it creates', h('span.badge.ok', null, 'Read & write')), ...folders.map((fd) => li(fd.name, fd.path, sel([['', 'No access'], ['read', 'Read only'], ...(fd.mode === 'readwrite' ? [['readwrite', 'Read & write']] : [])], fmap.get(fd.id) || '', { disabled: !manage, onchange: (e) => (e.target.value ? fmap.set(fd.id, e.target.value) : fmap.delete(fd.id)) })))),
      mbs.length ? h('div.section-title', null, 'Email') : null, mbs.length ? h('div.list', null, mbs.map((m) => li(m.email, m.name, toggle(mset.has(m.id), (v) => (v ? mset.add(m.id) : mset.delete(m.id)), dis)))) : null,
      cons.length ? h('div.section-title', null, 'Connectors') : null, cons.length ? h('div.list', null, cons.map((c) => li(c.name, `${c.tools.length} tools`, toggle(cset.has(c.id), (v) => (v ? cset.add(c.id) : cset.delete(c.id)), dis)))) : null,
      h('div.section-title', null, 'Independence'), h('div.list', null, li('How much to ask you', 'Risky = sending, posting, buying, deleting, running commands, changing shared files.', autoSeg)),
      h('div.section-title', null, 'Instructions'), ins,
      manage ? h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: guard(async () => { await orgApi('/assistant', { method: 'PUT', body: { tools: [...tools], folders: [...fmap].map(([id, mode]) => ({ id, mode })), mailboxes: [...mset], mcp: [...cset], autonomy, instructions: ins.value } }); toast('Saved'); }) }, 'Save')) : null);
  }
  if (tab === 'folders') {
    const folders = await orgApi('/folders');
    const add = async () => {
      const path = h('input', { type: 'text', placeholder: S.me.os === 'win32' ? 'C:\\Users\\you\\Documents\\Team' : '/Users/you/Documents/Team' });
      const pick = window.forgeDesktop ? h('button.btn', { onclick: async () => { const p = await window.forgeDesktop.pickFolder(); if (p) path.value = p; } }, 'Choose…') : null;
      const name = h('input', { type: 'text', placeholder: 'e.g. Team documents' });
      const mode = sel([['read', 'Read only'], ['readwrite', 'Read & write']], 'read');
      modal('Share a Folder', h('div', null, note('info', `Agents in ${o.name} can only use folders shared here — and only the ones you then give to each agent.`), h('div', { style: { height: '12px' } }), field('Folder on the server computer', h('div.row.nowrap', null, path, pick)), h('div.grid.g2', { style: { gap: '12px' } }, field('Name agents see', name), field('Most access allowed', mode))),
        [{ label: 'Cancel', onClick: () => {} }, { label: 'Share', primary: true, onClick: async () => { await orgApi('/folders', { body: { path: path.value, name: name.value, mode: mode.value } }); route(); } }]);
    };
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, 'Folders on the server computer that this organisation’s assistant and agents may use. Each agent only gets the folders you tick in its settings, never more than the access set here.'), isPlatform() ? h('button.btn.primary.sm', { onclick: add }, icon('plus', 'sm'), 'Share Folder') : null),
      folders.length ? h('div.list', null, folders.map((fd) => h('div.li', null, icon('folder'), h('div.t', null, h('b', null, fd.name), h('span', null, fd.path + (fd.exists ? '' : ' — not found'))),
        isPlatform() ? sel([['read', 'Read only'], ['readwrite', 'Read & write']], fd.mode, { style: { width: '150px' }, onchange: guard(async (e) => { await orgApi('/folders/' + fd.id, { method: 'PUT', body: { mode: e.target.value } }); toast('Saved'); }) }) : h('span.badge', null, fd.mode === 'readwrite' ? 'Read & write' : 'Read only'),
        isPlatform() ? h('button.btn.sm.ghost', { onclick: guard(async () => { await orgApi('/folders/' + fd.id, { method: 'DELETE' }); route(); }) }, 'Stop Sharing') : null)))
        : emptyState('folder', 'No shared folders', 'Agents can still create files in their own workspace.'));
  }
  if (tab === 'quotas') { await limitsTab(body); }
  if (tab === 'members') {
    if (!manage) { body.append(emptyState('lock', 'Admins only', 'Only organisation admins can manage people.')); return; }
    const ms = await orgApi('/members');
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, 'Organisation roles only apply here — an organisation admin never gets platform access.'), h('button.btn.primary.sm', { onclick: () => memberModal() }, icon('plus', 'sm'), 'Add Person')),
      ms.length ? h('div.list', null, ms.map((m) => h('div.li', null, h('div.avatar', null, initials(m.display_name || m.username)), h('div.t', null, h('b', null, m.display_name || m.username), h('span', null, `${m.username} · ${ROLE_NAMES[m.role]}`)), h('button.btn.sm.ghost', { onclick: guard(async () => { await orgApi('/members/' + m.id, { method: 'DELETE' }); route(); }) }, 'Remove'))))
        : emptyState('users', 'Just you so far', 'Platform owners and admins can already see this organisation.'));
  }
  if (tab === 'branding') {
    const name = h('input', { type: 'text', value: o.name, disabled: !manage });
    const color = h('input', { type: 'color', value: o.color, disabled: !manage });
    const domain = h('input', { type: 'text', value: o.domain || '', placeholder: 'ai.hillcountry.example', disabled: !manage });
    let logo = o.logo || '';
    const prevBox = h('div'); const drawPrev = () => clear(prevBox).append(monogram({ ...o, logo, color: color.value, name: name.value }, 'lg'));
    color.oninput = drawPrev; name.oninput = drawPrev; drawPrev();
    const lf = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp', style: { display: 'none' }, onchange: async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 300000) return toast('Logo must be under 300 KB', true); logo = `data:${f.type};base64,` + await readFileB64(f); drawPrev(); } });
    body.append(h('div.list', null,
      li('Name', null, name), li('Colour', 'Used as the accent colour inside this organisation.', color),
      li('Logo', 'PNG, JPEG, SVG or WebP under 300 KB.', h('div.row.nowrap', null, prevBox, lf, manage ? h('button.btn.sm', { onclick: () => lf.click() }, 'Choose…') : null, manage && logo ? h('button.btn.sm.ghost', { onclick: () => { logo = ''; drawPrev(); } }, 'Remove') : null)),
      li('Custom domain', 'For white-label use behind a reverse proxy or tunnel.', domain)),
    manage ? h('div.row', { style: { marginTop: '16px' } }, h('button.btn.primary', { onclick: guard(async () => { await orgApi('', { method: 'PUT', body: { name: name.value, color: color.value, logo, domain: domain.value } }); await loadMe(); toast('Saved'); route(); }) }, 'Save Branding')) : null);
  }
  if (tab === 'backups') {
    if (!manage) { body.append(emptyState('lock', 'Admins only', 'Only organisation admins can manage backups.')); return; }
    const [b, p] = await Promise.all([orgApi('/backups'), orgApi('/policy')]);
    const bk = { ...p.backup };
    const every = h('input', { type: 'number', min: 1, value: bk.every_hours, style: { width: '110px' } }); const keep = h('input', { type: 'number', min: 1, value: bk.keep, style: { width: '110px' } });
    const dest = h('input', { type: 'text', value: bk.dest || '', placeholder: 'Default: inside the ForgeAI data folder' });
    body.append(h('div.list', null,
      li('Automatic backups', 'Encrypted with this organisation’s own key.', toggle(bk.enabled, (v) => { bk.enabled = v; })),
      li('Every (hours)', null, every), li('Keep the last', null, keep),
      li('Save to folder', 'e.g. an external drive: /Volumes/Backup/AICore or D:\\Backups\\AICore', dest)),
    h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: guard(async () => { await orgApi('/policy', { method: 'PUT', body: { backup: { enabled: bk.enabled, every_hours: +every.value, keep: +keep.value, dest: dest.value } } }); toast('Saved'); route(); }) }, 'Save'), h('button.btn', { onclick: guard(async () => { await orgApi('/backups', { body: {} }); toast('Backup created'); route(); }) }, 'Back Up Now'), h('span.help', null, `Last backup: ${b.last ? ago(b.last) : 'never'}`)),
    h('div.section-title', null, 'Backups'),
    b.list.length ? h('div.list', null, b.list.map((x) => h('div.li', null, icon('shield'), h('div.t', null, h('b', null, new Date(x.at).toLocaleString()), h('span', null, bytes(x.size))), canOrg('own') ? h('button.btn.sm', { onclick: guard(async () => { if (!(await confirmBox('Restore Backup?', `Replace all of ${o.name}'s data with the backup from ${new Date(x.at).toLocaleString()}? A safety copy of the current data is made first.`, 'Restore', true))) return; await orgApi(`/backups/${encodeURIComponent(x.name)}/restore`, { body: {} }); toast('Restored'); route(); }) }, 'Restore') : null)))
      : h('div.card', null, h('span.muted', null, 'No backups yet.')), h('div.help', { style: { margin: '8px 4px' } }, 'Folder: ', h('span.mono', null, b.dest)));
  }
  if (tab === 'audit') {
    if (!manage) { body.append(emptyState('lock', 'Admins only', 'Only organisation admins can see the activity log.')); return; }
    body.append(auditTable(await orgApi('/audit')));
  }
}
function auditTable(rows, showOrg) {
  return rows.length ? h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['When', 'Who', ...(showOrg ? ['Organisation'] : []), 'Action', 'Detail'].map((x) => h('th', null, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, h('td.small.faint', { title: r.ts, style: { whiteSpace: 'nowrap' } }, ago(r.ts)), h('td', null, r.actor), showOrg ? h('td.muted', null, r.org_name || '') : null, h('td.mono', null, r.action), h('td.small.muted', { style: { maxWidth: '520px', overflowWrap: 'anywhere' } }, r.detail))))))) : emptyState('clock', 'No activity yet');
}
function memberModal() {
  const u = h('input', { type: 'text', placeholder: 'username (new or existing)' });
  const dn = h('input', { type: 'text', placeholder: 'Full name (new people)' });
  const pw = h('input', { type: 'password', placeholder: '8+ characters (new people)' });
  const role = sel(Object.entries(ROLE_NAMES).reverse(), 'user');
  modal('Add Person', h('div', null, field('Username', u), h('div.grid.g2', { style: { gap: '12px' } }, field('Name', dn), field('Password', pw)), field('Role here', role)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Add', primary: true, onClick: async () => { await orgApi('/members', { body: { username: u.value, displayName: dn.value, password: pw.value, role: role.value } }); route(); } }]);
}

// ---------------- SETTINGS
async function pageSettings(root, tab = 'general') {
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Settings'));
  const tabs = [['general', 'General'], ['appearance', 'Appearance'], ['computer', 'This computer'], ['orgs', 'Organisations'], ['users', 'People'], ['workflows', 'Cross-company'], ['audit', 'Activity'], ['account', 'My Account']].filter(([k]) => k === 'account' || k === 'general' || k === 'appearance' || (k === 'workflows' || k === 'computer' ? isOwner() : isPlatform()));
  if (!tabs.find(([k]) => k === tab)) tab = tabs[0][0];
  pg.append(h('div.tabs', null, tabs.map(([k, l]) => h('a' + (tab === k ? '.on' : ''), { href: '#/settings/' + k }, l))));
  const body = h('div'); pg.append(body);
  const li = (title, sub, ctl) => h('div.li', null, h('div.t', null, h('b', null, title), sub ? h('span', null, sub) : null), h('div.ctl', null, ctl));
  if (tab === 'appearance') return pageAppearance(body);
  if (tab === 'computer') return settingsThisComputer(body);
  if (tab === 'general') {
    const name = h('input', { type: 'text', value: S.platformName, disabled: !isOwner() });
    const theme = h('div.seg', null, [['', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('button' + ((store('theme') || '') === v ? '.on' : ''), { onclick: (e) => { store('theme', v); applyTheme(); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
    body.append(h('div.list', null,
      li('Platform name', 'Shown in the sidebar, the sign-in page and on other computers that connect.', h('div.row.nowrap', { style: { width: '100%' } }, name, isOwner() ? h('button.btn', { onclick: guard(async () => { await api('/api/settings/general', { method: 'PUT', body: { platform_name: name.value } }); S.me = null; toast('Renamed'); route(); }) }, 'Save') : null)),
      li('Appearance', null, theme),
      li('Computers & network', 'Remote access, other computers, model sharing.', h('a.btn.sm', { href: '#/network' }, 'Open'))));
  }
  if (tab === 'orgs') {
    body.append(h('div.row', { style: { justifyContent: 'flex-end', marginBottom: '10px' } }, h('button.btn.primary.sm', { onclick: () => newOrgModal() }, icon('plus', 'sm'), 'New Organisation')),
      h('div.list', null, S.orgs.map((o) => { const k = (o.kind === 'company' ? 'business' : o.kind); const lbl = { business: 'Business', project: 'Project', personal: 'Personal' }[k] || 'Business'; return h('div.li', null, monogram(o), h('div.t', null, h('b', null, o.name), h('span', null, lbl)), null,
        h('button.btn.sm', { onclick: () => switchOrg(o.id, '#/org') }, 'Settings'),
        isOwner() ? h('button.btn.sm.ghost', { onclick: guard(async () => { if (!(await confirmBox('Archive Organisation?', `Archive ${o.name}? It disappears from the platform and its cross-company permissions are removed. Its data stays on disk.`, 'Archive', true))) return; await api('/api/orgs/' + o.id, { method: 'DELETE' }); await loadMe(); route(); }) }, 'Archive') : null); })));
  }
  if (tab === 'users') {
    const users = await api('/api/users');
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, 'Platform owners see everything. Platform admins manage organisations, providers and computers. Everyone else only sees organisations they belong to.'), h('button.btn.primary.sm', { onclick: () => userModal() }, icon('plus', 'sm'), 'New Person')),
      h('div.list', null, users.map((u) => h('div.li', null, h('div.avatar', null, initials(u.display_name || u.username)),
        h('div.t', null, h('b', null, u.display_name || u.username, u.disabled ? h('span.badge.bad', { style: { marginLeft: '6px' } }, 'Disabled') : null), h('span', null, [u.username, { owner: 'Platform owner', admin: 'Platform admin', none: null }[u.platform_role], u.orgs.map((o) => `${o.name} (${ROLE_NAMES[o.role]})`).join(', ')].filter(Boolean).join(' · '))),
        isOwner() ? h('button.btn.sm', { onclick: () => userEdit(u) }, 'Edit') : null))));
  }
  if (tab === 'workflows') {
    const grants = (await api('/api/grants')).filter((g) => g.kind === 'cross_org');
    body.append(h('div.row.between', { style: { marginBottom: '10px' } }, h('span.help', null, 'Off by default. Each rule lets agents in one organisation ask agents in another. Every request is logged on both sides.'), h('button.btn.primary.sm', { onclick: () => workflowModal() }, icon('plus', 'sm'), 'Allow Workflow')),
      grants.length ? h('div.list', null, grants.map((g) => h('div.li', null, icon('network'), h('div.t', null, h('b', null, `${g.sourceName} → ${g.targetName}`), h('span', null, `Agents in ${g.sourceName} may ask agents in ${g.targetName} · by ${g.created_by} ${ago(g.created_at)}`)), h('button.btn.sm.danger', { onclick: guard(async () => { await api('/api/grants/' + g.id, { method: 'DELETE' }); route(); }) }, 'Revoke'))))
        : emptyState('shield', 'Organisations are fully separate', 'No cross-company workflows are allowed.'));
  }
  if (tab === 'audit') body.append(auditTable(await api('/api/audit'), true));
  if (tab === 'account') {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const nw = h('input', { type: 'password', autocomplete: 'new-password' });
    body.append(h('div.list', null, li('Current password', null, cur), li('New password', '8 characters or more.', nw)),
      h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: guard(async () => { await api('/api/me/password', { method: 'PUT', body: { current: cur.value, password: nw.value } }); toast('Password changed'); cur.value = ''; nw.value = ''; }) }, 'Change Password'), h('span.grow'),
        h('button.btn', { onclick: guard(async () => { await api('/api/logout', { body: {} }); location.hash = '#/login'; location.reload(); }) }, icon('logout', 'sm'), 'Sign Out')));
  }
}
function userModal() {
  const u = h('input', { type: 'text' }), dn = h('input', { type: 'text' }), pw = h('input', { type: 'password' });
  const role = sel([['none', 'Member of chosen organisations only'], ...(isOwner() ? [['admin', 'Platform admin'], ['owner', 'Platform owner']] : [])], 'none');
  modal('New Person', h('div', null, h('div.grid.g2', { style: { gap: '12px' } }, field('Username', u), field('Name', dn)), field('Password (8+ characters)', pw), field('Platform role', role), h('div.help', null, 'Add them to organisations from Organisation → People.')),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => { await api('/api/users', { body: { username: u.value, displayName: dn.value, password: pw.value, platformRole: role.value } }); route(); } }]);
}
function userEdit(u) {
  const role = sel([['none', 'None'], ['admin', 'Platform admin'], ['owner', 'Platform owner']], u.platform_role);
  const pw = h('input', { type: 'password', placeholder: 'Leave empty to keep' }); let disabled = !!u.disabled;
  modal(u.display_name || u.username, h('div', null, field('Platform role', role), field('Reset password', pw), h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Disabled'), h('span', null, 'Cannot sign in')), toggle(disabled, (v) => { disabled = v; })))),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => { await api('/api/users/' + u.id, { method: 'PUT', body: { platformRole: role.value, password: pw.value || undefined, disabled } }); route(); } }]);
}
function workflowModal() {
  const opts = S.orgs.map((o) => [o.id, o.name]);
  const src = sel(opts, opts[0] && opts[0][0]); const tgt = sel(opts, opts[1] && opts[1][0]);
  modal('Allow Cross-Company Workflow', h('div', null, h('div.grid.g2', { style: { gap: '12px' } }, field('Agents in', src), field('may ask agents in', tgt)),
    note('warn', 'Answers from the second organisation will flow into the first. Only allow this where the two are meant to share that information.')),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Allow', primary: true, onClick: async () => { await api('/api/grants', { body: { kind: 'cross_org', source_org: src.value, target_org: tgt.value, scopes: ['*'] } }); route(); } }]);
}

// Uninstall ForgeAI from a linked / added ForgeAI computer, and remove its access here.
function uninstallNode(n) {
  let purge = false;
  modal(`Uninstall ForgeAI from ${n.name}?`, h('div', null,
    h('p', null, `${n.name} stops ForgeAI and removes it (app, background service, shortcuts and start-up entries). It is then removed from this hub, so it loses access straight away.`),
    h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Also delete its data'), h('span', null, 'Chats, settings, downloaded models and saved keys on that computer. Cannot be undone.')), toggle(false, (v) => { purge = v; }))),
    note('warn', 'If ForgeAI on that computer runs without administrator rights, a system-wide copy there (if any) is left for an administrator to remove.')),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Uninstall', danger: true, primary: true, onClick: async () => { const r = await api(`/api/nodes/${n.id}/uninstall`, { body: { purge, confirm: true } }); toast(`${r.name}: uninstalling${r.purge ? ' and deleting data' : ''}`); if (r.note) setTimeout(() => toast(r.note), 2500); route(); } }]);
}
