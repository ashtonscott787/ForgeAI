'use strict';
/* ForgeAI 2.3 — clearer model menu (where each model runs, free or paid, what it can do), live progress for every prompt,
   asking several models at once, the built-in ForgeAI Engine (download & run models with no other apps), Ollama / LM Studio
   auto-start and LM Link, clearer "My models", quick clusters and model training. Loaded after forge22.js and overrides some of it. */

Object.assign(ICONS, {
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 4.9 4.9l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.6-8.6a4 4 0 0 1-2.1-2.1z"/><path d="M15.5 4.2l2 2"/>',
  brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 8 18.5a2.5 2.5 0 0 0 4 .5V5.5A2.5 2.5 0 0 0 9 4.5z"/><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5 3 3 0 0 1-3.5 5.5 2.5 2.5 0 0 1-4 .5"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  school: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5v4.5c3 2.5 8 2.5 11 0v-4.5M21.5 9.5v5"/>',
});

const APP_ICON = { engine: 'cpu', ollama: 'cube', lmstudio: 'laptop', llamacpp: 'server', mlx: 'laptop', vllm: 'server', exo: 'network', worker: 'server', generic: 'server' };
const pct = (x) => (x == null ? '' : Math.round(x * 100) + '%');
const gbs = (b) => (!b ? '' : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1) + ' GB' : Math.round(b / 2 ** 20) + ' MB');
const ctxK = (c) => (!c ? '' : c >= 1000 ? Math.round(c / 1000) + 'k' : String(c));

// ---------------- Model menu: grouped by WHERE it runs, free vs paid, loaded state, what it can do, details panel
function modelPicker(o, value, onChange, cfg = {}) {
  o = o || { local: [], cloud: [], profiles: [], pipelines: [], limits: {} };
  const L = o.limits || { providers: {}, profiles: {} }; const pre = cfg.raw ? '' : 'm:';
  const items = []; // { v, label, sub, group, kind, ... }
  const modes = cfg.modes || ['auto', 'fastest', 'best_quality', 'best_local', 'best_coding', 'best_reasoning', 'best_vision', 'cheapest', 'private', 'cloud', 'claude', 'openai', 'google'];
  const MODE_SUB = { auto: 'Picks a model for each request and tells you why', fastest: 'Quickest loaded model, local first', best_quality: 'Most capable model you have (cloud if connected, paid)', best_local: 'Most capable model on your computers (free)', best_coding: 'Strongest model for code (local first)', best_reasoning: 'Model that thinks before answering (local first)', best_vision: 'Model that reads images (local first)', cheapest: 'Free local model, else the cheapest cloud tier', private: 'Never leaves your computers', local_fast: 'Quickest model on your computers (free)', local_powerful: 'Most capable model on your computers (free)', cloud: 'Best connected cloud AI (paid)', claude: 'Anthropic Claude (paid)', openai: 'OpenAI (paid)', google: 'Google Gemini (paid)' };
  const MODE_ICON = { auto: 'wand', fastest: 'bolt', best_quality: 'sparkles', best_local: 'laptop', best_coding: 'code', best_reasoning: 'brain', best_vision: 'eye', cheapest: 'coin', private: 'lock', local_fast: 'laptop', local_powerful: 'laptop' };
  for (const k of modes) items.push({ v: k, label: MODE_NAMES[k] || k, sub: MODE_SUB[k] || '', icon: MODE_ICON[k] || 'globe', group: 'Automatic', gsub: '', cost: /local|private|cheapest/.test(k) ? 'free' : ['auto', 'fastest', 'best_coding', 'best_reasoning', 'best_vision'].includes(k) ? null : 'paid', kind: 'mode' });
  if (!cfg.noProfiles) for (const p of o.profiles || []) items.push({ v: pre + 'profile:' + p.id, label: p.name, sub: (p.tagline ? p.tagline + ' · ' : '') + 'uses ' + (p.engineLabel || 'Auto'), icon: p.icon, color: p.color, limit: L.profiles && L.profiles[p.id], group: 'My models', gsub: 'Your named presets — a model plus instructions and settings', kind: 'profile', p });
  if (!cfg.noPipelines) for (const p of o.pipelines || []) items.push({ v: pre + 'pipeline:' + p.id, label: p.name, sub: p.stages.join(' → '), icon: 'tasks', group: 'Pipelines', gsub: 'Several models in a row', kind: 'pipeline' });
  for (const m of o.local || []) {
    const e = (m.endpoints || [])[0] || {};
    const where = e.cluster ? 'Clusters' : e.nodeKind === 'local' ? 'This computer' : e.node || 'Other computers';
    const state = e.loaded ? 'loaded' : e.startable ? 'app-closed' : 'ready';
    items.push({ v: pre + 'local:' + m.id, label: m.name || m.id, sub: [e.appName || e.name, m.params, m.quant, m.context && ctxK(m.context) + ' context'].filter(Boolean).join(' · '), icon: APP_ICON[e.app] || 'cube',
      group: where, gsub: where === 'This computer' ? 'Free · private · runs on this computer' : where === 'Clusters' ? 'Free · one model split across your computers' : e.scope === 'internet' ? 'Free · your server on the internet' : 'Free · runs on ' + (e.node || 'your network'),
      scope: e.scope, cost: 'free', state, m, kind: 'local', app: e.app });
  }
  for (const c of o.cloud || []) {
    const st = L.providers && L.providers[c.providerId];
    for (const id of c.models) items.push({ v: `${pre}cloud:${c.providerId}:${id}`, label: id, sub: c.name, icon: 'globe', group: c.name, gsub: 'Paid · sent to ' + c.host + ' (leaves your network)', scope: 'internet', cost: 'paid', price: c.prices && c.prices[id], disabled: st && st.state === 'not_allowed', disabledWhy: st && st.detail, limit: st, kind: 'cloud', c });
    for (const id of c.other || []) items.push({ v: `${pre}cloud:${c.providerId}:${id}`, label: id, sub: 'not a chat model', icon: 'globe', group: c.name, gsub: 'Paid', scope: 'internet', cost: 'paid', other: true, kind: 'cloud', c });
  }
  const cur = () => items.find((x) => x.v === value) || { label: value && value.includes(':') ? value.split(':').pop() : MODE_NAMES[value] || 'Auto', icon: 'wand' };
  const btn = h('button.mpick' + (cfg.compact ? '.compact' : ''), { type: 'button', 'aria-haspopup': 'listbox', title: 'Choose a model' });
  const costTag = (x) => (x.cost === 'free' ? h('span.ctag.free', { title: 'Runs on your own hardware — no per-use charge' }, 'Free') : x.cost === 'paid' ? h('span.ctag.paid', { title: 'Billed by the provider per use' }, 'Paid') : null);
  const paint = () => { const c = cur(); clear(btn).append(...[c.color ? profileBadge(c, 18) : icon(c.icon || 'cube', 'sm'), h('span.lbl', null, c.label), c.group && c.group !== 'Automatic' && c.kind !== 'profile' ? h('span.mwhere', null, c.kind === 'cloud' ? c.c.name : c.group) : null, costTag(c), icon('down', 'sm')].filter(Boolean)); };
  paint();
  btn.onclick = (e) => { e.preventDefault(); open(); };
  function stateBadge(x) {
    if (x.state === 'loaded') return h('span.badge.ok', { title: 'In memory — answers start straight away' }, h('span.dot'), 'Loaded');
    if (x.state === 'app-closed') return h('span.badge', { title: `${x.m.endpoints[0].appName} is closed — ForgeAI opens it and loads the model when you send` }, 'Opens ' + x.m.endpoints[0].appName);
    if (x.kind === 'local') return h('span.badge', { title: 'Loads automatically when you send — the first answer takes a little longer' }, 'Starts automatically');
    return null;
  }
  const capIcons = (m) => h('span.caps', null, m.vision ? h('span', { title: 'Can read images' }, icon('eye', 'sm')) : null, m.tools ? h('span', { title: 'Can use tools (files, web, code…)' }, icon('wrench', 'sm')) : null, m.reasoning ? h('span', { title: 'Thinks before answering' }, icon('brain', 'sm')) : null);
  function details(x) {
    const box = h('div.mdet');
    if (!x) return box;
    const row = (k, v) => (v == null || v === '' ? null : h('div.kv', null, h('span', null, k), h('b', null, v)));
    const yn = (v, known = true) => (!known ? 'Unknown' : v ? 'Yes' : 'No');
    box.append(h('div.mdh', null, x.color ? profileBadge(x, 26) : h('span.mic', null, icon(x.icon || 'cube', 'sm')), h('div', null, h('b', null, x.label), h('div.small.muted', null, x.group))));
    if (x.kind === 'mode') box.append(h('p.small', null, x.sub), x.v === 'auto' ? h('p.small.muted', null, 'Before each answer you see which model was chosen and why. Your organisation’s rules decide whether cloud models may be used.') : null);
    if (x.kind === 'profile') box.append(h('p.small', null, x.p.tagline || ''), row('Model it uses', x.p.engineLabel || 'Auto'), row('Web search', x.p.web ? 'On' : 'Off'), row('Tools', x.p.tools ? 'On' : 'Off'), x.p.daily_limit ? row('Daily limit', `${x.p.used_today || 0} of ${x.p.daily_limit} used`) : null, h('p.small.muted', null, 'A “My model” is a preset: one model (or Auto) plus its own instructions and settings. Edit it in Models → My models.'));
    if (x.kind === 'pipeline') box.append(h('p.small', null, 'Runs these steps in order: ' + x.sub));
    if (x.kind === 'local') {
      const m = x.m;
      box.append(h('div.wherebox', null, icon(APP_ICON[x.app] || 'server', 'sm'), h('div', null, h('b', null, m.endpoints.map((e) => e.name).join(' · ')), h('div.small.muted', null, m.endpoints.map((e) => `${e.node} · ${e.host}`).join(' · '))), scopeChip(x.scope)),
        row('Cost', 'Free — runs on your own hardware'), row('Status', x.state === 'loaded' ? 'Loaded and ready' : x.state === 'app-closed' ? `${m.endpoints[0].appName} is closed — opened automatically` : 'Not loaded — loads automatically when you send'),
        row('Size', [m.params, m.quant, m.memBytes && gbs(m.memBytes) + ' of memory'].filter(Boolean).join(' · ')), row('Conversation memory (context)', m.context ? `${m.context.toLocaleString()} tokens${m.loadedContext && m.loadedContext !== m.context ? ` (loaded with ${m.loadedContext.toLocaleString()})` : ''}` : 'Unknown'),
        row('Reads images', yn(m.vision, m.capsKnown)), row('Uses tools', yn(m.tools, m.capsKnown)), m.reasoning ? row('Thinks first', 'Yes') : null,
        row('Speed (measured)', m.tps ? `${fmtTps(m.tps)}${m.ttft ? ' · first word ' + fmtMs(m.ttft) : ''}` : 'Not measured yet — shows after the first answer'),
        m.origin ? h('div.kv', null, h('span', null, 'Downloaded from'), h('a', { href: m.origin.url, target: '_blank' }, m.origin.url.replace(/^https?:\/\//, ''))) : m.from ? row('File from', m.from) : null,
        x.app === 'lmstudio' ? h('p.small.muted', null, 'If LM Link is on in LM Studio, LM Studio may run this model on another linked device. LM Studio does not report which one.') : null);
    }
    if (x.kind === 'cloud') {
      box.append(h('div.wherebox', null, icon('globe', 'sm'), h('div', null, h('b', null, x.c.name), h('div.small.muted', null, x.c.host)), scopeChip('internet')),
        row('Cost', x.price ? `Paid · about $${x.price.in} in / $${x.price.out} out per million tokens${x.price.from === 'default' ? ' (default estimate — set real prices in Settings)' : ' (your price list)'}` : 'Paid — billed by ' + x.c.name),
        row('Privacy', 'Your message is sent to ' + x.c.name), x.disabled ? h('p.small', { style: { color: 'var(--red)' } }, 'Not allowed: ' + (x.disabledWhy || '')) : null);
    }
    return box;
  }
  function open() {
    const pop = h('div.mpop.wide', { role: 'listbox' }); let showOther = false; let idx = -1; let rows = []; let filter = 'all';
    const q = h('input.mq', { type: 'search', placeholder: `Search ${items.length} models…`, 'aria-label': 'Search models' });
    const FILTERS = [['all', 'All'], ['free', 'Free'], ['paid', 'Paid'], ['loaded', 'Loaded now'], ['vision', 'Reads images'], ['tools', 'Uses tools']];
    const chips = h('div.mfilters', null, FILTERS.map(([k, l]) => h('button.fchip' + (k === filter ? '.on' : ''), { type: 'button', onclick: (e) => { filter = k; chips.querySelectorAll('.fchip').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, l)));
    const list = h('div.mlist'); const det = h('div.mdetwrap');
    const other = h('label.mother', null, h('input', { type: 'checkbox', onchange: (e) => { showOther = e.target.checked; draw(); } }), 'Show non-chat models');
    const show = (x) => clear(det).append(details(x));
    const pass = (x) => (filter === 'all') || (filter === 'free' && x.cost === 'free') || (filter === 'paid' && x.cost === 'paid') || (filter === 'loaded' && x.state === 'loaded') || (filter === 'vision' && x.m && x.m.vision) || (filter === 'tools' && x.m && x.m.tools);
    const draw = () => {
      clear(list); rows = []; const term = q.value.trim().toLowerCase(); let shown = 0, hidden = 0; const seen = new Set();
      const order = ['Automatic', 'My models', 'This computer', ...new Set(items.filter((x) => x.kind === 'local' && !['This computer', 'Clusters'].includes(x.group)).map((x) => x.group)), 'Clusters', 'Pipelines', ...new Set(items.filter((x) => x.kind === 'cloud').map((x) => x.group))];
      for (const g of order) {
        if (seen.has(g)) continue; seen.add(g);
        const gi = items.filter((x) => x.group === g && (showOther || !x.other) && pass(x) && (!term || (x.label + ' ' + (x.sub || '') + ' ' + g).toLowerCase().includes(term)));
        if (!gi.length) continue;
        const gsub = gi[0].gsub; const lim = gi[0].kind === 'cloud' ? gi[0].limit : null;
        list.append(h('div.mgrp', null, h('span', null, g), gsub ? h('span.gsub', null, gsub) : null, lim && lim.state !== 'unlimited' ? limitBadge(lim) : null));
        for (const x of gi) {
          if (shown >= 400) { hidden++; continue; }
          const r = h('button.mrow' + (x.v === value ? '.sel' : '') + (x.disabled ? '.dis' : ''), { type: 'button', role: 'option', 'aria-selected': x.v === value, 'aria-disabled': !!x.disabled, onmouseenter: () => show(x), onfocus: () => show(x),
            onclick: () => { if (x.disabled) return show(x); value = x.v; paint(); close(); onChange(x.v); } },
          x.color ? profileBadge(x, 20) : h('span.mic', null, icon(x.icon || 'cube', 'sm')),
          h('span.mt', null, h('span.ml', null, x.label), x.sub ? h('span.ms', null, x.disabled ? 'Not allowed' : x.sub) : null),
          x.m ? capIcons(x.m) : null, x.m && x.m.tps ? h('span.small.faint', null, fmtTps(x.m.tps)) : null, stateBadge(x), x.limit && x.kind === 'profile' && x.limit.state !== 'unlimited' ? limitBadge(x.limit) : null, x.cost === 'paid' ? costTag(x) : null, x.v === value ? icon('check', 'sm') : null);
          list.append(r); rows.push(r); shown++;
        }
      }
      if (hidden) list.append(h('div.mmore', null, `${hidden} more — type to search`));
      if (!rows.length) list.append(h('div.mmore', null, 'No models match'));
      idx = rows.findIndex((r) => r.classList.contains('sel'));
      show(items.find((x) => x.v === value) || items[0]);
    };
    q.oninput = draw;
    q.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1))); rows.forEach((r, i) => r.classList.toggle('kb', i === idx)); if (rows[idx]) { rows[idx].scrollIntoView({ block: 'nearest' }); rows[idx].dispatchEvent(new Event('mouseenter')); } }
      if (e.key === 'Enter' && rows[idx]) { e.preventDefault(); rows[idx].click(); }
      if (e.key === 'Escape') close();
    };
    const legend = h('div.mlegend', null, h('span', null, h('span.ctag.free', null, 'Free'), ' your computers'), h('span', null, h('span.ctag.paid', null, 'Paid'), ' cloud, billed per use'), h('span', null, icon('eye', 'sm'), ' images'), h('span', null, icon('wrench', 'sm'), ' tools'), h('span', null, icon('brain', 'sm'), ' thinks'),
      cfg.onCompare ? h('button.btn.sm.ghost', { style: { marginLeft: 'auto' }, onclick: () => { close(); cfg.onCompare(); } }, icon('layers', 'sm'), 'Ask several models…') : null);
    pop.append(h('div.mtop', null, q, chips), h('div.msplit', null, list, det), h('div.mfoot', null, legend, items.some((x) => x.other) ? other : null));
    const veil = h('div.mveil', { onmousedown: (e) => { if (e.target === veil) close(); } }, pop);
    document.body.append(veil);
    const r = btn.getBoundingClientRect(); const w = Math.min(760, window.innerWidth - 16);
    pop.style.width = w + 'px'; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 12; const up = below < 320 && r.top > below;
    pop.style.maxHeight = Math.max(280, Math.min(620, (up ? r.top : below) - 12)) + 'px';
    if (up) pop.style.bottom = (window.innerHeight - r.top + 6) + 'px'; else pop.style.top = (r.bottom + 6) + 'px';
    draw(); setTimeout(() => q.focus(), 10);
    function close() { veil.remove(); btn.focus(); }
  }
  btn.getValue = () => value; btn.setValue = (v) => { value = v; paint(); };
  btn.items = items;
  return btn;
}

// ---------------- Live progress for a prompt: each step with its time, and where it is up to
function progressCard() {
  const el = h('div.pcard'); const t0 = Date.now(); let timer = null; let tokens = 0; let writeAt = null; let finished = false;
  const steps = []; // {key, label, state: 'run'|'done'|'fail', detail, bar, at}
  const find = (k) => steps.find((s) => s.key === k);
  const set = (k, label, patch = {}) => { let s = find(k); if (!s) { s = { key: k, label, state: 'run', at: Date.now() }; for (const x of steps) if (x.state === 'run' && x.key !== k) { x.state = 'done'; x.end = x.end || Date.now(); } steps.push(s); } Object.assign(s, { label: label || s.label, ...patch }); draw(); };
  const draw = () => {
    clear(el);
    const head = h('div.ph', null, finished ? icon('check', 'sm') : h('span.spinner'), h('b', null, finished ? 'Done' : (steps.find((s) => s.state === 'run') || {}).label || 'Working'), h('span.grow'), h('span.small.faint', null, fmtMs(Date.now() - t0)));
    el.append(head, h('div.psteps', null, steps.map((s) => h('div.pst.' + s.state, null, h('span.pdot', null, s.state === 'done' ? icon('check', 'sm') : s.state === 'fail' ? icon('x', 'sm') : h('span.spinner.sm')),
      h('div.grow', null, h('div', null, s.label, s.detail ? h('span.small.muted', null, ' · ' + s.detail) : null), s.bar != null ? h('div.bar.thin', null, h('i', { style: { width: Math.max(2, Math.round(s.bar * 100)) + '%' } })) : s.state === 'run' && s.indeterminate ? h('div.bar.thin.ind', null, h('i')) : null),
      h('span.small.faint', null, s.end ? fmtMs(s.end - s.at) : s.state === 'run' ? fmtMs(Date.now() - s.at) : '')))));
  };
  timer = setInterval(() => { if (!el.isConnected && steps.length) return clearInterval(timer); if (!finished) draw(); }, 500);
  return {
    el,
    route(d) { set('route', `Chose ${d.label}`, { detail: d.why ? d.why.replace(/^.*?→\s*/, '').slice(0, 120) : null }); find('route').state = 'done'; find('route').end = Date.now(); draw(); },
    progress(p) {
      if (p.phase === 'starting') set('start', p.text);
      else if (p.phase === 'loading') set('load', p.text || 'Loading the model', { bar: p.pct != null ? p.pct : null, indeterminate: p.pct == null });
      else if (p.phase === 'loaded') { const s = find('load'); if (s) { s.state = 'done'; s.end = Date.now(); s.bar = null; s.detail = p.ms ? 'took ' + fmtMs(p.ms) : null; } draw(); }
      else if (p.phase === 'sending') set('read', p.text || 'Reading your message', { indeterminate: true, detail: p.where || null });
      else if (p.phase === 'prompt') set('read', 'Reading your message', { bar: p.total ? p.processed / p.total : null, detail: p.total ? `${p.processed.toLocaleString()} of ${p.total.toLocaleString()} tokens${p.cache ? ` (${p.cache.toLocaleString()} reused)` : ''}` : null, indeterminate: false });
    },
    firstWord(ms) { writeAt = Date.now(); set('write', 'Writing', { detail: `first word after ${fmtMs(ms)}` }); },
    delta(d) { tokens += Math.max(1, Math.round(d.length / 4)); if (!writeAt) { writeAt = Date.now(); set('write', 'Writing'); } const s = find('write'); const secs = (Date.now() - writeAt) / 1000; s.detail = `~${tokens.toLocaleString()} tokens${secs > 0.5 ? ` · ${Math.round(tokens / secs)} tok/s` : ''}`; },
    step(text) { set('tool:' + steps.length, text); },
    stage(d) { set('stage:' + d.index, `Stage ${d.index + 1} of ${d.total}: ${d.name} · ${d.model}`); },
    done() { finished = true; for (const s of steps) if (s.state === 'run') { s.state = 'done'; s.end = Date.now(); } clearInterval(timer); draw(); },
    fail(msg) { finished = true; const s = steps.find((x) => x.state === 'run'); if (s) { s.state = 'fail'; s.end = Date.now(); s.detail = msg; } clearInterval(timer); draw(); },
  };
}

// ---------------- Messages, with compared answers shown side by side
function renderAll(msgs, list) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i]; const c = m.meta && m.meta.compare;
    if (m.role === 'assistant' && c) {
      const group = [m]; while (i + 1 < list.length && list[i + 1].meta && list[i + 1].meta.compare && list[i + 1].meta.compare.of === c.of) group.push(list[++i]);
      group.sort((a, b) => a.meta.compare.slot - b.meta.compare.slot);
      const chosenAny = group.some((x) => x.meta.compare.chosen);
      msgs.append(h('div.cmpwrap', null, h('div.cmphead', null, icon('layers', 'sm'), `${group.length} models answered`, h('span.small.muted', null, chosenAny ? ' — the kept answer is what the conversation remembers' : ' — the first is remembered unless you keep another')),
        h('div.cmpgrid', null, group.map((x) => { const el = renderMsg(x); const kept = x.meta.compare.chosen || (!chosenAny && x.meta.compare.slot === 0);
          el.classList.toggle('kept', !!kept);
          if (canOrg('chat') && x.id && !x.meta.blocked && !x.meta.error) el.querySelector('.body').append(h('div.keep', null, kept ? h('span.badge.ok', null, icon('check', 'sm'), 'Remembered') : h('button.btn.sm', { onclick: guard(async () => { await orgApi(`/conversations/${CH.convId}/messages/${x.id}/choose`, { body: {} }); toast('Kept this answer'); route(); }) }, 'Keep this answer')));
          return el; }))));
      continue;
    }
    msgs.append(renderMsg(m));
  }
}
// Pick 2–3 models to ask at once.
function compareDialog(options, current, done) {
  const picks = [...(current || [])]; while (picks.length < 2) picks.push(picks.length ? 'm:local:' + ((options.local[0] || {}).id || '') : CH.pick);
  const box = h('div');
  const draw = () => { clear(box).append(h('p.muted', { style: { marginTop: 0 } }, 'Each model answers the same message at the same time. You see the answers side by side, with where each one ran and how fast it was.'),
    ...picks.map((v, i) => field(`Model ${i + 1}`, h('div.row', { style: { gap: '8px' } }, modelPicker({ ...options, profiles: options.profiles, pipelines: [] }, v, (nv) => { picks[i] = nv; }, { noPipelines: true }), picks.length > 2 ? h('button.btn.sm.icon.ghost', { title: 'Remove', onclick: () => { picks.splice(i, 1); draw(); } }, icon('x', 'sm')) : null))),
    picks.length < 3 ? h('button.btn.sm', { onclick: () => { picks.push('auto'); draw(); } }, icon('plus', 'sm'), 'Add a third model') : null,
    h('div', { style: { marginTop: '12px' } }, note('info', 'Models on the same computer share its memory and speed — asking three big local models at once can be slow. Cloud models are billed for each answer.'))); };
  draw();
  modal('Ask Several Models', box, [{ label: 'Stop comparing', onClick: () => done(null) }, { label: 'Use these', primary: true, onClick: () => done([...new Set(picks.filter(Boolean))].slice(0, 3)) }], { wide: true });
}

// ================= Models page: engines, what is running, every model by where it runs, downloads =================
const HF_QUERIES = { 'llama3.2:3b': 'Llama-3.2-3B-Instruct', 'qwen3:4b': 'Qwen3-4B', 'gemma3:4b': 'gemma-3-4b-it', 'qwen3:8b': 'Qwen3-8B', 'llama3.1:8b': 'Llama-3.1-8B-Instruct', 'deepseek-r1:8b': 'DeepSeek-R1-0528-Qwen3-8B', 'gemma3:12b': 'gemma-3-12b-it', 'qwen3:14b': 'Qwen3-14B', 'phi4:14b': 'phi-4', 'deepseek-r1:14b': 'DeepSeek-R1-Distill-Qwen-14B', 'qwen2.5-coder:14b': 'Qwen2.5-Coder-14B-Instruct', 'gpt-oss:20b': 'gpt-oss-20b', 'mistral-small3.2:24b': 'Mistral-Small-3.2-24B-Instruct-2506', 'gemma3:27b': 'gemma-3-27b-it', 'qwen3:30b': 'Qwen3-30B-A3B', 'qwen3-coder:30b': 'Qwen3-Coder-30B-A3B-Instruct', 'qwen3:32b': 'Qwen3-32B', 'deepseek-r1:32b': 'DeepSeek-R1-Distill-Qwen-32B', 'llama3.3:70b': 'Llama-3.3-70B-Instruct', 'gpt-oss:120b': 'gpt-oss-120b' };
const RUNTIME_NAME = { engine: 'ForgeAI Engine', ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', mlx: 'MLX', vllm: 'vLLM', exo: 'exo', generic: 'OpenAI-compatible', 'openai-compatible': 'OpenAI-compatible', worker: 'ForgeAI' };
// Rough fit: the file plus ~20% and 1.5 GB for the conversation, against the computer's memory. Shown as an estimate.
function fitFor(sizeBytes, ramGb) { if (!ramGb || !sizeBytes) return ['', '']; const need = sizeBytes * 1.2 / 2 ** 30 + 1.5; if (need <= ramGb * 0.7) return ['ok', 'Fits well']; if (need <= ramGb * 0.9) return ['warn', 'Tight — may be slow']; return ['bad', 'Too big for this computer']; }

async function pageModels(root) {
  const [c, eng, apps, jobs, lmsJobs, engTargets] = await Promise.all([api('/api/cluster'), isPlatform() ? api('/api/engine').catch(() => null) : null, isPlatform() ? api('/api/apps').catch(() => null) : null, isPlatform() ? api('/api/jobs').catch(() => []) : [], isPlatform() ? api('/api/lmstudio/downloads').catch(() => []) : [], isPlatform() ? api('/api/engine/targets').catch(() => []) : []]);
  const remoteDl = (ts) => (ts || []).filter((t) => t.id !== 'local').flatMap((t) => (t.downloads || []).map((d) => ({ ...d, kind: 'engine', node: t.name, nodeId: t.id })));
  const pg = h('div.page'); root.append(pg);
  const can = c.canManage; const local = c.nodes.find((n) => n.is_local);
  pg.append(pageHead('Models', 'Every model you can use — where it runs, whether it is loaded, and what it can do. Download new ones here; no other apps are needed.',
    h('button.btn', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/cluster/refresh', { body: {} }); route(); }) }, icon('refresh', 'sm'), 'Refresh'),
    can ? h('button.btn.primary', { onclick: () => getModelsModal(c, eng) }, icon('download', 'sm'), 'Get Models') : null));

  // Downloads in progress (ForgeAI Engine and Ollama)
  const dlBox = h('div'); pg.append(dlBox);
  const drawDl = (eDl, oJobs, lJobs, rDl) => {
    clear(dlBox); const list = [...(eDl || []).map((d) => ({ ...d, kind: 'engine' })), ...(rDl || []), ...(lJobs || []), ...(oJobs || []).map((j) => ({ id: j.id, model: j.displayName || j.finalName, from: 'ollama.com/library', state: j.state, status: j.status || j.error, done: j.completed, total: j.total, kind: 'ollama', node: j.nodeName }))].filter((d) => d.state === 'running' || Date.now() - (d.startedAt || 0) < 10 * 60000).slice(0, 8);
    if (!list.length) return;
    dlBox.append(h('div.section-title', { style: { marginTop: 0 } }, 'Downloads'), h('div.card.pad0', null, list.map((d) => { const p = d.total ? d.done / d.total : null;
      return h('div.job', null, h('div', { style: { color: d.state === 'error' ? 'var(--red)' : 'var(--accent)' } }, icon(d.state === 'done' ? 'check' : d.state === 'error' ? 'warn' : 'download')),
        h('div.grow', null, h('div', null, h('b', null, d.model), h('span.faint.small', null, ` · to ${d.kind === 'engine' ? 'ForgeAI Engine' + (d.node ? ' on ' + d.node : '') : d.kind === 'lmstudio' ? 'LM Studio' + (d.node ? ' on ' + d.node : '') + (d.quant ? ' · ' + d.quant : '') : 'Ollama' + (d.node ? ' on ' + d.node : '')}`)),
          h('div.small.muted', null, 'From ', /^https?:/.test(d.from) ? h('a', { href: d.from, target: '_blank' }, d.from.replace(/^https?:\/\//, '')) : d.from),
          d.state === 'running' ? h('div', null, h('div.bar', { style: { margin: '6px 0 4px' } }, h('i', { style: { width: Math.max(2, Math.round((p || 0) * 100)) + '%' } })), h('div.progress', null, `${d.status || ''}${d.total ? ` · ${gbs(d.done)} of ${gbs(d.total)} · ${pct(p)}` : ''}`))
            : h('div.small', { style: { color: d.state === 'error' ? 'var(--red)' : 'var(--text-2)' } }, d.status || d.state)),
        d.state === 'running' && d.kind !== 'lmstudio' ? h('button.btn.sm', { onclick: guard(async () => { await api(d.kind === 'engine' && d.nodeId ? `/api/engine/on/${d.nodeId}/cancel` : d.kind === 'engine' ? `/api/engine/downloads/${d.id}/cancel` : `/api/jobs/${d.id}/cancel`, { body: d.nodeId ? { id: d.id } : {} }); }) }, 'Cancel') : d.state === 'running' ? h('span.small.muted', null, 'Pause or cancel in LM Studio') : null); })));
  };
  drawDl(eng && eng.downloads, jobs, lmsJobs, remoteDl(engTargets));
  const anyRunning = () => (eng && eng.downloads || []).some((d) => d.state === 'running') || (jobs || []).some((j) => j.state === 'running') || (lmsJobs || []).some((j) => j.state === 'running') || remoteDl(engTargets).some((d) => d.state === 'running');
  if (anyRunning()) { const poll = async () => { if (!document.body.contains(dlBox)) return; const [e2, j2, l2, t2] = await Promise.all([api('/api/engine/downloads').catch(() => []), api('/api/jobs').catch(() => []), api('/api/lmstudio/downloads').catch(() => []), api('/api/engine/targets').catch(() => [])]); const r2 = remoteDl(t2); drawDl(e2, j2, l2, r2); if ([...e2, ...j2, ...l2, ...r2].some((d) => d.state === 'running')) S.pageTimer = setTimeout(poll, 2500); else route(); }; S.pageTimer = setTimeout(poll, 1500); }

  // Running now
  const loaded = []; for (const n of c.nodes) for (const m of n.models || []) if (m.loaded) loaded.push({ n, m });
  pg.append(h('div.section-title', null, 'Loaded right now'));
  pg.append(loaded.length ? h('div.list', null, loaded.map(({ n, m }) => h('div.li', null, icon(APP_ICON[m.runtime] || 'cube'), h('div.t', null, h('b', null, m.alias || m.id), h('span', null, `${RUNTIME_NAME[m.runtime] || m.runtime} on ${n.name}${m.memBytes ? ' · about ' + gbs(m.memBytes) + ' of memory' : ''}${m.tps ? ' · ' + fmtTps(m.tps) : ''}`)),
    can ? h('button.btn.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/models/control', { body: { nodeId: n.id, model: m.id, action: 'unload' } }); route(); }) }, 'Unload') : null)))
    : h('div.card', null, h('span.muted.small', null, 'No model is loaded. Models load automatically the first time you use them, and the ForgeAI Engine puts idle ones to sleep to free memory.')));

  // Engines on this computer
  if (isPlatform() && eng) pg.append(h('div.section-title', null, 'Engines on this computer'), enginesPanel(eng, apps, local));

  if (isPlatform()) await myModelsSection(pg);

  // Every model, by where it runs
  pg.append(h('div.section-title', { style: { marginTop: '30px' } }, 'All models — by where they run'));
  for (const n of c.nodes) {
    const models = (n.models || []).slice().sort((a, b) => (b.loaded - a.loaded) || String(a.runtime).localeCompare(String(b.runtime)) || String(a.id).localeCompare(String(b.id)));
    const isCluster = /\(cluster\)$/.test(n.name);
    pg.append(h('div.row.between', { style: { margin: '20px 4px 10px' } },
      h('div.row', null, icon(n.is_local ? osIcon(S.me.os) : isCluster ? 'layers' : 'server'), h('b', { style: { fontSize: '15px' } }, n.name), statusBadge(n.enabled ? n.status : 'disabled'), scopeChip(n.scope), h('span.small.muted', null, `${models.length} model${models.length === 1 ? '' : 's'}${n.ram_gb ? ' · ' + n.ram_gb + ' GB memory' : ''}`))));
    if (!models.length) { pg.append(h('div.card', null, h('div.muted.small', null, n.status === 'online' ? (n.is_local ? 'No models yet — press Get Models.' : 'No models.') : n.error || 'Not reachable.'))); continue; }
    pg.append(h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null,
      h('thead', null, h('tr', null, ['Model', 'Runs in', 'Can', 'Size', 'Context', 'Speed', 'Status', ''].map((x) => h('th', null, x)))),
      h('tbody', null, models.map((m) => {
        const appName = RUNTIME_NAME[m.runtime] || m.runtime; const host = (() => { if (String(m.endpointUrl || '').startsWith('forgeai-engine')) return 'built in'; try { return new URL(m.endpointUrl || n.url).host; } catch { return ''; } })();
        return h('tr', null,
          h('td', null, h('div', null, h('b', null, m.alias || m.id), m.alias ? h('div.small.faint.mono', null, m.id) : null, m.origin ? h('div.small.faint', null, 'from ', h('a', { href: m.origin.url, target: '_blank' }, m.origin.repo)) : m.from ? h('div.small.faint', null, 'file from ' + m.from) : null)),
          h('td.small', null, h('span.row.nowrap', { style: { gap: '6px' } }, icon(APP_ICON[m.runtime] || 'server', 'sm'), appName), h('div.faint.mono', null, host), m.runtime === 'lmstudio' ? h('div.faint', { title: 'If LM Link is on, LM Studio may run this on another of your devices' }, 'LM Link possible') : null),
          h('td', null, h('span.caps.row.nowrap', { style: { gap: '4px' } }, h('span', { title: 'Chat' }, icon('chat', 'sm')), m.vision ? h('span', { title: 'Reads images' }, icon('eye', 'sm')) : null, m.tools !== false ? h('span', { title: 'Uses tools' }, icon('wrench', 'sm')) : null, m.caps && m.caps.reasoning ? h('span', { title: 'Thinks first' }, icon('brain', 'sm')) : null)),
          h('td.muted', null, [m.params, m.quant].filter(Boolean).join(' · ') || '—', m.memBytes ? h('div.small.faint', null, gbs(m.memBytes) + ' memory') : null),
          h('td.muted', null, m.context ? ctxK(m.context) : '—'), h('td.muted', null, m.tps ? fmtTps(m.tps) : '—'),
          h('td', null, m.loaded ? h('span.badge.ok', null, h('span.dot'), 'Loaded') : m.startable ? h('span.badge', { title: 'The app is closed — ForgeAI opens it when the model is used' }, 'App closed') : m.state === 'loading' ? h('span.badge.warn', null, 'Loading…') : h('span.badge', { title: 'Loads automatically when used' }, 'Ready')),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            can ? h('button.btn.sm.icon.ghost', { title: 'Rename', onclick: () => renameModal(n, m, m.runtime === 'ollama' || n.kind === 'worker') }, icon('tag')) : null,
            can && (['engine', 'ollama', 'lmstudio'].includes(m.runtime) || n.kind === 'worker') ? h('button.btn.sm.ghost', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner')); await api('/api/models/control', { body: { nodeId: n.id, model: m.id, action: m.loaded ? 'unload' : 'load' } }); route(); }) }, m.loaded ? 'Unload' : 'Load') : null,
            can && m.runtime === 'engine' && isOwner() ? h('button.btn.sm.icon.ghost', { title: m.from ? 'Stop using this file (the file stays where it is)' : 'Delete the downloaded file', onclick: guard(async () => { if (!(await confirmBox(m.from ? 'Remove from ForgeAI Engine?' : 'Delete Model?', m.from ? `${m.id} stays in ${m.from}; ForgeAI just stops using it.` : `Delete ${m.id} (${gbs(m.sizeBytes)})? You can download it again later.`, m.from ? 'Remove' : 'Delete', true))) return; await api('/api/engine/models/' + encodeURIComponent(m.id), { method: 'DELETE' }); route(); }) }, icon('trash')) : null,
            can && (m.runtime === 'ollama' && n.is_local || n.kind === 'worker' || n.kind === 'ollama') && isOwner() ? h('button.btn.sm.icon.ghost', { title: 'Delete from ' + n.name, onclick: guard(async () => { if (!(await confirmBox('Delete Model?', `Remove ${m.alias || m.id} from ${n.name}?`, 'Delete', true))) return; await api(`/api/nodes/${n.id}/delete-model`, { body: { model: m.id } }); route(); }) }, icon('trash')) : null));
      }))))));
  }
  if (isPlatform()) await pipelinesSection(pg);
  if (can) await guideSection(pg);
}

function enginesPanel(eng, apps, local) {
  const box = h('div.grid.gauto', { style: { gap: '12px' } });
  // ForgeAI Engine
  const eStatus = !eng.installed ? (eng.install && eng.install.state === 'running' ? 'Installing…' : eng.install && eng.install.state === 'error' ? 'Install failed' : 'Not installed') : eng.running ? 'Running' : 'Stopped';
  const gpuSel = sel([['cpu', S.me.os === 'darwin' ? 'Standard (uses the Mac GPU)' : 'Standard (CPU)'], ['cuda', 'NVIDIA GPU (CUDA)'], ['vulkan', 'AMD / Intel GPU (Vulkan)']], 'cpu');
  box.append(h('div.card.engcard', null,
    h('div.row', { style: { gap: '10px' } }, h('div.pbadge', { style: { width: '38px', height: '38px', background: 'linear-gradient(145deg,#0a84ff,#5e5ce6)' } }, icon('cpu')), h('div.grow', null, h('b', null, 'ForgeAI Engine'), h('div.small.muted', null, 'Built in — downloads and runs models with no other apps')), h('span.badge' + (eng.running ? '.ok' : eng.installed ? '' : '.warn'), null, eStatus)),
    h('div.small', { style: { margin: '10px 0' } }, eng.installed ? `${(eng.models || []).length} model${(eng.models || []).length === 1 ? '' : 's'} · up to ${eng.maxLoaded} loaded at once · idle models sleep after ${eng.settings.sleepMinutes} min${eng.version ? ' · llama.cpp ' + eng.version : ''}` : 'Uses llama.cpp, downloaded once from github.com/ggml-org/llama.cpp (official release; checksum checked).'),
    eng.install && eng.install.state === 'running' ? h('div.small.muted', null, eng.install.status + (eng.install.total ? ` — ${pct(eng.install.completed / eng.install.total)}` : '')) : null,
    eng.install && eng.install.state === 'error' ? h('div.small', { style: { color: 'var(--red)' } }, eng.install.status) : null,
    h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
      !eng.installed ? [S.me.os !== 'darwin' ? gpuSel : null, h('button.btn.sm.primary', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/engine/install', { body: { gpu: gpuSel.value } }); const poll = async () => { const s = await api('/api/engine').catch(() => null); if (s && (s.installed || (s.install && s.install.state === 'error'))) return route(); setTimeout(poll, 1500); }; poll(); toast('Installing the ForgeAI Engine'); }) }, icon('download', 'sm'), 'Install')]
        : [eng.running ? h('button.btn.sm', { onclick: guard(async () => { await api('/api/engine/stop', { body: {} }); route(); }) }, 'Stop') : h('button.btn.sm.primary', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/engine/start', { body: {} }); route(); }) }, 'Start'),
          h('button.btn.sm.ghost', { onclick: () => engineSettings(eng) }, 'Settings'), h('button.btn.sm.ghost', { onclick: () => modal('ForgeAI Engine — log', h('pre.mono.small', { style: { maxHeight: '380px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, (eng.logs || []).join('\n') || 'Nothing yet.'), [{ label: 'Close', primary: true }], { wide: true }) }, 'Log')])));
  // Ollama
  if (apps) {
    const o = apps.ollama; const lm = apps.lmstudio;
    box.append(h('div.card.engcard', null,
      h('div.row', { style: { gap: '10px' } }, h('div.pbadge', { style: { width: '38px', height: '38px', background: 'linear-gradient(145deg,#1d1d1f,#48484a)' } }, icon('cube')), h('div.grow', null, h('b', null, 'Ollama'), h('div.small.muted', null, 'Separate free app · models from ollama.com')), h('span.badge' + (o.running ? '.ok' : ''), null, o.running ? 'Running' : o.installed ? 'Closed' : 'Not installed')),
      h('div.small', { style: { margin: '10px 0' } }, o.running ? 'Connected on port 11434.' : o.installed ? 'Installed but closed — ForgeAI opens it automatically when one of its models is used.' : 'Optional. The ForgeAI Engine does the same job without it.'),
      h('div.row', { style: { gap: '6px' } }, !o.running && o.installed ? h('button.btn.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/apps/ollama/start', { body: {} }); route(); }) }, 'Open Ollama') : null, !o.installed && ['darwin', 'win32'].includes(S.me.os) ? h('button.btn.sm.ghost', { onclick: () => ollamaModal() }, 'Install Ollama') : null)));
    const link = lm.link || {};
    box.append(h('div.card.engcard', null,
      h('div.row', { style: { gap: '10px' } }, h('div.pbadge', { style: { width: '38px', height: '38px', background: 'linear-gradient(145deg,#4b3cfa,#8a5cf6)' } }, icon('laptop')), h('div.grow', null, h('b', null, 'LM Studio'), h('div.small.muted', null, 'Separate app · its local server (port 1234)')), h('span.badge' + (lm.running ? '.ok' : ''), null, lm.running ? 'Server on' : lm.installed ? 'Server off' : 'Not installed')),
      h('div.small', { style: { margin: '10px 0' } }, lm.running ? 'Connected. Models load automatically when used.' : lm.installed ? (lm.cli ? 'ForgeAI starts its server automatically when one of its models is used.' : 'Turn on Developer → Start Server in LM Studio (ForgeAI could not find its “lms” command).') : 'Optional.'),
      lm.running && lm.auth === 'needs-token' ? h('div', { style: { marginBottom: '10px' } }, note('warn', 'LM Studio requires an API token, so ForgeAI can’t list, load or download its models. Add a token below (LM Studio → Developer → Server Settings → Manage Tokens).')) : null,
      lm.running && lm.auth === 'old-version' ? h('div', { style: { marginBottom: '10px' } }, note('warn', 'This LM Studio is too old for loading and downloading through its API. Update LM Studio (0.4 or newer).')) : null,
      lm.installed || lm.running ? h('div.small', { style: { marginBottom: '8px' } }, icon('key', 'sm'), ' API token: ', lm.tokenSet ? 'saved' : 'none', ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); lmTokenModal(lm.tokenSet); } }, lm.tokenSet ? 'Change' : 'Add')) : null,
      lm.installed ? h('div.small', { style: { marginBottom: '10px' } }, icon('link', 'sm'), ' LM Link: ', link.available ? (link.enabled ? 'on' : 'off') : 'not available', ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); lmLinkHelp(link); } }, 'What is this?')) : null,
      h('div.row', { style: { gap: '6px' } }, lm.installed && !lm.running ? h('button.btn.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/apps/lmstudio/start', { body: {} }); route(); }) }, 'Start Server') : null)));
  }
  return box;
}
function lmTokenModal(isSet) {
  const tok = h('input', { type: 'password', placeholder: isSet ? 'Saved — type a new one to replace, or leave empty and Save to remove' : 'Paste the token from LM Studio' });
  modal('LM Studio API Token', h('div', null, h('p.small.muted', { style: { marginTop: 0 } }, 'Only needed if “Require authentication” is on in LM Studio (Developer → Server Settings). Create a token there with Manage Tokens; give it permission to load and download models. ForgeAI stores it encrypted.'), field('Token', tok)),
    [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => { await api('/api/apps/lmstudio/token', { method: 'PUT', body: { token: tok.value } }); toast(tok.value ? 'Token saved' : 'Token removed'); route(); } }]);
}
function engineSettings(eng) {
  const s = eng.settings;
  const maxL = h('input', { type: 'number', min: 0, max: 16, value: s.maxLoaded || 0, style: { width: '90px' } });
  const ctx = sel([['4096', '4k'], ['8192', '8k'], ['16384', '16k'], ['32768', '32k'], ['65536', '64k'], ['131072', '128k']], String(s.ctx));
  const sleep = h('input', { type: 'number', min: 0, max: 1440, value: s.sleepMinutes, style: { width: '90px' } });
  const tok = h('input', { type: 'password', placeholder: eng.hfToken ? 'Saved — type to replace' : 'Optional — for models that need you to accept a licence' });
  modal('ForgeAI Engine Settings', h('div', null,
    field('Models loaded at once', maxL, `0 = automatic (${eng.maxLoaded} on this computer, about one per 12 GB of memory). More models at once need more memory.`),
    field('Conversation memory (context) per model', ctx, 'Larger lets models read longer conversations and files, but uses more memory. Never more than the model supports.'),
    field('Put idle models to sleep after (minutes)', sleep, '0 = never. Sleeping frees memory; the next request wakes the model.'),
    field('Hugging Face token', tok, 'Stored encrypted. Only needed for “gated” models such as some Llama and Gemma versions.'),
    h('div.small.muted', null, 'Models are stored in ', h('span.mono', null, eng.modelsDir))),
  [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => { await api('/api/engine/settings', { method: 'PUT', body: { maxLoaded: +maxL.value, ctx: +ctx.value, sleepMinutes: +sleep.value } }); if (tok.value.trim()) await api('/api/engine/hf-token', { method: 'PUT', body: { token: tok.value.trim() } }); toast('Saved — the engine restarted'); route(); } }]);
}
function lmLinkHelp(link) {
  modal('LM Studio and LM Link', h('div', null, h('div.md', { html: md(`**LM Link** is LM Studio’s own feature for using a model that runs on another of your devices (it uses an encrypted Tailscale network and your LM Studio account).

**How ForgeAI works with it**
- ForgeAI talks to LM Studio on this computer (port 1234). If LM Link is on, LM Studio can run a model on a *linked* device and pass the answer back — ForgeAI sees it as an LM Studio model.
- LM Studio’s API does **not** say which device ran it, so ForgeAI labels these models “LM Link possible”. To see and measure exactly which computer runs a model, add that computer’s LM Studio server directly instead: **AI providers → Add Provider → LM Studio** with its address (for example its Tailscale address and port 1234), or install ForgeAI on it.

**Setting up LM Link** (in LM Studio, on every device): sign in → LM Link → turn it on → on the computer with the models also allow loading models on that machine. Devices then find each other.

**Status from this computer:** ${link.available ? '`lms link status` says:' : link.reason || 'not available'}`) }), link.text ? h('pre.mono.small', { style: { whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' } }, link.text) : null), [{ label: 'Close', primary: true }], { wide: true });
}

// ---------------- Get Models: recommended, search Hugging Face, use files you already have, Ollama library
function getModelsModal(c, eng) {
  const local = c.nodes.find((n) => n.is_local); const ram = (local && local.ram_gb) || 0;
  const engOK = eng && eng.installed;
  let tab = 'rec';
  const body = h('div'); const tabs = h('div');
  const draw = () => {
    clear(tabs).append(segControl([['rec', 'Recommended'], ['search', 'Search Hugging Face'], ['have', 'Already on this computer'], ['lmstudio', 'LM Studio (optional)'], ['ollama', 'Ollama (optional)']], tab, (v) => { tab = v; draw(); }));
    clear(body);
    if (!engOK && !['ollama', 'lmstudio'].includes(tab)) body.append(note('warn', h('span', null, h('b', null, 'Install the ForgeAI Engine first'), ' (Models → Engines → Install). It downloads llama.cpp once from github.com/ggml-org/llama.cpp, then runs these models with no other apps.')), h('div', { style: { height: '10px' } }));
    body.append(h('div.card', { style: { marginTop: '0', marginBottom: '10px' } }, h('div.row.nowrap', { style: { gap: '10px' } }, icon('bolt', 'lg'), h('div', null, h('b', null, 'No other apps needed.'), h('div.small.muted', null, 'ForgeAI Engine downloads models from Hugging Face itself (sizes and checksums verified) and runs them. LM Studio and Ollama tabs are for people who already use those apps.')))));
    if (tab === 'rec') recTab(body, ram);
    if (tab === 'search') searchTab(body, ram);
    if (tab === 'have') haveTab(body);
    if (tab === 'lmstudio') lmStudioTab(body);
    if (tab === 'ollama') { body.append(h('p.small.muted', null, 'Downloads into the Ollama app (it must be installed). Source: ollama.com/library.')); const b = h('button.btn', { onclick: () => catalogModal(c) }, 'Open the Ollama library…'); body.append(b); }
  };
  draw();
  modal('Get Models', h('div', null, h('div', { style: { overflowX: 'auto', marginBottom: '14px' } }, tabs), body), [{ label: 'Done', primary: true, onClick: () => route() }], { wide: true });
}
function recTab(body, ram) {
  let cat = 'all'; const grid = h('div.catgrid'); const segs = h('div');
  const draw = () => {
    clear(grid);
    for (const m of CATALOG.filter((x) => cat === 'all' || x.cats.includes(cat)).sort((a, b) => a.size - b.size)) {
      const [fit, fitTxt] = fitFor(m.size * 2 ** 30 / 1.2, ram); const q = HF_QUERIES[m.id] || m.name;
      grid.append(h('div.catcard' + (fit === 'bad' ? '.dim' : ''), null,
        h('div.row.between', null, h('b', null, m.name), h('span.small.faint', null, m.by)),
        h('div.small.muted', { style: { margin: '4px 0 8px', minHeight: '34px' } }, m.desc),
        h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } }, h('span.chip', null, `about ${m.size} GB`), fitTxt ? h('span.badge.' + fit, null, fitTxt) : null, m.cats.includes('vision') ? h('span.chip', null, icon('eye', 'sm'), 'images') : null),
        h('div.row', { style: { marginTop: '10px' } }, h('button.btn.sm.primary', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner'), ' Finding on Hugging Face…'); const r = await api('/api/engine/resolve?q=' + encodeURIComponent(q)); b.disabled = false; clear(b).append(icon('download', 'sm'), 'Choose & Download'); if (!r.repo) return toast(`No GGUF found on Hugging Face for “${q}”. Try Search.`, true); repoModal(r.repo, ram, { via: r.via, vision: m.cats.includes('vision') }); }) }, icon('download', 'sm'), 'Choose & Download'))));
    }
  };
  clear(segs).append(segControl(CAT_NAMES, cat, (v) => { cat = v; draw(); }));
  body.append(h('p.small.muted', { style: { marginTop: 0 } }, 'Each button looks the model up on Hugging Face (huggingface.co) and shows you exactly which repository and file it will download before anything starts. Sizes here are approximate; the exact size is shown next.'), h('div', { style: { overflowX: 'auto', marginBottom: '12px' } }, segs), grid);
  draw();
}
function searchTab(body, ram) {
  const q = h('input', { type: 'search', placeholder: 'e.g. Qwen3 14B, gemma 3, mistral, ggml-org/…', autocomplete: 'off', style: { flex: 1 } });
  const out = h('div.list', { style: { boxShadow: 'none', marginTop: '10px' } });
  const go = guard(async () => {
    if (/^[\w.-]+\/[\w.-]+$/.test(q.value.trim())) return repoModal(q.value.trim(), ram, {});
    clear(out).append(h('div.li', null, h('span.spinner'), ' Searching huggingface.co…'));
    const list = await api('/api/engine/search?q=' + encodeURIComponent(q.value.trim()));
    clear(out); if (!list.length) return out.append(h('div.li', null, h('div.t', null, h('b', null, 'No GGUF models found'), h('span', null, 'Try a shorter name, e.g. “Qwen3 8B”.'))));
    for (const r of list) out.append(h('div.li.click', { onclick: () => repoModal(r.repo, ram, {}) }, icon('cube'), h('div.t', null, h('b', null, r.repo), h('span', null, [`${r.downloads.toLocaleString()} downloads`, r.gated ? 'needs licence acceptance' : null, r.tags.slice(0, 4).join(', ')].filter(Boolean).join(' · '))), icon('right', 'sm')));
  });
  q.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  body.append(h('div.row.nowrap', { style: { gap: '8px' } }, q, h('button.btn', { onclick: go }, 'Search')), h('div.small.muted', { style: { marginTop: '6px' } }, 'Searches huggingface.co for GGUF models, most-downloaded first. You can also paste publisher/repository.'), out);
  setTimeout(() => q.focus(), 30);
}
async function repoModal(repo, ram, o) {
  const box = h('div', null, h('span.spinner'), ' Reading the file list from huggingface.co…');
  const close = modal(repo, box, [], { wide: true });
  let info; try { info = await api('/api/engine/repo?repo=' + encodeURIComponent(repo)); } catch (e) { clear(box).append(note('warn', e.message)); return; }
  clear(box);
  const want = (c) => /Q4_K_M/i.test(c.quant) ? 0 : /Q4_K_S|Q4_0|IQ4_XS/i.test(c.quant) ? 1 : /Q5_K_M/i.test(c.quant) ? 2 : /Q8_0/i.test(c.quant) ? 3 : 4;
  const choices = info.choices.slice().sort((a, b) => want(a) - want(b) || a.size - b.size);
  let pick = choices.find((c) => fitFor(c.size, ram)[0] !== 'bad') || choices[0];
  const proj = info.projectors.slice().sort((a, b) => (/f16/i.test(b.path) - /f16/i.test(a.path)) || a.size - b.size)[0];
  let withProj = !!proj;
  const projRow = proj ? h('label.check', { style: { marginTop: '10px' } }, h('input', { type: 'checkbox', checked: withProj, onchange: (e) => { withProj = e.target.checked; } }), `Include image support (${proj.path.split('/').pop()}, ${gbs(proj.size)})`) : h('span');
  const [targets, engTargets] = await Promise.all([api('/api/lmstudio/targets').catch(() => []), api('/api/engine/targets').catch(() => [])]);
  let dest = o.dest || 'engine';
  const destSel = sel([['engine', 'ForgeAI Engine on this computer (built in — no other apps)'], ...engTargets.filter((t) => t.id !== 'local' && t.online).map((t) => ['eng:' + t.id, `ForgeAI Engine on ${t.name}${t.linked ? ' (remote link)' : ''}${t.engine === false ? ' — installs the engine first' : ''}`]), ...targets.map((t) => ['lms:' + t.id, t.name])], dest, { onchange: (e) => { dest = e.target.value; projRow.style.display = (dest === 'engine' || dest.startsWith('eng:')) && proj ? '' : 'none'; } });
  const listEl = h('div.list', { style: { boxShadow: 'none' } });
  const draw = () => { clear(listEl); for (const c of choices) { const [fit, ft] = fitFor(c.size, ram);
    listEl.append(h('label.li', { style: { cursor: 'pointer' } }, h('input', { type: 'radio', name: 'q', checked: c === pick, onchange: () => { pick = c; } }), h('div.t', null, h('b', null, c.quant || c.name, want(c) === 0 ? h('span.badge.ok', { style: { marginLeft: '6px' } }, 'Recommended') : null), h('span', null, `${c.name}${c.shards > 1 ? ` · ${c.shards} parts` : ''}`)), h('span.small', null, gbs(c.size)), ft ? h('span.badge.' + fit, null, ft) : null)); } };
  draw();
  box.append(h('div.wherebox', null, icon('globe', 'sm'), h('div', null, h('b', null, 'Source'), h('div.small', null, h('a', { href: info.url, target: '_blank' }, info.url.replace(/^https?:\/\//, '')), o.via ? h('span.muted', null, ` · ${o.via}`) : null)), h('span.badge', null, 'Hugging Face')),
    h('p.small.muted', null, 'Smaller files (Q4) are faster and use less memory; bigger ones (Q8, F16) are a little more accurate. The download is checked against Hugging Face’s checksum.'), listEl,
    projRow,
    targets.length || engTargets.length > 1 ? field('Download into', destSel, 'The chosen computer downloads the file itself from Hugging Face (checked against the checksum) and keeps it there. LM Studio keeps downloads in its own model folder.') : null,
    h('div.row', { style: { marginTop: '14px', gap: '8px' } }, h('span.grow'), h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: guard(async () => {
      if (!pick) return; const [fit] = fitFor(pick.size, ram);
      if (fit === 'bad' && !(await confirmBox('Download anyway?', `This file needs more memory than this computer has (${ram} GB). It may not load.`, 'Download'))) return;
      if (dest.startsWith('lms:')) { const j = await api('/api/lmstudio/download', { body: { nodeId: dest.slice(4), model: info.url, quantization: pick.quant || undefined, label: `${repo}${pick.quant ? ' · ' + pick.quant : ''}` } }); toast(j.state === 'done' ? j.status : 'LM Studio is downloading — see Models → Downloads'); }
      else if (dest.startsWith('eng:')) { const t = engTargets.find((x) => x.id === dest.slice(4)); if (t && t.engine === false) { toast(`Installing the engine on ${t.name} first…`); await api(`/api/engine/on/${t.id}/install`, { body: {} }); } await api(`/api/engine/on/${dest.slice(4)}/download`, { body: { repo, files: pick.files.map((f) => ({ path: f.path })), mmproj: withProj && proj ? { path: proj.path } : null } }); toast(`Downloading on ${t ? t.name : 'that computer'} — see Models → Downloads`); }
      else { await api('/api/engine/download', { body: { repo, files: pick.files.map((f) => ({ path: f.path })), mmproj: withProj && proj ? { path: proj.path } : null } }); toast('Download started — see Models → Downloads'); }
      close(); route();
    }) }, icon('download', 'sm'), 'Download')));
}
async function lmStudioTab(body) {
  const targets = await api('/api/lmstudio/targets').catch(() => []);
  if (!targets.length) return body.append(note('info', 'LM Studio is not installed on this computer and no LM Studio server has been added. The ForgeAI Engine does the same job without it.'));
  const dest = sel(targets.map((t) => [t.id, t.name]), targets[0].id);
  const id = h('input', { type: 'text', placeholder: 'e.g. qwen/qwen3-8b, openai/gpt-oss-20b, or a huggingface.co link', style: { flex: 1 } });
  const quant = h('input', { type: 'text', placeholder: 'Q4_K_M (Hugging Face links only)', style: { width: '200px' } });
  body.append(h('p.small.muted', { style: { marginTop: 0 } }, 'LM Studio downloads the model itself (from its catalog at lmstudio.ai/models or from Hugging Face) and keeps it in its own folder. Progress shows under Models → Downloads.'),
    field('Download into', dest), h('div.row.nowrap', { style: { gap: '8px' } }, id, quant, h('button.btn.primary', { onclick: guard(async () => { if (!id.value.trim()) throw new Error('Type a model'); const j = await api('/api/lmstudio/download', { body: { nodeId: dest.value, model: id.value.trim(), quantization: quant.value.trim() || undefined } }); toast(j.state === 'done' ? j.status : 'LM Studio is downloading'); route(); }) }, icon('download', 'sm'), 'Download')),
    h('div.small.muted', { style: { marginTop: '8px' } }, 'Tip: in Recommended or Search, choose a file and set “Download into” to LM Studio — ForgeAI passes LM Studio the exact Hugging Face link and quantisation.'));
}
async function haveTab(body) {
  body.append(h('div', null, h('span.spinner'), ' Looking in LM Studio’s and Ollama’s model folders…'));
  const list = await api('/api/engine/existing').catch((e) => { toast(e.message, true); return []; });
  clear(body);
  body.append(h('p.small.muted', { style: { marginTop: 0 } }, 'Models you already downloaded with LM Studio or Ollama. ForgeAI can run them with its own engine without copying them — the files stay where they are and the other app does not need to be open.'));
  if (!list.length) return body.append(h('div.card', null, h('span.muted.small', null, 'None found in ~/.lmstudio/models or ~/.ollama/models.')));
  const checks = list.map((f) => ({ f, cb: h('input', { type: 'checkbox', checked: !f.linked, disabled: f.linked }) }));
  body.append(h('div.list', { style: { boxShadow: 'none', maxHeight: '360px', overflow: 'auto' } }, checks.map(({ f, cb }) => h('label.li', { style: { cursor: f.linked ? 'default' : 'pointer' } }, cb, icon(f.from === 'Ollama' ? 'cube' : 'laptop'), h('div.t', null, h('b', null, f.label), h('span', null, `${f.from} · ${gbs(f.sizeBytes)}${f.mmproj ? ' · with image support' : ''}`)), f.linked ? h('span.badge.ok', null, 'In use') : null))),
    h('div.row', { style: { marginTop: '12px' } }, h('span.grow'), h('button.btn.primary', { onclick: guard(async () => { const items = checks.filter((x) => x.cb.checked && !x.f.linked).map((x) => x.f); if (!items.length) return; const r = await api('/api/engine/link', { body: { items } }); toast(`Added ${r.added.length} model${r.added.length === 1 ? '' : 's'} to the ForgeAI Engine`); route(); }) }, 'Use in ForgeAI Engine')));
}

// ---------------- My models: say plainly what each one is and where it runs
async function myModelsSection(pg) {
  const [list, opts] = await Promise.all([api('/api/profiles').catch(() => []), orgApi('/model-options').catch(() => ({ profiles: [] }))]);
  const info = Object.fromEntries((opts.profiles || []).map((p) => [p.id, p]));
  pg.append(h('div.row.between', { style: { margin: '30px 4px 8px' } },
    h('div', null, h('div.section-title', { style: { margin: 0 } }, 'My models'), h('div.small.muted', null, 'Your own named AIs. Each one is a preset: one model (or Auto), plus its own instructions, tools and limits. They appear in every model menu.')),
    h('div.row', null, h('button.btn.sm', { onclick: () => starterModal() }, icon('sparkles', 'sm'), list.length ? 'Add a set' : 'Create the starter set'), h('button.btn.sm.primary', { onclick: () => profileModal() }, icon('plus', 'sm'), 'New Model'))));
  if (!list.length) { pg.append(h('div.card.empty', null, h('div.big', null, icon('sparkles')), h('h2', null, 'Make your own named AIs'), h('p', null, 'A named AI is just a preset: one model (or Auto) plus its own instructions, tools and limits. The starter set makes six for you — e.g. My AI (everyday), My AI Research (web search), My AI Mail — and each one shows up in every model menu.'), h('button.btn.primary', { onclick: () => starterModal() }, 'Create the starter set'))); return; }
  pg.append(h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null,
    h('thead', null, h('tr', null, ['Name', 'What it does', 'Model it uses', 'Extras', 'Limit', 'On', ''].map((x) => h('th', null, x)))),
    h('tbody', null, list.map((p) => { const x = info[p.id] || {};
      return h('tr', null,
        h('td', null, h('div.row.nowrap', { style: { gap: '10px' } }, profileBadge(p, 30), h('b', null, p.name))),
        h('td.small', { style: { whiteSpace: 'normal', maxWidth: '260px' } }, p.tagline || PURPOSE_NAMES[p.purpose] || '', p.instructions ? h('div.faint', { title: p.instructions }, '“' + p.instructions.slice(0, 90) + (p.instructions.length > 90 ? '…”' : '”')) : null),
        h('td.small', { style: { whiteSpace: 'normal', maxWidth: '240px' } }, x.engineLabel || engineName(p.engine, p.speed)),
        h('td', null, h('div.row', { style: { gap: '4px', flexWrap: 'wrap' } }, p.web ? h('span.chip', null, icon('globe', 'sm'), 'Web') : null, p.tools ? h('span.chip', null, icon('wrench', 'sm'), 'Tools') : null, p.temperature != null ? h('span.chip', null, p.temperature <= 0.3 ? 'Precise' : p.temperature >= 0.8 ? 'Creative' : 'Balanced') : null)),
        h('td.small.muted', null, p.daily_limit ? `${x.used_today || 0} / ${p.daily_limit} today` : 'None'),
        h('td', null, toggle(p.enabled, guard(async (v) => { await api('/api/profiles/' + p.id, { method: 'PUT', body: { enabled: v } }); toast(v ? 'Switched on' : 'Switched off'); }))),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, h('button.btn.sm', { onclick: () => startChat('', 'm:profile:' + p.id) }, icon('chat', 'sm'), 'Chat'), h('button.btn.sm.ghost', { onclick: () => profileModal(p) }, 'Edit')));
    }))))));
}

// ================= Quick Cluster: one click across every ForgeAI computer =================
const clusterSection22 = window.clusterSection;
window.clusterSection = async function (pg) {
  await clusterSection22(pg);
  const btn = [...pg.querySelectorAll('button')].find((b) => /New Cluster/.test(b.textContent));
  if (btn) btn.before(h('button.btn.sm.primary', { style: { marginRight: '8px' }, onclick: () => quickClusterModal() }, icon('bolt', 'sm'), 'Quick Cluster'));
};
async function quickClusterModal() {
  const [eng, c] = await Promise.all([api('/api/engine').catch(() => ({ models: [] })), api('/api/cluster')]);
  const local = c.nodes.find((n) => n.is_local);
  const workers = c.nodes.filter((n) => n.kind === 'worker' && n.enabled && n.status === 'online');
  const choices = [...(eng.models || []).filter((m) => m.caps.chat).map((m) => ({ type: 'path', value: m.file, label: `${m.id} · ForgeAI Engine · ${gbs(m.sizeBytes)}` })),
    ...((local && local.models) || []).filter((m) => m.runtime === 'ollama').map((m) => ({ type: 'ollama', value: m.id, label: `${m.alias || m.id} · Ollama · ${gbs(m.sizeBytes || m.memBytes)}` }))];
  const box = h('div');
  if (!workers.length) { box.append(note('warn', h('span', null, h('b', null, 'Add another computer first. '), 'Install ForgeAI or ForgeAI Server on it, then Computers → Add Computer. A cluster needs at least two computers.'))); return modal('Quick Cluster', box, [{ label: 'Close', primary: true }]); }
  if (!choices.length) { box.append(note('warn', 'Download a model first (Models → Get Models). The model file must be on this computer, which coordinates the cluster.')); return modal('Quick Cluster', box, [{ label: 'Close', primary: true }]); }
  const mSel = sel(choices.map((x, i) => [String(i), x.label]), '0');
  const gpu = sel([['cpu', 'Standard (Mac: GPU · PC: CPU)'], ['cuda', 'NVIDIA (CUDA)'], ['vulkan', 'AMD / Intel (Vulkan)']], 'cpu');
  box.append(h('p.muted', { style: { marginTop: 0 } }, `One model split across this computer and ${workers.length} other${workers.length === 1 ? '' : 's'}: ${workers.map((w) => w.name).join(', ')}. ForgeAI installs llama.cpp on each, measures the links, splits the model by free memory and starts it.`),
    field('Model to split', mSel), field('Build for PCs with a graphics card', gpu, 'Macs always use their GPU.'),
    note('info', 'Use this when a model is too big for one computer. Connect the computers by cable (Thunderbolt or Ethernet) — Wi-Fi makes it slow.'));
  const vis = h('div'); const drawVis = guard(async () => { const pick = choices[+mSel.value]; clear(vis).append(h('div.small.muted', null, h('span.spinner'), ' Checking memory and links…')); const plan = await api('/api/clusters/plan', { body: { coordinator: 'local', measure: true, members: [{ id: 'local' }, ...workers.map((w) => ({ id: w.id }))], model: { type: pick.type, value: pick.value } } }); clear(vis).append(planVisual(plan)); });
  mSel.onchange = drawVis; box.append(vis); drawVis();
  modal('Quick Cluster', box, [{ label: 'Cancel' }, { label: 'Start', primary: true, onClick: async () => {
    const pick = choices[+mSel.value]; const job = await api('/api/clusters/quick', { body: { model: { type: pick.type, value: pick.value }, gpu: gpu.value } });
    quickProgress(job.id); } }], { wide: true });
}
// The plan as a picture: each computer's share, layers and memory; the slowest link; what to expect.
function planVisual(plan) {
  const v = plan.visual; if (!v) return h('div');
  const colors = ['var(--accent)', 'var(--green)', 'var(--orange)', '#a259ff', '#2ab0b0'];
  const bar = h('div', { style: { display: 'flex', height: '18px', borderRadius: '9px', overflow: 'hidden', margin: '8px 0' } }, v.perMachine.map((m, i) => h('div', { title: m.name, style: { width: (m.share * 100) + '%', background: colors[i % colors.length] } })));
  return h('div.planvis', null, h('div.row.between', null, h('b', null, v.model), v.layers ? h('span.small.muted', null, `${v.layers} layers · ${gbs(v.memBytes)}`) : h('span.small.muted', null, v.memBytes ? gbs(v.memBytes) : 'size unknown')), bar,
    h('div.grid.gauto', { style: { gap: '8px' } }, v.perMachine.map((m, i) => h('div.card.flat.small', null, h('div.row', { style: { gap: '6px' } }, h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', background: colors[i % colors.length] } }), h('b', null, m.name)), m.layers ? h('div', null, `Layers ${m.layers[0]}–${m.layers[1]}`) : null, m.gb != null ? h('div', null, `${m.gb} GB${m.fits === false ? ' — more than it has free' : ''}`) : null, h('div.muted', null, `${Math.round(m.share * 100)}% · ${gbs(m.memBytes)} available`)))),
    v.worstLink ? h('div.small', { style: { marginTop: '8px' } }, h('b', null, 'Network: '), `${v.worstLink.a} ↔ ${v.worstLink.b} · ${v.worstLink.mbps >= 1000 ? (v.worstLink.mbps / 1000).toFixed(1) + ' Gbit/s' : v.worstLink.mbps + ' Mbit/s'} · ${v.worstLink.rttMs} ms round trip (measured)`) : null,
    h('div.small', { style: { marginTop: '4px' } }, h('b', null, 'Speed: '), v.estimate.text),
    v.advice ? h('div', { style: { marginTop: '8px' } }, note(v.fitsAlone.length ? 'warn' : 'info', v.advice)) : null);
}
const planVisualLink = (links) => { const w = (links || []).filter((l) => l.mbps).sort((a, b) => a.mbps - b.mbps)[0]; return w ? { a: w.a, b: w.b, mbps: Math.round(w.mbps), rttMs: +(w.rttMs || 0).toFixed(1) } : null; };
function quickProgress(id) {
  const box = h('div'); const close = modal('Quick Cluster — progress', box, [{ label: 'Close', onClick: () => route() }], { wide: true });
  const tick = async () => {
    if (!box.isConnected) return; const j = await api('/api/clusters/quick/' + id).catch(() => null); if (!j) return;
    clear(box).append(h('div.pcard', null, h('div.psteps', null, j.steps.map((s) => h('div.pst.' + (s.state === 'warn' ? 'done' : s.state), null, h('span.pdot', null, s.state === 'run' ? h('span.spinner.sm') : s.state === 'fail' ? icon('x', 'sm') : s.state === 'warn' ? icon('warn', 'sm') : icon('check', 'sm')), h('div.grow', null, s.text))))));
    if (j.state === 'running') setTimeout(tick, 1200);
  };
  tick();
}

// ================= Training: teach a model from your examples (LoRA fine-tuning with MLX) =================
function lossChart(r) {
  const W = 520, H = 150, P = 28; const pts = r.points || []; const val = r.val || [];
  if (!pts.length && !val.length) return h('div.small.muted', null, 'The loss chart appears after the first few steps.');
  const all = [...pts.map((p) => p.loss), ...val.map((v) => v.loss)]; const max = Math.max(...all) * 1.05, min = Math.min(0, Math.min(...all));
  const iters = (r.config && r.config.iters) || Math.max(...pts.map((p) => p.it), 1);
  const X = (it) => P + (it / iters) * (W - P - 8); const Y = (l) => 8 + (1 - (l - min) / (max - min || 1)) * (H - P - 8);
  const line = (arr, k) => arr.map((p, i) => `${i ? 'L' : 'M'}${X(p.it).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Training loss">
    <line x1="${P}" y1="${H - P}" x2="${W - 8}" y2="${H - P}" stroke="var(--sep-strong)"/><line x1="${P}" y1="8" x2="${P}" y2="${H - P}" stroke="var(--sep-strong)"/>
    <text x="${P - 4}" y="14" font-size="10" text-anchor="end" fill="var(--text-sub)">${max.toFixed(1)}</text><text x="${P - 4}" y="${H - P}" font-size="10" text-anchor="end" fill="var(--text-sub)">${min.toFixed(1)}</text>
    <text x="${W - 8}" y="${H - 10}" font-size="10" text-anchor="end" fill="var(--text-sub)">step ${iters}</text>
    ${pts.length ? `<path d="${line(pts, 'loss')}" fill="none" stroke="var(--accent)" stroke-width="2"/>` : ''}
    ${val.length ? `<path d="${line(val, 'loss')}" fill="none" stroke="var(--green)" stroke-width="2" stroke-dasharray="5 4"/>` + val.map((v) => `<circle cx="${X(v.it)}" cy="${Y(v.loss)}" r="3" fill="var(--green)"/>`).join('') : ''}
  </svg>`;
  return h('div', null, h('div', { html: svg }), h('div.mlegend', null, h('span', null, h('i', { style: { display: 'inline-block', width: '14px', height: '3px', background: 'var(--accent)' } }), ' training loss'), h('span', null, h('i', { style: { display: 'inline-block', width: '14px', height: '3px', background: 'var(--green)' } }), ' check on unseen examples (validation)'), h('span', null, 'Lower is better. If the green line rises while blue falls, it is memorising — use fewer steps.')));
}
async function pageTrain(root) {
  const st = await api('/api/train');
  const pg = h('div.page'); root.append(pg);
  pg.append(pageHead('Training', 'Teach a model your style, formats or facts from examples. The result appears in every model menu.'));
  pg.append(h('div.card', null, h('div.md.small', { html: md(`**What training does:** it adjusts a model with your examples (questions and the answers you want) so it answers more like them — your tone, your formats, your facts. It uses *LoRA*: a small add-on is trained, the base model is not changed.

**When not to train:** to let a model look things up in your documents, use **Knowledge** instead — it is faster, and stays up to date.

**Where it runs:** ${st.supported.ok ? st.supported.device + (st.supported.note ? ' — ' + st.supported.note : '') : st.supported.why}`) })));
  if (!st.supported.ok) return;
  if (!st.ready) {
    const status = h('div.small.muted', { style: { marginTop: '8px' } }, st.setup.status || '');
    const btn = h('button.btn.primary', { disabled: st.setup.state === 'running', onclick: guard(async () => { btn.disabled = true; await api('/api/train/setup', { body: {} }); poll(); }) }, icon('download', 'sm'), 'Set Up Training');
    const poll = async () => { const s = await api('/api/train').catch(() => null); if (!s || !status.isConnected) return; status.textContent = s.setup.status || ''; status.style.color = s.setup.state === 'error' ? 'var(--red)' : ''; if (s.ready) return route(); if (s.setup.state === 'running') setTimeout(poll, 1500); else btn.disabled = false; };
    pg.append(h('div.card.setupcard', null, h('b', null, 'One-time setup'), h('p.small.muted', null, 'ForgeAI downloads “uv” from github.com/astral-sh/uv (checksum checked), uses it to set up a private Python just for training, then installs mlx-lm from pypi.org. Nothing else on your computer is changed. Needs internet once, about 1–2 GB of disk.'), btn, status));
    if (st.setup.state === 'running') poll();
    return;
  }
  // New training
  const name = h('input', { type: 'text', placeholder: 'e.g. My AI Mail style' });
  const base = h('input', { type: 'text', placeholder: 'e.g. mlx-community/… (search below) or a folder', style: { flex: 1 } });
  const found = h('div.list', { style: { boxShadow: 'none', marginTop: '6px', maxHeight: '220px', overflow: 'auto' } });
  const bq = h('input', { type: 'search', placeholder: 'Search MLX models on Hugging Face, e.g. Qwen3 4B 4bit', style: { flex: 1 } });
  const searchBase = guard(async () => { clear(found).append(h('div.li', null, h('span.spinner'), ' Searching huggingface.co (mlx-community)…')); const r = await api('/api/train/base-models?q=' + encodeURIComponent(bq.value.trim())); clear(found); if (!r.length) return found.append(h('div.li', null, 'No MLX models found — try a shorter name.')); for (const m of r) found.append(h('div.li.click', { onclick: () => { base.value = m.repo; clear(found).append(h('div.li', null, icon('check', 'sm'), ' Using ', h('a', { href: m.url, target: '_blank' }, m.repo))); } }, icon('cube'), h('div.t', null, h('b', null, m.repo), h('span', null, `${m.downloads.toLocaleString()} downloads${/4bit|3bit/i.test(m.repo) ? ' · small (quantised) — trains fastest' : ''}`)), icon('right', 'sm'))); });
  bq.onkeydown = (e) => { if (e.key === 'Enter') searchBase(); };
  let src = 'write'; const srcBox = h('div');
  const pairs = [{ q: '', a: '' }, { q: '', a: '' }];
  const system = h('textarea', { rows: 2, placeholder: 'Optional: instructions given with every example (e.g. “You are My AI Mail. Write short, warm emails.”)' });
  const jsonl = h('textarea', { rows: 6, class: 'mono', placeholder: '{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}\n{"prompt":"…","completion":"…"}\n{"text":"…"}' });
  let convs = null; const convChecks = new Map();
  const drawSrc = async () => {
    clear(srcBox);
    if (src === 'write') {
      const list = h('div'); const redraw = () => { clear(list).append(...pairs.map((p, i) => h('div.grid.g2', { style: { gap: '8px', marginBottom: '8px' } }, h('textarea', { rows: 2, placeholder: `Question or request ${i + 1}`, value: p.q, oninput: (e) => { p.q = e.target.value; } }), h('textarea', { rows: 2, placeholder: 'The answer you want', value: p.a, oninput: (e) => { p.a = e.target.value; } })))); };
      redraw(); srcBox.append(list, h('button.btn.sm', { onclick: () => { pairs.push({ q: '', a: '' }); redraw(); } }, icon('plus', 'sm'), 'Add Example'), h('span.small.muted', { style: { marginLeft: '8px' } }, 'Aim for 50 or more varied examples; 4 is the minimum.'));
    }
    if (src === 'chats') {
      if (!S.org) return srcBox.append(note('info', 'Choose an organisation first (top left) to use its chats.'));
      convs = convs || await orgApi('/conversations').catch(() => []);
      srcBox.append(h('p.small.muted', { style: { marginTop: 0 } }, `From ${S.org.name}: each of your messages and the answer you kept become one example. Pick chats where the answers were good.`),
        h('div.list', { style: { boxShadow: 'none', maxHeight: '240px', overflow: 'auto' } }, convs.slice(0, 200).map((c) => { const cb = convChecks.get(c.id) || h('input', { type: 'checkbox' }); convChecks.set(c.id, cb); return h('label.li', { style: { cursor: 'pointer' } }, cb, h('div.t', null, h('b', null, c.title), h('span', null, new Date(c.updated_at).toLocaleDateString()))); })));
    }
    if (src === 'file') srcBox.append(h('p.small.muted', { style: { marginTop: 0 } }, 'One example per line, in any of these formats (the same as mlx-lm):'), jsonl, h('input', { type: 'file', accept: '.jsonl,.json,.txt', onchange: async (e) => { const f = e.target.files[0]; if (f) jsonl.value = await f.text(); } }));
  };
  const srcSeg = segControl([['write', 'Write examples'], ['chats', 'From my chats'], ['file', 'Upload a file']], src, (v) => { src = v; drawSrc(); });
  const iters = segControl([['100', 'Quick (100 steps)'], ['300', 'Standard (300)'], ['1000', 'Thorough (1000)']], '300', (v) => { itersV = v; }); let itersV = '300';
  const layers = sel([['4', 'Light (4 layers) — least memory'], ['8', 'Normal (8 layers)'], ['16', 'Deep (16 layers) — more memory']], '8');
  const lr = h('input', { type: 'number', step: '0.000001', value: '0.00001', style: { width: '130px' } });
  const maxSeq = sel([['1024', '1,024 tokens'], ['2048', '2,048 tokens'], ['4096', '4,096 tokens']], '2048');
  pg.append(h('div.section-title', null, 'New training'), h('div.card', null,
    h('div.grid.g2', { style: { gap: '12px' } }, field('Name of the new model', name), field('Base model', h('div', null, h('div.row.nowrap', { style: { gap: '8px' } }, base), h('div.row.nowrap', { style: { gap: '8px', marginTop: '6px' } }, bq, h('button.btn.sm', { onclick: searchBase }, 'Search')), found), 'Start small: a 1–4B “4bit” model trains in minutes on a Mac; 8B+ needs 16 GB or more.')),
    h('div.section-title', null, 'Examples'), h('div', { style: { marginBottom: '10px' } }, srcSeg), srcBox, field('Instructions (optional)', system),
    h('details', null, h('summary.small.muted', { style: { cursor: 'pointer', margin: '6px 0' } }, 'Settings'),
      field('How long to train', iters, 'More steps learn more but take longer and can over-learn small example sets.'), h('div.grid.g3', { style: { gap: '12px' } }, field('Depth', layers), field('Learning rate', lr), field('Longest example', maxSeq))),
    h('div.row', { style: { marginTop: '12px' } }, h('span.grow'), h('button.btn.primary', { onclick: guard(async (e) => {
      const b = { name: name.value.trim() || 'My trained model', baseModel: base.value.trim(), system: system.value.trim() || undefined, iters: +itersV, layers: +layers.value, lr: +lr.value, maxSeq: +maxSeq.value };
      if (src === 'write') b.pairs = pairs; if (src === 'file') b.jsonl = jsonl.value; if (src === 'chats') b.fromChats = { org: S.org && S.org.id, ids: [...convChecks].filter(([, cb]) => cb.checked).map(([id]) => id) };
      const btn = e.currentTarget; btn.disabled = true; try { await api('/api/train/start', { body: b }); toast('Training started'); route(); } finally { btn.disabled = false; }
    }) }, icon('play', 'sm'), 'Start Training'))));
  drawSrc();
  // Runs
  const runsBox = h('div'); pg.append(h('div.section-title', null, 'Trained models'), runsBox);
  const drawRuns = (runs) => {
    clear(runsBox); if (!runs.length) return runsBox.append(h('div.card', null, h('span.muted.small', null, 'Nothing trained yet.')));
    for (const r of runs) {
      const last = (r.points || []).slice(-1)[0];
      runsBox.append(h('div.card', { style: { marginBottom: '12px' } },
        h('div.row', { style: { gap: '10px', alignItems: 'flex-start' } }, h('div.grow', null, h('b', { style: { fontSize: '15px' } }, r.name), h('div.small.muted', null, `${r.baseModel} · ${r.examples} examples (${r.train} to learn from, ${r.valid} to check)${r.skipped ? ` · ${r.skipped} skipped` : ''} · ${r.config.iters} steps · started ${new Date(r.created).toLocaleString()}`)),
          h('span.badge' + (r.state === 'done' ? '.ok' : r.state === 'error' ? '.bad' : r.state === 'running' ? '.warn' : ''), null, r.state === 'running' ? 'Training' : r.state === 'done' ? (r.serving ? 'In use' : 'Ready') : r.state === 'error' ? 'Failed' : 'Stopped')),
        h('div.small', { style: { margin: '8px 0', color: r.state === 'error' ? 'var(--red)' : '' } }, r.status, r.state === 'running' && r.etaMs ? ` · about ${fmtMs(r.etaMs)} left` : '', last ? ` · loss ${last.loss.toFixed(3)}${last.tps ? ` · ${Math.round(last.tps)} tokens/s` : ''}${last.mem ? ` · ${last.mem.toFixed(1)} GB peak memory` : ''}` : ''),
        r.state === 'running' && r.progress != null ? h('div.bar', { style: { marginBottom: '10px' } }, h('i', { style: { width: Math.max(2, r.progress * 100) + '%' } })) : null,
        lossChart(r),
        h('div.row', { style: { gap: '8px', marginTop: '10px' } },
          r.state === 'running' ? h('button.btn.sm', { onclick: guard(async () => { await api(`/api/train/${r.id}/stop`, { body: {} }); route(); }) }, 'Stop') : null,
          r.state === 'done' && !r.serving ? h('button.btn.sm.primary', { onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; clear(b).append(h('span.spinner'), ' Starting…'); await api(`/api/train/${r.id}/serve`, { body: {} }); toast(`${r.name} is in every model menu`); route(); }) }, icon('play', 'sm'), 'Use It') : null,
          r.serving ? h('button.btn.sm', { onclick: () => startChat('', 'm:local:' + 'default_model@' + new URL(r.url).host) }, icon('chat', 'sm'), 'Chat') : null,
          r.serving ? h('button.btn.sm.ghost', { onclick: guard(async () => { await api(`/api/train/${r.id}/unserve`, { body: {} }); route(); }) }, 'Stop Using') : null,
          r.state !== 'running' ? h('button.btn.sm.icon.ghost', { title: 'Delete', onclick: guard(async () => { if (!(await confirmBox('Delete trained model?', `${r.name} and what it learned will be deleted. Your examples in chats are not affected.`, 'Delete', true))) return; await api('/api/train/' + r.id, { method: 'DELETE' }); route(); }) }, icon('trash', 'sm')) : null)));
    }
  };
  drawRuns(st.runs);
  if (st.runs.some((r) => r.state === 'running')) { const poll = async () => { if (!runsBox.isConnected) return; const s = await api('/api/train').catch(() => null); if (!s) return; drawRuns(s.runs); if (s.runs.some((r) => r.state === 'running')) S.pageTimer = setTimeout(poll, 2000); }; S.pageTimer = setTimeout(poll, 2000); }
}

// ================= Running indicator: how many prompts are being answered right now, anywhere =================
(function runningPill() {
  let pill = null;
  const tick = async () => {
    try {
      if (S.me && isPlatform() && document.visibilityState === 'visible') {
        const live = await api('/api/perf/live');
        if (!pill) { pill = h('a.runpill', { href: '#/perf', title: 'Prompts being answered now — open Performance' }); document.body.append(pill); }
        pill.style.display = live.length ? '' : 'none';
        if (live.length) { const r = live[0]; clear(pill).append(h('span.spinner.sm'), h('b', null, `${live.length} running`), h('span', null, ` · ${r.model} · ${r.step || r.phase}${r.pct != null ? ' ' + Math.round(r.pct * 100) + '%' : ''}${live.length > 1 ? ` (+${live.length - 1})` : ''}`)); }
      }
    } catch {}
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2500);
})();
