'use strict';
/* Home, Mail, My models (e.g. My AI), model catalogue, one-click Ollama, limits. */

// ---------------- shared bits
const PROFILE_ICONS = ['sparkles', 'bolt', 'globe', 'target', 'mail', 'code', 'edit', 'chart', 'bulb', 'book', 'shield', 'agent'];
const PROFILE_COLORS = ['#0071e3', '#ff9f0a', '#34c759', '#af52de', '#5ac8fa', '#ff375f', '#5e5ce6', '#ffcc00', '#8e8e93'];
const SPEED_NAMES = { fast: 'Fast', balanced: 'Balanced', best: 'Best quality' };
const PURPOSE_NAMES = { general: 'Everyday', fast: 'Quick answers', research: 'Research', strategy: 'Strategy', mail: 'Email', code: 'Code', writing: 'Writing' };
function profileBadge(p, size = 36) {
  return h('div.pbadge', { style: { width: size + 'px', height: size + 'px', background: `linear-gradient(145deg, ${p.color || '#0071e3'}, color-mix(in srgb, ${p.color || '#0071e3'} 70%, #000))` } }, icon(p.icon || 'sparkles', size < 30 ? 'sm' : ''));
}
function meter(used, max, label) {
  const pct = max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0;
  return h('div', null, h('div.row.between.small', { style: { marginBottom: '5px' } }, h('span.muted', null, label), h('span', null, max > 0 ? `${num(used)} of ${num(max)}` : `${num(used)} · no limit`)),
    h('div.bar' + (pct >= 100 ? '.bad' : pct >= 80 ? '.warn' : ''), null, h('i', { style: { width: (max > 0 ? Math.max(2, pct) : 0) + '%' } })));
}
function segControl(options, value, onchange) {
  const seg = h('div.seg', null, options.map(([k, l]) => h('button' + (k === value ? '.on' : ''), { type: 'button', onclick: (e) => { seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); onchange(k); } }, l)));
  return seg;
}
function startChat(text, pick) { CH.pendingSend = { text, pick }; CH.convId = null; if (pick) { CH.pick = pick; store('pick', pick); } if (location.hash === '#/chat') route(); else location.hash = '#/chat'; }

// ---------------- HOME
async function pageHome(root) {
  const [opts, setup, agents] = await Promise.all([
    orgApi('/model-options').catch(() => ({ local: [], cloud: [], profiles: [] })),
    api('/api/setup-status?org=' + S.org.id).catch(() => null),
    orgApi('/agents').catch(() => []),
  ]);
  const pg = h('div.page.home'); root.append(pg);
  const hour = new Date().getHours(); const first = (S.me.user.displayName || S.me.user.username).split(' ')[0];
  const profiles = opts.profiles || [];
  let pick = store('pick') || opts.defaultPick || (profiles[0] ? 'm:profile:' + profiles[0].id : 'auto');
  if (pick === 'auto' && !store('pick') && profiles[0]) pick = 'm:profile:' + profiles[0].id;
  if (pick.startsWith('m:profile:') && !profiles.some((p) => 'm:profile:' + p.id === pick)) pick = profiles[0] ? 'm:profile:' + profiles[0].id : 'auto';

  const ta = h('textarea', { rows: 3, placeholder: 'Ask anything, or tell me what to do…', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } } });
  const go = () => { const t = ta.value.trim(); if (t) startChat(t, pick); };
  const pills = h('div.pills');
  const drawPills = () => {
    clear(pills);
    for (const p of profiles) pills.append(h('button.pill' + (pick === 'm:profile:' + p.id ? '.on' : ''), { title: p.tagline || '', onclick: () => { pick = 'm:profile:' + p.id; store('pick', pick); drawPills(); ta.focus(); } }, profileBadge(p, 20), p.name));
    pills.append(h('button.pill' + (pick === 'auto' ? '.on' : ''), { onclick: () => { pick = 'auto'; store('pick', pick); drawPills(); } }, icon('wand', 'sm'), 'Auto'));
    if (!profiles.length && isPlatform()) pills.append(h('button.pill.ghost', { onclick: () => starterModal() }, icon('plus', 'sm'), 'Create my own models'));
  };
  drawPills();
  pg.append(h('div.hero', null,
    h('div.orb'), h('h1', null, `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${first}`),
    h('p.muted', null, `Working in ${S.org.name}.`),
    h('div.askbox', null, ta, h('div.askfoot', null, pills, h('button.btn.primary.send', { onclick: go, title: 'Ask' }, icon('up'))))));

  const acts = [
    ['mail', 'Write an email', 'Draft with AI and send from your mailbox', () => composeModal()],
    ['globe', 'Research something', 'Web search with sources', () => { const p = profiles.find((x) => x.purpose === 'research'); ta.value = 'Research '; ta.focus(); if (p) { pick = 'm:profile:' + p.id; drawPills(); } }],
    ['target', 'Plan a strategy', 'Options, risks and next steps', () => { const p = profiles.find((x) => x.purpose === 'strategy'); ta.value = 'Help me decide '; ta.focus(); if (p) { pick = 'm:profile:' + p.id; drawPills(); } }],
    ['doc', 'Make a document', 'Word, PDF, PowerPoint or Excel', () => { ta.value = 'Make a Word document about '; ta.focus(); }],
    ['inbox', 'Check my inbox', 'Read and reply to email', () => { location.hash = '#/mail'; }],
    ['agent', 'Give an agent a job', agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} ready` : 'Create your first agent', () => { location.hash = '#/agents'; }],
  ];
  pg.append(h('div.acts', null, acts.map(([ic, t, s, fn]) => h('button.act', { onclick: fn }, h('span.ic2', null, icon(ic)), h('b', null, t), h('span', null, s)))));

  if (setup && setup.steps.some((x) => !x.done)) {
    const done = setup.steps.filter((x) => x.done).length;
    pg.append(h('div.section-title', null, `Get set up · ${done} of ${setup.steps.length}`), h('div.list', null, setup.steps.map((x) => h('div.li', null,
      h('span.tick' + (x.done ? '.on' : ''), null, x.done ? icon('check', 'sm') : null),
      h('div.t', null, h('b', null, x.title), h('span', null, x.detail)),
      x.done ? null : h('a.btn.sm', { href: x.href }, x.action)))));
  }
  setTimeout(() => ta.focus(), 50);
}

// ---------------- MY MODELS (profiles)
async function myModelsSection(pg) {
  const list = await api('/api/profiles').catch(() => []);
  pg.append(h('div.row.between', { style: { margin: '6px 4px 12px' } },
    h('div', null, h('div.section-title', { style: { margin: 0 } }, 'My models'), h('div.small.muted', null, 'Your own named AIs — each one picks an engine, has its own instructions, and can have a daily limit.')),
    h('div.row', null, h('button.btn.sm', { onclick: () => starterModal() }, icon('sparkles', 'sm'), list.length ? 'Add a set' : 'Create the starter set'), h('button.btn.sm.primary', { onclick: () => profileModal() }, icon('plus', 'sm'), 'New Model'))));
  if (!list.length) {
    pg.append(h('div.card.empty', null, h('div.big', null, icon('sparkles')), h('h2', null, 'Make your own named AIs'),
      h('p', null, 'For example My AI, My AI Fast, My AI Research, My AI Strategy and My AI Mail. They appear in every model menu.'),
      h('button.btn.primary', { onclick: () => starterModal() }, 'Create the starter set')));
    return;
  }
  pg.append(h('div.grid.gauto', null, list.map((p) => h('div.card.pcard' + (p.enabled ? '' : '.off'), null,
    h('div.row', { style: { gap: '12px', alignItems: 'flex-start' } }, profileBadge(p, 42), h('div.grow', null, h('b', { style: { fontSize: '15px' } }, p.name), h('div.small.muted', null, p.tagline || PURPOSE_NAMES[p.purpose])),
      toggle(p.enabled, guard(async (v) => { await api('/api/profiles/' + p.id, { method: 'PUT', body: { enabled: v } }); toast(v ? 'Switched on' : 'Switched off'); }), { title: 'On / off' })),
    h('div.row', { style: { gap: '6px', flexWrap: 'wrap', margin: '14px 0 12px' } },
      h('span.chip', null, icon('cube', 'sm'), engineName(p.engine, p.speed)), p.web ? h('span.chip', null, icon('globe', 'sm'), 'Web') : null, p.tools ? h('span.chip', null, icon('bolt', 'sm'), 'Tools') : null,
      p.daily_limit ? h('span.chip', null, icon('gauge', 'sm'), `${p.daily_limit}/day`) : null),
    h('div.row', { style: { gap: '8px' } }, h('button.btn.sm', { onclick: () => startChat('', 'm:profile:' + p.id) }, icon('chat', 'sm'), 'Chat'), h('button.btn.sm.ghost', { onclick: () => profileModal(p) }, 'Edit'))))));
}
function engineName(e, speed) {
  if (!e || e === 'auto') return `Auto · ${SPEED_NAMES[speed] || 'Balanced'}`;
  if (MODE_NAMES[e]) return MODE_NAMES[e];
  if (e.startsWith('local:')) return e.slice(6) + ' (local)';
  if (e.startsWith('cloud:')) return e.split(':').slice(2).join(':');
  return e;
}
async function starterModal() {
  const prefix = h('input', { type: 'text', value: 'My AI', maxlength: 24 });
  const prev = h('div.small.muted', { style: { marginTop: '10px', lineHeight: 1.8 } });
  const draw = () => { const P = prefix.value.trim() || 'My AI'; clear(prev).append(...[[P, 'everyday'], [P + ' Fast', 'instant short answers'], [P + ' Research', 'web search + sources'], [P + ' Strategy', 'plans & decisions'], [P + ' Mail', 'emails'], [P + ' Code', 'code & apps']].map(([n, d]) => h('div', null, h('b', null, n), ' — ', d))); };
  prefix.oninput = draw; draw();
  modal('Create Your Own Models', h('div', null, field('Name', prefix, 'Used as the start of every model name.'), prev,
    h('div', { style: { marginTop: '14px' } }, note('info', 'Each one automatically uses the best engine you have — a model on your computers or a connected cloud AI — within your organisation’s rules. Change any of them later.'))),
  [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => { const r = await api('/api/profiles/starter', { body: { prefix: prefix.value } }); toast(r.made.length ? `Created ${r.made.length} models` : 'You already have these'); route(); } }]);
}
async function profileModal(p) {
  const isNew = !p;
  p = p || { name: '', tagline: '', color: PROFILE_COLORS[0], icon: 'sparkles', purpose: 'general', engine: 'auto', speed: 'balanced', instructions: '', temperature: null, max_output: 0, web: false, tools: true, daily_limit: 0, org_ids: [], enabled: true };
  const opts = await orgApi('/model-options').catch(() => ({ local: [], cloud: [] }));
  const st = { ...p };
  const name = h('input', { type: 'text', value: p.name, placeholder: 'e.g. My AI Research', maxlength: 40 });
  const tagline = h('input', { type: 'text', value: p.tagline || '', placeholder: 'What it is for (shown under the name)' });
  const badgeBox = h('div');
  const drawBadge = () => clear(badgeBox).append(profileBadge(st, 56));
  const icons = h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } }, PROFILE_ICONS.map((ic) => h('button.btn.sm.icon' + (ic === st.icon ? '.tint' : '.ghost'), { type: 'button', onclick: (e) => { st.icon = ic; icons.querySelectorAll('button').forEach((b) => { b.className = 'btn sm icon ghost'; }); e.currentTarget.className = 'btn sm icon tint'; drawBadge(); } }, icon(ic, 'sm'))));
  const colors = h('div.row', { style: { gap: '8px' } }, PROFILE_COLORS.map((c) => h('button.swatch' + (c === st.color ? '.on' : ''), { type: 'button', style: { background: c }, onclick: (e) => { st.color = c; colors.querySelectorAll('.swatch').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); drawBadge(); } })));
  drawBadge();
  let engineV = p.engine || 'auto';
  const engine = modelPicker({ ...opts, profiles: [], pipelines: [] }, engineV, (v) => { engineV = v; drawSpeed(); }, { raw: true, noProfiles: true, noPipelines: true, modes: ['auto', 'local_fast', 'local_powerful', 'claude', 'openai', 'google'] });
  const speedRow = h('div');
  const speed = segControl([['fast', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best quality']], st.speed, (v) => { st.speed = v; });
  const drawSpeed = () => { speedRow.style.display = engineV === 'auto' ? '' : 'none'; };
  setTimeout(drawSpeed, 0);
  speedRow.append(field('Speed', speed, 'Fast prefers quick local models; Best prefers the most capable model you have connected.'));
  const TEMPLATES = {
    general: 'Answer first, in the first sentence; then the reasoning; then any risks. Be direct and practical.',
    research: 'Search the web before answering anything current. Use several independent sources, prefer primary ones, note dates, and end with a list of sources.',
    strategy: 'Start with a clear recommendation. Give 2–3 options with trade-offs, the key assumption, the strongest counter-argument, and next steps with owners and dates.',
    mail: 'Write short, warm, clear emails: a specific subject, the point in the first two lines, one clear ask.',
    code: 'Write complete working code, run it when possible, and explain briefly how to use it.',
    fast: 'Reply in one to three sentences. No preamble.',
    writing: 'Write in plain, vivid English. Short sentences. No clichés.',
  };
  const instructions = h('textarea', { rows: 6, value: p.instructions || '', placeholder: 'How this model should behave — tone, format, what to always or never do.' });
  const purpose = sel(Object.entries(PURPOSE_NAMES), p.purpose, { onchange: (e) => { if (!instructions.value.trim()) instructions.value = TEMPLATES[e.target.value] || ''; } });
  let web = !!p.web, tools = p.tools !== false;
  const tempOn = h('input', { type: 'checkbox', checked: p.temperature != null });
  const temp = h('input', { type: 'range', min: 0, max: 1, step: 0.1, value: p.temperature != null ? p.temperature : 0.7, disabled: p.temperature == null });
  const tempLbl = h('span.small.muted', null); const drawTemp = () => { tempLbl.textContent = tempOn.checked ? (+temp.value <= 0.3 ? 'Precise' : +temp.value >= 0.8 ? 'Creative' : 'Balanced') + ` (${temp.value})` : 'Engine default'; temp.disabled = !tempOn.checked; };
  tempOn.onchange = drawTemp; temp.oninput = drawTemp; drawTemp();
  const maxOut = sel([['0', 'Engine default'], ['800', 'Short'], ['2000', 'Medium'], ['8000', 'Long'], ['16000', 'Very long']], String(p.max_output || 0));
  const daily = h('input', { type: 'number', min: 0, value: p.daily_limit || 0, style: { width: '120px' } });
  const orgChecks = h('div', null, S.orgs.map((o) => h('label.check', null, h('input', { type: 'checkbox', value: o.id, checked: !(p.org_ids || []).length || p.org_ids.includes(o.id) }), o.name)));
  const body = h('div', null,
    h('div.row', { style: { gap: '16px', alignItems: 'flex-start' } }, badgeBox, h('div.grow', null, h('div.grid.g2', { style: { gap: '12px' } }, field('Name', name), field('Good for', purpose)), field('Description', tagline))),
    h('div.grid.g2', { style: { gap: '12px' } }, field('Icon', icons), field('Colour', colors)),
    h('div.section-title', null, 'Engine'),
    field('Runs on', engine, 'Auto keeps working whatever you connect later. Or pin it to one exact model.'), speedRow,
    h('div.section-title', null, 'Behaviour'),
    field('Instructions', instructions),
    h('div.list', { style: { boxShadow: 'none' } },
      h('div.li', null, h('div.t', null, h('b', null, 'Search the web'), h('span', null, 'Looks things up and cites sources (needs a cloud AI or a search key).')), toggle(web, (v) => { web = v; })),
      h('div.li', null, h('div.t', null, h('b', null, 'Use tools'), h('span', null, 'Files, documents, code, email, charts and agents. Off = fastest plain answers.')), toggle(tools, (v) => { tools = v; })),
      h('div.li', null, h('div.t', null, h('b', null, 'Creativity'), tempLbl), h('div.row', null, tempOn, temp)),
      h('div.li', null, h('div.t', null, h('b', null, 'Answer length')), h('div.ctl', null, maxOut))),
    h('div.section-title', null, 'Limits & access'),
    h('div.list', { style: { boxShadow: 'none' } },
      h('div.li', null, h('div.t', null, h('b', null, 'Requests per day'), h('span', null, '0 = no limit. Counted per organisation; resets at midnight.')), daily)),
    field('Available in', orgChecks));
  modal(isNew ? 'New Model' : p.name, body, [
    !isNew ? { label: 'Delete', danger: true, onClick: async () => { if (!(await confirmBox('Delete Model?', `Delete ${p.name}? Chats that used it keep their history.`, 'Delete', true))) return false; await api('/api/profiles/' + p.id, { method: 'DELETE' }); route(); } } : null,
    { label: 'Cancel', onClick: () => {} },
    { label: isNew ? 'Create' : 'Save', primary: true, onClick: async () => {
      const ids = [...orgChecks.querySelectorAll('input:checked')].map((i) => i.value);
      const b = { name: name.value, tagline: tagline.value, color: st.color, icon: st.icon, purpose: purpose.value, engine: engineV, speed: st.speed, instructions: instructions.value, temperature: tempOn.checked ? +temp.value : null, max_output: +maxOut.value, web, tools, daily_limit: +daily.value, org_ids: ids.length === S.orgs.length ? [] : ids };
      if (isNew) await api('/api/profiles', { body: b }); else await api('/api/profiles/' + p.id, { method: 'PUT', body: b });
      toast('Saved'); route();
    } }].filter(Boolean), { wide: true });
}

// ---------------- CATALOGUE & OLLAMA
// Sizes are approximate download sizes (Q4). "ram" = memory the computer should have for it to run comfortably.
const CATALOG = [
  { id: 'llama3.2:3b', name: 'Llama 3.2 3B', by: 'Meta', cats: ['fast'], size: 2.0, ram: 8, desc: 'Tiny and very quick. Great for short answers on any Mac.' },
  { id: 'qwen3:4b', name: 'Qwen 3 4B', by: 'Alibaba', cats: ['fast', 'general'], size: 2.6, ram: 8, desc: 'Fast, surprisingly smart, uses tools.' },
  { id: 'gemma3:4b', name: 'Gemma 3 4B', by: 'Google', cats: ['fast', 'vision'], size: 3.3, ram: 8, desc: 'Quick, and can look at images.' },
  { id: 'qwen3:8b', name: 'Qwen 3 8B', by: 'Alibaba', cats: ['general', 'mail', 'fast'], size: 5.2, ram: 16, desc: 'Best all-rounder for 16 GB. Good at email and tools.' },
  { id: 'llama3.1:8b', name: 'Llama 3.1 8B', by: 'Meta', cats: ['general', 'mail'], size: 4.9, ram: 16, desc: 'Reliable general model, natural writing.' },
  { id: 'deepseek-r1:8b', name: 'DeepSeek R1 8B', by: 'DeepSeek', cats: ['reasoning', 'strategy'], size: 5.2, ram: 16, desc: 'Thinks step by step before answering.' },
  { id: 'gemma3:12b', name: 'Gemma 3 12B', by: 'Google', cats: ['general', 'mail', 'vision', 'writing'], size: 8.1, ram: 16, desc: 'Excellent writing; reads images.' },
  { id: 'qwen3:14b', name: 'Qwen 3 14B', by: 'Alibaba', cats: ['general', 'strategy', 'research'], size: 9.3, ram: 24, desc: 'Powerful, strong with tools and agents.' },
  { id: 'phi4:14b', name: 'Phi-4 14B', by: 'Microsoft', cats: ['reasoning', 'strategy'], size: 9.1, ram: 24, desc: 'Strong at maths and logic.' },
  { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', by: 'DeepSeek', cats: ['reasoning', 'strategy'], size: 9.0, ram: 24, desc: 'Deeper step-by-step reasoning.' },
  { id: 'qwen2.5-coder:14b', name: 'Qwen 2.5 Coder 14B', by: 'Alibaba', cats: ['code'], size: 9.0, ram: 24, desc: 'Writes and fixes code.' },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', by: 'OpenAI', cats: ['general', 'reasoning', 'strategy', 'research'], size: 14, ram: 24, desc: 'OpenAI’s open model. Reasoning and tools.' },
  { id: 'mistral-small3.2:24b', name: 'Mistral Small 3.2', by: 'Mistral', cats: ['general', 'mail', 'writing', 'vision'], size: 15, ram: 32, desc: 'Polished writing, follows instructions well.' },
  { id: 'gemma3:27b', name: 'Gemma 3 27B', by: 'Google', cats: ['general', 'writing', 'vision'], size: 17, ram: 32, desc: 'Google’s largest open model. Great writer.' },
  { id: 'qwen3:30b', name: 'Qwen 3 30B-A3B', by: 'Alibaba', cats: ['fast', 'general', 'research'], size: 19, ram: 32, desc: 'Big-model quality at small-model speed.' },
  { id: 'qwen3-coder:30b', name: 'Qwen 3 Coder 30B', by: 'Alibaba', cats: ['code'], size: 19, ram: 32, desc: 'Fast, strong coding agent model.' },
  { id: 'qwen3:32b', name: 'Qwen 3 32B', by: 'Alibaba', cats: ['strategy', 'research', 'general'], size: 20, ram: 48, desc: 'Very capable. Needs a 48–64 GB Mac.' },
  { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B', by: 'DeepSeek', cats: ['reasoning', 'strategy'], size: 20, ram: 48, desc: 'Top local reasoning for big Macs.' },
  { id: 'llama3.3:70b', name: 'Llama 3.3 70B', by: 'Meta', cats: ['general', 'strategy', 'writing'], size: 43, ram: 64, desc: 'Near top-tier quality. 64 GB+ only.' },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', by: 'OpenAI', cats: ['reasoning', 'strategy', 'research'], size: 65, ram: 96, desc: 'Largest open OpenAI model. 96 GB+ only.' },
];
const CAT_NAMES = [['all', 'All'], ['fast', 'Fast'], ['general', 'Everyday'], ['research', 'Research'], ['strategy', 'Strategy'], ['mail', 'Email'], ['writing', 'Writing'], ['code', 'Code'], ['reasoning', 'Reasoning'], ['vision', 'Sees images']];

function fitOf(m, ram) {
  if (!ram) return ['', ''];
  if (ram >= m.ram) return ['ok', 'Runs well'];
  if (ram >= m.size + 2.5) return ['warn', 'Tight — may be slow'];
  return ['bad', 'Too big for this computer'];
}
function catalogModal(c, nodeId) {
  let nodeSel; try { nodeSel = nodePicker(c, nodeId); } catch (e) { return ollamaModal(); }
  let cat = 'all';
  const have = new Set(); c.nodes.forEach((n) => (n.models || []).forEach((m) => have.add(m.id)));
  const grid = h('div.catgrid');
  const nodeRam = () => { const n = c.nodes.find((x) => x.id === nodeSel.value); return (n && n.ram_gb) || 0; };
  const draw = () => {
    clear(grid); const ram = nodeRam();
    const list = CATALOG.filter((m) => cat === 'all' || m.cats.includes(cat)).sort((a, b) => { const fa = fitOf(a, ram)[0] === 'bad', fb = fitOf(b, ram)[0] === 'bad'; return fa - fb || a.size - b.size; });
    for (const m of list) {
      const [fit, fitTxt] = fitOf(m, ram); const got = have.has(m.id);
      grid.append(h('div.catcard' + (fit === 'bad' ? '.dim' : ''), null,
        h('div.row.between', null, h('b', null, m.name), h('span.small.faint', null, m.by)),
        h('div.small.muted', { style: { margin: '4px 0 8px', minHeight: '34px' } }, m.desc),
        h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } }, h('span.chip', null, `${m.size} GB`), fitTxt ? h('span.badge.' + fit, null, fitTxt) : null),
        h('div.row', { style: { marginTop: '10px' } }, got ? h('span.badge.ok', null, icon('check', 'sm'), 'Downloaded') : h('button.btn.sm' + (fit === 'bad' ? '' : '.primary'), { onclick: guard(async (e) => {
          if (fit === 'bad' && !(await confirmBox('Download Anyway?', `${m.name} needs about ${m.ram} GB of memory; this computer has ${ram} GB. It may not run.`, 'Download'))) return;
          e.currentTarget.disabled = true;
          await api(`/api/nodes/${nodeSel.value}/pull`, { body: { model: m.id, displayName: m.name } });
          toast(`Downloading ${m.name}`); have.add(m.id); draw();
        }) }, icon('download', 'sm'), 'Download'))));
    }
  };
  nodeSel.onchange = draw;
  const custom = h('input', { type: 'text', placeholder: 'Any model, e.g. mistral-nemo or hf.co/user/repo', autocomplete: 'off' });
  const customName = h('input', { type: 'text', placeholder: 'Name it (optional)' });
  const body = h('div', null,
    h('div.row.between', { style: { marginBottom: '12px', gap: '12px', flexWrap: 'wrap' } }, h('div.row', null, h('span.small.muted', null, 'Download to'), nodeSel), h('span.small.muted', null, 'Sizes are approximate.')),
    h('div', { style: { overflowX: 'auto', marginBottom: '14px' } }, segControl(CAT_NAMES, cat, (v) => { cat = v; draw(); })),
    grid,
    h('details', { style: { marginTop: '16px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Download any other model'),
      h('div.row', { style: { marginTop: '10px', gap: '8px' } }, custom, customName, h('button.btn', { onclick: guard(async () => { if (!custom.value.trim()) throw new Error('Type a model name'); await api(`/api/nodes/${nodeSel.value}/pull`, { body: { model: custom.value.trim(), displayName: customName.value } }); toast('Download started'); custom.value = ''; }) }, 'Download')),
      h('div.help', null, 'Anything from ', h('a', { href: 'https://ollama.com/search', target: '_blank' }, 'ollama.com/search'), ' or Hugging Face GGUF models.')));
  draw();
  modal('Get More Models', body, [{ label: 'Done', primary: true, onClick: () => route() }], { wide: true });
}
async function ollamaCard(pg) {
  const st = await api('/api/runtime/ollama').catch(() => null);
  if (!st || !['darwin', 'win32'].includes(st.os)) {
    pg.append(h('div', { style: { marginBottom: '18px' } }, note('warn', h('b', null, 'No model engine on this computer yet. '), 'Install ', h('a', { href: 'https://ollama.com/download', target: '_blank' }, 'Ollama'), ' (free), open it once, then click Refresh.')));
    return;
  }
  const status = h('div.small.muted'); const barI = h('i', { style: { width: '0%' } }); const bar = h('div.bar', { style: { margin: '10px 0 6px', display: 'none' } }, barI);
  const btn = h('button.btn.primary', { onclick: guard(async () => { btn.disabled = true; await api('/api/runtime/ollama', { body: {} }); poll(); }) }, icon('download', 'sm'), st.installed ? 'Start Ollama' : 'Install Ollama');
  const poll = async () => {
    const j = await api('/api/runtime/ollama').catch(() => null); if (!j || !document.body.contains(status)) return;
    status.textContent = j.status || ''; bar.style.display = j.state === 'running' && j.total ? '' : 'none'; if (j.total) barI.style.width = Math.round(j.completed / j.total * 100) + '%';
    if (j.state === 'running') setTimeout(poll, 1000); else if (j.state === 'done') { toast('Ollama is ready'); route(); } else if (j.state === 'error') { btn.disabled = false; status.style.color = 'var(--red)'; }
  };
  pg.append(h('div.card.setupcard', null, h('div.row', { style: { gap: '16px', alignItems: 'flex-start' } }, h('div.pbadge', { style: { width: '48px', height: '48px', background: 'linear-gradient(145deg,#1d1d1f,#48484a)' } }, icon('cube')),
    h('div.grow', null, h('b', { style: { fontSize: '16px' } }, 'Run AI privately on this computer'),
      h('div.muted', { style: { margin: '4px 0 12px' } }, `ForgeAI uses Ollama — free and made for ${st.os === 'darwin' ? 'Mac (macOS 14 or later)' : 'Windows 10 or later'} — to run models on your own computer. ${st.installed ? 'It is installed but not running.' : 'One click downloads it from ollama.com and installs it.'}`),
      h('div.row', null, btn, h('button.btn', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await api('/api/cluster/refresh', { body: {} }); route(); }) }, icon('refresh', 'sm'), 'Check Again')), bar, status))));
  if (st.state === 'running') { btn.disabled = true; poll(); }
}
function ollamaModal() { const box = h('div'); modal('Install a Model Engine', box, [{ label: 'Close', onClick: () => route() }]); ollamaCard(box); }

// ---------------- MAIL
const MAIL = { mb: null, folder: 'INBOX', q: '' };
async function pageMail(root, mbId, uidArg) {
  const boxes = await orgApi('/mailboxes').catch(() => []);
  const pg = h('div.mail'); root.append(pg);
  if (!boxes.length) {
    const p = h('div.page'); pg.replaceWith(p);
    p.append(pageHead('Mail', 'Read, write and send email — with AI to help.'), emptyState('mail', 'Connect a mailbox', 'Just your email address and password. ForgeAI finds the right server settings for 1st Domains, Gmail, iCloud, Yahoo and most hosts.', canOrg('manage') ? h('button.btn.primary', { onclick: () => mailboxWizard() }, icon('plus', 'sm'), 'Connect Mailbox') : null));
    return;
  }
  MAIL.mb = boxes.find((b) => b.id === mbId) || boxes.find((b) => b.id === MAIL.mb) || boxes[0]; MAIL.mb = MAIL.mb.id;
  const mb = boxes.find((b) => b.id === MAIL.mb);
  const listEl = h('div.maillist'); const view = h('div.mailview');
  const search = h('input', { type: 'search', placeholder: 'Search mail', value: MAIL.q, oninput: debounce((e) => { MAIL.q = e.target.value; loadList(); }, 400) });
  const mbSel = sel(boxes.map((b) => [b.id, b.email]), mb.id, { onchange: (e) => { location.hash = '#/mail/' + e.target.value; } });
  const folderSel = h('select', { style: { flex: '1', minWidth: '0' }, onchange: (e) => { MAIL.folder = e.target.value; loadList(); } }, h('option', { value: 'INBOX' }, 'Inbox'));
  pg.append(h('div.mailside', null,
    h('div.top', null, h('button.btn.primary', { onclick: () => composeModal({ mailbox: mb.id }) }, icon('edit', 'sm'), 'Write'), mbSel, h('div.row.nowrap', { style: { gap: '6px' } }, folderSel, h('button.btn.sm.icon.ghost', { title: 'Refresh', onclick: () => loadList() }, icon('refresh', 'sm'))), search),
    mb.status !== 'connected' ? h('div', { style: { padding: '0 10px 10px' } }, note('warn', h('div', null, mb.status_detail || 'Not connected', ' ', canOrg('manage') ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); mailboxWizard(mb); } }, 'Fix settings') : null))) : null,
    listEl), view);
  view.append(h('div.mailempty', null, icon('inbox'), h('div', null, 'Select an email')));
  mail_folders();
  async function mail_folders() {
    const fs = await orgApi(`/mailboxes/${mb.id}/folders`).catch(() => []);
    const nice = { '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Trash': 'Trash', '\\Junk': 'Junk', '\\Archive': 'Archive' };
    clear(folderSel).append(h('option', { value: 'INBOX' }, 'Inbox'), ...fs.filter((f) => f.path.toUpperCase() !== 'INBOX').map((f) => h('option', { value: f.path, selected: f.path === MAIL.folder }, nice[f.special] || f.name || f.path)));
    if (![...folderSel.options].some((o) => o.value === MAIL.folder)) MAIL.folder = 'INBOX';
    folderSel.value = MAIL.folder;
  }
  async function loadList() {
    clear(listEl).append(h('div.faint.small', { style: { padding: '16px' } }, h('span.spinner'), ' Loading…'));
    try {
      const rows = await orgApi(`/mailboxes/${mb.id}/messages?folder=${encodeURIComponent(MAIL.folder)}&q=${encodeURIComponent(MAIL.q)}&limit=60`);
      clear(listEl);
      if (!rows.length) listEl.append(h('div.faint.small', { style: { padding: '16px' } }, MAIL.q ? 'No matches' : 'No email here'));
      for (const r of rows) listEl.append(h('a.mitem' + (r.unread ? '.unread' : ''), { href: '#', onclick: (e) => { e.preventDefault(); listEl.querySelectorAll('.mitem').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); e.currentTarget.classList.remove('unread'); openMsg(r.uid); pg.classList.add('reading'); } },
        h('div.row.between', null, h('b', null, (MAIL.folder.match(/sent/i) ? 'To: ' + r.to : r.fromName) || r.fromAddress), h('span.small.faint', null, shortDate(r.date))), h('div.subj', null, r.subject)));
    } catch (e) { clear(listEl).append(h('div', { style: { padding: '12px' } }, note('warn', e.message))); }
  }
  async function openMsg(uid) {
    clear(view).append(h('div.mailempty', null, h('span.spinner')));
    try {
      const m = await orgApi(`/mailboxes/${mb.id}/messages/${uid}?folder=${encodeURIComponent(MAIL.folder)}`);
      const bodyEl = h('div.mailbody');
      const showText = () => clear(bodyEl).append(h('div.mailtext', null, m.text || '(no text)'));
      const showHtml = () => clear(bodyEl).append(h('iframe.mailframe', { sandbox: '', srcdoc: `<base target="_blank"><meta name="referrer" content="no-referrer"><style>body{font:14px -apple-system,system-ui,sans-serif;margin:0;color:#1d1d1f;word-wrap:break-word}img{max-width:100%;height:auto}</style>${m.html}` }));
      if (m.html) showHtml(); else showText();
      const move = (to) => guard(async () => { await orgApi(`/mailboxes/${mb.id}/messages/${uid}/move?folder=${encodeURIComponent(MAIL.folder)}`, { body: { to } }); toast(to === 'trash' ? 'Moved to Trash' : 'Archived'); clear(view); loadList(); });
      const quote = `\n\nOn ${new Date(m.date).toLocaleString()}, ${m.from} wrote:\n${String(m.text || '').split('\n').map((l) => '> ' + l).join('\n').slice(0, 20000)}`;
      const reply = (all) => composeModal({ mailbox: mb.id, to: all ? [m.fromAddress || m.from, m.cc].filter(Boolean).join(', ') : (m.fromAddress || m.from), subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), text: '', quote, inReplyTo: m.messageId, references: m.references || m.messageId, original: { from: m.from, subject: m.subject, text: m.text } });
      clear(view).append(
        h('div.mailhead', null,
          h('button.btn.sm.icon.ghost.mobile-only', { onclick: () => pg.classList.remove('reading') }, icon('down', 'sm')),
          h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
            h('button.btn.sm.primary', { onclick: () => reply(false) }, icon('reply', 'sm'), 'Reply'), h('button.btn.sm', { onclick: () => reply(true) }, 'Reply All'),
            h('button.btn.sm', { onclick: () => composeModal({ mailbox: mb.id, subject: 'Fwd: ' + (m.subject || ''), text: `\n\n---------- Forwarded message ----------\nFrom: ${m.from}\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to}\n\n${m.text || ''}` }) }, 'Forward'),
            h('button.btn.sm.tint', { onclick: () => composeModal({ mailbox: mb.id, to: m.fromAddress || m.from, subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), quote, inReplyTo: m.messageId, references: m.references || m.messageId, original: { from: m.from, subject: m.subject, text: m.text }, autoDraft: true }) }, icon('sparkles', 'sm'), 'AI Reply'),
            h('span.grow'), h('button.btn.sm.icon.ghost', { title: 'Archive', onclick: move('archive') }, icon('inbox', 'sm')), h('button.btn.sm.icon.ghost', { title: 'Delete', onclick: move('trash') }, icon('trash', 'sm')))),
        h('div.mailmeta', null, h('h2', null, m.subject || '(no subject)'), h('div.small', null, h('b', null, m.from)), h('div.small.muted', null, `To ${m.to || ''}${m.cc ? ' · Cc ' + m.cc : ''} · ${new Date(m.date).toLocaleString()}`),
          m.attachments.length ? h('div.row', { style: { gap: '6px', marginTop: '8px', flexWrap: 'wrap' } }, m.attachments.map((a) => h('span.chip', null, icon('clip', 'sm'), a.filename || 'attachment', h('span.faint', null, bytes(a.size))))) : null,
          m.html ? h('div.row', { style: { marginTop: '8px' } }, segControl([['html', 'Formatted'], ['text', 'Plain text']], 'html', (v) => (v === 'html' ? showHtml() : showText()))) : null),
        bodyEl);
    } catch (e) { clear(view).append(h('div', { style: { padding: '20px' } }, note('warn', e.message))); }
  }
  loadList();
  if (uidArg) openMsg(+uidArg);
}
const shortDate = (d) => { const x = new Date(d); const n = new Date(); return x.toDateString() === n.toDateString() ? x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : x.toLocaleDateString([], { day: 'numeric', month: 'short' }); };

async function composeModal(o = {}) {
  const boxes = await orgApi('/mailboxes').catch(() => []);
  if (!boxes.length) { if (canOrg('manage')) return mailboxWizard(); return toast('No mailbox connected yet', true); }
  const opts = await orgApi('/model-options').catch(() => ({ profiles: [] }));
  const from = sel(boxes.map((b) => [b.id, b.name ? `${b.name} <${b.email}>` : b.email]), o.mailbox || boxes[0].id);
  const to = h('input', { type: 'text', value: o.to || '', placeholder: 'name@example.com, another@example.com' });
  const cc = h('input', { type: 'text', value: o.cc || '', placeholder: 'Cc (optional)' });
  const subject = h('input', { type: 'text', value: o.subject || '', placeholder: 'Subject' });
  const text = h('textarea.mailcompose', { rows: 12, value: o.text || '', placeholder: 'Write your email — or ask the AI below to write it.' });
  let atts = [];
  const attRow = h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } });
  const drawAtts = () => clear(attRow).append(...atts.map((a) => h('span.chip', null, icon('clip', 'sm'), a.name, h('button', { onclick: () => { atts = atts.filter((x) => x !== a); drawAtts(); } }, icon('x', 'sm')))));
  const fileIn = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: async (e) => { for (const f of e.target.files) { if (f.size > 15 * 2 ** 20) { toast(f.name + ' is over 15 MB', true); continue; } atts.push({ name: f.name, data: await readFileB64(f) }); } e.target.value = ''; drawAtts(); } });
  const mailProfiles = (opts.profiles || []);
  const aiModel = sel([['', 'Auto (your Mail model if you have one)'], ...mailProfiles.map((p) => ['profile:' + p.id, p.name])], (mailProfiles.find((p) => p.purpose === 'mail') ? 'profile:' + mailProfiles.find((p) => p.purpose === 'mail').id : ''));
  const tone = sel([['friendly', 'Friendly'], ['professional', 'Professional'], ['brief', 'Very brief'], ['firm', 'Firm'], ['apologetic', 'Apologetic'], ['enthusiastic', 'Enthusiastic']], 'friendly');
  const ask = h('input', { type: 'text', placeholder: o.original ? 'e.g. say yes and suggest Tuesday 2pm' : 'e.g. tell the team the office is closed Friday', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); draftBtn.click(); } } });
  const draftBtn = h('button.btn.tint', { onclick: guard(async (e) => {
    const b = e.currentTarget; b.disabled = true; const old = b.innerHTML; clear(b).append(h('span.spinner'), ' Writing…');
    try {
      const r = await orgApi('/mail/draft', { body: { model: aiModel.value || undefined, instruction: `${ask.value || (o.original ? 'Write a helpful reply.' : 'Improve this email.')} Tone: ${tone.value}.${to.value ? ' Recipient: ' + to.value + '.' : ''}`, original: o.original, current: text.value.trim() && !o.autoDraft ? { subject: subject.value, text: text.value } : undefined } });
      if (r.subject && (!subject.value || !o.original)) subject.value = r.subject; text.value = r.text; o.autoDraft = false; toast('Draft ready — check it, then Send');
    } finally { b.disabled = false; b.innerHTML = old; }
  }) }, icon('sparkles', 'sm'), 'Write with AI');
  const body = h('div.composeform', null,
    h('div.grid.g2', { style: { gap: '10px' } }, field('From', from), field('To', to)),
    h('div.grid.g2', { style: { gap: '10px' } }, field('Cc', cc), field('Subject', subject)),
    h('div.aibar', null, icon('sparkles', 'sm'), ask, tone, aiModel, draftBtn),
    text, o.quote ? h('div.small.faint', { style: { marginTop: '6px' } }, 'The original email is quoted below your reply when sent.') : null,
    h('div.row', { style: { marginTop: '8px', gap: '8px' } }, h('button.btn.sm.ghost', { onclick: () => fileIn.click() }, icon('clip', 'sm'), 'Attach'), fileIn, attRow));
  modal(o.original ? 'Reply' : 'New Email', body, [{ label: 'Cancel', onClick: () => {} }, { label: 'Send', primary: true, onClick: async () => {
    if (!to.value.trim()) throw new Error('Add a recipient');
    if (!text.value.trim() && !(await confirmBox('Send Empty Email?', 'The message has no text.', 'Send'))) return false;
    const r = await orgApi(`/mailboxes/${from.value}/send`, { body: { to: to.value, cc: cc.value || undefined, subject: subject.value, text: text.value + (o.quote || ''), inReplyTo: o.inReplyTo, references: o.references, attachments: atts } });
    toast(`Sent to ${(r.accepted || []).join(', ') || to.value}${r.savedToSent ? '' : ' (not copied to Sent)'}`);
  } }], { wide: true });
  if (o.autoDraft) setTimeout(() => draftBtn.click(), 50); else setTimeout(() => (o.to ? text : to).focus(), 60);
}

// Connect a mailbox: address + password → ForgeAI finds the servers.
async function mailboxWizard(m) {
  const presets = await api('/api/mail-presets');
  if (m) return mailboxSettings(m, presets);
  const email = h('input', { type: 'email', placeholder: 'you@yourcompany.co.nz', autocomplete: 'off' });
  const name = h('input', { type: 'text', placeholder: 'e.g. Your name (shown to recipients)' });
  const pass = h('input', { type: 'password', placeholder: 'Mailbox password or app password', autocomplete: 'new-password' });
  const hint = h('div.help');
  const drawHint = () => {
    const d = (email.value.split('@')[1] || '').toLowerCase();
    clear(hint);
    if (/gmail|googlemail/.test(d)) hint.append(h('b', null, 'Gmail: '), 'use an App Password, not your normal password. ', h('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank' }, 'Create one'), ' (needs 2-Step Verification on).');
    else if (/outlook|hotmail|live\.|msn\./.test(d)) hint.append(h('b', null, 'Outlook.com / Hotmail: '), 'Microsoft is switching off passwords for other apps. It may not connect; a 1st Domains, Gmail or iCloud mailbox works reliably.');
    else if (/icloud|me\.com|mac\.com/.test(d)) hint.append(h('b', null, 'iCloud: '), 'use an app-specific password from ', h('a', { href: 'https://account.apple.com', target: '_blank' }, 'account.apple.com'), '.');
    else if (/yahoo|ymail/.test(d)) hint.append(h('b', null, 'Yahoo: '), 'use an app password (Account security → Generate app password).');
    else hint.append('Your normal mailbox password. For 1st Domains it is the password set in your 1st Domains control panel.');
  };
  email.oninput = drawHint; drawHint();
  const result = h('div');
  let found = null;
  const body = h('div', null, h('div.grid.g2', { style: { gap: '12px' } }, field('Email address', email), field('Your name', name)), field('Password', pass, hint), result,
    h('details', { style: { marginTop: '10px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Enter server settings myself'), h('div', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: () => { closeW(); mailboxSettings({ email: email.value, name: name.value }, presets, pass.value); } }, 'Manual Setup'))));
  const sideLine = (label, r) => h('div.li', null, h('span.tick' + (r.ok ? '.on' : '.bad'), null, icon(r.ok ? 'check' : 'x', 'sm')), h('div.t', null, h('b', null, label + (r.ok ? ' works' : ' failed')), h('span', null, r.host ? `${r.host} · port ${r.port}` : ''), r.ok ? null : h('span', { style: { color: 'var(--red)', whiteSpace: 'normal' } }, r.message)));
  const save = async (extra = {}) => {
    const b = { email: email.value.trim(), name: name.value, password: pass.value, imap_host: found.imap.host, imap_port: found.imap.port, smtp_host: found.smtp.host, smtp_port: found.smtp.port, ...extra };
    const r = await orgApi('/mailboxes', { body: b });
    toast(r.status === 'connected' ? `${r.email} connected` : `Saved — ${r.status_detail}`, r.status !== 'connected');
    closeW(); if (location.hash.startsWith('#/mail')) route(); else route();
  };
  const closeW = modal('Connect Mailbox', body, [{ label: 'Cancel', onClick: () => {} }, { label: 'Connect', primary: true, onClick: async (close) => {
    if (found && found.imap.ok && found.smtp.ok) { await save(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) throw new Error('Enter your email address');
    if (!pass.value) throw new Error('Enter the password');
    clear(result).append(h('div.card.flat', { style: { marginTop: '12px' } }, h('span.spinner'), ' Finding your mail server and signing in… this can take up to a minute.'));
    found = await orgApi('/mailboxes/detect', { body: { email: email.value.trim(), password: pass.value } });
    const bothOk = found.imap.ok && found.smtp.ok;
    const certSide = [found.imap, found.smtp].find((x) => x.code === 'cert_name' && x.cert && x.cert.fingerprint);
    clear(result).append(h('div', { style: { marginTop: '14px' } },
      h('div.small.muted', { style: { marginBottom: '6px' } }, `Provider: ${found.providerLabel}`),
      h('div.list', { style: { boxShadow: 'none' } }, sideLine('Reading email', found.imap), sideLine('Sending email', found.smtp)),
      certSide ? h('div', { style: { marginTop: '12px' } }, note('warn', h('div', null, `The server's certificate is made out to ${[...new Set([certSide.cert.subject, ...(certSide.cert.names || [])].filter(Boolean))].slice(0, 3).join(', ')} (issued by ${certSide.cert.issuer || 'unknown'}). `,
        h('div.row', { style: { marginTop: '8px', gap: '8px' } },
          (certSide.cert.names || []).filter((n) => !n.startsWith('*')).slice(0, 1).map((n) => h('button.btn.sm', { onclick: guard(async () => { found.imap = { ...found.imap, ok: true, host: n }; found.smtp = { ...found.smtp, ok: true, host: n }; await save(); }) }, `Use ${n}`)),
          h('button.btn.sm', { onclick: guard(async () => { found.imap.ok = true; found.smtp.ok = true; await save({ tls_pin: certSide.cert.fingerprint }); }) }, 'Trust This Certificate'))))) : null,
      !bothOk && (found.imap.ok || found.smtp.ok || found.imap.host) ? h('div.row', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: guard(async () => { found.imap.host = found.imap.host || found.smtp.host; found.smtp.host = found.smtp.host || found.imap.host; found.imap.port = found.imap.port || 993; found.smtp.port = found.smtp.port || 465; await save(); }) }, 'Save Anyway'), h('span.small.muted', null, 'You can fix it later in Integrations → Email.')) : null));
    return false;
  } }], { wide: true });
}
function mailboxSettings(m, presets, pw) {
  const isNew = !m.id;
  const f = { email: h('input', { type: 'text', value: m.email || '' }), name: h('input', { type: 'text', value: m.name || '' }), password: h('input', { type: 'password', value: pw || '', placeholder: isNew ? 'Password or app password' : 'Leave empty to keep' }),
    imap_host: h('input', { type: 'text', value: m.imap_host || '' }), imap_port: sel([['993', '993 · SSL'], ['143', '143 · STARTTLS']], String(m.imap_port || 993)),
    smtp_host: h('input', { type: 'text', value: m.smtp_host || '' }), smtp_port: sel([['465', '465 · SSL'], ['587', '587 · STARTTLS'], ['25', '25 · STARTTLS'], ['2525', '2525']], String(m.smtp_port || 465)),
    username: h('input', { type: 'text', value: m.username || '', placeholder: 'Usually the full email address' }), signature: h('textarea', { rows: 3, value: m.signature || '', placeholder: 'Added to the end of every email sent from this mailbox' }) };
  const preset = sel([['', 'Fill in from a provider…'], ...Object.entries(presets).filter(([, p]) => p.imap_host).map(([k, p]) => [k, p.label])], '', { onchange: (e) => { const p = presets[e.target.value]; if (!p) return; f.imap_host.value = p.imap_host; f.imap_port.value = String(p.imap_port); f.smtp_host.value = p.smtp_host; f.smtp_port.value = String(p.smtp_port); } });
  const readErr = m.read_detail ? JSON.parse(m.read_detail) : null; const sendErr = m.send_detail ? JSON.parse(m.send_detail) : null;
  const statusBox = !isNew ? h('div.list', { style: { boxShadow: 'none', marginBottom: '14px' } },
    h('div.li', null, h('span.tick' + (m.read_ok ? '.on' : '.bad'), null, icon(m.read_ok ? 'check' : 'x', 'sm')), h('div.t', null, h('b', null, m.read_ok ? 'Reading works' : 'Reading failed'), readErr ? h('span', { style: { whiteSpace: 'normal' } }, readErr.message) : null)),
    h('div.li', null, h('span.tick' + (m.send_ok ? '.on' : '.bad'), null, icon(m.send_ok ? 'check' : 'x', 'sm')), h('div.t', null, h('b', null, m.send_ok ? 'Sending works' : 'Sending failed'), sendErr ? h('span', { style: { whiteSpace: 'normal' } }, sendErr.message) : null)),
    (readErr && /^cert/.test(readErr.code)) || (sendErr && /^cert/.test(sendErr.code)) ? h('div.li', null, h('div.t', null, h('b', null, 'Certificate problem'), h('span', null, 'Check what the server presents, then decide.')), h('button.btn.sm', { onclick: guard(async () => {
      const side = readErr && /^cert/.test(readErr.code) ? 'read' : 'send'; const c = await orgApi(`/mailboxes/${m.id}/cert?side=${side}`);
      if (await confirmBox('Trust This Certificate?', `Issued to: ${[c.subject, ...(c.names || [])].filter(Boolean).slice(0, 4).join(', ')}\nIssued by: ${c.issuer}\nValid until: ${c.validTo}\n\nForgeAI will accept exactly this certificate for ${m.email} and warn if it ever changes.`, 'Trust')) { const r = await orgApi(`/mailboxes/${m.id}/trust`, { body: { fingerprint: c.fingerprint } }); toast(r.status === 'connected' ? 'Connected' : r.status_detail, r.status !== 'connected'); route(); }
    }) }, 'Check Certificate')) : null) : null;
  modal(isNew ? 'Mailbox Settings' : m.email, h('div', null, statusBox,
    h('div.grid.g2', { style: { gap: '12px' } }, field('Email address', f.email), field('Your name', f.name)), field('Password', f.password),
    h('div.section-title', null, 'Servers'), field('Provider', preset),
    h('div.grid.g2', { style: { gap: '12px' } }, field('Incoming (IMAP) server', f.imap_host), field('Port', f.imap_port), field('Outgoing (SMTP) server', f.smtp_host), field('Port', f.smtp_port)), field('Username', f.username),
    h('div.section-title', null, 'Signature'), f.signature),
  [!isNew ? { label: 'Remove', danger: true, onClick: async () => { if (!(await confirmBox('Remove Mailbox?', `Remove ${m.email} from ForgeAI? Nothing is deleted from the mailbox itself.`, 'Remove', true))) return false; await orgApi('/mailboxes/' + m.id, { method: 'DELETE' }); route(); } } : null, { label: 'Cancel', onClick: () => {} },
    { label: isNew ? 'Save & Test' : 'Save & Test', primary: true, onClick: async () => {
      const b = { email: f.email.value, name: f.name.value, imap_host: f.imap_host.value, imap_port: +f.imap_port.value, smtp_host: f.smtp_host.value, smtp_port: +f.smtp_port.value, username: f.username.value || f.email.value, password: f.password.value || undefined, signature: f.signature.value };
      const r = isNew ? await orgApi('/mailboxes', { body: b }) : await orgApi('/mailboxes/' + m.id, { method: 'PUT', body: b });
      toast(r.status === 'connected' ? 'Reading and sending work' : r.status_detail, r.status !== 'connected'); route();
    } }].filter(Boolean), { wide: true });
}
async function sendTestEmail(m) {
  const r = await orgApi(`/mailboxes/${m.id}/send`, { body: { to: m.email, subject: 'ForgeAI test email', text: `This is a test from ForgeAI, sent ${new Date().toLocaleString()}. If you can read this, sending works.`, signature: false } });
  toast(`Test email sent to ${(r.accepted || []).join(', ') || m.email}`);
}

// ---------------- LIMITS (Organisation → Limits)
async function limitsTab(body) {
  const d = await orgApi('/limits');
  const L = d.limits; const ed = d.canEdit;
  const inp = (v, w = '130px') => h('input', { type: 'number', min: 0, value: v || 0, disabled: !ed, style: { width: w } });
  const f = { calls: inp(L.calls_per_day), tokens: inp(L.tokens_per_day, '150px'), budget: inp(L.cloud_budget_month), ram: inp(L.quota_ram_gb), stor: inp(L.quota_storage_gb), ans: sel([['0', 'No limit'], ['1000', 'Short (~750 words)'], ['4000', 'Medium (~3,000 words)'], ['16000', 'Long (~12,000 words)']], String(L.max_answer_tokens || 0), { disabled: !ed }) };
  body.append(h('div.grid.g3', { style: { marginBottom: '18px' } },
    h('div.card', null, meter(d.today.calls, L.calls_per_day, 'AI requests today')),
    h('div.card', null, meter(d.today.tokens, L.tokens_per_day, 'Tokens today')),
    h('div.card', null, meter(Math.round(d.monthSpend * 100) / 100, L.cloud_budget_month, 'Cloud spend this month ($)'))));
  body.append(h('div.list', null,
    h('div.li', null, h('div.t', null, h('b', null, 'AI requests per day'), h('span', null, 'Every model call counts, including each agent step. 0 = no limit.')), f.calls),
    h('div.li', null, h('div.t', null, h('b', null, 'Tokens per day'), h('span', null, 'Roughly 750 words = 1,000 tokens. 0 = no limit.')), f.tokens),
    h('div.li', null, h('div.t', null, h('b', null, 'Cloud budget per month (US$)'), h('span', null, 'When reached, only models on your own computers are used. Estimated from list prices.')), f.budget),
    h('div.li', null, h('div.t', null, h('b', null, 'Longest answer'), h('span', null, 'Caps how much a model writes in one reply.')), h('div.ctl', null, f.ans)),
    h('div.li', null, h('div.t', null, h('b', null, 'Memory for local models (GB)'), h('span', null, 'Largest amount of computer memory this organisation may use at once. 0 = no limit.')), f.ram),
    h('div.li', null, h('div.t', null, h('b', null, 'File storage (GB)'), h('span', null, `Using ${bytes(d.storageBytes)}. 0 = no limit.`)), f.stor)),
  ed ? h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: guard(async () => { await orgApi('', { method: 'PUT', body: { calls_per_day: +f.calls.value, tokens_per_day: +f.tokens.value, cloud_budget_month: +f.budget.value, max_answer_tokens: +f.ans.value, quota_ram_gb: +f.ram.value, quota_storage_gb: +f.stor.value } }); toast('Limits saved'); route(); }) }, 'Save Limits')) : h('div.help', { style: { marginTop: '10px' } }, 'Limits are set by the platform owner or admin.'));
  if (d.agents.length) {
    body.append(h('div.section-title', null, 'Agents'), h('div.card.pad0', null, h('div.tablewrap', null, h('table.t', null,
      h('thead', null, h('tr', null, ['Agent', 'Tasks today', 'Tasks per day', 'Spend this month', 'Monthly budget ($)', ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.agents.map((a) => { const r = inp(a.runs_per_day, '90px'); const bgt = inp(a.budget_month, '90px'); return h('tr', null,
        h('td', null, h('b', null, a.name)), h('td.muted', null, num(a.runsToday)), h('td', null, r), h('td.muted', null, money(a.spendMonth)), h('td', null, bgt),
        h('td', { style: { textAlign: 'right' } }, ed ? h('button.btn.sm', { onclick: guard(async () => { await orgApi(`/agents/${a.id}/limits`, { method: 'PUT', body: { runs_per_day: +r.value, budget_month: +bgt.value } }); toast('Saved'); }) }, 'Save') : null)); }))))));
  }
  if (d.profiles.length) {
    body.append(h('div.section-title', null, 'My models'), h('div.list', null, d.profiles.map((p) => h('div.li', null, profileBadge(p, 28), h('div.t', null, h('b', null, p.name), h('span', null, p.daily_limit ? `${p.usedToday} of ${p.daily_limit} requests today` : `${p.usedToday} requests today · no limit`)),
      isPlatform() ? h('a.btn.sm.ghost', { href: '#/models' }, 'Change') : null))));
  }
}
