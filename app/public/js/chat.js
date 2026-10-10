'use strict';
/* AI CHAT */
const CH = { tools: (store('chatTools') || '1') === '1', convId: null, conv: null, pick: 'auto', sensitivity: 'normal', web: false, atts: [], ctl: null, options: null, projectFilter: '', q: '', queue: [], editing: null };
const ACT_LEVELS = [['off', 'Off'], ['summary', 'Summary'], ['verbose', 'Verbose']];

function modelSelect(options, value, onchange) { return modelPicker(options, value, onchange, { compact: true }); }
const pickToReq = (pick) => (pick.startsWith('m:') ? { mode: 'other', model: pick.slice(2) } : { mode: pick, model: null });
const tstamp = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');

async function pageChat(root, convId) {
  CH.options = await orgApi('/model-options').catch(() => ({ local: [], cloud: [], policy: {}, profiles: [], pipelines: [], limits: {} }));
  const agents = await orgApi('/agents').catch(() => []);
  const projects = await orgApi('/projects').catch(() => []);
  const wrap = h('div.chat'); root.append(wrap);
  const list = h('div.convlist'); const main = h('div.chatmain'); wrap.append(list, main);

  // ---- conversation list
  const items = h('div.items');
  const search = h('input', { type: 'search', placeholder: 'Search', value: CH.q, oninput: debounce((e) => { CH.q = e.target.value; loadList(); }, 250) });
  const projSel = h('select', { onchange: async (e) => {
    if (e.target.value === '__new') { e.target.value = CH.projectFilter; return newProject(); }
    CH.projectFilter = e.target.value; loadList();
  } }, h('option', { value: '' }, 'All conversations'), projects.map((p) => h('option', { value: p.id, selected: p.id === CH.projectFilter }, p.name)), canOrg('chat') ? h('option', { value: '__new' }, 'New project…') : null);
  list.append(h('div.top', null,
    h('button.btn.primary', { onclick: () => { CH.convId = null; location.hash = '#/chat'; }, disabled: !canOrg('chat') }, icon('edit', 'sm'), 'New Chat'), search, projSel), items);
  async function loadList() {
    const q = CH.q ? '?q=' + encodeURIComponent(CH.q) : CH.projectFilter ? '?project=' + CH.projectFilter : '';
    const convs = await orgApi('/conversations' + q);
    clear(items);
    if (!convs.length) items.append(h('div.faint.small', { style: { padding: '12px 10px' } }, CH.q ? 'No matches' : 'No conversations yet'));
    const groups = {}; const now = Date.now();
    for (const c of convs) {
      const age = (now - new Date(c.updated_at).getTime()) / 864e5;
      const g = age < 1 ? 'Today' : age < 7 ? 'Previous 7 Days' : age < 30 ? 'Previous 30 Days' : 'Older';
      (groups[g] = groups[g] || []).push(c);
    }
    for (const [g, cs] of Object.entries(groups)) {
      items.append(h('div.grp', null, g));
      for (const c of cs) items.append(h('a.item' + (c.id === CH.convId ? '.on' : ''), { href: '#/chat/' + c.id, title: c.title, onclick: () => wrap.classList.remove('show-list') }, c.sensitivity !== 'normal' ? icon('lock', 'sm') : null, h('span', null, c.title)));
    }
  }
  async function newProject() {
    const name = h('input', { type: 'text', placeholder: 'e.g. Q3 board report' });
    const ins = h('textarea', { placeholder: 'Optional instructions for every conversation in this project' });
    modal('New Project', h('div', null, field('Name', name), field('Project instructions', ins)), [{ label: 'Cancel', onClick: () => {} }, { label: 'Create', primary: true, onClick: async () => { const r = await orgApi('/projects', { body: { name: name.value, instructions: ins.value } }); CH.projectFilter = r.id; route(); } }]);
  }
  loadList();

  // ---- header
  CH.convId = convId || null; CH.conv = null; CH.atts = []; CH.queue = []; CH.editing = null;
  if (CH.convId) {
    CH.conv = await orgApi('/conversations/' + CH.convId).catch(() => null);
    if (!CH.conv) { location.hash = '#/chat'; return; }
    CH.pick = CH.conv.model_mode === 'other' ? (CH.conv.model_pick || CH.pick) : CH.conv.model_mode || 'auto';
    CH.sensitivity = CH.conv.sensitivity || 'normal'; CH.web = !!CH.conv.web;
  } else { CH.sensitivity = 'normal'; CH.pick = (CH.pendingSend && CH.pendingSend.pick) || store('pick') || (CH.options.defaultPick && CH.options.defaultPick !== 'auto' ? CH.options.defaultPick : null) || ((CH.options.profiles || [])[0] ? 'm:profile:' + CH.options.profiles[0].id : 'auto'); }
  const titleEl = h('div.title', { title: CH.conv ? 'Click to rename' : '', style: { cursor: CH.conv ? 'pointer' : 'default' }, onclick: () => CH.conv && rename() }, CH.conv ? CH.conv.title : 'New Chat');
  const cmpChip = h('span');
  const openCompare = () => compareDialog(CH.options, CH.compare, (c) => { CH.compare = c && (c.mode === 'expert' || (c.models && c.models.length > 1)) ? c : null; drawCmp(); });
  const drawCmp = () => { clear(cmpChip); if (CH.compare) cmpChip.append(h('button.chip.cmpchip', { title: 'Each message goes to several models. Click to change.', onclick: openCompare }, icon('layers', 'sm'), CH.compare.mode === 'expert' ? 'Expert team' : CH.compare.mode === 'debate' ? `Debate · ${CH.compare.models.length} models` : `Asking ${CH.compare.models.length} models`, h('span', { title: 'Stop comparing', onclick: (e) => { e.stopPropagation(); CH.compare = null; drawCmp(); } }, icon('x', 'sm')))); mSel.style.display = CH.compare ? 'none' : ''; };
  const mSel = modelPicker(CH.options, CH.pick, (v) => { CH.pick = v; store('pick', v); preview(); if (CH.conv) orgApi('/conversations/' + CH.convId, { method: 'PUT', body: { mode: pickToReq(v).mode, model_pick: v } }); }, { compact: true, onCompare: openCompare });
  setTimeout(drawCmp, 0);
  CH.where = CH.where || store('where') || 'auto'; if (!(CH.options.places || []).some((p) => p.value === CH.where)) CH.where = 'auto';
  const whereSel = (CH.options.places || []).length > 2 ? sel((CH.options.places || []).map((p) => [p.value, p.label]), CH.where, { title: 'Where to run — limits automatic choice to one computer or the cluster', onchange: (e) => { CH.where = e.target.value; store('where', CH.where); preview(); } }) : h('span');
  const sSel = sel(Object.entries(SENS_NAMES), CH.sensitivity, { title: 'Data sensitivity — controls where this conversation may be sent', onchange: (e) => { CH.sensitivity = e.target.value; preview(); if (CH.conv) orgApi('/conversations/' + CH.convId, { method: 'PUT', body: { sensitivity: CH.sensitivity } }); } });
  const toolsT = h('label.lbl', { title: 'Let the assistant use tools: research, files, documents, code, charts, schedules', style: { cursor: 'pointer' } }, icon('bolt', 'sm'), 'Tools', toggle(CH.tools, (v) => { CH.tools = v; store('chatTools', v ? '1' : '0'); }, { style: { transform: 'scale(.85)' } }));
  const projMove = CH.conv ? sel([['', 'No project'], ...projects.map((p) => [p.id, p.name])], CH.conv.project_id || '', { title: 'Project', onchange: (e) => orgApi('/conversations/' + CH.convId, { method: 'PUT', body: { project_id: e.target.value } }).then(loadList) }) : null;
  const actLevel = store('activity') || 'summary';
  const actBtn = h('button.btn.sm.icon.ghost', { title: 'Activity: what is happening now', onclick: () => { activity.classList.toggle('open'); actBtn.classList.toggle('on', activity.classList.contains('open')); store('activityOpen', activity.classList.contains('open') ? '1' : '0'); } }, icon('gauge'));
  main.append(h('div.chathead', null,
    h('button.btn.sm.icon.ghost.mobile-only', { onclick: () => wrap.classList.toggle('show-list'), title: 'Conversations' }, icon('menu')),
    titleEl, mSel, cmpChip, whereSel, h('span.lbl', null, icon('lock', 'sm')), sSel, toolsT, projMove, actBtn,
    CH.conv ? h('button.btn.sm.icon.ghost', { title: 'Export as Markdown', onclick: () => { location.href = `/api/orgs/${S.org.id}/conversations/${CH.convId}/export`; } }, icon('share')) : null,
    CH.conv && canOrg('chat') ? h('button.btn.sm.icon.ghost', { title: 'Delete conversation', onclick: guard(async () => { if (await confirmBox('Delete Conversation?', 'This removes the conversation and its uploaded files.', 'Delete', true)) { await orgApi('/conversations/' + CH.convId, { method: 'DELETE' }); location.hash = '#/chat'; } }) }, icon('trash')) : null));

  // ---- activity panel (off / summary / verbose)
  const actBody = h('div.actbody');
  const actSel = sel(ACT_LEVELS, actLevel, { onchange: (e) => { store('activity', e.target.value); activity.dataset.level = e.target.value; } });
  const activity = h('div.activity' + (store('activityOpen') === '1' && actLevel !== 'off' ? '.open' : ''), { 'data-level': actLevel }, h('div.acthead', null, h('b', null, 'Activity'), actSel, h('button.btn.sm.icon.ghost', { title: 'Close', onclick: () => { activity.classList.remove('open'); actBtn.classList.remove('on'); store('activityOpen', '0'); } }, icon('x', 'sm'))), actBody);
  actBtn.classList.toggle('on', activity.classList.contains('open'));
  actBody.append(h('div.al.muted', null, 'Routing, the endpoint used, timings, tokens and — on Verbose — the model’s reasoning appear here while it works.'));
  const act = (kind, ...kids) => { const line = h('div.al.' + kind, null, h('span.at', null, new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })), ...kids); actBody.append(line); actBody.scrollTop = actBody.scrollHeight; return line; };
  let thinkLine = null;

  const msgs = h('div.msgs');
  main.append(h('div.chatbody', null, msgs, activity));
  if (CH.conv && CH.conv.messages.length) renderAll(msgs, CH.conv.messages);
  else msgs.append(welcome(agents, (v) => { CH.pick = v; store('pick', v); mSel.setValue(v); preview(); ta.focus(); }));
  scrollDown(msgs, true);

  // ---- composer
  const chips = h('div.row', { style: { gap: '6px', padding: '2px 4px 4px' } });
  const queueRow = h('div.queue');
  const editBar = h('div.editbar', { style: { display: 'none' } });
  let spell = (store('spell') || '1') === '1';
  const ta = h('textarea', { rows: 1, placeholder: canOrg('chat') ? `Message ${S.org.name}` : 'You have read-only access', disabled: !canOrg('chat'),
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape' && CH.editing) cancelEdit(); },
    oninput: () => { ta.style.height = 'auto'; ta.style.height = Math.min(260, ta.scrollHeight) + 'px'; debPreview(); },
    onpaste: (e) => { const f = [...(e.clipboardData.files || [])]; if (f.length) { e.preventDefault(); upload(f); } } });
  const spellBtn = h('button.btn.sm.ghost.spell', { onclick: () => { spell = !spell; store('spell', spell ? '1' : '0'); applySpell(); ta.focus(); } }, 'Abc', icon('check', 'sm'));
  const applySpell = () => { ta.spellcheck = spell; ta.setAttribute('autocorrect', spell ? 'on' : 'off'); ta.setAttribute('autocapitalize', spell ? 'sentences' : 'off'); spellBtn.classList.toggle('on', spell); spellBtn.title = spell ? 'Spellcheck and autocorrect on — click to turn off (e.g. for code)' : 'Spellcheck off — click to turn on'; };
  const fileIn = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: (e) => { upload([...e.target.files]); e.target.value = ''; } });
  const routeHint = h('span.faint.small.grow.routehint');
  const sendBtn = h('button.btn.primary.send', { onclick: () => send(), title: 'Send' }, icon('up'));
  const stopBtn = h('button.btn.send.stop', { style: { display: 'none' }, onclick: () => CH.ctl && CH.ctl.abort(), title: 'Stop' }, icon('stop'));
  const comp = h('div.composer', null, editBar, queueRow, h('div.box', null, chips, ta, h('div.tools', null,
    h('button.btn.sm.icon.ghost', { title: 'Attach files or images', onclick: () => fileIn.click(), disabled: !canOrg('chat') }, icon('clip')), fileIn, spellBtn, routeHint, stopBtn, sendBtn)),
  h('div.hint', null, 'While it works you can keep typing — it’s added to the running request or queued next' + (agents.length ? ` · “@${agents[0].name}” hands work to an agent` : ' · “Remember that …” saves to memory')));
  applySpell();
  main.append(comp);
  comp.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('drag'); });
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'));
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drag'); upload([...e.dataTransfer.files]); });
  setTimeout(() => ta.focus(), 50);

  async function preview() {
    const text = ta.value.trim();
    try {
      const r = await orgApi('/route-preview', { body: { ...pickToReq(CH.pick), sensitivity: CH.sensitivity, web: CH.web, text: text || 'hello', where: CH.where && CH.where !== 'auto' ? CH.where : undefined } });
      clear(routeHint).append(r.blocked ? (r.approvable ? 'Needs approval before sending' : r.reasons[r.reasons.length - 1]) : h('span', null, r.scope === 'internet' ? h('span.netdot', { title: 'Leaves your network' }) : null, r.why || r.label));
      routeHint.title = [r.why, ...(r.reasons || [])].filter(Boolean).join('\n');
    } catch { routeHint.textContent = ''; }
  }
  const debPreview = debounce(preview, 400); preview();

  function renderChips() {
    clear(chips);
    for (const a of CH.atts) chips.append(h('span.chip', null, icon(a.image ? 'image' : a.unsupported ? 'warn' : 'doc', 'sm'), a.name, a.unsupported ? h('span.faint', null, '(not readable)') : null, h('button', { onclick: () => { CH.atts = CH.atts.filter((x) => x !== a); renderChips(); }, title: 'Remove' }, icon('x', 'sm'))));
  }
  function renderQueue() {
    clear(queueRow);
    CH.queue.forEach((q, i) => queueRow.append(h('div.qitem', null, icon('clock', 'sm'), h('span.grow', null, q.text), h('span.faint.small', null, 'sends next'), h('button.btn.sm.icon.ghost', { title: 'Edit', onclick: () => { ta.value = q.text; CH.queue.splice(i, 1); renderQueue(); ta.focus(); } }, icon('edit', 'sm')), h('button.btn.sm.icon.ghost', { title: 'Remove', onclick: () => { CH.queue.splice(i, 1); renderQueue(); } }, icon('x', 'sm')))));
  }
  async function upload(files) {
    for (const f of files) {
      const chip = h('span.chip', null, h('span.spinner'), f.name); chips.append(chip);
      try {
        if (f.size > 30 * 2 ** 20) throw new Error(f.name + ' is larger than 30 MB');
        const r = await orgApi('/attachments', { body: { name: f.name, mime: f.type, data: await readFileB64(f), conv_id: CH.convId } });
        CH.atts.push(r);
      } catch (e) { toast(e.message, true); }
      chip.remove(); renderChips();
    }
  }
  async function rename() {
    const inp = h('input', { type: 'text', value: CH.conv.title });
    modal('Rename Conversation', inp, [{ label: 'Cancel', onClick: () => {} }, { label: 'Save', primary: true, onClick: async () => { await orgApi('/conversations/' + CH.convId, { method: 'PUT', body: { title: inp.value } }); titleEl.textContent = inp.value; loadList(); } }]);
  }
  function startEdit(m) {
    if (CH.ctl) return toast('Stop the current answer first', true);
    CH.editing = { id: m.id };
    clear(editBar).append(icon('edit', 'sm'), h('span.grow', null, 'Editing your message — sending replaces it and everything after it.'), h('button.btn.sm.ghost', { onclick: cancelEdit }, 'Cancel'));
    editBar.style.display = ''; ta.value = m.content; ta.dispatchEvent(new Event('input')); ta.focus();
    const el = msgs.querySelector(`[data-id="${m.id}"]`); if (el) { let x = el; while (x) { x.classList.add('editing-fade'); x = x.nextElementSibling; } }
  }
  function cancelEdit() { CH.editing = null; editBar.style.display = 'none'; msgs.querySelectorAll('.editing-fade').forEach((x) => x.classList.remove('editing-fade')); ta.value = ''; ta.dispatchEvent(new Event('input')); }

  // Shared streaming: a live bubble (one per model when comparing) with a progress card; events also feed the activity panel.
  async function runStream(url, payload, { userMsg, replaceEl } = {}) {
    if (userMsg) msgs.append(renderMsg(userMsg));
    const mkBubble = (container) => {
      const live = { role: 'assistant', content: '', meta: {} }; const el = renderMsg(live, true);
      const b = { el, md: el.querySelector('.md'), route: el.querySelector('.routeinfo'), acc: '', base: '', raf: 0, prog: progressCard(), steps: h('div.steps'), stage: h('div.stagebar') };
      b.md.before(b.prog.el); if (container) container.append(el); return b;
    };
    let main;
    if (replaceEl) { main = { el: replaceEl, md: replaceEl.querySelector('.md'), route: h('div'), acc: '', base: replaceEl.querySelector('.md').dataset.raw || '', raf: 0, prog: progressCard(), steps: h('div.steps'), stage: h('div.stagebar') }; replaceEl.classList.add('continuing'); main.md.before(main.prog.el); }
    else main = mkBubble(msgs);
    const slots = {}; let cmpGrid = null;
    const B = (d) => (d && d.slot != null && slots[d.slot] ? slots[d.slot] : main);
    scrollDown(msgs, true);
    CH.ctl = new AbortController(); sendBtn.title = 'Add to the running request'; stopBtn.style.display = '';
    clear(actBody); thinkLine = null; act('start', icon('up', 'sm'), payload.compare ? `Asking ${payload.compare.length} models at once` : 'Request sent');
    const paint = (b) => () => { b.raf = 0; b.md.innerHTML = md(b.base + b.acc); b.md.classList.add('cursor'); scrollDown(msgs); };
    const label = (d) => (d && d.slot != null ? `[${d.slot + 1}] ` : '');
    try {
      await stream(url, payload, {
        user: (d) => { if (d.title) titleEl.textContent = d.title; if (d.id) { const u = [...msgs.querySelectorAll('.msg.user')].pop(); if (u && !u.dataset.id) u.dataset.id = d.id; } },
        compare: (d) => {
          main.el.remove(); cmpGrid = h('div.cmpgrid');
          msgs.append(h('div.cmpwrap', null, h('div.cmphead', null, icon('layers', 'sm'), `Asking ${d.count} models at once`), cmpGrid));
          for (let i = 0; i < d.count; i++) slots[i] = mkBubble(cmpGrid);
        },
        fallback: (f) => { const b = B(f); b.md.before(fallbackBanner(f)); b.prog.step(`${f.from} failed — continuing with ${f.to}`); act('warn', icon('swap', 'sm'), `${label(f)}${f.from} failed (${f.reason}). Continuing with ${f.to}.`); },
        trace: (t) => { act('trace', icon('tasks', 'sm'), label(t) + t.text); },
        whynot: (d) => { act('trace', icon('info', 'sm'), h('details', null, h('summary', null, 'Why not another model?'), h('ul', null, d.list.map((w) => h('li', null, w))))); },
        route: (d) => { const b = B(d); clear(b.route).append(h('span.spinner'), d.label, d.scope === 'internet' ? scopeChip('internet') : null); b.route.title = (d.reasons || []).join('\n'); b.prog.route(d); act('route', icon('wand', 'sm'), h('span', null, label(d) + (d.why || d.label)), d.scope ? scopeChip(d.scope, true) : null); },
        progress: (p) => { const b = B(p); b.prog.progress(p); if (p.phase !== 'prompt' || p.processed === p.total) act('prog', icon(p.phase === 'loading' || p.phase === 'loaded' ? 'download' : p.phase === 'starting' ? 'play' : 'clock', 'sm'), label(p) + (p.phase === 'prompt' ? `Read ${p.total} tokens of prompt${p.ms ? ' in ' + fmtMs(p.ms) : ''}` : p.text || p.phase) + (p.where && p.phase === 'sending' ? ' · ' + p.where : '')); },
        stage: (d) => { const b = B(d); if (!b.stage.isConnected) b.md.before(b.stage); clear(b.stage).append(h('span.spinner'), `Stage ${d.index + 1} of ${d.total}: `, h('b', null, d.name), ` · ${d.model}`, d.scope === 'internet' ? scopeChip('internet') : null); b.prog.stage(d); act('stage', icon('tasks', 'sm'), `Stage ${d.index + 1}/${d.total} · ${d.name} → ${d.model}`); },
        stage_delta: () => {},
        delta: (d) => { const b = B(d); b.acc += d.d; b.prog.delta(d.d); if (!b.raf) b.raf = requestAnimationFrame(paint(b)); },
        thinking: (d) => { if (!thinkLine) thinkLine = act('think', h('div.thinktext')); thinkLine.querySelector('.thinktext').textContent += d.d; actBody.scrollTop = actBody.scrollHeight; },
        stats: (s) => {
          const b = B(s);
          if (s.ttftMs != null && s.totalMs == null) { b.prog.firstWord(s.ttftMs); act('stat', icon('clock', 'sm'), `${label(s)}First word after ${fmtMs(s.ttftMs)}`); return; }
          act('stat', icon('gauge', 'sm'), h('span', null, label(s) + [s.stage ? s.stage + ':' : null, s.model, s.endpoint, s.inputTokens != null ? `${num(s.inputTokens)} in / ${num(s.outputTokens)} out` : null, s.loadMs ? `model load ${fmtMs(s.loadMs)}` : null, s.ttftMs != null ? `first word ${fmtMs(s.ttftMs)}` : null, s.tps ? fmtTps(s.tps) : null, `total ${fmtMs(s.totalMs)}`, s.retries ? `${s.retries} retr${s.retries > 1 ? 'ies' : 'y'}` : null].filter(Boolean).join(' · ')), s.scope ? scopeChip(s.scope, true) : null);
          if (s.bottleneck && s.bottleneck.kind !== 'none') act('warn', icon('warn', 'sm'), label(s) + s.bottleneck.text);
        },
        step: (st) => { const b = B(st); if (!b.steps.isConnected) b.md.before(b.steps); b.steps.append(stepLine(st)); if (st.kind === 'call') { clear(b.route).append(h('span.spinner'), st.content); b.prog.step(st.content || st.tool); } act(st.kind === 'note' ? 'note' : 'step', icon(st.kind === 'note' ? 'chat' : TOOL_ICON(st.tool), 'sm'), st.kind === 'note' ? 'Your note was added: ' + st.content : st.content || st.tool); scrollDown(msgs); },
        done: (d) => {
          const b = B(d); b.prog.done();
          const el = renderMsg(d.message);
          if (d.replace) { const old = msgs.querySelector(`[data-id="${d.replace}"]`); if (old) old.replaceWith(el); else msgs.append(el); if (main.el.isConnected && main.el !== replaceEl) main.el.remove(); }
          else if (b.el.isConnected) b.el.replaceWith(el); else msgs.append(el);
          const mm = d.message.meta || {}; act('done', icon('check', 'sm'), `${label(d)}Finished${mm.finishedAt && mm.startedAt ? ' in ' + fmtMs(new Date(mm.finishedAt) - new Date(mm.startedAt)) : ''}${mm.endpoint ? ' · served by ' + mm.endpoint : ''}`);
        },
        error: (d) => { const b = B(d); b.prog.fail(d.message); b.md.classList.remove('cursor'); b.md.innerHTML = md(d.message); act('warn', icon('warn', 'sm'), d.message); },
      }, CH.ctl.signal);
    } catch (e) { for (const b of [main, ...Object.values(slots)]) { b.md.classList.remove('cursor'); b.prog.fail(e.name === 'AbortError' ? 'Stopped' : e.message); } if (e.name !== 'AbortError') { main.md.innerHTML = md(e.message); act('warn', e.message); } else act('warn', icon('stop', 'sm'), 'Stopped — you can edit your message or press Continue'); }
    CH.ctl = null; sendBtn.title = 'Send'; stopBtn.style.display = 'none'; if (replaceEl) replaceEl.classList.remove('continuing');
    if (!document.body.contains(msgs)) return;
    // Reload from the server so every message has its id and its Copy / Edit / Re-run / Continue buttons.
    if (CH.convId) { const c = await orgApi('/conversations/' + CH.convId).catch(() => null); if (c) { const keep = msgs.scrollTop; clear(msgs); renderAll(msgs, c.messages); msgs.scrollTop = keep; } }
    scrollDown(msgs, true); loadList(); refreshCounts(); watchPending(); preview();
    if (CH.queue.length) { const q = CH.queue.shift(); renderQueue(); setTimeout(() => send(q.text), 60); }
  }

  async function send(textOverride) {
    const text = (textOverride || ta.value).trim();
    if (!text && !CH.atts.length) return;
    // Busy: add to the running request (tool runs) or queue it for when this answer finishes.
    if (CH.ctl) {
      ta.value = ''; ta.style.height = 'auto';
      const run = CH.convId ? await orgApi(`/conversations/${CH.convId}/running`).catch(() => ({})) : {};
      if (run.id) { try { await orgApi(`/tasks/${run.id}/steer`, { body: { text } }); act('note', icon('chat', 'sm'), 'Added to the running request: ' + text); toast('Added to the running request'); return; } catch {} }
      CH.queue.push({ text }); renderQueue(); toast('Queued — sends when this answer finishes'); return;
    }
    if (!CH.convId) {
      const c = await orgApi('/conversations', { body: { project_id: CH.projectFilter || null, mode: pickToReq(CH.pick).mode, sensitivity: CH.sensitivity } });
      CH.convId = c.id; CH.conv = { ...c, messages: [] }; history.replaceState(null, '', location.search + '#/chat/' + c.id);
      clear(msgs);
    }
    const atts = CH.atts; CH.atts = []; renderChips(); ta.value = ''; ta.style.height = 'auto';
    const payload = { text, attachments: atts.map((a) => a.id), ...pickToReq(CH.pick), sensitivity: CH.sensitivity, web: CH.web, tools: CH.tools, where: CH.where && CH.where !== 'auto' ? CH.where : undefined };
    if (CH.compare && !CH.editing) { if (CH.compare.mode === 'compare') { payload.compare = CH.compare.models; payload.tools = false; } else { payload.multi = CH.compare; payload.tools = false; } }
    let url = `/api/orgs/${S.org.id}/conversations/${CH.convId}/messages`;
    if (CH.editing) {
      url = `/api/orgs/${S.org.id}/conversations/${CH.convId}/messages/${CH.editing.id}/edit`;
      const el = msgs.querySelector(`[data-id="${CH.editing.id}"]`); if (el) { let x = el; while (x) { const n = x.nextElementSibling; x.remove(); x = n; } }
      CH.editing = null; editBar.style.display = 'none';
    }
    await runStream(url, payload, { userMsg: { role: 'user', content: text, meta: {}, created_at: new Date().toISOString(), attachments: atts.map((a) => ({ id: a.id, name: a.name, mime: a.image ? 'image/*' : '' })) } });
  }
  CH.send = send;
  // Message actions used by renderMsg.
  CH.act = {
    edit: (m) => startEdit(m),
    rerun: (m, pick) => { if (CH.ctl) return toast('Wait for the current answer, or stop it', true); runStream(`/api/orgs/${S.org.id}/conversations/${CH.convId}/messages/${m.id}/rerun`, { ...pickToReq(pick || CH.pick), sensitivity: CH.sensitivity }); },
    retry: async (m, pick) => {
      if (CH.ctl) return toast('Wait for the current answer, or stop it', true);
      const c = await orgApi('/conversations/' + CH.convId); const i = c.messages.findIndex((x) => x.id === m.id);
      const u = c.messages.slice(0, i).reverse().find((x) => x.role === 'user'); if (!u) return toast('Nothing to retry', true);
      runStream(`/api/orgs/${S.org.id}/conversations/${CH.convId}/messages/${u.id}/rerun`, { ...pickToReq(pick || CH.pick), sensitivity: CH.sensitivity });
    },
    cont: (m) => { if (CH.ctl) return; const el = msgs.querySelector(`[data-id="${m.id}"]`); runStream(`/api/orgs/${S.org.id}/conversations/${CH.convId}/messages/${m.id}/continue`, { ...pickToReq((m.meta && m.meta.pick) || CH.pick), sensitivity: CH.sensitivity }, { replaceEl: el }); },
  };
  // A task waiting for approval finishes later: poll until its answer arrives.
  function watchPending() {
    const conv = CH.convId; if (!conv) return;
    const tick = async () => {
      if (CH.convId !== conv || !document.body.contains(msgs) || CH.ctl) return;
      const c = await orgApi('/conversations/' + conv).catch(() => null); if (!c) return;
      const pend = c.messages.some((m) => m.meta && m.meta.pending);
      const n = msgs.querySelectorAll('.msg').length;
      if (c.messages.length !== n || (!pend && msgs.querySelector('.approve-inline'))) { clear(msgs); renderAll(msgs, c.messages); scrollDown(msgs, true); }
      if (pend) setTimeout(tick, 2500);
    };
    setTimeout(tick, 2500);
  }
  if (CH.conv && CH.conv.messages.some((m) => m.meta && m.meta.pending)) watchPending();
  if (CH.pendingSend) { const p = CH.pendingSend; CH.pendingSend = null; if (p.text) setTimeout(() => send(p.text), 30); }
}
function stepLine(st) {
  if (st.kind === 'result') return h('div.s.res', null, (st.content || '').split('\n')[0].slice(0, 140), st.files ? h('span.row', { style: { gap: '4px' } }, st.files.map((f) => fileChip(f, 'assistant'))) : null);
  if (st.kind === 'approval') return h('div.s', { style: { color: 'var(--orange)' } }, icon('lock', 'sm'), st.content);
  if (st.kind === 'thought') return h('div.s', null, icon('bulb', 'sm'), (st.content || '').slice(0, 200));
  if (st.kind === 'note') return h('div.s', null, icon('chat', 'sm'), 'Your note: ' + (st.content || ''));
  if (st.kind === 'error') return h('div.s', { style: { color: 'var(--red)' } }, icon('warn', 'sm'), st.content);
  return h('div.s', null, icon(TOOL_ICON(st.tool), 'sm'), st.content || st.tool);
}
function showSteps(taskId, agentId) { const box = h('div'); modal('How it was done', box, [], { wide: true }); taskTimeline(box, taskId, agentId ? { id: agentId } : null); }

function welcome(agents, setPick) {
  const profs = (CH.options && CH.options.profiles) || [];
  const sugg = [
    ...agents.filter((a) => a.enabled).slice(0, 2).map((a) => ['agent', `Ask the ${a.name} ${a.description ? 'for an update on ' + a.description.toLowerCase().replace(/\.$/, '') : 'for a status update'}`]),
    ['doc', 'Summarise the attached document in five bullet points'],
    ['edit', 'Draft a short email to a customer about a delivery delay'],
    ['bulb', 'Remember that our financial year ends on 31 March'],
  ].slice(0, 4);
  return h('div.welcome', null,
    S.org.logo ? h('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: '18px' } }, monogram(S.org, 'lg')) : h('div.orb'),
    h('h1', null, `How can I help ${S.org.name}?`),
    h('p', null, 'Private to this organisation. Auto chooses a model on your own computers or in the cloud — and tells you which one and why.'),
    profs.length ? h('div.pills', { style: { justifyContent: 'center', marginTop: '22px' } }, profs.map((p) => h('button.pill' + (CH.pick === 'm:profile:' + p.id ? '.on' : ''), { title: p.tagline || '', onclick: (e) => { setPick('m:profile:' + p.id); e.currentTarget.parentNode.querySelectorAll('.pill').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, profileBadge(p, 20), p.name))) : null,
    h('div.sugg', null, sugg.map(([ic, s]) => h('button', { onclick: () => CH.send && CH.send(s) }, icon(ic), s))));
}

// Small menu anchored to a button.
function popMenu(anchor, items) {
  const veil = h('div.mveil', { onmousedown: (e) => { if (e.target === veil) veil.remove(); } });
  const menu = h('div.mpop.menu', null, items.filter(Boolean).map(([label, fn, ic]) => h('button.mrow', { type: 'button', onclick: () => { veil.remove(); fn(); } }, ic ? h('span.mic', null, icon(ic, 'sm')) : null, h('span.mt', null, h('span.ml', null, label)))));
  veil.append(menu); document.body.append(veil);
  const r = anchor.getBoundingClientRect(); menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 248)) + 'px'; menu.style.width = '240px';
  if (window.innerHeight - r.bottom > 200) menu.style.top = r.bottom + 4 + 'px'; else menu.style.bottom = window.innerHeight - r.top + 4 + 'px';
}
// Opens the model picker next to a button and calls fn with the choice.
function pickThen(anchor, fn) {
  const r = anchor.getBoundingClientRect();
  const holder = modelPicker(CH.options, CH.pick, (v) => { holder.remove(); fn(v); }, {});
  Object.assign(holder.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', opacity: '0' });
  document.body.append(holder); holder.click();
  const veil = document.querySelector('.mveil:last-of-type'); if (veil) new MutationObserver((ms, ob) => { if (!veil.isConnected) { holder.remove(); ob.disconnect(); } }).observe(document.body, { childList: true });
}
function copyMenu(anchor, m, mdEl) {
  popMenu(anchor, [
    ['Copy text', () => navigator.clipboard.writeText(mdEl ? mdEl.innerText : m.content).then(() => toast('Copied text')), 'copy'],
    ['Copy as Markdown', () => navigator.clipboard.writeText(m.content).then(() => toast('Copied Markdown')), 'doc'],
  ]);
}

function renderMsg(m, live) {
  const meta = m.meta || {};
  const isUser = m.role === 'user';
  const who = isUser ? (meta.by || 'You') : meta.agent ? meta.agent : meta.pipeline ? meta.pipeline : S.platformName;
  const atts = (m.attachments || []).map((a) => /^image/.test(a.mime) || /\.(png|jpe?g|gif|webp)$/i.test(a.name)
    ? h('a', { href: `/api/orgs/${S.org.id}/attachments/${a.id}/raw`, target: '_blank' }, h('img', { src: `/api/orgs/${S.org.id}/attachments/${a.id}/raw`, alt: a.name }))
    : h('a.chip', { href: `/api/orgs/${S.org.id}/attachments/${a.id}/raw` }, icon('doc', 'sm'), a.name));
  const mdEl = h('div.md' + (live ? '.cursor' : ''), { html: md(m.content || '') });
  mdEl.dataset.raw = m.content || '';
  if (!live) enhanceBlocks(mdEl);
  const bits = []; const acts = [];
  const can = canOrg('chat') && !live && m.id;
  if (isUser) {
    if (m.created_at) bits.push(h('span', { title: new Date(m.created_at).toLocaleString() }, 'Sent ' + tstamp(m.created_at)));
    if (can) acts.push(
      h('button.btn.sm.icon.ghost', { title: 'Copy', onclick: (e) => copyMenu(e.currentTarget, m, mdEl) }, icon('copy', 'sm')),
      h('button.btn.sm.icon.ghost', { title: 'Edit and resend', onclick: () => CH.act && CH.act.edit(m) }, icon('edit', 'sm')),
      h('button.btn.sm.icon.ghost', { title: 'Re-run this request', onclick: (e) => { const b = e.currentTarget; popMenu(b, [['Re-run with the same model', () => CH.act.rerun(m), 'refresh'], ['Re-run with another model…', () => pickThen(b, (v) => CH.act.rerun(m, v)), 'cube']]); } }, icon('refresh', 'sm')));
  } else {
    if (meta.model) bits.push(h('span', { title: [meta.why, ...(Array.isArray(meta.route) ? meta.route : [])].filter(Boolean).join('\n') }, meta.model));
    if (meta.endpoint) bits.push(h('span.ep', { title: 'Served by' }, icon('server', 'sm'), meta.endpoint));
    if (meta.scope) bits.push(scopeChip(meta.scope, true));
    if (meta.stats && meta.stats.ttftMs != null) bits.push(h('span', { title: 'Time to first word' }, 'first word ' + fmtMs(meta.stats.ttftMs)));
    if (meta.stats && meta.stats.tps) bits.push(h('span', null, fmtTps(meta.stats.tps)));
    if (meta.tokens) bits.push(h('span', null, `${num(meta.tokens[0] + meta.tokens[1])} tokens`));
    if (meta.cost) bits.push(h('span', null, money(meta.cost)));
    if (meta.finishedAt) bits.push(h('span', { title: `Started ${new Date(meta.startedAt || m.created_at).toLocaleString()}\nFinished ${new Date(meta.finishedAt).toLocaleString()}` }, `Replied ${tstamp(meta.finishedAt)}${meta.startedAt ? ' · ' + fmtMs(new Date(meta.finishedAt) - new Date(meta.startedAt)) : ''}`));
    if (meta.taskId && meta.steps) bits.push(h('a', { href: '#', onclick: (e) => { e.preventDefault(); showSteps(meta.taskId, meta.agentId); } }, `${meta.steps} step${meta.steps === 1 ? '' : 's'}`));
    if (meta.rerunOf) bits.push(h('span.badge', null, 'Re-run'));
    if (meta.continued) bits.push(h('span.badge', null, 'Continued'));
    if (can && m.content) acts.push(h('button.btn.sm.icon.ghost', { title: 'Copy', onclick: (e) => copyMenu(e.currentTarget, m, mdEl) }, icon('copy', 'sm')));
    if (can && (meta.truncated || (meta.stopped && m.content && m.content !== '_(stopped)_'))) acts.push(h('button.btn.sm.tint', { onclick: () => CH.act && CH.act.cont(m) }, icon('right', 'sm'), 'Continue'));
    if (can && meta.alternatives && meta.alternatives.length) acts.push(...meta.alternatives.map((a) => h('button.btn.sm.tint', { title: 'Send the same message to this model', onclick: () => CH.act && CH.act.retry(m, a.value) }, icon('right', 'sm'), 'Use ' + a.label)));
    if (can && (meta.error || meta.blocked)) acts.push(h('button.btn.sm', { onclick: () => CH.act && CH.act.retry(m) }, icon('refresh', 'sm'), 'Try Again'), h('button.btn.sm.ghost', { onclick: (e) => pickThen(e.currentTarget, (v) => CH.act.retry(m, v)) }, 'Try Another Model…'));
    else if (can && !meta.pending) acts.push(h('button.btn.sm.icon.ghost', { title: 'Re-run with another model', onclick: (e) => pickThen(e.currentTarget, (v) => CH.act.retry(m, v)) }, icon('refresh', 'sm')));
  }
  const files = !isUser && meta.files && meta.files.length ? h('div.row', { style: { gap: '6px', marginTop: '10px' } }, meta.files.map((f) => fileChip(f, meta.agentId || 'assistant'))) : null;
  const approve = !isUser && meta.pending && meta.approvalId && canOrg('approve') ? h('div.approve-inline', null,
    h('button.btn.primary.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await orgApi(`/approvals/${meta.approvalId}/decide`, { body: { approve: true } }); toast('Approved — continuing'); refreshCounts(); }) }, icon('check', 'sm'), 'Approve'),
    h('button.btn.danger.sm', { onclick: guard(async (e) => { e.currentTarget.disabled = true; await orgApi(`/approvals/${meta.approvalId}/decide`, { body: { approve: false } }); toast('Declined'); refreshCounts(); }) }, 'Decline'),
    meta.taskId ? h('button.btn.sm.ghost', { onclick: () => showSteps(meta.taskId, meta.agentId) }, 'Details') : null) : null;
  const stages = !isUser && meta.stages && meta.stages.length ? h('details.stages', null, h('summary', null, icon('tasks', 'sm'), `${meta.stages.length} stage${meta.stages.length === 1 ? '' : 's'}: ` + meta.stages.map((s) => `${s.name} (${s.skipped ? 'skipped' : s.model})`).join(' → ')),
    meta.stages.map((s) => h('div.stg', null, h('div.row', null, h('b', null, s.name), s.model ? h('span.small.muted', null, `${s.model} · ${s.endpoint || ''}`) : null, s.scope ? scopeChip(s.scope, true) : null, s.stats ? h('span.small.muted', null, `${fmtMs(s.stats.totalMs)}${s.stats.tps ? ' · ' + fmtTps(s.stats.tps) : ''}`) : null), s.text ? h('div.md.small', { html: md(s.text) }) : s.skipped ? h('div.small.muted', null, s.reason) : null))) : null;
  const review = !isUser && meta.review ? h('details.review', { open: true }, h('summary', null, icon('check', 'sm'), 'Review'), h('div.md.small', { html: md(meta.review) })) : null;
  const thinking = !isUser && meta.thinking ? h('details.thinking', null, h('summary', null, icon('bulb', 'sm'), 'Model’s reasoning'), h('div.small.mono', { style: { whiteSpace: 'pre-wrap' } }, meta.thinking)) : null;
  return h('div.msg' + (isUser ? '.user' : '') + (meta.error ? '.err' : ''), { 'data-id': m.id || '', 'data-role': m.role },
    isUser ? null : meta.agent ? h('div.av.agent', null, icon('agent', 'sm')) : h('div.av.ai'),
    h('div.body', null, isUser ? null : h('div.who', null, who), live ? h('div.routeinfo', null, h('span.spinner'), 'Choosing a model…') : null,
      stages, thinking, mdEl, review, atts.length ? h('div.atts', null, atts) : null, files, approve,
      bits.length || acts.length ? h('div.meta', null, ...bits, acts.length ? h('span.acts', null, acts) : null) : null));
}
function scrollDown(el, force) { if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
