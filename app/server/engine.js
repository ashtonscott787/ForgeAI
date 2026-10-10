'use strict';
// Chat, agents, agent-to-agent tasks, approvals, scheduler and the Owner AI.
const fs = require('fs');
const path = require('path');
const { uid, now } = require('./db');
const { estTokens, safeJSON } = require('./router');
const { isImage, imageMime } = require('./files');

const MAX_AGENT_DEPTH = 2;
const MAX_ASKS = 3;

const DEFAULT_STAGE_TEXT = {
  ideate: 'Brainstorm the approach and write a short, concrete plan (bullet points). Do not write the final answer.',
  execute: 'Using the plan, write the complete final answer for the user. Do not mention the stages.',
  review: 'Check the final answer above for mistakes, missing points and risks. Reply with a short list of issues (or “No issues found”).',
  custom: '',
};
const DEFAULT_PIPELINES = [
  { id: 'ideate-execute', name: 'Ideate locally → Execute in the cloud', stages: [
    { name: 'Ideate', role: 'ideate', pick: 'local_powerful', fallback: 'local_fast' },
    { name: 'Execute', role: 'execute', pick: 'cloud', fallback: 'local_powerful' },
    { name: 'Review', role: 'review', pick: 'local_fast', fallback: null, optional: true, enabled: false },
  ] },
];
class Engine {
  constructor(store, models, cluster) {
    this.store = store; this.models = models; this.cluster = cluster;
    this.running = new Map(); // taskId -> true
  }

  // ---------- prompts
  systemPrompt(orgDb, { agent, project, extra } = {}) {
    const org = orgDb.org;
    const mem = orgDb.all('SELECT content FROM memory ORDER BY created_at DESC LIMIT 40').map((m) => '- ' + m.content);
    const parts = [
      agent ? `You are "${agent.name}", an AI agent working for ${org.name}.` : `You are the AI assistant for ${org.name}${org.kind === 'personal' ? ' (the owner\'s personal workspace)' : ''}.`,
      `Today is ${new Date().toDateString()}. Be accurate, concise and practical. Say clearly when you are unsure or do not have the data.`,
      `You only have information about ${org.name}. Never claim knowledge of other organisations.`,
    ];
    if (agent && agent.description) parts.push('Your role: ' + agent.description);
    if (agent && agent.instructions) parts.push('Instructions:\n' + agent.instructions);
    if (project && project.instructions) parts.push('Project instructions:\n' + project.instructions);
    if (mem.length) parts.push('Things to remember about this organisation:\n' + mem.join('\n'));
    if (agent) {
      const colleagues = this.colleaguesFor(orgDb, agent);
      if (colleagues.length) parts.push(`You can ask colleague agents for help. To do so, reply with lines of the exact form\nASK <agent name>: <question>\n(at most ${MAX_ASKS}) and nothing else. You will receive their answers and then write your final answer.\nColleagues:\n` + colleagues.map((c) => `- ${c.name}${c.orgName !== org.name ? ' (' + c.orgName + ')' : ''}: ${c.description || ''}`).join('\n'));
    }
    if (extra) parts.push(extra);
    return parts.join('\n\n');
  }

  // Same-organisation agents the agent may talk to, plus agents in organisations with an explicit cross-org workflow grant.
  colleaguesFor(orgDb, agent) {
    const allow = safeJSON(agent.can_talk_to, ['*']);
    const out = orgDb.all('SELECT id,name,description FROM agents WHERE enabled=1 AND id<>?', agent.id)
      .filter((a) => allow.includes('*') || allow.includes(a.id)).map((a) => ({ ...a, orgId: orgDb.id, orgName: orgDb.org.name }));
    for (const g of this.store.all('SELECT * FROM grants WHERE kind=\'cross_org\' AND source_org=?', orgDb.id)) {
      const tgt = this.store.getOrg(g.target_org); if (!tgt) continue;
      const scopes = safeJSON(g.scopes, []);
      const tdb = this.store.openOrg(g.target_org);
      for (const a of tdb.all('SELECT id,name,description FROM agents WHERE enabled=1')) if (scopes.includes('*') || scopes.includes(a.id)) out.push({ ...a, orgId: tgt.id, orgName: tgt.name });
    }
    return out;
  }

  findAgentByName(orgDb, name) {
    const n = name.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+agent$/, '');
    const all = orgDb.all('SELECT * FROM agents WHERE enabled=1');
    return all.find((a) => a.name.toLowerCase() === name.trim().toLowerCase())
      || all.find((a) => a.name.toLowerCase().replace(/\s+agent$/, '') === n)
      || all.find((a) => n.includes(a.name.toLowerCase().replace(/\s+agent$/, '')));
  }

  // "Ask the Freight Agent where container X is" / "@Freight Agent ..." -> { agent, question }
  detectAgentMention(orgDb, text) {
    const agents = orgDb.all('SELECT * FROM agents WHERE enabled=1');
    if (!agents.length) return null;
    const t = text.trim();
    for (const a of agents.sort((x, y) => y.name.length - x.name.length)) {
      const nm = a.name.toLowerCase(); const short = nm.replace(/\s+agent$/, '');
      const lower = t.toLowerCase();
      if (lower.startsWith('@' + nm) || lower.startsWith('@' + short)) return { agent: a, question: t.slice(1 + (lower.startsWith('@' + nm) ? nm.length : short.length)).replace(/^[\s,:]+/, '') || t };
      const m = /^(?:please\s+)?(?:ask|tell|get)\s+(?:the\s+)?(.+?)\s+(?:agent\s+)?(?:to\s+|what\s+|where\s+|when\s+|who\s+|how\s+|which\s+|if\s+|whether\s+|about\s+|for\s+)/i.exec(t);
      if (m) {
        const cand = m[1].toLowerCase().replace(/\s+agent$/, '');
        const orgName = orgDb.org.name.toLowerCase();
        const cleaned = cand.replace(orgName, '').trim();
        if (cand === short || cleaned === short || cand.endsWith(short) || short.endsWith(cleaned)) return { agent: a, question: t };
      }
    }
    return null;
  }

  // ---------- conversation history -> model messages
  historyMessages(orgDb, convId, budgetTokens, upToMsgId) {
    let rows = orgDb.all('SELECT * FROM messages WHERE conv_id=? ORDER BY created_at, rowid', convId).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (upToMsgId) { const i = rows.findIndex((m) => m.id === upToMsgId); if (i >= 0) rows = rows.slice(0, i + 1); }
    const out = []; let used = 0;
    const chosen = new Set(); for (const m of rows) { const x = safeJSON(m.meta, {}); if (x.compare && x.compare.chosen) chosen.add(x.compare.of); }
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i]; const meta = safeJSON(m.meta, {});
      if (meta.pending || meta.error || meta.system || meta.blocked) continue;
      // In a comparison only one answer is remembered: the one you kept, or else the first.
      if (meta.compare && (chosen.has(meta.compare.of) ? !meta.compare.chosen : meta.compare.slot > 0)) continue;
      let content = m.content;
      const images = [];
      const atts = orgDb.all('SELECT * FROM attachments WHERE message_id=?', m.id);
      for (const a of atts) {
        if (isImage(a.mime, a.name)) {
          if (i === rows.length - 1 || out.length < 4) { try { images.push({ mime: imageMime(a.mime, a.name), b64: fs.readFileSync(path.join(orgDb.dir, 'files', a.path)).toString('base64') }); } catch {} }
        } else if (a.text) content = `[Attached file: ${a.name}]\n${a.text}\n[End of ${a.name}]\n\n` + content;
      }
      const t = estTokens(content);
      if (used + t > budgetTokens && out.length) break;
      used += t;
      out.unshift({ role: m.role, content, images });
    }
    return { messages: out, tokens: used };
  }

  // ---------- chat
  // emit(event, data) streams to the browser.
  async chat(orgDb, user, convId, input, emit, signal) {
    const conv = orgDb.get('SELECT * FROM conversations WHERE id=?', convId);
    if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
    const text = String(input.text || '').trim();
    const msgId = uid('msg_');
    orgDb.run('INSERT INTO messages(id,conv_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?)', msgId, convId, 'user', text, JSON.stringify({ by: user.username }), now());
    for (const aid of input.attachments || []) orgDb.run('UPDATE attachments SET message_id=?, conv_id=? WHERE id=? AND message_id IS NULL', msgId, convId, aid);
    const title = conv.title === 'New conversation' ? text.slice(0, 60) || 'Conversation' : conv.title;
    orgDb.run('UPDATE conversations SET updated_at=?, title=?, model_mode=?, sensitivity=?, web=?, model_pick=? WHERE id=?', now(), title, input.mode || conv.model_mode, input.sensitivity || conv.sensitivity, input.web ? 1 : 0, input.model ? 'm:' + input.model : null, convId);
    emit('user', { id: msgId, title });

    // "remember that ..." -> organisation memory
    const rem = /^remember(?: that)?[:\s]+(.+)/i.exec(text);
    if (rem) {
      orgDb.run('INSERT INTO memory(id,content,source,created_at) VALUES(?,?,?,?)', uid('mem_'), rem[1].trim(), 'chat:' + user.username, now());
      orgDb.audit(user.username, 'memory.add', rem[1].slice(0, 200));
      return this.saveAssistant(orgDb, convId, `Saved to ${orgDb.org.name} memory: "${rem[1].trim()}"`, { system: true }, emit);
    }

    // Ask several models at once: each answers in its own message, side by side.
    if (Array.isArray(input.compare) && input.compare.length > 1) return this.compare(orgDb, conv, msgId, input, text, emit, signal);
    // Debate / Expert team: several models in turn, built as a one-off pipeline.
    if (input.multi && ['debate', 'expert'].includes(input.multi.mode)) {
      const project0 = conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null;
      return this.runPipeline(orgDb, convId, this.multiPipeline(orgDb, input, text), { input, project: project0 }, emit, signal);
    }
    // Talk to an agent (it works with its own tools, mailboxes and browser)
    const mention = this.detectAgentMention(orgDb, text);
    if (mention) return this.toolChat(orgDb, user, conv, input, emit, signal, mention.agent, mention.question);
    const project = conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null;
    // Hybrid routing: a named pipeline (Ideate → Execute → Review), chosen directly or as the organisation's Auto mode.
    const pol = orgDb.policy();
    const pipeId = input.model && String(input.model).startsWith('pipeline:') ? String(input.model).slice(9) : (!input.model && (input.mode || 'auto') === 'auto' && pol.default_mode === 'hybrid' && pol.pipeline) ? pol.pipeline : null;
    if (pipeId) return this.runPipeline(orgDb, convId, pipeId, { input, project }, emit, signal);
    const needVision = (input.attachments || []).some((id) => { const a = orgDb.get('SELECT * FROM attachments WHERE id=?', id); return a && isImage(a.mime, a.name); });
    const pre = this.historyMessages(orgDb, convId, 100000);
    // With tools: research, files, documents, code, charts, scheduling… (unless switched off or no tool-capable model)
    const prof = input.model && String(input.model).startsWith('profile:') ? this.models.profile(String(input.model).slice(8)) : null;
    const tools = (this.app.runtime.assistantProfile(orgDb).tools || []).length && input.tools !== false && !(prof && !prof.tools);
    if (tools) {
      const dt = this.models.decide({ orgDb, mode: input.mode, model: input.model, sensitivity: input.sensitivity, needVision, text, tokens: pre.tokens, needTools: true, where: input.where });
      if (!dt.blocked && !dt.noTools) return this.toolChat(orgDb, user, conv, input, emit, signal, null, null, needVision);
    }
    const decision = this.models.decide({ orgDb, mode: input.mode, model: input.model, sensitivity: input.sensitivity, web: input.web, needVision, text, tokens: pre.tokens, where: input.where });
    if (decision.blocked) {
      if (decision.approvable) {
        const askPolicy = orgDb.policy().default_mode === 'ask_cloud' && (input.sensitivity || 'normal') !== 'finance';
        const ap = this.createApproval(orgDb, { kind: 'external_model', title: askPolicy ? `Send to ${decision.want.model} (leaves your network)` : `Use ${decision.want.model} for finance data`, detail: text.slice(0, 500), requestedBy: user.username,
          payload: { type: 'chat', convId, userMsgId: msgId, providerType: decision.want.providerType, input: { ...input, approved: true } } });
        return this.saveAssistant(orgDb, convId, askPolicy ? `${orgDb.org.name}'s policy is **ask before cloud**: this request would go to ${decision.want.model}, which leaves your network.\n\nAn approval request was created. Once approved, the answer appears here. Or pick a local model from the menu.` : `This conversation is marked **Finance**, and ${orgDb.org.name}'s policy needs approval before finance data is sent to an external model (${decision.want.model}).\n\nAn approval request was created. Once it is approved, the answer will appear here. You can also switch the model to a local one.`, { approvalId: ap.id, pending: true, alternatives: this.alternativesFor(orgDb, { kind: 'cloud', providerId: 'x', model: decision.want.model }, { content: text }) }, emit);
      }
      return this.saveAssistant(orgDb, convId, decision.reasons[decision.reasons.length - 1], { blocked: true, reasons: decision.reasons, alternatives: decision.alternatives || undefined, capability: decision.capability || undefined }, emit);
    }
    return this.answer(orgDb, convId, decision, project, emit, signal);
  }

  // Debate: propose → critique → independent check → final answer. Expert team: specialists chosen by purpose.
  multiPipeline(orgDb, input, text) {
    const m = input.multi; const models = (m.models || []).map((v) => (v.startsWith('m:') ? v.slice(2) : v));
    if (m.mode === 'debate') {
      const [a, b, c] = [models[0] || 'auto', models[1] || 'auto', models[2] || models[0] || 'auto'];
      return { id: 'debate', name: 'Debate', stages: [
        { name: 'Propose', role: 'ideate', pick: a, instruction: 'Give your best complete answer to the question.' },
        { name: 'Critique', role: 'custom', pick: b, instruction: 'Critique the proposed answer above: list factual errors, weak reasoning, missing points and risks. Be specific. Do not rewrite the answer.' },
        { name: 'Check', role: 'custom', pick: c, instruction: 'Independently answer the original question without relying on the proposal, then note where you agree or disagree with the proposal and the critique.' },
        { name: 'Final answer', role: 'execute', pick: a, instruction: 'Using the proposal, the critique and the independent check above, write the final answer for the user. Fix every valid criticism, keep what held up, and do not mention the process.' } ] };
    }
    const hasImages = (input.attachments || []).some((id) => { const at = orgDb.get('SELECT * FROM attachments WHERE id=?', id); return at && isImage(at.mime, at.name); });
    const coding = /```|\b(code|function|script|website|app|bug|api|python|javascript|typescript|html|css|sql)\b/i.test(text);
    const stages = [];
    if (hasImages) stages.push({ name: 'Look (vision)', role: 'custom', pick: 'best_vision', instruction: 'Describe everything relevant in the attached image(s) precisely, so the next experts can work from your description.' });
    stages.push({ name: 'Plan (reasoning)', role: 'ideate', pick: 'best_reasoning', instruction: 'Think through the request step by step and write a short plan: what the answer must contain, pitfalls, and checks.' });
    stages.push({ name: coding ? 'Build (coding)' : 'Write (best quality)', role: 'execute', pick: coding ? 'best_coding' : 'best_quality', instruction: coding ? 'Following the plan, write the complete, working code and a short explanation.' : 'Following the plan, write the full answer.' });
    stages.push({ name: 'Review', role: 'review', pick: 'auto', instruction: 'Review the answer above against the plan: correctness, completeness, clarity. List any problems in 3–6 short bullets, or say it is good.', optional: true });
    return { id: 'expert', name: 'Expert team', stages };
  }
  chooseAnswer(orgDb, convId, msgId) {
    const m = orgDb.get('SELECT * FROM messages WHERE id=? AND conv_id=?', msgId, convId); const meta = m && safeJSON(m.meta, {});
    if (!meta || !meta.compare) throw Object.assign(new Error('Not part of a comparison'), { status: 400 });
    for (const x of orgDb.all('SELECT * FROM messages WHERE conv_id=?', convId)) { const mm = safeJSON(x.meta, {}); if (mm.compare && mm.compare.of === meta.compare.of) { mm.compare.chosen = x.id === msgId; orgDb.run('UPDATE messages SET meta=? WHERE id=?', JSON.stringify(mm), x.id); } }
    return { ok: true };
  }
  async compare(orgDb, conv, msgId, input, text, emit, signal) {
    const picks = [...new Set(input.compare.map(String))].slice(0, 3);
    const project = conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null;
    const needVision = (input.attachments || []).some((id) => { const a = orgDb.get('SELECT * FROM attachments WHERE id=?', id); return a && isImage(a.mime, a.name); });
    const pre = this.historyMessages(orgDb, conv.id, 100000);
    emit('compare', { count: picks.length, of: msgId });
    const results = await Promise.all(picks.map(async (pick, slot) => {
      const e2 = (ev, data) => emit(ev, { ...(data || {}), slot });
      const req = pick.startsWith('m:') ? { mode: 'other', model: pick.slice(2) } : { mode: pick, model: null };
      const d = this.models.decide({ orgDb, ...req, sensitivity: input.sensitivity, web: input.web, needVision, text, tokens: pre.tokens, where: input.where });
      if (d.blocked) return this.saveAssistant(orgDb, conv.id, d.reasons[d.reasons.length - 1], { blocked: true, alternatives: d.alternatives, compare: { slot, of: msgId }, pick }, e2);
      return this.answer(orgDb, conv.id, d, project, e2, signal, null, { pick, compare: { slot, of: msgId, count: picks.length } });
    }));
    emit('compare_done', { count: results.length });
    return results[0];
  }
  async answer(orgDb, convId, decision, project, emit, signal, upToMsgId, opts = {}) {
    emit('route', { label: decision.label, reasons: decision.reasons, why: decision.why, scope: decision.scope });
    const budget = decision.kind === 'local' ? 12000 : 80000;
    const { messages } = this.historyMessages(orgDb, convId, budget, upToMsgId);
    if (opts.extraMessages) messages.push(...opts.extraMessages);
    const startedAt = now(); let acc = ''; let thinking = ''; const fallbacks = []; const trace = [...(decision.trace || [])];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user') || {};
    if (decision.whyNot && decision.whyNot.length) emit('whynot', { list: decision.whyNot });
    for (const t of trace) emit('trace', { text: t });
    try {
      const r = await this.models.run(decision, { orgDb, system: this.systemPrompt(orgDb, { project }), messages, onDelta: (d) => { acc += d; emit('delta', { d }); }, onThinking: (t) => { thinking += t; emit('thinking', { d: t }); }, onStats: (st) => emit('stats', st), onProgress: (pg) => emit('progress', pg), signal,
        text: lastUser.content || '', tokens: estTokens(messages.map((m) => m.content).join('\n')), sensitivity: (orgDb.get('SELECT sensitivity FROM conversations WHERE id=?', convId) || {}).sensitivity, needVision: !!(lastUser.images && lastUser.images.length),
        onFallback: (f) => { fallbacks.push(f); emit('fallback', f); }, trace: (t) => { trace.push(t); emit('trace', { text: t }); } });
      const label = opts.label || (upToMsgId && !opts.rerun ? (orgDb.get('SELECT content FROM messages WHERE id=?', upToMsgId) || {}).content : null);
      const meta = { model: r.model, provider: r.provider, node: r.node, endpoint: r.endpointLabel, scope: r.scope, cost: r.cost, tokens: [r.inputTokens, r.outputTokens], route: decision.reasons, why: r.why || decision.why, whyNot: r.whyNot && r.whyNot.length ? r.whyNot.slice(0, 12) : undefined, trace: trace.slice(0, 80), fallbacks: fallbacks.length ? fallbacks : undefined, stats: r.stats, stop: r.stop, truncated: r.stop === 'length', startedAt, finishedAt: now(), thinking: thinking ? thinking.slice(0, 20000) : undefined, rerunOf: opts.rerun ? upToMsgId : undefined, pick: opts.pick, compare: opts.compare };
      if (opts.appendTo) return this.appendToMessage(orgDb, opts.appendTo, r.text, meta, emit);
      return this.saveAssistant(orgDb, convId, (label ? `> _Approved answer to:_ ${label.slice(0, 200).replace(/\n/g, ' ')}\n\n` : '') + r.text, meta, emit, true);
    } catch (e) {
      if (signal && signal.aborted) {
        if (opts.appendTo) return this.appendToMessage(orgDb, opts.appendTo, acc, { stopped: true, truncated: true }, emit);
        return this.saveAssistant(orgDb, convId, acc ? acc : '_(stopped)_', { stopped: true, truncated: !!acc, model: decision.model, startedAt, finishedAt: now(), compare: opts.compare }, emit, true);
      }
      const info = e.info || null;
      return this.saveAssistant(orgDb, convId, info ? `**${info.title}**\n\n${info.text}${e.cooldown ? `\n\nForgeAI has set ${info.model || decision.model} aside for automatic routing for ${e.cooldown.minutes} minutes after ${e.cooldown.n} failures.` : ''}${info.next ? `\n\nNext: ${info.next}` : ''}` : e.message, { error: true, retryable: true, errorInfo: info ? { ...info, raw: (info.raw || '').slice(0, 4000) } : undefined, model: decision.model, endpoint: e.endpoint, startedAt, finishedAt: now(), partial: acc || undefined, compare: opts.compare, pick: opts.pick, fallbacks: fallbacks.length ? fallbacks : undefined, trace: trace.slice(0, 80), alternatives: this.alternativesFor(orgDb, decision, lastUser) }, emit, true);
    }
  }
  // Buttons for a failed answer: the models Auto would try next (never the one that just failed).
  alternativesFor(orgDb, decision, lastUser) {
    try { const failed = decision.kind === 'local' ? decision.model : `cloud:${decision.providerId}:${decision.model}`;
      const d = this.models.decide({ orgDb, mode: 'auto', model: null, text: (lastUser && lastUser.content) || '', needVision: !!(lastUser && lastUser.images && lastUser.images.length), excludeIds: [failed], _nofb: true });
      if (!d || d.blocked) return undefined; const v = d.kind === 'local' ? 'm:local:' + d.model : `m:cloud:${d.providerId}:${d.model}`; return [{ value: v, label: d.label }]; } catch { return undefined; }
  }
  // "Continue": resume an answer that stopped early, appending to the same message.
  appendToMessage(orgDb, msgId, text, meta, emit) {
    const m = orgDb.get('SELECT * FROM messages WHERE id=?', msgId); const old = safeJSON(m.meta, {});
    const content = m.content.replace(/_\(stopped\)_$/, '') + text;
    const merged = { ...old, ...meta, tokens: old.tokens && meta.tokens ? [old.tokens[0] + meta.tokens[0], old.tokens[1] + meta.tokens[1]] : meta.tokens || old.tokens, continued: (old.continued || 0) + 1, startedAt: old.startedAt || meta.startedAt };
    orgDb.run('UPDATE messages SET content=?, meta=? WHERE id=?', content, JSON.stringify(merged), msgId);
    const msg = { id: msgId, role: 'assistant', content, meta: merged, created_at: m.created_at };
    emit && emit('done', { message: msg, streamed: true, replace: msgId });
    return msg;
  }
  async continueMessage(orgDb, convId, msgId, input, emit, signal) {
    const m = orgDb.get('SELECT * FROM messages WHERE id=? AND conv_id=?', msgId, convId);
    if (!m || m.role !== 'assistant') throw Object.assign(new Error('Nothing to continue'), { status: 400 });
    const decision = this.models.decide({ orgDb, mode: input.mode, model: input.model, sensitivity: input.sensitivity, text: m.content.slice(-2000) });
    if (decision.blocked) throw Object.assign(new Error(decision.reasons[decision.reasons.length - 1]), { status: 400 });
    const conv = orgDb.get('SELECT * FROM conversations WHERE id=?', convId);
    const project = conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null;
    return this.answer(orgDb, convId, decision, project, emit, signal, msgId, { appendTo: msgId, extraMessages: [{ role: 'user', content: 'Continue exactly where your previous message stopped. Do not repeat anything already written and do not add an introduction — start with the very next words.' }] });
  }
  // Re-run an earlier request with the same or a different model; the new answer is added at the end.
  async rerun(orgDb, user, convId, userMsgId, input, emit, signal) {
    const m = orgDb.get('SELECT * FROM messages WHERE id=? AND conv_id=?', userMsgId, convId);
    if (!m || m.role !== 'user') throw Object.assign(new Error('Pick one of your messages to re-run'), { status: 400 });
    const conv = orgDb.get('SELECT * FROM conversations WHERE id=?', convId);
    const project = conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null;
    const pre = this.historyMessages(orgDb, convId, 100000, userMsgId);
    const decision = this.models.decide({ orgDb, mode: input.mode, model: input.model, sensitivity: input.sensitivity, web: input.web, text: m.content, tokens: pre.tokens });
    if (decision.blocked) return this.saveAssistant(orgDb, convId, decision.reasons[decision.reasons.length - 1], { blocked: true }, emit);
    emit('user', { id: null, title: conv.title });
    return this.answer(orgDb, convId, decision, project, emit, signal, userMsgId, { rerun: true, pick: input.model || input.mode, label: null });
  }

  // ---------- Hybrid pipelines: each stage has its own model and fallback; the last stage writes the answer.
  pipelines() { return this.store.getSetting('pipelines', DEFAULT_PIPELINES); }
  async runPipeline(orgDb, convId, pipeId, { input, project }, emit, signal) {
    const pipe = typeof pipeId === 'object' ? pipeId : this.pipelines().find((p) => p.id === pipeId);
    if (!pipe) return this.saveAssistant(orgDb, convId, 'That pipeline no longer exists (Models → Pipelines).', { error: true }, emit);
    const stages = pipe.stages.filter((s) => s.enabled !== false);
    const { messages: hist, tokens } = this.historyMessages(orgDb, convId, 60000);
    const question = (hist[hist.length - 1] || {}).content || input.text || '';
    const done = []; const startedAt = now(); let finalText = ''; let finalRun = null;
    const pick = (p) => (!p || p === 'auto' ? { mode: 'auto', model: null } : /^(profile|local|cloud):/.test(p) ? { mode: 'other', model: p } : { mode: p, model: null });
    emit('route', { label: `${pipe.name} · ${stages.length} stages`, reasons: [`Hybrid pipeline “${pipe.name}”`] });
    for (let i = 0; i < stages.length; i++) {
      const stg = stages[i]; const isFinal = i === stages.length - 1 || stages.slice(i + 1).every((x) => x.role === 'review');
      let decision = null; const tried = [];
      for (const cand of [stg.pick, stg.fallback].filter(Boolean)) {
        const d = this.models.decide({ orgDb, ...pick(cand), sensitivity: input.sensitivity, text: question, tokens });
        tried.push(cand); if (!d.blocked) { decision = d; break; }
      }
      if (!decision) {
        if (stg.optional || stg.role === 'review') { done.push({ name: stg.name, skipped: true, reason: 'No allowed model for this stage' }); continue; }
        return this.saveAssistant(orgDb, convId, `Stage “${stg.name}” could not run: no allowed model (tried ${tried.join(', ')}). Next: change the stage’s model or fallback in Models → Pipelines.`, { error: true, retryable: true, stages: done }, emit);
      }
      emit('stage', { index: i, total: stages.length, name: stg.name, model: decision.label, scope: decision.scope });
      const prior = done.filter((d) => d.text).map((d) => `## ${d.name} (by ${d.model})\n${d.text}`).join('\n\n');
      const instruction = stg.instruction || DEFAULT_STAGE_TEXT[stg.role] || '';
      const msgs = [...hist.slice(0, -1), { role: 'user', content: `${question}${prior ? '\n\n---\nWork from the earlier stages:\n\n' + prior : ''}\n\n---\nYour stage: ${stg.name}. ${instruction}` }];
      let thinking = '';
      try {
        const r = await this.models.run(decision, { orgDb, system: this.systemPrompt(orgDb, { project }), messages: msgs, stage: stg.name, signal,
          onDelta: (d) => (isFinal && stg.role !== 'review' ? emit('delta', { d }) : emit('stage_delta', { index: i, d })), onThinking: (t) => { thinking += t; emit('thinking', { d: t }); }, onStats: (st) => emit('stats', { ...st, stage: stg.name }), onProgress: (pg) => emit('progress', { ...pg, stage: stg.name }) });
        done.push({ name: stg.name, role: stg.role, model: r.model, endpoint: r.endpointLabel, scope: r.scope, text: r.text, stats: r.stats, cost: r.cost });
        if (stg.role !== 'review') { finalText = r.text; finalRun = r; }
      } catch (e) {
        if (signal && signal.aborted) return this.saveAssistant(orgDb, convId, finalText || '_(stopped)_', { stopped: true, stages: done }, emit, true);
        if (stg.optional || stg.role === 'review') { done.push({ name: stg.name, skipped: true, reason: e.message }); continue; }
        return this.saveAssistant(orgDb, convId, `Stage “${stg.name}” failed: ${e.message}`, { error: true, retryable: true, stages: done }, emit, true);
      }
    }
    const review = done.find((d) => d.role === 'review' && d.text);
    const meta = { pipeline: pipe.name, stages: done.map((d) => ({ ...d, text: d.role === 'review' || d.text === finalText ? undefined : d.text })), review: review ? review.text : undefined,
      model: finalRun && finalRun.model, endpoint: finalRun && finalRun.endpointLabel, scope: done.some((d) => d.scope === 'internet') ? 'internet' : finalRun && finalRun.scope, cost: done.reduce((a, d) => a + (d.cost || 0), 0), stats: finalRun && finalRun.stats, startedAt, finishedAt: now(), truncated: finalRun && finalRun.stop === 'length' };
    return this.saveAssistant(orgDb, convId, finalText, meta, emit, true);
  }

  // A chat turn handled by the agent runtime. Steps stream to the browser; approvals pause it.
  async toolChat(orgDb, user, conv, input, emit, signal, agent, question, needVision) {
    const hist = this.historyMessages(orgDb, conv.id, 60000).messages;
    const last = hist.pop() || { content: question || input.text, images: [] };
    const history = hist.map((m, i) => ({ role: m.role, content: m.content, images: i >= hist.length - 2 ? m.images : [] }));
    const task = this.createTask(orgDb, { agentId: agent ? agent.id : null, title: String(question || input.text || 'Chat').slice(0, 80), input: agent ? question || last.content : last.content, createdBy: user.username, convId: conv.id });
    orgDb.run('UPDATE tasks SET kind=?, conv_id=?, route=? WHERE id=?', agent ? 'agent' : 'chat', conv.id, JSON.stringify(agent ? {} : { mode: input.mode, model: input.model, sensitivity: input.sensitivity, where: input.where || null, history, images: last.images || [], vision: !!needVision }), task.id);
    if (agent) emit('route', { label: agent.name, reasons: ['Handed to ' + agent.name] });
    const r = await this.app.runtime.run(orgDb, task.id, { signal, onEvent: (e) => {
      if (e.type === 'route' && !agent) emit('route', { label: e.label, reasons: e.reasons });
      if (e.type === 'step') emit('step', e.step);
      if (e.type === 'thinking') emit('thinking', { d: e.text + '\n' });
      if (e.type === 'stats') emit('stats', { ...e.stats, endpoint: e.endpoint, scope: e.scope, model: e.model, step: e.step });
      if (e.type === 'progress') { const { type, ...pg } = e; emit('progress', pg); }
      if (e.type === 'fallback') { const { type, ...f } = e; emit('fallback', f); }
    } });
    return this.finishChatTask(orgDb, task.id, r, emit);
  }
  finishChatTask(orgDb, taskId, r, emit) {
    const t = orgDb.get('SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?', taskId);
    if (!t || !t.conv_id) return null;
    orgDb.run('DELETE FROM messages WHERE conv_id=? AND meta LIKE ?', t.conv_id, `%"waitingTask":"${taskId}"%`);
    const steps = orgDb.get('SELECT COUNT(*) c FROM steps WHERE task_id=? AND kind=\'call\'', taskId).c;
    const base = { taskId, agent: t.agent_name || null, agentId: t.agent_id || null, steps };
    if (r && r.paused) return this.saveAssistant(orgDb, t.conv_id, `Waiting for your approval: **${r.title}**`, { ...base, waitingTask: taskId, approvalId: r.approvalId, pending: true }, emit);
    if (r && r.error) return this.saveAssistant(orgDb, t.conv_id, r.error, { ...base, error: true, retryable: !/Stopped/.test(r.error), startedAt: t.started_at || t.created_at, finishedAt: now() }, emit);
    if (emit && r && r.text) { for (let i = 0; i < r.text.length; i += 24) emit('delta', { d: r.text.slice(i, i + 24) }); }
    return this.saveAssistant(orgDb, t.conv_id, (r && r.text) || '', { ...base, model: r && r.model, node: r && r.node, endpoint: r && r.endpoint, scope: r && r.scope, stats: r && r.stats, truncated: r && r.stop === 'length', startedAt: t.started_at || t.created_at, finishedAt: now(), files: (r && r.files) || [] }, emit, true);
  }

  saveAssistant(orgDb, convId, content, meta, emit, streamed) {
    const id = uid('msg_');
    orgDb.run('INSERT INTO messages(id,conv_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?)', id, convId, 'assistant', content, JSON.stringify(meta || {}), now());
    orgDb.run('UPDATE conversations SET updated_at=? WHERE id=?', now(), convId);
    const msg = { id, role: 'assistant', content, meta, created_at: now() };
    emit && emit('done', { message: msg, streamed: !!streamed });
    return msg;
  }

  // ---------- tasks & agents
  createTask(orgDb, { agentId, title, input, createdBy, parentTask, dueAt, convId }) {
    const id = uid('task_');
    orgDb.run('INSERT INTO tasks(id,agent_id,title,input,status,created_by,parent_task,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, agentId, title || (input || '').slice(0, 80), input, 'queued', createdBy || 'system', parentTask || null, dueAt || null, now());
    orgDb.audit(createdBy, 'task.create', { id, agentId, title, convId });
    return orgDb.get('SELECT * FROM tasks WHERE id=?', id);
  }

  // Agent work runs in the tool runtime (browser, email, files, documents, code, connectors…).
  async runTask(orgDb, taskId, { signal, depth = 0 } = {}) {
    const r = await this.app.runtime.run(orgDb, taskId, { signal, depth });
    return r.text || r.error || (r.paused ? 'Waiting for approval: ' + r.title : '');
  }

  // ---------- approvals
  createApproval(orgDb, { kind, title, detail, payload, requestedBy }) {
    const id = uid('apr_');
    orgDb.run('INSERT INTO approvals(id,kind,title,detail,payload,status,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?)', id, kind, title, detail, JSON.stringify(payload || {}), 'pending', requestedBy, now());
    orgDb.audit(requestedBy, 'approval.request', { id, kind, title });
    return { id };
  }
  async decideApproval(orgDb, id, approve, user) {
    const a = orgDb.get('SELECT * FROM approvals WHERE id=?', id);
    if (!a || a.status !== 'pending') throw Object.assign(new Error('Approval not pending'), { status: 400 });
    orgDb.run('UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=?', approve ? 'approved' : 'rejected', user.username, now(), id);
    orgDb.audit(user.username, approve ? 'approval.approve' : 'approval.reject', { id, title: a.title });
    const p = safeJSON(a.payload, {});
    if (p.type === 'agent_output') orgDb.run('UPDATE tasks SET status=? WHERE id=?', approve ? 'done' : 'rejected', p.taskId);
    if (p.type === 'action') {
      this.app.runtime.run(orgDb, p.taskId, { resume: { approve: !!approve, by: user.username } })
        .then((r) => { this.finishChatTask(orgDb, p.taskId, r); this.afterTask(orgDb, p.taskId, r); }).catch(() => {});
    }
    if (p.type === 'chat') {
      // Clear the pending placeholder, then answer (or record the rejection).
      orgDb.run('DELETE FROM messages WHERE conv_id=? AND meta LIKE ?', p.convId, `%"approvalId":"${id}"%`);
      if (!approve) this.saveAssistant(orgDb, p.convId, `Approval rejected by ${user.username}. Nothing was sent to an external model.`, {});
      else {
        const conv = orgDb.get('SELECT * FROM conversations WHERE id=?', p.convId);
        const decision = this.models.decide({ orgDb, mode: p.input.mode, model: p.input.model, sensitivity: p.input.sensitivity, web: p.input.web, text: '', approved: true });
        if (decision.blocked) this.saveAssistant(orgDb, p.convId, decision.reasons[decision.reasons.length - 1], {});
        else this.answer(orgDb, p.convId, decision, conv && conv.project_id ? orgDb.get('SELECT * FROM projects WHERE id=?', conv.project_id) : null, () => {}, null, p.userMsgId);
      }
    }
  }

  // ---------- scheduler
  static nextRun(schedule, from = new Date()) {
    const s = typeof schedule === 'string' ? safeJSON(schedule, null) : schedule;
    if (!s || !s.type || s.type === 'none') return null;
    if (s.type === 'interval') return new Date(from.getTime() + Math.max(5, +s.minutes || 60) * 60000).toISOString();
    if (s.type === 'daily') {
      const [h, m] = String(s.time || '08:00').split(':').map(Number);
      const days = s.days && s.days.length ? s.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
      const d = new Date(from); d.setSeconds(0, 0); d.setHours(h, m || 0);
      for (let i = 0; i < 8; i++) {
        if (d > from && days.includes(d.getDay())) return d.toISOString();
        d.setDate(d.getDate() + 1); d.setHours(h, m || 0);
      }
    }
    return null;
  }
  // Called after any background task finishes: post scheduled results to chat and notify.
  afterTask(orgDb, taskId, r) {
    const t = orgDb.get('SELECT * FROM tasks WHERE id=?', taskId); if (!t || !r || r.paused) return;
    if (t.kind === 'job' && t.conv_id) { this.finishChatTask(orgDb, taskId, r); this.app.notify(orgDb, t.title, (r.text || r.error || '').slice(0, 180), '#/chat/' + t.conv_id); }
    else if (t.created_by === 'scheduler' || t.kind === 'inbox') this.app.notify(orgDb, t.title, (r.text || r.error || '').slice(0, 180), '#/tasks/' + taskId);
  }
  runJobs(db, ts) {
    const { nextFor } = require('./agent');
    for (const j of db.all('SELECT * FROM jobs WHERE enabled=1 AND next_run<=?', ts.toISOString())) {
      const rep = safeJSON(j.repeat, { type: 'once' }); const nx = nextFor(rep, new Date(j.next_run));
      let n = nx; while (n && n <= ts) n = nextFor(rep, n);
      db.run('UPDATE jobs SET last_run=?, next_run=?, enabled=? WHERE id=?', ts.toISOString(), n ? n.toISOString() : j.next_run, n ? 1 : 0, j.id);
      let conv = j.conv_id && db.get('SELECT id FROM conversations WHERE id=?', j.conv_id);
      if (!conv) { const cid = uid('conv_'); db.run('INSERT INTO conversations(id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?)', cid, 'Scheduled: ' + j.title, j.created_by, now(), now()); db.run('UPDATE jobs SET conv_id=? WHERE id=?', cid, j.id); conv = { id: cid }; }
      db.run('INSERT INTO messages(id,conv_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?)', uid('msg_'), conv.id, 'user', `⏰ ${j.title}\n\n${j.instruction}`, JSON.stringify({ by: 'Schedule' }), now());
      const t = this.createTask(db, { agentId: j.agent_id || null, title: j.title, input: `Scheduled task “${j.title}” (it is now ${ts.toString()}): ${j.instruction}`, createdBy: 'scheduler', convId: conv.id });
      db.run('UPDATE tasks SET kind=?, conv_id=? WHERE id=?', 'job', conv.id, t.id);
      this.app.runtime.run(db, t.id).then((r) => this.afterTask(db, t.id, r)).catch(() => {});
    }
  }
  async watchInboxes(db) {
    for (const a of db.all('SELECT * FROM agents WHERE enabled=1 AND inbox_watch IS NOT NULL')) {
      const w = safeJSON(a.inbox_watch, {}); if (!w.enabled) continue;
      const key = 'inbox_last_check:' + a.id; const last = db.kv(key);
      if (last && Date.now() - new Date(last).getTime() < Math.max(2, w.minutes || 5) * 60000) continue;
      db.setKv(key, now());
      for (const mbId of safeJSON(a.mailboxes, [])) {
        const mb = db.get('SELECT * FROM mailboxes WHERE id=?', mbId); if (!mb) continue;
        try {
          const list = await this.app.mail.list(mb, { unreadOnly: true, limit: 20 });
          const seenKey = `inbox_seen:${a.id}:${mb.id}`; const seen = db.kv(seenKey);
          const maxUid = Math.max(0, ...list.map((m) => m.uid));
          if (seen == null) { db.setKv(seenKey, maxUid); continue; } // first run: only handle mail that arrives from now on
          const fresh = list.filter((m) => m.uid > seen).slice(0, 5);
          if (maxUid > seen) db.setKv(seenKey, maxUid);
          for (const m of fresh.reverse()) {
            const t = this.createTask(db, { agentId: a.id, title: `New email: ${m.subject}`.slice(0, 80), input: `A new email arrived in ${mb.email}: #${m.uid} from ${m.from}, subject “${m.subject}”. Read it with email_read (mailbox ${mb.email}, uid ${m.uid}) and handle it. ${w.instruction || 'Summarise it and draft a suitable reply for approval.'}`, createdBy: 'inbox' });
            db.run('UPDATE tasks SET kind=? WHERE id=?', 'inbox', t.id);
            this.app.runtime.run(db, t.id).then((r) => this.afterTask(db, t.id, r)).catch(() => {});
          }
        } catch (e) { db.audit(a.name, 'inbox.error', e.message); }
      }
    }
  }
  tick() {
    const ts = new Date();
    for (const o of this.store.listOrgs()) {
      const db = this.store.openOrg(o.id);
      try { this.runJobs(db, ts); } catch (e) { console.error('jobs', e); }
      this.watchInboxes(db).catch(() => {});
      for (const a of db.all('SELECT * FROM agents WHERE enabled=1 AND schedule IS NOT NULL')) {
        const s = safeJSON(a.schedule, null);
        if (!s || s.type === 'none') continue;
        if (!a.next_run) { db.run('UPDATE agents SET next_run=? WHERE id=?', Engine.nextRun(s, ts), a.id); continue; }
        if (new Date(a.next_run) <= ts) {
          db.run('UPDATE agents SET next_run=? WHERE id=?', Engine.nextRun(s, ts), a.id);
          const t = this.createTask(db, { agentId: a.id, title: `Scheduled: ${a.name}`, input: a.schedule_prompt || 'Do your scheduled work and report back.', createdBy: 'scheduler' });
          this.app.runtime.run(db, t.id).then((r) => this.afterTask(db, t.id, r)).catch(() => {});
        }
      }
    }
  }

  // ---------- Owner AI (cross-organisation, explicit grants only)
  ownerContext() {
    const grants = this.store.all('SELECT * FROM grants WHERE kind=\'owner_ai\'');
    const blocks = []; const orgs = [];
    for (const g of grants) {
      const org = this.store.getOrg(g.target_org); if (!org || org.archived) continue;
      const scopes = safeJSON(g.scopes, []);
      const db = this.store.openOrg(org.id); const pol = db.policy();
      orgs.push({ org, pol });
      let b = `## ${org.name}\n`;
      if (scopes.includes('overview')) {
        const s = orgStats(db);
        b += `Agents: ${s.agents} (${s.running} running). Pending approvals: ${s.approvals}. Overdue tasks: ${s.overdue}. Failed tasks (24h): ${s.failed24}. Cloud AI spend this month: $${s.spend.toFixed(2)}${org.cloud_budget_month ? ' of $' + org.cloud_budget_month : ''}.\n`;
        const ap = db.all('SELECT title, requested_by, created_at FROM approvals WHERE status=\'pending\' ORDER BY created_at DESC LIMIT 10');
        if (ap.length) b += 'Pending approvals:\n' + ap.map((x) => `- ${x.title} (from ${x.requested_by}, ${x.created_at.slice(0, 10)})`).join('\n') + '\n';
        const od = db.all('SELECT title, due_at FROM tasks WHERE due_at IS NOT NULL AND due_at<? AND status NOT IN (\'done\',\'rejected\') LIMIT 10', now());
        if (od.length) b += 'Overdue tasks:\n' + od.map((x) => `- ${x.title} (due ${x.due_at.slice(0, 10)})`).join('\n') + '\n';
      }
      if (scopes.includes('reports')) {
        const rep = db.all('SELECT t.title, t.output, t.finished_at, a.name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.status=\'done\' ORDER BY t.finished_at DESC LIMIT 8');
        if (rep.length) b += 'Recent agent reports:\n' + rep.map((x) => `### ${x.name || 'Agent'} — ${x.title} (${(x.finished_at || '').slice(0, 10)})\n${String(x.output || '').slice(0, 1500)}`).join('\n') + '\n';
      }
      if (scopes.includes('documents')) {
        const docs = db.all('SELECT name, text FROM documents WHERE share_owner_ai=1 ORDER BY created_at DESC LIMIT 10');
        if (docs.length) b += 'Shared documents:\n' + docs.map((d) => `### ${d.name}\n${String(d.text || '').slice(0, 4000)}`).join('\n') + '\n';
      }
      if (scopes.includes('memory')) {
        const mem = db.all('SELECT content FROM memory ORDER BY created_at DESC LIMIT 20');
        if (mem.length) b += 'Key facts:\n' + mem.map((m) => '- ' + m.content).join('\n') + '\n';
      }
      blocks.push(b);
    }
    return { text: blocks.join('\n'), orgs };
  }
}

function orgStats(db) {
  const n = now(); const day = new Date(Date.now() - 864e5).toISOString();
  const org = db.org;
  const s = {
    agents: db.get('SELECT COUNT(*) c FROM agents').c,
    running: db.get('SELECT COUNT(*) c FROM agents WHERE enabled=1').c,
    busy: db.get('SELECT COUNT(*) c FROM tasks WHERE status=\'running\'').c,
    approvals: db.get('SELECT COUNT(*) c FROM approvals WHERE status=\'pending\'').c,
    overdue: db.get('SELECT COUNT(*) c FROM tasks WHERE due_at IS NOT NULL AND due_at<? AND status NOT IN (\'done\',\'rejected\')', n).c,
    failed24: db.get('SELECT COUNT(*) c FROM tasks WHERE status=\'failed\' AND created_at>?', day).c,
    errors24: db.get('SELECT COUNT(*) c FROM usage WHERE ok=0 AND ts>?', day).c,
    spend: db.monthSpend(),
    conversations: db.get('SELECT COUNT(*) c FROM conversations').c,
  };
  s.alerts = s.failed24 + (org.cloud_budget_month && s.spend >= org.cloud_budget_month * 0.8 ? 1 : 0);
  s.health = s.failed24 > 3 || s.errors24 > 10 ? 'Attention' : 'Healthy';
  return s;
}

module.exports = { DEFAULT_PIPELINES, DEFAULT_STAGE_TEXT, Engine, orgStats };
