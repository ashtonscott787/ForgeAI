'use strict';
/* ForgeAI 2.2 — model picker, connections (Add Provider), performance & bottlenecks, capability guide, pipelines, routing rules. */

const SCOPE = { local: ['laptop', 'This computer', 'ok'], lan: ['network', 'Your network', 'ok'], vpn: ['lock', 'Private VPN', 'ok'], internet: ['globe', 'Leaves your network', 'warn'] };
function scopeChip(scope, short) {
  if (!scope || !SCOPE[scope]) return null;
  const [ic, label, kind] = SCOPE[scope];
  return h('span.badge.' + kind + '.scope', { title: scope === 'internet' ? 'This request is sent outside your local network' : 'Stays on ' + label.toLowerCase() }, icon(ic, 'sm'), short && scope !== 'internet' ? null : label);
}
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s');
const fmtTps = (t) => (t == null ? '—' : (t < 10 ? t.toFixed(1) : Math.round(t)) + ' tok/s');
const LIMIT_BADGE = { unlimited: ['', 'Unlimited'], limited: ['warn', 'Limited'], not_allowed: ['bad', 'Not allowed'] };
function limitBadge(st) {
  if (!st) return null;
  const [k, l] = LIMIT_BADGE[st.state] || ['', st.state];
  const tip = st.detail || (st.caps || []).map((c) => `${c.remaining} of ${c.cap} ${c.what} left`).join('\n');
  const short = st.state === 'limited' && st.caps && st.caps[0] ? `${st.caps[0].remaining} left` : l;
  return h('span.badge' + (k ? '.' + k : ''), { title: tip }, short);
}

// ---------------- Model picker (replaces the native select: readable in light/dark, searchable, any number of models)
function modelPicker(o, value, onChange, cfg = {}) {
  o = o || { local: [], cloud: [], profiles: [], pipelines: [], limits: {} };
  const L = o.limits || { providers: {}, profiles: {} };
  const groups = [];
  if (!cfg.noProfiles && (o.profiles || []).length) groups.push({ title: 'My models', items: o.profiles.map((p) => ({ v: (cfg.raw ? '' : 'm:') + 'profile:' + p.id, label: p.name, sub: p.tagline || '', icon: p.icon, color: p.color, limit: L.profiles && L.profiles[p.id] })) });
  if (!cfg.noPipelines && (o.pipelines || []).length) groups.push({ title: 'Pipelines (hybrid)', items: o.pipelines.map((p) => ({ v: (cfg.raw ? '' : 'm:') + 'pipeline:' + p.id, label: p.name, sub: p.stages.join(' → '), icon: 'tasks' })) });
  const modes = cfg.modes || ['auto', 'local_fast', 'local_powerful', 'cloud', 'claude', 'openai', 'google'];
  const MODE_SUB = { auto: 'Chooses for each request and says why', local_fast: 'Quickest model on your computers', local_powerful: 'Most capable model on your computers', cloud: 'Best connected cloud model', claude: 'Anthropic', openai: 'OpenAI', google: 'Google' };
  groups.push({ title: 'Automatic', items: modes.map((k) => ({ v: k, label: k === 'cloud' ? 'Cloud (best)' : MODE_NAMES[k], sub: MODE_SUB[k] || '', icon: k === 'auto' ? 'wand' : /local/.test(k) ? 'laptop' : 'globe' })) });
  if ((o.local || []).length) groups.push({ title: 'On your computers & servers', limit: L.local, items: o.local.map((m) => { const e = (m.endpoints || [])[0] || {}; return { v: (cfg.raw ? '' : 'm:') + 'local:' + m.id, label: m.name || m.id, sub: [e.name && `${e.name} · ${e.host || e.node}`, m.params, m.quant, m.context && Math.round(m.context / 1000) + 'k ctx', m.tps && fmtTps(m.tps)].filter(Boolean).join(' · '), loaded: m.loaded, scope: e.scope, icon: 'cube' }; }) });
  for (const c of o.cloud || []) {
    const st = L.providers && L.providers[c.providerId];
    const mk = (id, other) => ({ v: `${cfg.raw ? '' : 'm:'}cloud:${c.providerId}:${id}`, label: id, sub: other ? 'not a chat model' : c.host, scope: 'internet', icon: 'globe', disabled: st && st.state === 'not_allowed', disabledWhy: st && st.detail, other });
    groups.push({ title: c.name, limit: st, items: [...c.models.map((id) => mk(id)), ...(c.other || []).map((id) => mk(id, true))] });
  }
  const all = groups.flatMap((g) => g.items);
  const cur = () => all.find((x) => x.v === value) || { label: value && value.includes(':') ? value.split(':').pop() : MODE_NAMES[value] || 'Auto', icon: 'wand' };
  const btn = h('button.mpick' + (cfg.compact ? '.compact' : ''), { type: 'button', 'aria-haspopup': 'listbox', title: 'Choose a model' });
  const paint = () => { const c = cur(); clear(btn).append(...[c.color ? profileBadge(c, 18) : icon(c.icon || 'cube', 'sm'), h('span.lbl', null, c.label), c.scope === 'internet' ? h('span.netdot', { title: 'Leaves your network' }) : null, icon('down', 'sm')].filter(Boolean)); };
  paint();
  btn.onclick = (e) => { e.preventDefault(); open(); };
  function open() {
    const pop = h('div.mpop', { role: 'listbox' }); let showOther = false; let idx = -1; let rows = [];
    const q = h('input.mq', { type: 'search', placeholder: `Search ${all.length} models…`, 'aria-label': 'Search models' });
    const list = h('div.mlist');
    const other = h('label.mother', null, h('input', { type: 'checkbox', onchange: (e) => { showOther = e.target.checked; draw(); } }), 'Show non-chat models');
    const draw = () => {
      clear(list); rows = []; const term = q.value.trim().toLowerCase(); let shown = 0, hidden = 0;
      for (const g of groups) {
        const items = g.items.filter((x) => (showOther || !x.other) && (!term || (x.label + ' ' + (x.sub || '') + ' ' + g.title).toLowerCase().includes(term)));
        if (!items.length) continue;
        list.append(h('div.mgrp', null, h('span', null, g.title), g.limit && g.limit.state !== 'unlimited' ? limitBadge(g.limit) : null));
        for (const x of items) {
          if (shown >= 400) { hidden++; continue; }
          const r = h('button.mrow' + (x.v === value ? '.sel' : '') + (x.disabled ? '.dis' : ''), { type: 'button', role: 'option', 'aria-selected': x.v === value, 'aria-disabled': !!x.disabled, title: x.disabled ? x.disabledWhy || 'Not allowed' : x.sub || x.label,
            onclick: () => { if (x.disabled) return; value = x.v; paint(); close(); onChange(x.v); } },
          x.color ? profileBadge(x, 20) : h('span.mic', null, icon(x.icon || 'cube', 'sm')),
          h('span.mt', null, h('span.ml', null, x.label), x.sub || x.disabled ? h('span.ms', null, x.disabled ? 'Not allowed — ' + (x.disabledWhy || '') : x.sub) : null),
          x.limit && x.limit.state !== 'unlimited' ? limitBadge(x.limit) : null, x.loaded ? h('span.badge.ok', { title: 'Loaded and ready' }, 'Loaded') : null, x.scope === 'internet' ? h('span.netdot', { title: 'Leaves your network' }) : null, x.v === value ? icon('check', 'sm') : null);
          list.append(r); rows.push(r); shown++;
        }
      }
      if (hidden) list.append(h('div.mmore', null, `${hidden} more — type to search`));
      if (!rows.length) list.append(h('div.mmore', null, 'No models match'));
      idx = rows.findIndex((r) => r.classList.contains('sel'));
    };
    q.oninput = draw;
    q.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1))); rows.forEach((r, i) => r.classList.toggle('kb', i === idx)); rows[idx] && rows[idx].scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter' && rows[idx]) { e.preventDefault(); rows[idx].click(); }
      if (e.key === 'Escape') close();
    };
    pop.append(q, list, all.some((x) => x.other) ? other : null);
    const veil = h('div.mveil', { onmousedown: (e) => { if (e.target === veil) close(); } }, pop);
    document.body.append(veil);
    const r = btn.getBoundingClientRect(); const w = Math.min(420, window.innerWidth - 16);
    pop.style.width = w + 'px'; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 12; const up = below < 280 && r.top > below;
    pop.style.maxHeight = Math.max(240, (up ? r.top : below) - 12) + 'px';
    if (up) pop.style.bottom = (window.innerHeight - r.top + 6) + 'px'; else pop.style.top = (r.bottom + 6) + 'px';
    draw(); setTimeout(() => q.focus(), 10);
    function close() { veil.remove(); btn.focus(); }
  }
  btn.getValue = () => value; btn.setValue = (v) => { value = v; paint(); };
  return btn;
}

// ---------------- Connections: one "Add Provider" flow for cloud and self-hosted servers
const SERVER_PRESETS = [
  ['lmstudio', 'LM Studio', 'laptop', 'http://127.0.0.1:1234'], ['ollama', 'Ollama', 'laptop', 'http://127.0.0.1:11434'], ['llamacpp', 'llama.cpp server', 'server', 'http://127.0.0.1:8080'],
  ['vllm', 'vLLM', 'server', 'http://127.0.0.1:8000'], ['exo', 'exo cluster', 'network', 'http://127.0.0.1:52415'], ['mlx', 'MLX server', 'laptop', 'http://127.0.0.1:8080'],
  ['koboldcpp', 'KoboldCpp', 'laptop', 'http://127.0.0.1:5001'], ['jan', 'Jan', 'laptop', 'http://127.0.0.1:1337'], ['generic', 'Any OpenAI-compatible server', 'server', 'http://'],
];
const CLOUD_PRESETS = [['openai', 'OpenAI', 'Create a key at platform.openai.com'], ['anthropic', 'Anthropic (Claude)', 'Create a key at console.anthropic.com'], ['google', 'Google Gemini', 'Create a key at aistudio.google.com'], ['openai_compat', 'Other cloud (OpenAI-compatible)', 'OpenRouter, Groq, Together, Mistral…']];

function connectWizard(prefill = {}) {
  const st = { step: prefill.preset || prefill.provider ? 1 : 0, cloud: !!prefill.provider, preset: prefill.preset || 'lmstudio', provider: prefill.provider || 'openai', name: prefill.name || '', url: prefill.url || '', apiKey: '', headers: '', tls_mode: 'verify', cert_pin: null, timeout: 15, org_id: '', budget: 0, label: '', base_url: '', test: null, testing: false };
  const box = h('div.wiz'); const foot = h('div.wizfoot');
  const manageable = S.orgs.filter((o) => ['org_owner', 'org_admin'].includes(o.role));
  let closeFn = null;
  const kindOf = () => (st.preset === 'ollama' ? 'ollama' : 'compat');
  const stepsBar = () => h('div.wizsteps', null, ['Choose', 'Details', 'Test & save'].map((t, i) => h('span' + (i === st.step ? '.on' : i < st.step ? '.done' : ''), null, i < st.step ? icon('check', 'sm') : h('b', null, i + 1), t)));
  const draw = () => {
    clear(box); clear(foot); box.append(stepsBar());
    if (st.step === 0) {
      box.append(h('div.section-title', null, 'On your computers & servers'), h('div.presets', null, SERVER_PRESETS.map(([k, n, ic, u]) => h('button.preset' + (!st.cloud && st.preset === k ? '.on' : ''), { type: 'button', onclick: () => { st.cloud = false; st.preset = k; if (!st.url || SERVER_PRESETS.some((p) => p[3] === st.url)) st.url = u; st.name = st.name || n; st.test = null; st.step = 1; draw(); } }, icon(ic), h('span', null, n)))),
        h('div.row', { style: { margin: '10px 0 0', gap: '8px' } }, h('button.btn.sm', { onclick: () => discover(false) }, icon('search', 'sm'), 'Find on this computer'), h('button.btn.sm', { onclick: () => discover(true) }, icon('network', 'sm'), 'Scan my network'), h('button.btn.sm.ghost', { onclick: () => importFile() }, icon('up', 'sm'), 'Import file…')),
        h('div.found'),
        h('div.section-title', null, 'Cloud providers'), h('div.presets', null, CLOUD_PRESETS.map(([k, n, help]) => h('button.preset' + (st.cloud && st.provider === k ? '.on' : ''), { type: 'button', title: help, onclick: () => { st.cloud = true; st.provider = k; st.test = null; st.step = 1; draw(); } }, icon('key'), h('span', null, n)))),
        h('div', { style: { marginTop: '12px' } }, note('info', 'ForgeAI only uses official API keys — never your ChatGPT or Claude website login. Keys are encrypted and never shown to agents.')));
      foot.append(h('button.btn', { onclick: () => closeFn() }, 'Cancel'));
    } else if (st.step === 1) {
      if (st.cloud) {
        const P = CLOUD_PRESETS.find((p) => p[0] === st.provider);
        box.append(h('h3.wizh', null, P[1]), note('info', P[2] + '. API billing is separate from ChatGPT/Claude subscriptions.'), h('div', { style: { height: '12px' } }),
          field('API key', inp('apiKey', 'password', 'Paste API key'), 'Stored encrypted. Never shown again.'),
          st.provider === 'openai_compat' ? field('Base URL', inp('base_url', 'url', 'https://api.example.com/v1')) : null,
          field('Used by', sel([...(isPlatform() ? [['', 'All organisations (default key)']] : []), ...manageable.map((o) => [o.id, 'Only ' + o.name])], st.org_id, { onchange: (e) => { st.org_id = e.target.value; } }), 'An organisation’s own key always wins over the default key.'),
          h('div.grid.g2', { style: { gap: '12px' } }, field('Monthly budget (US$, 0 = none)', inp('budget', 'number')), field('Label', inp('label', 'text', P[1]))));
      } else {
        const P = SERVER_PRESETS.find((p) => p[0] === st.preset);
        box.append(h('h3.wizh', null, P[1]),
          h('div.grid.g2', { style: { gap: '12px' } }, field('Name', inp('name', 'text', P[1])), field('Address', inp('url', 'url', P[3]), 'Any IP, host name, port, http or https — on this computer, your network or another site.')),
          field('API key / token (optional)', inp('apiKey', 'password', st.preset === 'lmstudio' ? 'LM Studio API token, if you turned one on' : 'Bearer token, if the server needs one')),
          h('details', { open: st.headers || st.tls_mode !== 'verify' }, h('summary.small.muted', { style: { cursor: 'pointer', margin: '6px 0 10px' } }, 'Advanced: headers, security, timeout'),
            field('Extra headers', h('textarea', { rows: 2, class: 'mono', placeholder: 'Header-Name: value (one per line)', value: st.headers, oninput: (e) => { st.headers = e.target.value; } }), 'Stored encrypted.'),
            h('div.grid.g2', { style: { gap: '12px' } },
              field('HTTPS certificate', sel([['verify', 'Must be trusted (normal)'], ['pin', 'Trust this server’s certificate'], ['insecure', 'Don’t check (not safe)']], st.tls_mode, { onchange: (e) => { st.tls_mode = e.target.value; } }), 'Use “Trust this server’s certificate” for your own self-signed server.'),
              field('Timeout (seconds)', inp('timeout', 'number')))),
          h('div.card.flat.small', { style: { marginTop: '8px' } }, h('b', null, 'Connecting across networks safely. '), 'Prefer a VPN (Tailscale or WireGuard) or a reverse proxy with HTTPS and a key. Never expose a model server to the internet without authentication.'));
      }
      foot.append(h('button.btn', { onclick: () => { st.step = 0; draw(); } }, 'Back'), h('span.grow'), h('button.btn.primary', { onclick: () => { st.step = 2; draw(); runTest(); } }, 'Test Connection'));
    } else {
      const t = st.test; const ok = t && t.reachable && t.authenticated && !t.error;
      const row = (good, label, val) => h('div.li', null, h('span.tick' + (good === true ? '.on' : good === false ? '.bad' : ''), null, good === true ? icon('check', 'sm') : good === false ? icon('x', 'sm') : null), h('div.t', null, h('b', null, label)), h('span', null, val));
      box.append(h('h3.wizh', null, st.cloud ? CLOUD_PRESETS.find((p) => p[0] === st.provider)[1] : (st.name || 'Server')), h('div.small.muted', { style: { marginBottom: '10px' } }, st.cloud ? (st.base_url || 'Official API') : st.url));
      if (st.testing || !t) box.append(h('div.card.flat', null, h('span.spinner'), ' Testing…'));
      else {
        box.append(h('div.list', { style: { boxShadow: 'none' } },
          row(t.reachable, 'Reachable', t.reachable ? (t.latencyMs != null ? fmtMs(t.latencyMs) : 'yes') : 'no'),
          row(t.authenticated, 'Authenticated', t.authenticated ? 'yes' : t.authenticated === false ? 'key rejected' : '—'),
          row(t.modelCount != null ? t.modelCount > 0 : null, 'Models', t.modelCount != null ? (st.cloud && t.chatModels != null ? `${t.modelCount} (${t.chatModels} chat)` : String(t.modelCount)) : '—'),
          h('div.li', null, h('div.t', null, h('b', null, 'Network')), scopeChip(t.scope))));
        if (t.error) box.append(h('div', { style: { marginTop: '10px' } }, note('warn', t.error)));
        if (t.warning) box.append(h('div', { style: { marginTop: '10px' } }, note('warn', t.warning)));
        if (t.cert) box.append(h('div.card.flat', { style: { marginTop: '10px' } }, h('b', null, 'Certificate presented'), h('div.small.muted', null, `Issued to ${[t.cert.subject, ...(t.cert.names || [])].filter(Boolean).slice(0, 3).join(', ')} by ${t.cert.issuer || 'unknown'} · valid to ${t.cert.validTo}`), h('div.small.mono', { style: { wordBreak: 'break-all', margin: '4px 0 8px' } }, t.cert.fingerprint),
          h('button.btn.sm', { onclick: () => { st.tls_mode = 'pin'; st.cert_pin = t.cert.fingerprint; runTest(); } }, icon('lock', 'sm'), 'Trust This Certificate')));
        if (ok && t.models && t.models.length) box.append(h('div.small.muted', { style: { marginTop: '10px' } }, 'Found: ' + t.models.slice(0, 8).map((m) => m.id + (m.loaded ? ' (loaded)' : '')).join(', ') + (t.models.length > 8 ? '…' : '')));
      }
      foot.append(h('button.btn', { onclick: () => { st.step = 1; draw(); } }, 'Back'), h('button.btn.ghost', { onclick: runTest, disabled: st.testing }, 'Test Again'), h('span.grow'),
        !ok && t && !st.testing && !st.cloud ? h('button.btn', { onclick: guard(async () => { await save(true); }) }, 'Save Anyway') : null,
        h('button.btn.primary', { disabled: !ok || st.testing, onclick: guard(async () => { await save(false); }) }, 'Save'));
    }
  };
  function inp(k, type, ph) { return h('input', { type, value: st[k] == null ? '' : st[k], placeholder: ph || '', autocomplete: 'off', oninput: (e) => { st[k] = type === 'number' ? +e.target.value : e.target.value; st.test = null; } }); }
  async function runTest() {
    st.testing = true; st.test = null; draw();
    try {
      st.test = st.cloud ? await api('/api/providers/test', { body: { provider: st.provider, apiKey: st.apiKey, base_url: st.base_url || undefined, org_id: st.org_id || undefined } })
        : await api('/api/connections/test', { body: { preset: st.preset, kind: kindOf(), url: st.url, apiKey: st.apiKey || undefined, headers: st.headers, tls_mode: st.tls_mode, cert_pin: st.cert_pin, timeout_ms: (st.timeout || 15) * 1000 } });
    } catch (e) { st.test = { reachable: false, error: e.message }; }
    st.testing = false; draw();
  }
  async function save(force) {
    if (st.cloud) {
      const r = await api('/api/providers', { body: { provider: st.provider, org_id: st.org_id || null, apiKey: st.apiKey, base_url: st.base_url || null, budget_month: st.budget, label: st.label || undefined } });
      toast(`Connected — ${r.provider.status_detail}`);
    } else {
      await api('/api/nodes', { body: { kind: kindOf(), preset: st.preset, name: st.name || SERVER_PRESETS.find((p) => p[0] === st.preset)[1], url: st.url, apiKey: st.apiKey || undefined, headers: st.headers, tls_mode: st.tls_mode, cert_pin: st.cert_pin, timeout_ms: (st.timeout || 15) * 1000 } });
      toast(force ? 'Saved — it will be used when it comes online' : 'Server added');
    }
    closeFn(); route();
  }
  async function discover(lan) {
    const box2 = box.querySelector('.found'); clear(box2).append(h('div.card.flat', { style: { marginTop: '10px' } }, h('span.spinner'), lan ? ' Scanning your network (can take ~20 s)…' : ' Looking on this computer…'));
    try {
      const r = await api('/api/connections/discover', { body: { lan } });
      clear(box2).append(h('div.list', { style: { boxShadow: 'none', marginTop: '10px' } }, r.found.length ? r.found.map((f) => h('div.li', null, icon('server'), h('div.t', null, h('b', null, f.name), h('span', null, `${f.url} · ${f.needsKey ? 'needs a key' : f.models + ' models'}`)), scopeChip(f.scope, true),
        f.alreadyAdded ? h('span.badge.ok', null, 'Added') : h('button.btn.sm.tint', { onclick: () => { st.cloud = false; st.preset = f.preset; st.url = f.url; st.name = f.name; st.step = 1; draw(); } }, 'Add…'))) : [h('div.li', null, h('div.t', null, h('b', null, 'Nothing found'), h('span', null, `Checked ${r.scanned} address${r.scanned === 1 ? '' : 'es'} on the usual ports. Make sure the server is running and allows network connections.`)))]));
    } catch (e) { clear(box2).append(note('warn', e.message)); }
  }
  function importFile() {
    const f = h('input', { type: 'file', accept: '.json,application/json', onchange: guard(async (e) => { const file = e.target.files[0]; if (!file) return; const data = JSON.parse(await file.text()); const r = await api('/api/connections/import', { body: data }); toast(`Imported ${r.added.length} server${r.added.length === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`); if (r.needKeys.length) modal('Add Keys', h('div', null, h('p', null, 'Keys are never stored in export files. Add them for:'), h('ul', null, r.needKeys.map((k) => h('li', null, k)))), [{ label: 'OK', primary: true, onClick: () => route() }]); else { closeFn(); route(); } }) });
    f.click();
  }
  draw();
  closeFn = modal('Add Provider', h('div', null, box, foot), [], { wide: true });
}

async function pageProviders(root) {
  const [provs, cl, opts] = await Promise.all([api('/api/providers'), api('/api/cluster'), S.org ? orgApi('/model-options').catch(() => ({ limits: {} })) : { limits: {} }]);
  const pg = h('div.page'); root.append(pg);
  const plat = isPlatform();
  pg.append(pageHead('AI Providers', 'Cloud AI services and model servers — on this computer, your network, or another site. Every answer shows which one served it.',
    plat ? h('button.btn', { onclick: () => { location.href = '/api/connections/export'; } }, icon('download', 'sm'), 'Export') : null,
    h('button.btn.primary', { onclick: () => connectWizard() }, icon('plus', 'sm'), 'Add Provider')));
  // servers
  const servers = cl.nodes.filter((n) => !n.is_local && n.kind !== 'worker');
  const local = cl.nodes.find((n) => n.is_local);
  pg.append(h('div.section-title', { style: { marginTop: 0 } }, 'Model servers'));
  const srvRow = (n, ep) => h('div.li', null, icon(n.kind === 'ollama' || (ep && ep.runtime === 'ollama') ? 'laptop' : 'server'),
    h('div.t', null, h('b', null, ep ? `${({ ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', mlx: 'MLX', vllm: 'vLLM', exo: 'exo' })[ep.runtime] || ep.runtime} on this computer` : n.name),
      h('span', null, [ep ? ep.url : n.url, ep ? (ep.ok ? `${ep.models} models · ${fmtMs(ep.latencyMs)}` : 'not running') : n.status === 'online' ? `${(n.models || []).length} models · ${(n.models || []).filter((m) => m.loaded).length} loaded` : null, !ep && n.hasKey ? 'key set' : null, !ep && n.tls_mode === 'pin' ? 'certificate trusted' : !ep && n.tls_mode === 'insecure' ? 'certificate not checked' : null].filter(Boolean).join(' · ')),
      !ep && n.status !== 'online' && n.error ? h('span', { style: { color: 'var(--red)', whiteSpace: 'normal' } }, n.error) : ep && !ep.ok ? h('span', { style: { whiteSpace: 'normal' } }, ep.error || '') : null),
    scopeChip(ep ? 'local' : n.scope), statusBadge(ep ? (ep.ok ? 'online' : 'offline') : n.enabled ? n.status : 'disabled'),
    !ep && plat ? h('button.btn.sm', { onclick: () => serverEdit(n) }, 'Settings') : null);
  pg.append(h('div.list', null, ...(local && local.endpoints ? local.endpoints.map((ep) => srvRow(local, ep)) : []), ...servers.map((n) => srvRow(n)),
    !servers.length ? h('div.li', null, h('div.t', null, h('span', null, 'Add LM Studio, llama.cpp, vLLM, exo or any OpenAI-compatible server — on this computer, another computer, or another site.')), h('button.btn.sm.tint', { onclick: () => connectWizard() }, 'Add')) : null));
  if (plat) pg.append(h('div.help', { style: { margin: '8px 4px 0' } }, 'This computer is checked every 15 seconds for models being loaded or unloaded. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); runtimesModal(cl.runtimes); } }, 'Ports checked on this computer')));
  // cloud
  pg.append(h('div.section-title', null, 'Cloud providers'));
  if (!provs.length) pg.append(h('div.card', null, h('span.muted', null, 'No cloud provider connected. '), h('a', { href: '#', onclick: (e) => { e.preventDefault(); connectWizard({ provider: 'anthropic' }); } }, 'Connect Claude, OpenAI or Gemini')));
  for (const p of provs) {
    const u = p.usage; const lim = opts.limits && opts.limits.providers && opts.limits.providers[p.id];
    const stat = (l, v, s2, extra) => h('div.kpi', null, h('div.l', null, l), h('div', { style: { fontWeight: 650, fontSize: '17px' } }, v), s2 ? h('div.s', null, s2) : null, extra || null);
    pg.append(h('div.card', { style: { marginBottom: '14px' } },
      h('div.row.between', null, h('div', null, h('h2', { style: { margin: 0 } }, p.label), h('div.small.muted', null, `${p.providerName} · ${p.base_url || 'official API'} · ${p.orgName ? 'only ' + p.orgName : 'all organisations without their own key'} · key ${p.keyHint || '—'}`)),
        h('div.row', null, scopeChip('internet', true), limitBadge(lim), statusBadge(p.status))),
      lim && (lim.detail || lim.caps) ? h('div.small', { style: { marginTop: '6px', color: 'var(--text-2)' } }, lim.detail || lim.caps.map((c) => `${c.remaining} of ${c.cap} ${c.what} left`).join(' · ')) : null,
      p.status_detail ? h('div.small', { style: { marginTop: '6px', color: p.status === 'connected' ? 'var(--text-2)' : 'var(--red)' } }, p.status_detail) : null,
      h('div.grid.g4', { style: { marginTop: '16px' } },
        stat('Today', money(u.todayCost), `${num(u.todayReq)} requests`), stat('This month', money(u.monthCost), `${num(u.monthReq)} requests`), stat('Failures', num(u.failures), 'this month'),
        stat('Budget', p.budget_month ? money(p.budget_month) : 'None', null, p.budget_month ? h('div.bar', { style: { marginTop: '6px' } }, h('i', { style: { width: Math.min(100, u.monthCost / p.budget_month * 100) + '%' } })) : null)),
      h('hr.sep'),
      h('div.row', null, h('span.small.muted.grow', null, `${p.models.length} chat models${p.allModels > p.models.length ? ` (${p.allModels} in total)` : ''}${p.default_model ? ' · default ' + p.default_model : ''} · checked ${ago(p.checked_at)}`),
        h('button.btn.sm', { onclick: guard(async () => { await api(`/api/providers/${p.id}/test`, { body: {} }); toast('Checked'); route(); }) }, 'Test'), h('button.btn.sm', { onclick: () => providerEdit(p) }, 'Settings'))));
  }
  if (plat) {
    const prices = await api('/api/prices');
    pg.append(h('details', { style: { marginTop: '20px' } }, h('summary.section-title', { style: { cursor: 'pointer' } }, 'Advanced — prices used for cost estimates'),
      h('div.card', null, h('p.small.muted', { style: { marginTop: 0 } }, 'US dollars per million tokens. The longest matching name wins; * is the fallback. These are estimates — check each provider’s pricing page.'), pricesEditor(prices))));
  }
}
function serverEdit(n) {
  const st = { name: n.name, url: n.url, apiKey: '', headers: null, tls_mode: n.tls_mode || 'verify', timeout: Math.round((n.timeout_ms || 0) / 1000) || 15, enabled: !!n.enabled };
  const f = (k, type, ph) => h('input', { type, value: st[k] == null ? '' : st[k], placeholder: ph || '', oninput: (e) => { st[k] = type === 'number' ? +e.target.value : e.target.value; } });
  const hdr = h('textarea', { rows: 2, class: 'mono', placeholder: n.headerNames.length ? `Saved: ${n.headerNames.join(', ')} — type to replace` : 'Header-Name: value', oninput: (e) => { st.headers = e.target.value; } });
  const res = h('div');
  modal(n.name, h('div', null,
    h('div.grid.g2', { style: { gap: '12px' } }, field('Name', f('name', 'text')), field('Address', f('url', 'url'))),
    field('API key / token', f('apiKey', 'password', n.hasKey ? 'Saved — type to replace (leave empty to keep)' : 'None')),
    field('Extra headers', hdr),
    h('div.grid.g2', { style: { gap: '12px' } }, field('HTTPS certificate', sel([['verify', 'Must be trusted'], ['pin', n.pinned ? 'Trusted certificate (pinned)' : 'Trust this server’s certificate'], ['insecure', 'Don’t check (not safe)']], st.tls_mode, { onchange: (e) => { st.tls_mode = e.target.value; } })), field('Timeout (seconds)', f('timeout', 'number'))),
    h('div.li', null, h('div.t', null, h('b', null, 'Use this server')), toggle(st.enabled, (v) => { st.enabled = v; })), res),
  [{ label: 'Remove', danger: true, onClick: async () => { if (!(await confirmBox('Remove Server?', `Remove ${n.name}? Its models will no longer be used.`, 'Remove', true))) return false; await api('/api/nodes/' + n.id, { method: 'DELETE' }); route(); } },
    { label: 'Test', onClick: async () => { const t = await api('/api/connections/test', { body: { preset: n.preset, kind: n.kind, url: st.url, apiKey: st.apiKey || undefined, headers: st.headers || undefined, tls_mode: st.tls_mode, timeout_ms: st.timeout * 1000 } }); clear(res).append(h('div', { style: { marginTop: '10px' } }, note(t.error ? 'warn' : 'info', t.error || `Reachable · ${t.modelCount} models · ${fmtMs(t.latencyMs)}`))); return false; } },
    { label: 'Save', primary: true, onClick: async () => {
      let pin;
      if (st.tls_mode === 'pin' && !n.pinned) { const c = await api('/api/connections/cert', { body: { url: st.url } }); if (!(await confirmBox('Trust This Certificate?', `${[c.subject, ...(c.names || [])].filter(Boolean).join(', ')} · issued by ${c.issuer}\n${c.fingerprint}`, 'Trust'))) return false; pin = c.fingerprint; }
      await api('/api/nodes/' + n.id, { method: 'PUT', body: { name: st.name, url: st.url !== n.url ? st.url : undefined, apiKey: st.apiKey || undefined, headers: st.headers != null ? st.headers : undefined, tls_mode: st.tls_mode, cert_pin: pin, timeout_ms: st.timeout * 1000, enabled: st.enabled } }); toast('Saved'); route();
    } }], { wide: true });
}

// ---------------- Performance: live stats, speeds and bottlenecks
async function pagePerf(root) {
  const pg = h('div.page.perf'); root.append(pg);
  pg.append(pageHead('Performance', 'Live speeds across every model, computer, server and cloud provider — and what is slowing things down.', h('span.small.muted', { id: 'perfat' })));
  const bott = h('div'); const live = h('div'); const machines = h('div'); const modelsBox = h('div'); const provBox = h('div'); const recentBox = h('div'); const clusterBox = h('div');
  pg.append(h('div.section-title', null, 'Bottlenecks'), bott, h('div.section-title', null, 'Running now'), live, h('div.section-title', null, 'Computers & servers'), machines, h('div.section-title', null, 'Models — last 24 hours'), modelsBox, h('div.section-title', null, 'Cloud providers'), provBox, clusterBox, h('div.section-title', null, 'Recent requests — where the time went'), recentBox);
  const bar = (pct, cls) => h('div.bar' + (pct >= 90 ? '.bad' : pct >= 75 ? '.warn' : '') + (cls || ''), null, h('i', { style: { width: Math.max(2, Math.min(100, pct || 0)) + '%' } }));
  const timeline = (r) => {
    const tot = r.totalMs || 1; const st = r.serverTimings || {}; const parts = [];
    if (r.ttftMs != null) {
      const load = st.load_ms || 0, pre = st.prompt_ms || 0, wait = Math.max(0, r.ttftMs - load - pre);
      if (wait) parts.push(['wait', wait, 'Waiting / network']); if (load) parts.push(['load', load, 'Loading model']); if (pre) parts.push(['pre', pre, 'Reading prompt']);
      parts.push(['gen', tot - r.ttftMs, 'Writing']);
    } else parts.push(['gen', tot, r.ok ? 'Working' : 'Failed']);
    return h('div.tl', { title: parts.map((p) => `${p[2]}: ${fmtMs(p[1])}`).join('\n') }, parts.map(([k, v]) => h('i.' + k, { style: { width: (v / tot * 100) + '%' } })));
  };
  async function draw() {
    if (!document.body.contains(pg)) return;
    let d; try { d = await api('/api/perf'); } catch (e) { clear(bott).append(note('warn', e.message)); return; }
    const at = document.getElementById('perfat'); if (at) at.textContent = 'Updated ' + new Date().toLocaleTimeString();
    clear(bott).append(h('div.list', null, d.bottlenecks.slice(0, 8).map((b) => h('div.li', null, h('span.sev.s' + b.sev, null, icon(b.sev >= 3 ? 'warn' : b.sev ? 'info' : 'check', 'sm')), h('div.t', null, h('b', { style: { whiteSpace: 'normal' } }, b.text), b.fix ? h('span', { style: { whiteSpace: 'normal' } }, b.fix) : null), h('span.small.muted', null, b.where)))));
    clear(live).append(d.live.length ? h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['Model', 'Where', 'Stage', 'Phase', 'Elapsed', 'First word', 'Speed'].map((x) => h('th', null, x)))),
      h('tbody', null, d.live.map((r) => h('tr', null, h('td', null, h('b', null, r.model)), h('td', null, r.node, ' ', scopeChip(r.scope, true)), h('td.muted', null, r.stage || '—'), h('td', null, r.phase === 'writing' ? h('span.badge.ok', null, 'Writing') : h('span.badge.info', null, h('span.spinner'), 'Waiting')), h('td', null, fmtMs(r.elapsedMs)), h('td', null, fmtMs(r.ttftMs)), h('td', null, fmtTps(r.tps)))))))) : h('div.card', null, h('span.muted', null, 'Nothing running.')));
    clear(machines).append(h('div.grid.gauto', null, d.machines.map((m) => {
      const x = m.metrics; const memPct = x && x.memTotal ? 100 - x.memFree / x.memTotal * 100 : null;
      return h('div.card.mcard', null,
        h('div.row.between', null, h('div', null, h('b', null, m.name), h('div.small.muted', null, [m.kind === 'local' ? 'This computer' : m.preset || m.kind, m.url].filter(Boolean).join(' · '))), h('div.row', null, scopeChip(m.scope, true), statusBadge(m.status))),
        x ? h('div.metrics', null,
          h('div', null, h('div.row.between.small', null, h('span.muted', null, 'CPU'), h('span', null, x.cpuPct != null ? x.cpuPct + '%' : '—')), bar(x.cpuPct)),
          h('div', null, h('div.row.between.small', null, h('span.muted', null, 'Memory'), h('span', null, `${((x.memTotal - x.memFree) / 2 ** 30).toFixed(1)} / ${(x.memTotal / 2 ** 30).toFixed(0)} GB`)), bar(memPct)),
          ...(x.gpu || []).map((g) => h('div', null, h('div.row.between.small', null, h('span.muted', null, g.name), h('span', null, [g.utilPct != null ? g.utilPct + '%' : null, g.memTotal ? `${(g.memUsed / 2 ** 30).toFixed(1)}/${(g.memTotal / 2 ** 30).toFixed(0)} GB VRAM` : g.memUsed ? `${(g.memUsed / 2 ** 30).toFixed(1)} GB in use` : null, g.tempC != null ? g.tempC + '°C' : null].filter(Boolean).join(' · ') || '—')), g.utilPct != null ? bar(g.utilPct) : null)),
          !(x.gpu || []).length ? h('div.small.muted', null, 'GPU: not reported on this computer') : null,
          h('div.small.muted', null, x.temps ? `CPU ${x.temps.cpuC}°C` : 'Temperature: not available', (x.notes || []).length ? ' · ' + x.notes[0] : '')) : h('div.small.muted', { style: { margin: '10px 0' } }, m.metricsNote || 'No hardware data.'),
        m.endpoints && m.endpoints.length ? h('div.small', { style: { marginTop: '8px' } }, m.endpoints.map((e) => h('div.row.between', null, h('span.muted', null, e.runtime + ' · ' + e.url.replace(/^https?:\/\//, '')), h('span', null, e.ok ? fmtMs(e.latencyMs) : 'offline')))) : null,
        h('div.small', { style: { marginTop: '8px' } }, h('b', null, 'Loaded: '), m.loaded.length ? m.loaded.map((l) => `${l.id}${l.vram ? ` (${(l.vram / 2 ** 30).toFixed(1)} GB VRAM)` : ''}`).join(', ') : 'none', m.inflight ? ` · ${m.inflight} running` : ''),
        m.speeds.length ? h('div.small', { style: { marginTop: '4px' } }, h('b', null, 'Speed: '), m.speeds.map((s) => `${s.id} ${fmtTps(s.tps)}${s.ttft ? ', first word ' + fmtMs(s.ttft) : ''}`).join(' · ')) : null,
        m.changes && m.changes.length && m.changedAt ? h('div.small.muted', { style: { marginTop: '4px' } }, `Last change ${ago(m.changedAt)}: ` + m.changes.map((c) => `${c.id} ${c.change}`).join(', ')) : null);
    })));
    const maxTps = Math.max(1, ...d.models.map((a) => a.tps || 0));
    clear(modelsBox).append(d.models.length ? h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['Model', 'Where', 'Requests', 'First word', 'Speed', '', 'Total (median / p95)', 'Errors', 'Usual bottleneck', ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.models.map((a) => h('tr', null, h('td', null, h('b', null, a.key)), h('td.muted', null, a.provider === 'local' ? a.node : a.provider, ' ', scopeChip(a.scope, true)), h('td', null, num(a.calls)), h('td', null, fmtMs(a.ttftMs)), h('td', null, fmtTps(a.tps)), h('td', { style: { width: '90px' } }, a.tps ? bar(a.tps / maxTps * 100, '.good') : null),
        h('td', null, `${fmtMs(a.medianMs)} / ${fmtMs(a.p95Ms)}`), h('td', null, a.errors ? h('span', { style: { color: 'var(--red)' } }, `${a.errors}${a.rateLimited ? ` (${a.rateLimited} rate-limited)` : ''}`) : '0'),
        h('td.muted.small', null, a.topBottleneck ? `${({ model_load: 'model loading', prefill: 'reading long prompts', queue: 'waiting in queue', network: 'network', provider: 'provider latency', generation: 'slow writing', limit: 'length limit', rate_limit: 'rate limits', error: 'errors' })[a.topBottleneck[0]] || a.topBottleneck[0]} (${a.topBottleneck[1]}×)` : '—'),
        h('td', null, a.provider === 'local' ? h('button.btn.sm.ghost', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner')); const r = await api('/api/models/benchmark', { body: { model: a.key } }); toast(`${a.key}: first word ${fmtMs(r.ttftMs)}, ${fmtTps(r.tps)}`); draw(); }) }, 'Benchmark') : null))))))) : h('div.card', null, h('span.muted', null, 'No requests yet in the last 24 hours.')));
    clear(provBox).append(d.providers.length ? h('div.list', null, d.providers.map((p) => { const a = d.endpoints.find((e) => e.provider === p.provider && e.key.includes(p.provider)); return h('div.li', null, icon('globe'), h('div.t', null, h('b', null, p.name), h('span', null, a ? `${num(a.calls)} requests · first word ${fmtMs(a.ttftMs)} · ${fmtTps(a.tps)} · ${a.errors} errors` : 'No requests yet')), p.rateLimited ? h('span.badge.warn', null, 'Rate limited') : null, statusBadge(p.status)); })) : h('div.card', null, h('span.muted', null, 'No cloud providers.')));
    clear(clusterBox); if ((d.clusters || []).length) clusterBox.append(h('div.section-title', null, 'Clusters'), h('div.list', null, d.clusters.map((c) => h('div.li', null, icon('network'), h('div.t', null, h('b', null, c.name), h('span', null, `${BACKEND_NAME[c.backend] || c.backend} · ${(c.members || []).length} computers · ${(c.model || {}).value || ''}${c.bench ? ` · ${fmtTps(c.bench.tps)}, first word ${fmtMs(c.bench.ttftMs)}` : ''}`), (c.links || []).length ? h('span', null, c.links.filter((l) => l.mbps).map((l) => `${l.a}↔${l.b}: ${linkText(l)}`).join(' · ')) : null), statusBadge(c.status || 'unknown')))));
    clear(recentBox).append(d.recent.length ? h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['When', 'Model', 'Where', 'Time split', 'Total', 'First word', 'Speed', 'Bottleneck'].map((x) => h('th', null, x)))),
      h('tbody', null, d.recent.slice(0, 30).map((r) => h('tr', null, h('td.muted', null, new Date(r.finishedAt).toLocaleTimeString()), h('td', null, r.model, r.stage ? h('span.faint.small', null, ' · ' + r.stage) : null), h('td.muted', null, r.node, ' ', scopeChip(r.scope, true)), h('td', { style: { width: '140px' } }, timeline(r)), h('td', null, fmtMs(r.totalMs)), h('td', null, fmtMs(r.ttftMs)), h('td', null, fmtTps(r.tps)), h('td.small', { style: { whiteSpace: 'normal', maxWidth: '340px', color: r.bottleneck && r.bottleneck.kind !== 'none' ? 'var(--orange)' : 'var(--text-2)' } }, r.bottleneck ? r.bottleneck.text : ''))))))) : h('div.card', null, h('span.muted', null, 'No requests yet.')),
      h('div.legend.small.muted', { style: { marginTop: '8px' } }, [['wait', 'Waiting / network'], ['load', 'Loading model'], ['pre', 'Reading prompt'], ['gen', 'Writing']].map(([k, l]) => h('span', null, h('i.' + k), l))));
    S.pageTimer = setTimeout(draw, 2500);
  }
  draw();
}

// ---------------- Capability guide (Models page)
async function guideSection(pg) {
  const d = await api('/api/models/guide').catch(() => null); if (!d || !d.models.length) return;
  const tag = (src) => src ? h('span.src.' + src, { title: { reported: 'Reported by the server', measured: 'Measured on this hardware', card: 'From the model card', estimate: 'Estimated', guessed: 'Guessed from the name', unknown: 'Unknown' }[src] || src }, { reported: 'server', measured: 'measured', card: 'model card', estimate: 'estimate', guessed: 'name', unknown: '?' }[src] || src) : null;
  const card = (id) => (typeof CATALOG !== 'undefined' ? CATALOG.find((c) => c.id === id || id.startsWith(c.id + '-') || id.replace(/[-_]/g, '').toLowerCase().includes(c.id.replace(/[:.\-]/g, '').toLowerCase())) : null);
  pg.append(h('div.section-title', { style: { marginTop: '30px' } }, 'Capability guide'),
    h('div.help', { style: { margin: '-4px 4px 10px' } }, 'Where each number comes from: ', tag('reported'), ' the server said so · ', tag('measured'), ' timed on your hardware · ', tag('card'), ' ForgeAI’s model notes · ', tag('estimate'), ' worked out · ', tag('unknown'), ' not known.'),
    h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['Model', 'Served by', 'Can do', 'Context', 'Size · quant', 'Memory needed', 'Speed here', ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.models.map((m) => {
        const c = m.caps || {}; const cd = card(m.id); const src = m.source || {};
        const capsList = [['chat', 'Chat'], ['tools', 'Tools'], ['vision', 'Vision'], ['reasoning', 'Reasoning'], ['thinking', 'Thinking'], ['embeddings', 'Embeddings']].filter(([k]) => c[k]).map(([, l]) => h('span.chip', null, l));
        const sp = m.measured ? [fmtTps(m.measured.tps), 'measured'] : m.liveTps ? [fmtTps(m.liveTps), 'measured'] : [null, 'unknown'];
        const mem = m.vramBytes ? [`${(m.vramBytes / 2 ** 30).toFixed(1)} GB (in use)`, 'reported'] : m.sizeBytes ? [`≈ ${(m.sizeBytes * 1.1 / 2 ** 30 + 0.5).toFixed(1)} GB + context`, 'estimate'] : cd ? [`${cd.ram} GB computer`, 'card'] : ['—', 'unknown'];
        return h('tr', null, h('td', null, h('b', null, m.alias || m.id), m.file ? h('div.small.faint.mono', null, m.file) : null, cd ? h('div.small.muted', null, cd.desc) : null),
          h('td.small', null, m.endpoint ? `${m.endpoint.name} · ${m.node}` : m.node, h('div.faint.mono', null, m.endpoint ? m.endpoint.url : ''), scopeChip(m.endpoint && m.endpoint.scope, true)),
          h('td', null, h('div.row', { style: { gap: '4px', flexWrap: 'wrap' } }, capsList.length ? capsList : h('span.muted', null, '—'), tag(src.caps || 'unknown'))),
          h('td.small', null, m.context ? Math.round(m.context / 1000) + 'k max' : '—', tag(src.context || (m.context ? 'reported' : 'unknown')), m.loadedContext ? h('div', null, Math.round(m.loadedContext / 1000) + 'k loaded ', tag('reported')) : null),
          h('td.small', null, [m.params, m.quant, m.format].filter(Boolean).join(' · ') || '—', tag(src.quant || 'unknown'), m.sizeBytes ? h('div', null, bytes(m.sizeBytes), ' ', tag(src.size || 'reported')) : null),
          h('td.small', null, mem[0], ' ', tag(mem[1])),
          h('td.small', null, sp[0] || 'not measured', ' ', tag(sp[1]), m.measured ? h('div.faint', null, `first word ${fmtMs(m.measured.ttftMs)} · ${ago(m.measured.at)}`) : null),
          h('td', null, h('button.btn.sm.ghost', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner')); const r = await api('/api/models/benchmark', { body: { model: m.id } }); toast(`${m.id}: ${fmtTps(r.tps)}, first word ${fmtMs(r.ttftMs)}`); route(); }) }, 'Benchmark')));
      }))))));
}

// ---------------- Hybrid pipelines (Models page)
async function pipelinesSection(pg) {
  const list = await api('/api/pipelines').catch(() => []);
  pg.append(h('div.row.between', { style: { margin: '30px 4px 10px' } }, h('div', null, h('div.section-title', { style: { margin: 0 } }, 'Pipelines (hybrid routing)'), h('div.small.muted', null, 'Run one request through several models — e.g. plan on your own computer, then write the final answer in the cloud.')),
    h('button.btn.sm.primary', { onclick: () => pipelineModal(null, list) }, icon('plus', 'sm'), 'New Pipeline')));
  pg.append(h('div.list', null, list.map((p) => h('div.li.click', { onclick: () => pipelineModal(p, list) }, icon('tasks'), h('div.t', null, h('b', null, p.name), h('span', null, p.stages.filter((s) => s.enabled !== false).map((s) => `${s.name} (${s.pick}${s.fallback ? ' → ' + s.fallback : ''})`).join('  →  '))), icon('right', 'sm')))));
}
async function pipelineModal(p, list) {
  const opts = await (S.org ? orgApi('/model-options') : Promise.resolve({ local: [], cloud: [], profiles: [] })).catch(() => ({ local: [], cloud: [], profiles: [] }));
  const isNew = !p; p = p ? JSON.parse(JSON.stringify(p)) : { id: '', name: 'My pipeline', stages: [{ name: 'Ideate', role: 'ideate', pick: 'local_powerful', fallback: 'local_fast' }, { name: 'Execute', role: 'execute', pick: 'cloud', fallback: 'local_powerful' }] };
  const name = h('input', { type: 'text', value: p.name });
  const stagesBox = h('div');
  const pickerOpts = { ...opts, pipelines: [] };
  const draw = () => {
    clear(stagesBox);
    p.stages.forEach((s, i) => {
      stagesBox.append(h('div.stage', null,
        h('div.row.between', null, h('div.row', null, h('b.stn', null, i + 1), h('input', { type: 'text', value: s.name, style: { width: '160px' }, oninput: (e) => { s.name = e.target.value; } }),
          sel([['ideate', 'Ideate / plan'], ['execute', 'Execute / write'], ['review', 'Review / check'], ['custom', 'Custom']], s.role, { style: { width: '160px' }, onchange: (e) => { s.role = e.target.value; } })),
        h('div.row', null, h('button.btn.sm.icon.ghost', { title: 'Move up', disabled: i === 0, onclick: () => { [p.stages[i - 1], p.stages[i]] = [p.stages[i], p.stages[i - 1]]; draw(); } }, icon('up', 'sm')),
          h('button.btn.sm.icon.ghost', { title: 'Move down', disabled: i === p.stages.length - 1, onclick: () => { [p.stages[i + 1], p.stages[i]] = [p.stages[i], p.stages[i + 1]]; draw(); } }, icon('down', 'sm')),
          h('button.btn.sm.icon.ghost', { title: 'Remove stage', disabled: p.stages.length < 2, onclick: () => { p.stages.splice(i, 1); draw(); } }, icon('trash', 'sm')))),
        h('div.grid.g2', { style: { gap: '10px', marginTop: '8px' } }, field('Model', modelPicker(pickerOpts, s.pick, (v) => { s.pick = v; }, { raw: true, noPipelines: true })), field('If unavailable, use', modelPicker(pickerOpts, s.fallback || 'auto', (v) => { s.fallback = v; }, { raw: true, noPipelines: true }))),
        field('Instruction for this stage (optional)', h('input', { type: 'text', value: s.instruction || '', placeholder: 'Leave empty for the default for its type', oninput: (e) => { s.instruction = e.target.value; } })),
        h('div.row', null, checkRow('Optional — skip if it fails', !!s.optional, (v) => { s.optional = v; }), checkRow('On', s.enabled !== false, (v) => { s.enabled = v; }))));
    });
    stagesBox.append(h('button.btn.sm', { onclick: () => { p.stages.push({ name: 'Review', role: 'review', pick: 'local_fast', fallback: null, optional: true }); draw(); } }, icon('plus', 'sm'), 'Add Stage'));
  };
  draw();
  modal(isNew ? 'New Pipeline' : p.name, h('div', null, field('Name', name), h('div.section-title', null, 'Stages run in order'), stagesBox, h('div', { style: { marginTop: '10px' } }, note('info', 'The last non-review stage writes the answer. Review stages add a check underneath. Each stage’s model, and where it ran, is shown on the answer.'))),
    [!isNew ? { label: 'Delete', danger: true, onClick: async () => { await api('/api/pipelines', { method: 'PUT', body: { pipelines: list.filter((x) => x.id !== p.id) } }); route(); } } : null, { label: 'Cancel', onClick: () => {} },
      { label: 'Save', primary: true, onClick: async () => { p.name = name.value; const out = isNew ? [...list, p] : list.map((x) => (x.id === p.id ? p : x)); await api('/api/pipelines', { method: 'PUT', body: { pipelines: out } }); toast('Pipeline saved'); route(); } }].filter(Boolean), { wide: true });
}

// ================= Clusters: one model split across several computers (K1–K3) =================
const BACKEND_NAME = { llamacpp: 'llama.cpp RPC', exo: 'exo', mlx: 'MLX distributed', vllm: 'vLLM + Ray' };
const linkText = (l) => (l.mbps ? `${l.mbps >= 1000 ? (l.mbps / 1000).toFixed(1) + ' Gbit/s' : Math.round(l.mbps) + ' Mbit/s'}, ${l.rttMs != null ? l.rttMs.toFixed(1) + ' ms' : '—'}` : l.error || 'not measured');
// What a measured link is good for. Thresholds are rules of thumb, shown as such.
function linkGrade(l) {
  if (!l || !l.mbps) return ['', 'Not measured'];
  if (l.mbps >= 8000) return ['ok', 'Fast (Thunderbolt / 10 Gb class)'];
  if (l.mbps >= 1500) return ['ok', 'Good (2.5–5 Gb class)'];
  if (l.mbps >= 500) return ['warn', '1 Gb Ethernet class — usable, will limit speed'];
  return ['bad', 'Slow (Wi-Fi or congested) — avoid for clusters'];
}
const ifaceKind = { thunderbolt: 'Thunderbolt', usb4: 'USB4', ethernet: 'Ethernet', wifi: 'Wi-Fi', vpn: 'VPN', other: 'Network' };
function capsLine(c) {
  if (!c) return '';
  const gpu = (c.gpu || []).map((g) => g.kind === 'nvidia' ? `${g.name} (${bytes(g.vramTotal - g.vramUsed)} free of ${bytes(g.vramTotal)})` : g.name).join(', ') || 'No GPU found — CPU only';
  return [`${({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[c.os] || c.os} ${c.osVersion || ''} · ${c.arch}`, `${c.cpus} CPU cores`, `${bytes(c.memFree)} free of ${bytes(c.memTotal)} memory`, gpu].join(' · ');
}

async function clusterSection(pg) {
  const box = h('div');
  pg.append(h('div.row.between', { style: { margin: '28px 4px 10px' } }, h('div.section-title', { style: { margin: 0 } }, 'Clusters — one big model across several computers'), h('button.btn.sm.tint', { onclick: () => clusterWizard() }, icon('plus', 'sm'), 'New Cluster')), box);
  const draw = async () => {
    const d = await api('/api/kit').catch((e) => ({ error: e.message, clusters: [] }));
    clear(box);
    if (d.error) return box.append(note('warn', d.error));
    if (!d.clusters.length) return box.append(h('div.card', null, h('div.md', { html: md(`Join computers together to run a model that is **too big for any one of them**. ForgeAI installs and runs **llama.cpp** on each computer for you, or connects to **exo**, **MLX** or **vLLM** clusters you already run.

Speed depends mostly on the cable between computers: **Thunderbolt or 10 Gb Ethernet** works well; 1 Gb Ethernet works but is slower; Wi-Fi is not recommended. A cluster is usually *slower per word* than one computer that can hold the whole model — use one when the model doesn't fit.`) })));
    box.append(h('div.list', null, d.clusters.map((c) => {
      const acts = h('div.row.nowrap', { style: { gap: '6px' } });
      const run = (label, fn, cls = '') => h('button.btn.sm' + cls, { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; const t = b.textContent; clear(b).append(h('span.spinner'), ' ' + label + '…'); try { await fn(); } finally { b.disabled = false; b.textContent = t; draw(); } }) }, label);
      if (c.backend === 'llamacpp') {
        if (c.status === 'running') acts.append(run('Benchmark', async () => { const r = await api(`/api/clusters/${c.id}/benchmark`, { body: {} }); toast(`${c.name}: first word ${fmtMs(r.bench.ttftMs)}, ${fmtTps(r.bench.tps)}`); }), run('Stop', () => api(`/api/clusters/${c.id}/stop`, { body: {} })));
        else acts.append(run('Start', async () => { await api(`/api/clusters/${c.id}/start`, { body: {} }); toast(`${c.name} is running — it appears in every model list as “${c.name} (cluster)”`); }, '.primary'));
      } else acts.append(h('button.btn.sm' + (c.status === 'running' ? '' : '.primary'), { onclick: () => connectCluster(c, draw) }, c.status === 'running' ? 'Change Address' : 'Connect'));
      acts.append(h('button.btn.sm.ghost', { onclick: () => clusterLogs(c) }, 'Logs'), h('button.btn.sm.ghost', { title: 'Delete', onclick: guard(async () => { if (!(await confirmBox('Delete cluster?', `“${c.name}” will be stopped and removed. Models and computers are not affected.`, 'Delete', true))) return; if (c.status === 'running' && c.backend === 'llamacpp') await api(`/api/clusters/${c.id}/stop`, { body: {} }).catch(() => {}); await api(`/api/clusters/${c.id}`, { method: 'DELETE' }); draw(); }) }, icon('trash', 'sm')));
      return h('div.li', null, icon('network'), h('div.t', null, h('b', null, c.name),
        h('span', null, [BACKEND_NAME[c.backend], `${c.members.length} computers`, c.model && c.model.value, c.url].filter(Boolean).join(' · ')),
        (c.devices || []).length ? h('span', null, 'Model placed: ' + c.devices.map((d) => `${(c.members.find((m) => m.id === d.member) || {}).name || (d.member === 'local' ? 'This computer' : d.device)}${d.host ? ' (main memory)' : ''} ${d.mib >= 1024 ? (d.mib / 1024).toFixed(1) + ' GB' : Math.round(d.mib) + ' MB'}${d.kvMib ? ` + ${Math.round(d.kvMib)} MB context` : ''}`).join(' · ') + (c.offload ? ` · ${c.offload.layers} of ${c.offload.of} layers on GPUs / workers${c.offload.layers < c.offload.of ? ' (the rest run on the coordinator’s CPU — slower)' : ''}` : '')) : null,
        c.bench ? h('span', null, `Measured: first word ${fmtMs(c.bench.ttftMs)} · ${fmtTps(c.bench.tps)} · ${ago(c.bench.at)}`) : null,
        (c.links || []).filter((l) => l.mbps).length ? h('span', null, 'Links: ' + c.links.filter((l) => l.mbps).map((l) => `${l.a} ↔ ${l.b} ${linkText(l)}`).join(' · ')) : null,
        c.error && c.status === 'error' ? h('span', { style: { color: 'var(--red)' } }, c.error) : null, c.note ? h('span', { style: { color: 'var(--orange, #c77700)' } }, icon('moon', 'sm'), ' ', c.note, ' — lent-when-idle; the cluster comes back when that computer is free') : null, c.error && c.status === 'stopped' ? h('span', { style: { color: 'var(--red)' } }, c.error) : null),
        c.status === 'stopped' ? h('span.badge', null, h('span.dot'), 'Stopped') : statusBadge(c.status === 'error' ? 'error' : c.status === 'running' ? 'online' : c.status === 'starting' ? 'partial' : 'disabled'), acts);
    })));
  };
  await draw();
}
async function clusterLogs(c) {
  const out = await api(`/api/clusters/${c.id}/logs`);
  modal(`${c.name} — logs`, h('div', null, Object.entries(out).map(([who, l]) => h('div', { style: { marginBottom: '12px' } }, h('b', null, who), l && l.error ? note('warn', l.error) : ['rpc', 'server'].map((k) => (l && l[k] && l[k].length ? h('pre.mono.small', { style: { maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--fill)', padding: '8px', borderRadius: '8px' } }, `— ${k === 'rpc' ? 'RPC worker' : 'llama-server'} —\n` + l[k].join('\n')) : null))))), [{ label: 'Close', primary: true }], { wide: true });
}
function connectCluster(c, done) {
  const url = h('input', { type: 'url', value: c.url || { exo: 'http://127.0.0.1:52415', vllm: 'http://127.0.0.1:8000', mlx: 'http://127.0.0.1:8080' }[c.backend] || '' });
  modal(`Connect ${c.name}`, h('div', null, field('Address the cluster serves on', url, { exo: 'exo serves an OpenAI-compatible API on port 52415 of any of its computers.', vllm: 'The vLLM API server (head node), usually port 8000.', mlx: 'mlx_lm.server on the first Mac, usually port 8080.' }[c.backend])),
    [{ label: 'Cancel' }, { label: 'Test & Connect', primary: true, onClick: async () => { await api(`/api/clusters/${c.id}/connect`, { body: { url: url.value } }); toast('Connected'); done && done(); } }]);
}

// The wizard: computers → hardware & links → engine → model → split → save & start.
async function clusterWizard() {
  const nodes = (await api('/api/cluster')).nodes.filter((n) => n.kind === 'worker');
  const st = { step: 0, members: [{ id: 'local', name: 'This computer', on: true }, ...nodes.map((n) => ({ id: n.id, name: n.name, on: false, status: n.status }))], manual: [], coordinator: 'local', plan: null, planning: false, backend: 'llamacpp', model: { type: 'ollama', value: '' }, ctx: 8192, port: 8090, gpu: 'cpu', name: '', split: {}, customSplit: false, kit: {}, useCoordinator: true };
  const box = h('div.wiz'); const foot = h('div.wizfoot'); let closeFn;
  const STEPS = ['Computers', 'Hardware & links', 'Engine', 'Model', 'Split', 'Save'];
  const chosen = () => [...st.members.filter((m) => m.on), ...st.manual];
  const nm = (id) => (chosen().find((m) => m.id === id) || {}).name || id;
  const stepsBar = () => h('div.wizsteps', null, STEPS.map((t, i) => h('span' + (i === st.step ? '.on' : i < st.step ? '.done' : ''), null, i < st.step ? icon('check', 'sm') : h('b', null, i + 1), t)));
  const go = (n) => { st.step = n; draw(); };
  async function plan() {
    st.planning = true; draw();
    try { st.plan = await api('/api/clusters/plan', { body: { coordinator: st.coordinator, measure: true, members: chosen().map((m) => (m.manual ? { id: m.id, manual: true, host: m.host, port: m.port, name: m.name, memGb: m.memGb } : { id: m.id })) } }); }
    catch (e) { st.plan = { error: e.message }; }
    st.planning = false;
    if (st.plan && st.plan.split) for (const x of st.plan.split) if (!st.customSplit) st.split[x.id] = Math.round(x.share * 100);
    if (st.plan && st.plan.nodes) for (const n of st.plan.nodes) { const m = chosen().find((x) => x.id === n.id); if (m && !m.manual && n.caps && !m.address) { const tb = (n.caps.interfaces || []).find((i) => (i.kind === 'thunderbolt' || i.kind === 'usb4') && i.address); if (tb && n.id !== st.coordinator) m.address = tb.ipv4; } }
    draw();
  }
  async function refreshKit() { await Promise.all(chosen().filter((m) => !m.manual).map(async (m) => { try { st.kit[m.id] = await api(`/api/kit/${m.id}/status`, { body: {} }); } catch (e) { st.kit[m.id] = { error: e.message }; } })); }
  const draw = () => {
    clear(box); clear(foot); box.append(stepsBar());
    const back = h('button.btn', { onclick: () => (st.step ? go(st.step - 1) : closeFn()) }, st.step ? 'Back' : 'Cancel');
    if (st.step === 0) {
      box.append(h('p.muted', null, 'Choose the computers to join. Each one needs ForgeAI running with “Work for another ForgeAI” on, and must be added under Computers doing the work.'),
        h('div.list', { style: { boxShadow: 'none' } }, st.members.map((m) => h('label.li', { style: { cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: m.on, onchange: (e) => { m.on = e.target.checked; if (!m.on && st.coordinator === m.id) st.coordinator = 'local'; st.plan = null; draw(); } }),
          icon(m.id === 'local' ? 'laptop' : 'server'), h('div.t', null, h('b', null, m.name), h('span', null, m.id === 'local' ? 'Where you are now' : m.status === 'online' ? 'Online' : 'Not reachable right now')),
          m.on ? h('label.small.row.nowrap', { style: { gap: '6px' } }, h('input', { type: 'radio', name: 'coord', checked: st.coordinator === m.id, onchange: () => { st.coordinator = m.id; st.plan = null; } }), 'Coordinator') : null))),
        st.manual.length ? h('div.list', { style: { boxShadow: 'none', marginTop: '8px' } }, st.manual.map((m, i) => h('div.li', null, icon('server'), h('div.t', null, h('b', null, m.name), h('span', null, `RPC server you run yourself · ${m.host}:${m.port}${m.memGb ? ` · ${m.memGb} GB` : ''}`)), h('button.btn.sm.ghost', { onclick: () => { st.manual.splice(i, 1); draw(); } }, icon('x', 'sm'))))) : null,
        h('details', { style: { marginTop: '10px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Add a computer that only runs a llama.cpp RPC server (e.g. a Linux box or Raspberry Pi without ForgeAI)'),
          (() => { const host = h('input', { type: 'text', placeholder: '192.168.1.40' }), port = h('input', { type: 'number', value: 50052 }), mem = h('input', { type: 'number', placeholder: 'GB free' }), name = h('input', { type: 'text', placeholder: 'Name' });
            return h('div', null, h('div.grid.g2', { style: { gap: '8px', marginTop: '8px' } }, field('Name', name), field('Address', host), field('Port', port), field('Memory it can give (GB)', mem, 'Used for the split. Unknown = 0, set it in Split.')),
              h('div.small.muted', null, 'On that computer run: ', h('span.mono', null, 'ggml-rpc-server -H <its LAN address> -p 50052 -c'), '. Only on a private network or VPN — the llama.cpp RPC server has no password.'),
              h('button.btn.sm', { style: { marginTop: '8px' }, onclick: () => { if (!host.value) return toast('Enter its address', true); st.manual.push({ id: 'manual_' + Date.now(), manual: true, name: name.value || host.value, host: host.value.trim(), port: +port.value || 50052, memGb: +mem.value || 0 }); st.plan = null; draw(); } }, 'Add')); })()),
        nodes.length ? null : h('div', { style: { marginTop: '10px' } }, note('info', 'No other ForgeAI computers added yet. Add them under “Computers doing the work” (Add Computer → Another computer running ForgeAI).')));
      foot.append(back, h('span.grow'), h('button.btn.primary', { disabled: chosen().length < 2, title: chosen().length < 2 ? 'Choose at least two computers' : '', onclick: () => { go(1); plan(); } }, 'Next'));
    } else if (st.step === 1) {
      const p = st.plan;
      if (st.planning || !p) box.append(h('div.card.flat', null, h('span.spinner'), ' Checking each computer and measuring the links between them…'));
      else if (p.error) box.append(note('warn', p.error));
      else {
        box.append(h('div.list', { style: { boxShadow: 'none' } }, p.nodes.map((n) => h('div.li', null, icon(n.manual ? 'server' : n.id === 'local' ? 'laptop' : 'server'), h('div.t', null,
          h('div.row', { style: { gap: '6px', alignItems: 'center' } }, h('b', null, n.name), n.id === st.coordinator ? h('span.badge', { style: { flex: 'none' } }, 'Coordinator') : null, n.caps && n.caps.board ? h('span.badge.warn', { style: { flex: 'none' } }, n.caps.board) : null),
          n.error ? h('span', { style: { color: 'var(--red)' } }, n.error) : n.manual ? h('span', null, n.reachable ? `RPC port open at ${n.host}:${n.port}` : `Nothing answering at ${n.host}:${n.port} — start ggml-rpc-server there`) : h('span', null, capsLine(n.caps)),
          n.caps ? h('span', null, 'Connections: ' + ((n.caps.interfaces || []).map((i) => `${ifaceKind[i.kind] || i.kind} ${i.name}${i.address ? ' ' + i.address : ''}${i.mbps ? ` (${i.mbps >= 1000 ? i.mbps / 1000 + ' Gb' : i.mbps + ' Mb'} reported)` : ''}`).join(' · ') || 'none found')) : null),
          n.manual ? (n.reachable ? h('span.badge.ok', null, 'Reachable') : h('span.badge.bad', null, 'Not reachable')) : n.error ? h('span.badge.bad', null, 'Error') : h('span.badge.ok', null, 'Ready')))));
        box.append(h('div.section-title', null, 'Links (measured now)'));
        if (!p.links.length) box.append(h('div.small.muted', null, 'Links are measured between ForgeAI computers. Manual RPC servers are checked for an open port only.'));
        else box.append(h('div.list', { style: { boxShadow: 'none' } }, p.links.map((l) => { const [k, t] = linkGrade(l); return h('div.li', null, icon('gauge'), h('div.t', null, h('b', null, `${l.a} ↔ ${l.b}`), h('span', null, l.error ? l.error : `${linkText(l)} round trip · measured with ${Math.round((l.bytes || 0) / 2 ** 20)} MB over HTTP(S), so real throughput can be a little higher`)), h('span.badge.' + (k || 'x'), null, t)); })));
        for (const w of p.warnings) box.append(h('div', { style: { marginTop: '8px' } }, note('warn', w)));
        box.append(h('details', { style: { marginTop: '10px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Which cable should I use?'), h('div.md.small', { html: md(`- **Thunderbolt 4/5 or USB4 cable between two Macs/PCs** — creates a network link (Thunderbolt Bridge on Mac). Fastest simple option. ForgeAI picks the Thunderbolt address automatically when it finds one.
- **RDMA over Thunderbolt 5** (Macs with Thunderbolt 5 on macOS 26.2+) — lowest latency. Turn it on once from macOS Recovery with \`rdma_ctl enable\`; llama.cpp and exo then use it automatically when you connect over the Thunderbolt address.
- **10 Gb Ethernet** — good for mixed Mac/Windows/Linux setups.
- **1 Gb Ethernet** — works, but splitting a big model will be noticeably slower.
- **Wi-Fi** — not recommended. Speeds above are *measured*; the "reported" speeds are what the operating system says the port can do.`) })));
      }
      foot.append(back, h('button.btn.ghost', { onclick: plan, disabled: st.planning }, 'Measure Again'), h('span.grow'), h('button.btn.primary', { disabled: !p || p.error || st.planning || p.nodes.some((n) => n.error || (n.manual && !n.reachable)), onclick: () => go(2) }, 'Next'));
    } else if (st.step === 2) {
      const B = st.plan.backends;
      box.append(h('p.muted', null, 'Choose the engine that splits the model. ForgeAI runs llama.cpp for you; the others you start with their own tools and ForgeAI connects to them.'),
        h('div.list', { style: { boxShadow: 'none' } }, Object.entries(B).map(([k, b]) => h('label.li' + (b.ok ? '' : '.dim'), { style: { cursor: b.ok ? 'pointer' : 'default', opacity: b.ok ? 1 : 0.6 } }, h('input', { type: 'radio', name: 'be', disabled: !b.ok, checked: st.backend === k, onchange: () => { st.backend = k; draw(); } }),
          h('div.t', null, h('b', null, b.name, k === 'llamacpp' ? h('span.badge.ok', { style: { marginLeft: '6px' } }, 'Managed by ForgeAI') : null, k === 'exo' && b.rdma ? h('span.badge', { style: { marginLeft: '6px' } }, 'RDMA possible') : null), h('span', null, b.note), !b.ok ? h('span', { style: { color: 'var(--orange)' } }, 'Not supported on every chosen computer') : null)))),
        st.backend !== 'llamacpp' ? h('div', { style: { marginTop: '10px' } }, note('info', h('span', { html: md({ exo: 'Install exo on each computer (`pip install exo` / see exo docs), start it with `exo`; computers find each other automatically. Then save here and press **Connect** with the address (port 52415).', mlx: 'On each Mac install `mlx-lm`, set up SSH between the Macs, then start `mlx.launch --hosts … -- mlx_lm.server`. Save here and press **Connect** with the server address.', vllm: 'Start a Ray cluster (`ray start --head` / `ray start --address=…`) and run `vllm serve <model> --tensor-parallel-size N --pipeline-parallel-size M`. Save here and press **Connect** with the API address.' }[st.backend]) }))) : null);
      foot.append(back, h('span.grow'), h('button.btn.primary', { onclick: async () => { if (st.backend === 'llamacpp') { go(3); await refreshKit(); draw(); } else go(5); } }, 'Next'));
    } else if (st.step === 3) {
      const ollamaModels = []; // filled from the catalog below
      const typeSel = sel([['ollama', 'A model already in Ollama on the coordinator'], ['path', 'A GGUF file on the coordinator'], ['hf', 'Download from Hugging Face']], st.model.type, { onchange: (e) => { st.model.type = e.target.value; st.model.value = ''; draw(); } });
      let nextBtn; const allInstalled = () => chosen().filter((m) => !m.manual).every((m) => st.kit[m.id] && st.kit[m.id].installed);
      const val = h('input', { type: 'text', value: st.model.value, placeholder: { ollama: 'e.g. llama3.3:70b', path: '/path/to/model.gguf', hf: 'e.g. unsloth/Qwen3-32B-GGUF:Q4_K_M' }[st.model.type], oninput: (e) => { st.model.value = e.target.value.trim(); if (nextBtn) { nextBtn.disabled = !allInstalled() || !st.model.value; nextBtn.title = !allInstalled() ? 'Install llama.cpp on every computer first' : !st.model.value ? 'Choose a model' : ''; } } });
      const kitRows = chosen().filter((m) => !m.manual).map((m) => {
        const k = st.kit[m.id]; const inst = k && k.installed; const prog = k && k.install;
        const folder = h('input', { type: 'text', placeholder: 'Folder or .zip/.tar.gz on that computer', style: { minWidth: '220px' } });
        return h('div.li', null, icon(m.id === 'local' ? 'laptop' : 'server'), h('div.t', null, h('b', null, m.name),
          k && k.error ? h('span', { style: { color: 'var(--red)' } }, k.error) : inst ? h('span', null, `llama.cpp ${inst.tag === 'custom' ? '(your own build)' : inst.tag} installed${inst.verified ? ' (checksum verified)' : ''}${inst.coordinator === false ? ' · worker only' : ''}`) : prog && prog.state === 'running' ? h('span', null, prog.status + (prog.total ? ` — ${Math.round(prog.completed / prog.total * 100)}%` : '')) : prog && prog.state === 'error' ? h('span', { style: { color: 'var(--red)' } }, prog.status) : h('span', null, 'Not installed'),
          !inst ? h('details', null, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'No internet on that computer?'), h('div.row', { style: { gap: '6px', marginTop: '6px' } }, folder, h('button.btn.sm', { onclick: guard(async () => { const v = folder.value.trim(); if (!v) return; await api(`/api/kit/${m.id}/install`, { body: /\.(zip|tar\.gz|tgz)$/i.test(v) ? { archive: v } : { folder: v } }); await refreshKit(); draw(); }) }, 'Use'))) : null),
          inst ? h('span.badge.ok', null, 'Ready') : h('button.btn.sm.tint', { disabled: prog && prog.state === 'running', onclick: guard(async () => { await api(`/api/kit/${m.id}/install`, { body: { gpu: st.gpu } }); poll(); }) }, 'Install llama.cpp'));
      });
      box.append(field('Model', h('div', null, typeSel, h('div', { style: { height: '6px' } }), val), st.model.type === 'ollama' ? 'ForgeAI uses Ollama’s downloaded file directly — nothing is copied twice.' : st.model.type === 'hf' ? 'llama-server downloads it on the coordinator the first time (needs internet).' : 'Full path on the coordinator computer.'),
        h('div.grid.g2', { style: { gap: '12px' } }, field('Context length (tokens)', h('input', { type: 'number', value: st.ctx, oninput: (e) => { st.ctx = +e.target.value; } }), 'Bigger uses more memory on every computer.'),
          field('Build to install', sel([['cpu', 'Standard (Mac: Metal GPU · PC: CPU)'], ['cuda', 'NVIDIA (CUDA)'], ['vulkan', 'AMD / Intel GPU (Vulkan)']], st.gpu, { onchange: (e) => { st.gpu = e.target.value; } }), 'Macs always use the GPU. Pick CUDA or Vulkan for PCs with those GPUs.')),
        h('div.section-title', null, 'llama.cpp on each computer'), h('div.list', { style: { boxShadow: 'none' } }, kitRows),
        h('div.small.muted', { style: { marginTop: '6px' } }, 'Downloaded once from the official llama.cpp releases on GitHub (checksum checked).'));
      const allInst = allInstalled();
      nextBtn = h('button.btn.primary', { disabled: !allInst || !st.model.value, title: !allInst ? 'Install llama.cpp on every computer first' : !st.model.value ? 'Choose a model' : '', onclick: () => go(4) }, 'Next');
      foot.append(back, h('button.btn.ghost', { onclick: async () => { await refreshKit(); draw(); } }, 'Refresh'), h('span.grow'), nextBtn);
    } else if (st.step === 4) {
      const p = st.plan; const coordCaps = (p.nodes.find((n) => n.id === st.coordinator) || {}).caps || {};
      const coordGpu = (coordCaps.gpu || []).length;
      const rows = p.split.map((x) => { const inp = h('input', { type: 'number', min: 0, max: 100, value: st.split[x.id] ?? 0, style: { width: '80px' }, oninput: (e) => { st.split[x.id] = +e.target.value; st.customSplit = true; drawBars(); } });
        return h('div.li', null, h('div.t', null, h('b', null, x.name), h('span', null, `${bytes(x.memBytes)} available for the model`)), inp, h('span', null, '%')); });
      const bars = h('div.splitbar', { style: { display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', margin: '10px 0' } });
      const colors = ['var(--accent)', 'var(--green)', 'var(--orange)', 'var(--purple, #a259ff)', 'var(--teal, #2ab0b0)'];
      const drawBars = () => { clear(bars); const tot = p.split.reduce((a, x) => a + (+st.split[x.id] || 0), 0) || 1; p.split.forEach((x, i) => bars.append(h('div', { title: `${x.name} ${st.split[x.id] || 0}%`, style: { width: ((+st.split[x.id] || 0) / tot * 100) + '%', background: colors[i % colors.length] } }))); };
      drawBars();
      const visBox = h('div'); if (st.model.value) api('/api/clusters/plan', { body: { coordinator: st.coordinator, measure: false, members: chosen().map((m) => (m.manual ? { id: m.id, manual: true, host: m.host, port: m.port, name: m.name, memGb: m.memGb } : { id: m.id })), model: st.model } }).then((pl) => { if (pl.visual) clear(visBox).append(planVisual({ ...pl, visual: { ...pl.visual, worstLink: planVisualLink(st.plan.links) } })); }).catch(() => {});
      box.append(visBox, h('p.muted', null, 'Layers are shared in proportion to memory available on each computer. Change the numbers if one computer should do more (for example, a faster GPU).'), bars, h('div.list', { style: { boxShadow: 'none' } }, rows),
        h('div.row', { style: { gap: '8px', marginTop: '8px' } }, h('button.btn.sm.ghost', { onclick: () => { st.customSplit = false; for (const x of p.split) st.split[x.id] = Math.round(x.share * 100); draw(); } }, 'Reset to automatic')),
        !coordGpu ? h('label.row.small', { style: { gap: '8px', marginTop: '10px' } }, h('input', { type: 'checkbox', checked: st.useCoordinator, onchange: (e) => { st.useCoordinator = e.target.checked; } }), 'Also use the coordinator’s memory (it has no GPU, so ForgeAI runs a private RPC worker on it, bound to 127.0.0.1)') : null,
        coordGpu > 1 && st.customSplit ? note('warn', 'The coordinator has several GPUs — llama.cpp will use its automatic split instead of these numbers.') : null);
      foot.append(back, h('span.grow'), h('button.btn.primary', { onclick: () => go(5) }, 'Next'));
    } else {
      const name = h('input', { type: 'text', value: st.name || (st.backend === 'llamacpp' ? (st.model.value.split(/[/:]/).filter(Boolean).slice(-2).join(' ') || 'Cluster') : BACKEND_NAME[st.backend] + ' cluster'), oninput: (e) => { st.name = e.target.value; } });
      st.name = name.value;
      const port = h('input', { type: 'number', value: st.port, oninput: (e) => { st.port = +e.target.value; } });
      const workerAddr = chosen().filter((m) => !m.manual && m.id !== st.coordinator && m.id !== 'local' || (!m.manual && m.id === 'local' && st.coordinator !== 'local')).map((m) => { const n = st.plan.nodes.find((x) => x.id === m.id) || {}; const opts = [['', 'Its usual address'], ...((n.caps && n.caps.interfaces) || []).filter((i) => i.address).map((i) => [i.address, `${ifaceKind[i.kind] || i.kind} ${i.address}`])]; return field(`${m.name} — RPC worker listens on`, sel(opts, m.address || '', { onchange: (e) => { m.address = e.target.value || null; } }), 'Pick the Thunderbolt or 10 Gb address for the fastest link. Never all addresses.'); });
      box.append(h('div.grid.g2', { style: { gap: '12px' } }, field('Cluster name', name), st.backend === 'llamacpp' ? field('Port on the coordinator', port, 'Only this computer can reach it unless the coordinator is another computer.') : null),
        st.backend === 'llamacpp' ? h('div', null, ...workerAddr) : null,
        st.backend === 'llamacpp' && workerAddr.length ? h('div', { style: { margin: '6px 0 10px' } }, h('button.btn.sm', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Measuring every link…'; try { const r = await api('/api/clusters/links', { body: { members: chosen().filter((m) => !m.manual && m.id !== 'local').map((m) => m.id) } }); const lines = []; for (const m of chosen()) { const x = r[m.id]; if (!x) continue; if (x.error) { lines.push(`${m.name}: ${x.error}`); continue; } if (x.best && x.candidates.length > 1) m.address = x.best; lines.push(`${m.name}: ` + x.candidates.map((c) => `${ifaceKind[c.kind] || c.kind} ${c.address} — ${!c.reachable ? 'not reachable from here' : c.mbps ? `${c.mbps >= 1000 ? (c.mbps / 1000).toFixed(1) + ' Gbit/s' : Math.round(c.mbps) + ' Mbit/s'}, ${c.rttMs != null ? c.rttMs.toFixed(1) + ' ms' : ''}${c.address === x.best ? ' ← chosen' : ''}` : c.error || 'linked'}`).join(' · ')); } toast('Fastest link chosen for each computer'); draw(); modal('Links measured', h('div.small', null, lines.map((l) => h('div', { style: { margin: '4px 0' } }, l))), [{ label: 'OK', primary: true, onClick: () => {} }]); } finally { b.disabled = false; } }) }, icon('gauge', 'sm'), 'Measure every link and choose the fastest'), h('span.small.muted', { style: { marginLeft: '8px' } }, 'Tries each computer’s Thunderbolt/USB-C bridge, Ethernet, Wi-Fi and VPN addresses from this computer.')) : null,
        h('div.card.flat.small', { style: { marginTop: '10px' } }, h('b', null, 'Summary: '), `${BACKEND_NAME[st.backend]} on ${chosen().map((m) => m.name).join(', ')}; coordinator ${nm(st.coordinator)}${st.backend === 'llamacpp' ? `; model ${st.model.value}; context ${st.ctx}` : ''}.`),
        st.backend === 'llamacpp' ? h('div', { style: { marginTop: '8px' } }, note('info', 'After saving, ForgeAI starts the RPC workers, loads the model across them (this can take minutes for big models) and adds it to every model list as “', st.name, ' (cluster)”. Then press Benchmark to measure real speed.')) : null);
      foot.append(back, h('span.grow'), h('button.btn', { onclick: guard(() => save(false)) }, 'Save'), st.backend === 'llamacpp' ? h('button.btn.primary', { onclick: guard(() => save(true)) }, 'Save & Start') : null);
    }
  };
  let pollT;
  function poll() { clearTimeout(pollT); pollT = setTimeout(async () => { if (!box.isConnected) return; await refreshKit(); draw(); if (Object.values(st.kit).some((k) => k.install && k.install.state === 'running')) poll(); }, 1500); }
  async function save(start) {
    const members = chosen().map((m) => ({ id: m.id, manual: !!m.manual, host: m.host, port: m.manual ? m.port : 50052, address: m.address || null, name: m.name }));
    const body = { name: st.name, backend: st.backend, coordinator: st.coordinator, members, model: st.model, ctx: st.ctx, port: st.port, gpu: st.gpu, links: (st.plan && st.plan.links) || [], split: st.customSplit ? st.split : null, useCoordinator: st.useCoordinator };
    const c = await api('/api/clusters', { body });
    if (start) {
      clear(foot).append(h('span.spinner'), h('span.muted', null, ' Starting workers and loading the model…'));
      try { await api(`/api/clusters/${c.id}/start`, { body: {} }); toast(`${c.name} is running`); }
      catch (e) { toast(e.message, true); }
    } else toast(st.backend === 'llamacpp' ? 'Saved — press Start when ready' : 'Saved — press Connect when the cluster is running');
    closeFn(); route();
  }
  draw();
  closeFn = modal('New Cluster', h('div', null, box, foot), [], { wide: true });
}
