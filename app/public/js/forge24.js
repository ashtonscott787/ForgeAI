'use strict';
/* ForgeAI 2.4 — reliability: model health dashboard, Test Model, capability overrides, memory manager & queue settings,
   automatic fallback banners, "why wasn't another model selected", full request trace, plain-English errors with
   technical details, Debate / Expert Team modes. Loaded after forge23.js. */

Object.assign(ICONS, {
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3z"/><path d="M12 14v6"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
});
const STATE_BADGE = { Healthy: 'ok', Slow: 'warn', Loading: 'warn', Crashed: 'bad', Disabled: '', Incompatible: 'bad', 'Out of memory': 'bad', Unknown: '' };
const KIND_ICON = { MODEL_FAILED: 'warn', BACKEND_FAILED: 'server', MACHINE_UNREACHABLE: 'network', NETWORK_FAILED: 'network', API_KEY_INVALID: 'key', RATE_LIMITED: 'clock', OUT_OF_MEMORY: 'cpu', TIMEOUT: 'clock', REQUEST_REJECTED: 'x', USER_CANCELLED: 'stop', UNKNOWN: 'warn' };

// ---------------- Chat: fallback banner, why-not, trace, error cards
function fallbackBanner(f) {
  return h('div.fbanner', null, icon('swap', 'sm'), h('div', null, h('b', null, `${f.from} ${f.kind === 'OUT_OF_MEMORY' ? 'did not fit in memory' : f.kind === 'TIMEOUT' ? 'did not answer in time' : 'failed'}.`), ` Automatically continuing with ${f.to}. Your conversation has been preserved.`,
    f.cooldown ? h('div.small.muted', null, `${f.cooldown.scope === 'model' ? 'That model' : 'That app'} is set aside for automatic routing for ${f.cooldown.minutes} minutes after ${f.cooldown.n} failures.`) : null));
}
function whyNotBox(list) {
  if (!list || !list.length) return null;
  return h('details.whynot', null, h('summary', null, 'Why wasn’t another model selected?'), h('ul', null, list.map((w) => h('li', null, w))));
}
function traceBox(trace) {
  if (!trace || !trace.length) return null;
  return h('details.tracebox', null, h('summary', null, icon('tasks', 'sm'), ' Full trace'), h('ol', null, trace.map((t) => h('li', null, typeof t === 'string' ? t : t.text))));
}
function errorCard(m) {
  const e = m.meta.errorInfo; if (!e) return null;
  return h('div.errcard', null, h('div.row', { style: { gap: '8px', alignItems: 'flex-start' } }, icon(KIND_ICON[e.kind] || 'warn'), h('div.grow', null, h('b', null, e.title || 'Something went wrong'), h('div', null, e.text),
    e.causes && e.causes.length ? h('div.small', { style: { marginTop: '6px' } }, 'Likely causes:', h('ul', { style: { margin: '2px 0 0 16px' } }, e.causes.map((c) => h('li', null, c)))) : null,
    e.next ? h('div.small', { style: { marginTop: '6px' } }, h('b', null, 'Next: '), e.next) : null,
    e.raw ? h('details', { style: { marginTop: '6px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'View technical details'), h('pre.mono.small', { style: { whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto', background: 'var(--fill)', padding: '8px', borderRadius: '8px' } }, `${e.kind}${e.status ? ' · HTTP ' + e.status : ''}${e.code ? ' · ' + e.code : ''}${e.where ? ' · ' + e.where : ''}\n${e.raw}`)) : null)));
}
// Hook into renderMsg: wrap the original to add our blocks.
const renderMsg23 = window.renderMsg;
window.renderMsg = function (m, live) {
  const el = renderMsg23(m, live); if (live || !m.meta) return el;
  const body = el.querySelector('.body'); const md = el.querySelector('.md'); if (!body || !md) return el;
  if (m.meta.errorInfo) { md.replaceWith(errorCard(m)); }
  if (m.meta.fallbacks && m.meta.fallbacks.length) { const fb = h('div'); for (const f of m.meta.fallbacks) fb.append(fallbackBanner(f)); (body.querySelector('.errcard') || body.querySelector('.md')).before(fb); }
  const extras = [whyNotBox(m.meta.whyNot), traceBox(m.meta.trace)].filter(Boolean);
  if (extras.length) { const meta = body.querySelector('.meta'); const box = h('div.msgextras', null, ...extras); if (meta) meta.before(box); else body.append(box); }
  return el;
};

// ---------------- Health page
async function pageHealth(root) {
  const d = await api('/api/health');
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Model health', 'Which models and apps are working, how reliable and fast they have been, and what ForgeAI is avoiding right now. Capabilities can be corrected here.',
    h('button.btn', { onclick: () => route() }, icon('refresh', 'sm'), 'Refresh'),
    isOwner() ? h('button.btn.primary', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner'), ' Testing every local model…'); const r = await api('/api/models/test-all', { body: {} }); modal('Test results', h('div.list', { style: { boxShadow: 'none' } }, r.map((x) => h('div.li', null, icon(x.ok ? 'check' : 'warn', 'sm'), h('div.t', null, h('b', null, x.model), h('span', null, x.ok ? `OK${x.loadMs ? ' · loaded in ' + fmtMs(x.loadMs) : ''} · first word ${fmtMs(x.ttftMs)}` : (x.kind ? x.kind.replace(/_/g, ' ').toLowerCase() + ': ' : '') + x.error))))), [{ label: 'Close', primary: true, onClick: () => route() }], { wide: true }); }) }, icon('play', 'sm'), 'Test All Local Models') : null));
  // Summary line
  const counts = {}; for (const m of d.models) counts[m.health] = (counts[m.health] || 0) + 1;
  pg.append(h('div.row', { style: { gap: '8px', flexWrap: 'wrap', marginBottom: '16px' } }, Object.entries(counts).map(([k, n]) => h('span.badge' + (STATE_BADGE[k] ? '.' + STATE_BADGE[k] : ''), null, `${n} ${k}`))));
  // Models
  pg.append(h('div.section-title', null, 'Models'));
  const srcTag = (s) => (s === 'reported' || s === 'provider' ? null : h('span.faint', { title: s === 'guessed' ? 'Guessed — the app did not report this. Correct it with the toggle.' : s === 'name' ? 'From the model name' : 'Unknown' }, s === 'guessed' ? '?' : s === 'name' ? '~' : '?'));
  const capToggle = (m, k, label) => { const o = m.overridden.includes(k); return h('label.capt' + (m.caps[k] ? '.on' : '') + (o ? '.ov' : ''), { title: `${label}${o ? ' (set manually)' : ' (' + (m.source[k] || 'unknown') + ')'} — click to change` }, h('input', { type: 'checkbox', checked: !!m.caps[k], disabled: !isOwner(), onchange: guard(async (e) => { await api('/api/health/caps/' + encodeURIComponent(m.id), { method: 'PUT', body: { [k]: e.target.checked } }); toast(`${m.name}: ${label} ${e.target.checked ? 'on' : 'off'}`); }) }), label, srcTag(m.source[k])); };
  pg.append(h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null, h('thead', null, h('tr', null, ['Model', 'Where', 'State', 'Requests', 'Speed', 'Loads in', 'Can do', 'Last error', ''].map((x) => h('th', null, x)))),
    h('tbody', null, d.models.map((m) => { const st = m.stats || {}; const total = (st.ok || 0) + (st.fail || 0);
      return h('tr', null,
        h('td', null, h('b', null, m.name), m.kind === 'cloud' ? h('div.small.faint', null, 'cloud · paid') : h('div.small.faint', null, [m.params, m.quant, m.memBytes ? gbs(m.memBytes) : null].filter(Boolean).join(' · ')), m.note ? h('div.small.muted', null, m.note) : null),
        h('td.small', null, m.backend, h('div.faint', null, m.machine)),
        h('td', null, h('span.badge' + (STATE_BADGE[m.health] ? '.' + STATE_BADGE[m.health] : ''), { title: m.avoid ? m.avoid.text : '' }, m.health), m.avoid ? h('div.small.muted', null, `${m.avoid.minutesLeft} min left`) : null, m.loaded ? h('div.small.faint', null, 'loaded') : null),
        h('td.small', null, total ? `${st.ok} ok · ${st.fail} failed` : '—', total ? h('div.faint', null, `${Math.round((st.crashRate || 0) * 100)}% crashes`) : null),
        h('td.small', null, m.tps ? fmtTps(m.tps) : '—', m.ttftMs ? h('div.faint', null, 'first word ' + fmtMs(m.ttftMs)) : null),
        h('td.small', null, m.loadMs ? fmtMs(m.loadMs) : '—'),
        h('td', null, h('div.row', { style: { gap: '4px', flexWrap: 'wrap' } }, capToggle(m, 'vision', 'images'), capToggle(m, 'tools', 'tools'), capToggle(m, 'coding', 'code'), capToggle(m, 'reasoning', 'thinks'))),
        h('td.small', { style: { maxWidth: '260px', whiteSpace: 'normal' } }, st.lastError ? h('span', { style: { color: 'var(--red)' } }, st.lastError.text) : h('span.faint', null, st.lastOk ? 'none since ' + ago(new Date(st.lastOk).toISOString()) : '—')),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          h('button.btn.sm', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner')); const r = await api('/api/models/test', { body: { model: m.id } }); testModal(m, r); route(); }) }, 'Test'),
          isOwner() && m.avoid ? h('button.btn.sm.ghost', { title: 'Allow automatic routing again now', onclick: guard(async () => { await api('/api/health/clear', { body: { scope: 'model', id: m.id } }); route(); }) }, 'Allow again') : null,
          isOwner() ? h('button.btn.sm.icon.ghost', { title: m.excluded ? 'Excluded from automatic routing — click to include' : 'Exclude from automatic routing', onclick: guard(async () => { await api('/api/health/disable', { body: { id: m.id, on: !m.excluded } }); route(); }) }, icon(m.excluded ? 'play' : 'pause', 'sm')) : null));
    }))))));
  pg.append(h('div.small.muted', { style: { margin: '6px 4px 0' } }, 'Capabilities marked ? were guessed; ~ came from the model name. Click a capability to correct it — your setting wins over detection. Speed and reliability come from real requests on this computer.'));
  // Backends
  pg.append(h('div.section-title', null, 'Apps and providers'));
  pg.append(h('div.list', null, d.backends.map((b) => h('div.li', null, icon(b.node === 'cloud' ? 'globe' : b.kind === 'ok' ? 'check' : 'warn'), h('div.t', null, h('b', null, b.name, h('span.small.muted', null, ' · ' + b.node)), h('span', null, b.ok ? `Reachable · ${b.models || 0} models${b.latencyMs != null ? ' · ' + fmtMs(b.latencyMs) : ''}` : (d.kinds[b.kind] || b.kind) + (b.error ? ' — ' + b.error : '')), b.stats && (b.stats.ok || b.stats.fail) ? h('span.faint', null, `${b.stats.ok} ok · ${b.stats.fail} failed${b.stats.cooldownUntil ? ' · set aside ' + Math.ceil((b.stats.cooldownUntil - Date.now()) / 60000) + ' min' : ''}`) : null),
    h('span.badge' + (b.ok ? '.ok' : b.kind === 'app-closed' ? '' : '.bad'), null, b.ok ? 'OK' : b.kind === 'app-closed' ? 'App closed' : (d.kinds[b.kind] || 'Failed').replace(/^The /, '')),
    b.url && b.node !== 'cloud' && b.url !== 'built in' ? h('span.small.mono.faint', null, b.url.replace(/^https?:\/\//, '')) : null))));
  // Memory + queue
  const ms = d.memory.settings;
  const keep = sel([['auto', `Automatic (${d.memory.keepLimit} on this computer)`], ['1', '1 model'], ['2', '2 models'], ['3', '3 models'], ['4', '4 models'], ['max', 'As many as possible']], String(ms.keep));
  const idle = sel([['0', 'Never'], ['5', '5 min'], ['15', '15 min'], ['30', '30 min'], ['60', '1 hour']], String(ms.idleMinutes));
  const autoUnload = toggle(ms.autoUnload !== false, () => {});
  pg.append(h('div.section-title', null, 'Memory'), h('div.card', null,
    h('div.grid.g3', { style: { gap: '12px' } }, field('Keep loaded', keep, 'More models in memory means instant answers but less room for each.'), field('Unload after idle', idle), field('Make room automatically', h('div', null, autoUnload), 'Unload idle models when a bigger one needs the space. Models in use or pinned are never unloaded.')),
    isOwner() ? h('button.btn.sm.primary', { onclick: guard(async () => { await api('/api/memory', { method: 'PUT', body: { keep: keep.value === 'auto' || keep.value === 'max' ? keep.value : +keep.value, idleMinutes: +idle.value, autoUnload: autoUnload.querySelector('input') ? autoUnload.querySelector('input').checked : true } }); toast('Saved'); route(); }) }, 'Save') : null,
    h('div.section-title', null, 'Loaded now'),
    d.memory.loaded.length ? h('div.list', { style: { boxShadow: 'none' } }, d.memory.loaded.map((m) => h('div.li', null, icon(APP_ICON[m.runtime] || 'cube'), h('div.t', null, h('b', null, m.id), h('span', null, `${RUNTIME_NAME[m.runtime] || m.runtime} · ${gbs(m.memBytes)}${m.inUse ? ` · in use by ${m.inUse} request${m.inUse > 1 ? 's' : ''}` : m.lastUsed ? ' · last used ' + ago(new Date(m.lastUsed).toISOString()) : ''}`)),
      isOwner() ? h('button.btn.sm' + (m.pinned ? '.tint' : '.ghost'), { title: m.pinned ? 'Pinned — never unloaded automatically' : 'Pin: keep loaded', onclick: guard(async () => { await api('/api/memory/pin', { body: { id: m.id, on: !m.pinned } }); route(); }) }, icon('pin', 'sm'), m.pinned ? 'Pinned' : 'Pin') : null))) : h('div.small.muted', null, 'Nothing loaded on this computer.'),
    d.memory.log.length ? h('details', { style: { marginTop: '10px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'What the memory manager did'), h('ul.small', null, d.memory.log.map((l) => h('li', null, `${new Date(l.at).toLocaleTimeString()} — ${l.text}`)))) : null));
  const q = d.queue; const qs = Object.entries(q);
  pg.append(h('div.section-title', null, 'Request queue'), h('div.card', null, h('p.small.muted', { style: { marginTop: 0 } }, 'Each app answers a limited number of requests at once; the rest wait in order (chats before agents before benchmarks). Waiting time is shown on the Performance page.'),
    qs.length ? h('div.list', { style: { boxShadow: 'none' } }, qs.map(([k, v]) => h('div.li', null, h('div.t', null, h('b', null, k.replace('forgeai-engine://local', 'ForgeAI Engine').replace(/^cloud:/, 'cloud ')), h('span', null, `${v.running} running · ${v.waiting} waiting · limit ${v.limit}`))))) : h('div.small.muted', null, 'No requests have queued yet.'),
    isOwner() ? h('div.row', { style: { gap: '8px', marginTop: '10px', flexWrap: 'wrap' } }, ...[['localDefault', 'Local apps', 2], ['engineDefault', 'ForgeAI Engine', 4], ['cloudDefault', 'Cloud', 8]].map(([k, l, dflt]) => { const inp = h('input', { type: 'number', min: 1, max: 32, value: dflt, style: { width: '70px' } }); return h('label.small.row.nowrap', { style: { gap: '6px' } }, l + ' at once', inp, h('button.btn.sm.ghost', { onclick: guard(async () => { await api('/api/queue', { method: 'PUT', body: { [k]: +inp.value } }); toast('Saved'); }) }, 'Set')); })) : null));
}
function testModal(m, r) {
  modal(`Test: ${m.name}`, h('div', null, h('div.list', { style: { boxShadow: 'none' } }, r.steps.map((s) => h('div.li', null, h('span.tick' + (s.ok === true ? '.on' : s.ok === false ? '.bad' : ''), null, s.ok === true ? icon('check', 'sm') : s.ok === false ? icon('x', 'sm') : h('span', null, '?')), h('div.t', null, h('b', null, s.name), h('span', null, s.detail))))),
    r.error ? h('div', { style: { marginTop: '10px' } }, note('warn', h('span', null, h('b', null, r.error.title || r.error.kind), ' ', r.error.text, r.error.next ? ' Next: ' + r.error.next : ''))) : null,
    h('div.small.muted', { style: { marginTop: '10px' } }, `Took ${fmtMs(r.totalMs)}. “?” means the model answered but not as instructed (for example it did not call the tool) — it may still work for normal chat.`)), [{ label: 'Close', primary: true }]);
}

// ---------------- Ask several models: Compare / Debate / Expert Team
function compareDialog(options, current, done) {
  let mode = (current && current.mode) || 'compare'; const picks = [...((current && current.models) || [])]; while (picks.length < 2) picks.push(picks.length ? 'm:local:' + ((options.local[0] || {}).id || '') : CH.pick);
  const box = h('div');
  const draw = () => { clear(box).append(
    h('div', { style: { marginBottom: '10px' } }, segControl([['compare', 'Compare'], ['debate', 'Debate'], ['expert', 'Expert team']], mode, (v) => { mode = v; draw(); })),
    h('p.muted', { style: { marginTop: 0 } }, mode === 'compare' ? 'Each model answers the same message at the same time. You see the answers side by side and keep the one you like.' : mode === 'debate' ? 'Model 1 proposes an answer, Model 2 critiques it, Model 3 (or 1 again) checks it independently, then a final pass writes the answer using all three.' : 'ForgeAI picks specialists for the job — a planner (best reasoning), a worker (best coding for software, best quality otherwise), a reviewer, and a vision model if there are images — and runs them in turn.'),
    ...(mode === 'expert' ? [] : picks.map((v, i) => field(mode === 'debate' ? ['Proposes', 'Critiques', 'Checks'][i] || `Model ${i + 1}` : `Model ${i + 1}`, h('div.row', { style: { gap: '8px' } }, modelPicker({ ...options, profiles: options.profiles, pipelines: [] }, v, (nv) => { picks[i] = nv; }, { noPipelines: true }), picks.length > 2 ? h('button.btn.sm.icon.ghost', { title: 'Remove', onclick: () => { picks.splice(i, 1); draw(); } }, icon('x', 'sm')) : null)))),
    mode !== 'expert' && picks.length < 3 ? h('button.btn.sm', { onclick: () => { picks.push('auto'); draw(); } }, icon('plus', 'sm'), 'Add a third model') : null,
    h('div', { style: { marginTop: '12px' } }, note('info', mode === 'compare' ? 'Models on the same computer share its memory and speed. Cloud models are billed for each answer.' : 'Debate and Expert team run several models in turn, so answers take longer and cloud models are billed for each pass.'))); };
  draw();
  modal('Ask Several Models', box, [{ label: 'Stop', onClick: () => done(null) }, { label: 'Use this', primary: true, onClick: () => done({ mode, models: mode === 'expert' ? [] : [...new Set(picks.filter(Boolean))].slice(0, 3) }) }], { wide: true });
}

// ---------------- Models page gains a Health link
const pageModels23 = window.pageModels;
window.pageModels = async function (root) {
  await pageModels23(root);
  const head = root.querySelector('.phead .row'); if (head && isPlatform()) head.prepend(h('a.btn', { href: '#/health' }, icon('heart', 'sm'), 'Health'));
};
