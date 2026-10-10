'use strict';
// Routing engine + model execution.
// decide() applies (in order): platform rules -> organisation policy -> agent settings -> task/conversation settings,
// then picks a concrete model. run() executes it, streams output, records usage/cost and enforces budgets & RAM quotas.
const { PROVIDER_TYPES, estTokens } = require('./providers');
const { explainNet, isTransient, networkScope } = require('./net');
const { now } = require('./db');
const { requirements, memoryNeeded } = require('./caps');
const { classify, KINDS } = require('./health');

const GB = 2 ** 30;
const DEFAULT_PRICES = [ // USD per 1M tokens. ESTIMATES — editable in Providers → Prices.
  ['claude-opus', 5, 25], ['claude-sonnet', 3, 15], ['claude-haiku', 1, 5],
  ['gpt-5-nano', 0.05, 0.4], ['gpt-5-mini', 0.25, 2], ['gpt-5', 1.25, 10], ['gpt-4.1-mini', 0.4, 1.6], ['gpt-4.1', 2, 8],
  ['gpt-4o-mini', 0.15, 0.6], ['gpt-4o', 2.5, 10], ['o3', 2, 8], ['o4-mini', 1.1, 4.4],
  ['gemini-2.5-pro', 1.25, 10], ['gemini-2.5-flash', 0.3, 2.5], ['gemini', 1.25, 10], ['*', 3, 15],
];
const FAMILY_OF = { openai: 'openai', anthropic: 'claude', google: 'google', openai_compat: 'other' };
const ALLOW_KEY = { openai: 'allow_openai', anthropic: 'allow_anthropic', google: 'allow_google', openai_compat: 'allow_openai' };

function paramsNum(m) {
  const x = /([\d.]+)\s*([BbMm])/.exec(m.params || m.id || '');
  if (x) return parseFloat(x[1]) * (/[Mm]/.test(x[2]) ? 0.001 : 1);
  return (m.sizeBytes || 0) / GB * 1.8;
}
function assessComplexity(text) {
  const t = String(text || ''); const L = t.length;
  const heavy = /(strateg|analy[sz]|compare|forecast|evaluate|recommend|trade-?off|legal|contract|architect|business plan|financial model|investigat|why |root cause|write (a|an) (report|proposal|plan))/i.test(t);
  if (L > 1500 || (heavy && L > 60)) return 'high';
  if (L < 220 && !heavy) return 'low';
  return 'medium';
}

class ModelService {
  constructor(store, vault, cluster) {
    this.store = store; this.vault = vault; this.cluster = cluster;
    if (!store.get('SELECT 1 FROM prices LIMIT 1')) for (const [p, i, o] of DEFAULT_PRICES) store.run('INSERT INTO prices VALUES(?,?,?)', p, i, o);
  }

  price(model) {
    const rows = this.store.all('SELECT * FROM prices');
    let best = rows.find((r) => r.pattern === '*') || { input_per_m: 3, output_per_m: 15 };
    let bestLen = 0;
    for (const r of rows) if (r.pattern !== '*' && model.includes(r.pattern) && r.pattern.length > bestLen) { best = r; bestLen = r.pattern.length; }
    return best;
  }

  // Provider configs visible to an organisation: its own credentials win over platform-wide ones.
  providersFor(orgId) {
    const rows = this.store.all('SELECT * FROM providers WHERE (org_id IS NULL OR org_id=?) AND status=\'connected\'', orgId || null);
    const byType = {};
    for (const r of rows) {
      const cur = byType[r.provider];
      if (!cur || (r.org_id && !cur.org_id)) byType[r.provider] = r;
    }
    return byType;
  }
  cloudAdapter(cfg) {
    const t = PROVIDER_TYPES[cfg.provider];
    return t.make({ apiKey: this.vault.reveal(cfg.secret_ref), baseUrl: cfg.base_url || undefined });
  }
  providerMonthSpend(providerId) {
    // Sum across all organisations that used this credential (platform-level configs are shared).
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    let t = this.store.get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE provider_id=? AND ts>=?', providerId, start.toISOString()).c; // Owner AI
    for (const o of this.store.listOrgs()) {
      t += this.store.openOrg(o.id).get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE provider_id=? AND ts>=?', providerId, start.toISOString()).c;
    }
    return t;
  }

  pickCloudModel(cfg, tier) {
    const info = safeJSON(cfg.models, {});
    if (tier === 'fast' && info.fast) return info.fast;
    if (info.default && tier !== 'fast') return info.default;
    const ids = (info.list || []).filter((m) => !m.kind || m.kind === 'chat').map((m) => m.id).sort().reverse();
    const pref = {
      anthropic: tier === 'fast' ? [/haiku/] : [/opus/, /sonnet/],
      openai: tier === 'fast' ? [/mini/, /^gpt/] : [/^gpt-\d+(\.\d+)?$/, /^gpt-\d/, /^o\d/],
      google: tier === 'fast' ? [/flash(?!.*lite)/, /flash/] : [/pro/, /flash/],
      openai_compat: [/./],
    }[cfg.provider] || [/./];
    for (const re of pref) {
      const hit = ids.find((id) => re.test(id) && !/(preview|exp|latest-?$)/.test(id)) || ids.find((id) => re.test(id));
      if (hit) return hit;
    }
    return ids[0] || info.default || null;
  }

  localCandidates(org, needVision, needTools, noInternet, opts = {}) {
    return this.report(org, { vision: needVision, tools: needTools }, { noInternet, ...opts }).eligible;
  }
  // Free memory on the machine a model would load on (null = unknown). Local: live sample; workers: last metrics seen.
  freeMemory(nodeName) {
    const local = this.cluster.nodes().find((n) => n.is_local);
    if (local && (nodeName === local.name || !nodeName)) return this.perf && this.perf.machine ? this.perf.machine.memFree : null;
    const n = this.cluster.nodes().find((x) => x.name === nodeName); const mt = n && this.cluster.metrics && this.cluster.metrics.get(n.id);
    return mt ? mt.memFree : null;
  }
  // Every local model with a verdict: eligible, or rejected with a plain reason. `req` is what the request needs.
  // Capability mismatches, context, memory preflight, health cooldowns and manual exclusions all explain themselves.
  report(org, req = {}, { noInternet = false, manual = false, ctx = 0, pol = {} } = {}) {
    const quota = (org.quota_ram_gb || 0) * GB; const ov = this.caps ? this.caps.overrides() : {}; const eligible = [], rejected = [];
    const need = req.tokens ? Math.ceil(req.tokens * 1.15) + 1024 : 0;
    for (const m of this.cluster.distinctModels()) {
      const o = ov[m.id] || {}; const vision = o.vision ?? m.vision; const tools = o.tools ?? (m.tools !== false); const name = m.alias || m.id; let ep = (m.endpoints || [m.endpoint])[0] || {};
      const context = o.context || m.loadedContext || m.context;
      const drop = (why, soft) => rejected.push({ id: m.id, name, node: ep.node, why, soft: !!soft });
      if (o.excluded) { drop('excluded in Settings → Model capabilities'); continue; }
      if (req.where && req.where !== 'auto') { // "where to run": this computer / a named computer / a cluster
        const eps = m.endpoints || [ep]; const localNode = this.cluster.nodes().find((n) => n.is_local);
        const okEp = eps.find((e) => req.where === 'local' ? (!e.node || (localNode && e.node === localNode.name)) && !e.cluster : req.where === 'cluster' ? !!e.cluster : e.node === req.where || e.name === req.where);
        if (okEp) ep = okEp; // judge memory, health and naming on the chosen computer
        if (!okEp) { drop(req.where === 'local' ? 'not on this computer' : req.where === 'cluster' ? 'not served by a cluster' : `not on ${req.where}`); continue; }
      }
      if (m.caps && m.caps.embeddings && !m.caps.chat) { drop('embeddings model, not chat'); continue; }
      if (quota && m.memBytes && m.memBytes > quota) { drop(`above ${org.name}'s memory quota (${org.quota_ram_gb} GB)`); continue; }
      if (noInternet && !(m.endpoints || [m.endpoint]).some((e) => !e || e.scope !== 'internet')) { drop('its server is on the internet and this request may not leave the network'); continue; }
      if (req.vision && !vision) { drop('cannot read images'); continue; }
      if (req.tools && !tools) { drop('cannot call tools'); continue; }
      if (req.imageGen || req.audioIn || req.audioOut) { drop(req.imageGen ? 'cannot generate images (a chat model)' : 'cannot handle audio'); continue; }
      if (pol.strict_caps !== false && !manual) { // strict: a capability only counts when the app that serves the model reported it, or you confirmed it under Model health
        const src = this.caps ? this.caps.detectLocal(m).source : {};
        if (req.vision && o.vision == null && src.vision !== 'reported') { drop('image support is only guessed — confirm it under Model health (strict capability checks)'); continue; }
        if (req.tools && o.tools == null && src.tools !== 'reported') { drop('tool support is only guessed — confirm it under Model health (strict capability checks)'); continue; }
      }
      if (!manual) { // computers lent only when idle: skip every endpoint whose computer is in use right now
        const busy = (e) => { const n = e && e.node && this.cluster.nodes().find((x) => x.name === e.node && !x.is_local); const mt = n && this.cluster.metrics && this.cluster.metrics.get(n.id); return mt && mt.availability && mt.availability.available === false ? mt.availability.reason : null; };
        const eps = m.endpoints || [ep]; const reasons = eps.map(busy); if (eps.length && reasons.every(Boolean)) { drop(`${ep.node} is lent only when idle — right now: ${reasons[0]}`, true); continue; }
      }
      if (need && context && context < need) { drop(`context too small (${Math.round(context / 1000)}k, needs ~${Math.round(need / 1000)}k)`); continue; }
      const avoid = this.health ? this.health.avoid({ model: m.id, endpoint: ep.url, machine: ep.node }) : null;
      if (avoid && !manual && !(this.health.probeAllowed({ model: m.id }))) { drop(`unhealthy: ${avoid.text.toLowerCase()}`); continue; }
      if (!m.anyLoaded && !(ep.nodeKind === 'compat' && ep.app !== 'lmstudio')) { // loading needed: does it fit?
        const free = this.freeMemory(ep.node); const mem = memoryNeeded(m, ctx || Math.min(context || 8192, 8192));
        if (free != null && m.memBytes && mem.bytes > free * 1.05 && !pol.allow_unload) { drop(`needs about ${(mem.bytes / GB).toFixed(1)} GB to load (estimate) but ${ep.node || 'its computer'} has ${(free / GB).toFixed(1)} GB free`, true); continue; }
      }
      eligible.push({ ...m, vision, tools, context, avoidWarning: avoid ? avoid.text : null, coding: o.coding ?? (this.caps ? this.caps.detectLocal(m).coding : false), reasoning: o.reasoning ?? (this.caps ? this.caps.detectLocal(m).reasoning : false) });
    }
    return { eligible, rejected };
  }
  pickLocal(org, tier, needVision, needTools) {
    const c = this.localCandidates(org, needVision, needTools);
    if (!c.length) return null;
    if (tier === 'fast') {
      c.sort((a, b) => (b.anyLoaded - a.anyLoaded) || ((b.tps || 0) - (a.tps || 0)) || (paramsNum(a) - paramsNum(b)));
    } else {
      c.sort((a, b) => (paramsNum(b) - paramsNum(a)) || (b.anyLoaded - a.anyLoaded));
    }
    return c[0];
  }

  // Three distinct states, never merged: unlimited (no cap known) · limited (cap + remaining) · not_allowed (and why).
  limitStates(orgDb) {
    const org = orgDb.org, pol = orgDb.policy(); const out = { providers: {}, local: null, profiles: {}, org: null };
    const day = orgDb.dayUsage ? orgDb.dayUsage() : { calls: 0, tokens: 0 };
    const orgCaps = [];
    if (org.calls_per_day > 0) orgCaps.push({ what: 'requests today', cap: org.calls_per_day, used: day.calls, remaining: Math.max(0, org.calls_per_day - day.calls) });
    if (org.tokens_per_day > 0) orgCaps.push({ what: 'tokens today', cap: org.tokens_per_day, used: day.tokens, remaining: Math.max(0, org.tokens_per_day - day.tokens) });
    out.org = orgCaps.length ? { state: 'limited', caps: orgCaps } : { state: 'unlimited', detail: 'No daily cap set' };
    const spend = orgDb.monthSpend();
    const all = this.store.all("SELECT * FROM providers WHERE org_id IS NULL OR org_id=?", org.id);
    for (const cfg of all) {
      const name = PROVIDER_TYPES[cfg.provider] ? PROVIDER_TYPES[cfg.provider].name : cfg.provider;
      let st;
      if (pol.default_mode === 'local_only') st = { state: 'not_allowed', detail: `Blocked by ${org.name} policy: local models only (Organisation → AI Policy)` };
      else if (pol[ALLOW_KEY[cfg.provider]] === false) st = { state: 'not_allowed', detail: `Blocked by ${org.name} policy: ${name} is switched off (Organisation → AI Policy)` };
      else if (cfg.status !== 'connected') st = { state: 'not_allowed', detail: `Disabled: not connected — ${cfg.status_detail || 'test the key under AI Providers'}` };
      else {
        const caps = [];
        if (cfg.budget_month > 0) { const used = this.providerMonthSpend(cfg.id); caps.push({ what: 'US$ this month (this key)', cap: cfg.budget_month, used: +used.toFixed(2), remaining: +Math.max(0, cfg.budget_month - used).toFixed(2) }); }
        if (org.cloud_budget_month > 0) caps.push({ what: `US$ this month (${org.name} cloud budget)`, cap: org.cloud_budget_month, used: +spend.toFixed(2), remaining: +Math.max(0, org.cloud_budget_month - spend).toFixed(2) });
        caps.push(...orgCaps);
        const rl = /rate limit/i.test(cfg.status_detail || '');
        st = caps.length || rl ? { state: 'limited', caps, rateLimited: rl, detail: rl ? 'The provider recently rate-limited requests (429).' : null } : { state: 'unlimited', detail: 'No cap known — set a budget in AI Providers or Limits' };
      }
      out.providers[cfg.id] = { name: cfg.label || name, ...st };
    }
    const lcaps = [...orgCaps];
    if (org.quota_ram_gb > 0) { const used = (this.cluster.orgRam.get(org.id) || 0) / GB; lcaps.push({ what: 'GB memory in use', cap: org.quota_ram_gb, used: +used.toFixed(1), remaining: +Math.max(0, org.quota_ram_gb - used).toFixed(1) }); }
    out.local = lcaps.length ? { state: 'limited', caps: lcaps } : { state: 'unlimited', detail: 'No cap known' };
    for (const p of this.store.all('SELECT * FROM profiles')) {
      const ids = safeJSON(p.org_ids, []);
      if (!p.enabled) out.profiles[p.id] = { state: 'not_allowed', detail: 'Disabled in Models → My models' };
      else if (ids.length && !ids.includes(org.id)) out.profiles[p.id] = { state: 'not_allowed', detail: `Not available to ${org.name}` };
      else if (p.daily_limit > 0) { const used = orgDb.dayUsage ? orgDb.dayUsage({ profileId: p.id }).calls : 0; out.profiles[p.id] = { state: 'limited', caps: [{ what: 'requests today', cap: p.daily_limit, used, remaining: Math.max(0, p.daily_limit - used) }, ...orgCaps] }; }
      else out.profiles[p.id] = orgCaps.length ? { state: 'limited', caps: orgCaps } : { state: 'unlimited', detail: 'No cap known' };
    }
    return out;
  }

  // Pick a local model for a task: must fit the context and capabilities; then balance quality (size), measured speed,
  // current load, and whether it is already loaded (no cold start). Returns { m, why }.
  pickLocalScored(org, { tier, task, tokens = 0, needVision, needTools, pol = {}, noInternet, req = {}, excludeIds = [], onlyIds = null, trace = [] }) {
    const R = this.report(org, { vision: needVision, tools: needTools, tokens, imageGen: req.imageGen, audioIn: req.audioIn, audioOut: req.audioOut, where: req.where }, { noInternet, pol });
    let c = R.eligible.filter((m) => !excludeIds.includes(m.id) && (!onlyIds || onlyIds.includes(m.id)));
    const whyNot = R.rejected.map((r) => `${r.name}${r.node ? ' on ' + r.node : ''}: ${r.why}`);
    trace.push(`Found ${R.eligible.length + R.rejected.length} local models; removed ${R.rejected.length}`); for (const r of R.rejected) trace.push(`Removed ${r.name}: ${r.why}`);
    if (!c.length) { this._lastWhyNot = R.rejected; return null; }
    const need = Math.ceil((tokens || 0) * 1.15) + 1024;
    const big = Math.max(...c.map(paramsNum), 1);
    const wantQuality = tier === 'powerful' || ['code', 'reasoning', 'long'].includes(task);
    const learned = this.taskScores();
    const scored = c.map((m) => {
      const q = paramsNum(m) / big;                         // 0..1 relative size
      const hs = this.health ? this.health.stats('model', m.id) : null;
      const tps = m.tps || (hs && hs.tps) || null; const sp = tps ? Math.min(1, tps / 40) : 0.5;
      const busy = m.inflight || 0;
      const remote = (m.endpoints || [m.endpoint]).every((e) => e && e.scope === 'internet');
      let score = (wantQuality ? 0.6 * q + 0.25 * sp : 0.25 * q + 0.6 * sp) + (m.anyLoaded ? 0.15 : 0) - 0.12 * busy - (remote ? 0.2 : 0);
      if (task === 'code' && m.coding) score += 0.25; if (task === 'reasoning' && m.reasoning) score += 0.15;
      if (req.vision && m.vision) score += 0.05;
      const ls = learned[task] && learned[task][m.id]; if (ls) score += 0.2 * (ls.success - 0.5) + (ls.n >= 3 ? 0.05 : 0);
      if (hs && hs.fail + hs.ok >= 3) score -= 0.4 * (hs.fail / (hs.fail + hs.ok));
      if (hs && hs.loadMs > 20000 && !m.anyLoaded) score -= 0.1;
      if (pol.avoid_slow_tps > 0 && tps && tps < pol.avoid_slow_tps) score -= 0.5;
      if (m.avoidWarning) score -= 0.3;
      return { m, score, tps, busy };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0]; const m = best.m;
    const bits = [];
    bits.push(wantQuality ? (paramsNum(m) >= big ? 'largest model that fits' : 'good size/speed balance') : 'quickest suitable model');
    if (task === 'code' && m.coding) bits.push('coding model'); if (task === 'reasoning' && m.reasoning) bits.push('reasoning model');
    if (m.tools !== false && req.tools) bits.push('tool support');
    if (m.memBytes) bits.push(`${(m.memBytes / GB).toFixed(m.memBytes > 10 * GB ? 0 : 1)} GB memory (estimate)`);
    if (m.context) bits.push(`${Math.round(m.context / 1000)}k context${tokens ? ' (needs ~' + Math.max(1, Math.round(need / 1000)) + 'k)' : ''}`);
    bits.push(m.anyLoaded ? 'currently loaded' : 'not loaded — first reply may be slow');
    bits.push(best.tps ? `~${best.tps.toFixed(0)} tok/s measured` : 'speed not measured yet');
    const hs = this.health ? this.health.stats('model', m.id) : null; if (hs && hs.ok + hs.fail >= 3) bits.push(`${Math.round(hs.ok / (hs.ok + hs.fail) * 100)}% reliable here`);
    if (best.busy) bits.push(`${best.busy} job${best.busy > 1 ? 's' : ''} running`);
    for (const alt of scored.slice(1, 6)) whyNot.push(`${alt.m.alias || alt.m.id}: scored lower (${alt.tps ? alt.tps.toFixed(0) + ' tok/s' : 'speed unknown'}${alt.m.anyLoaded ? ', loaded' : ', not loaded'}${task === 'code' && !alt.m.coding ? ', not a coding model' : ''})`);
    trace.push(`Selected ${m.alias || m.id}: ${bits.join(', ')}`);
    return { m, why: bits.join(', '), whyNot, fallbacks: scored.slice(1, 4).map((x) => x.m.id) };
  }
  // Alternatives for a manually chosen model: what Auto would pick next (used only if the chosen model fails).
  fallbacksFor(o, pickedId) {
    try { const d = this.decide({ ...o, model: null, mode: 'auto', excludeIds: [...(o.excludeIds || []), pickedId.replace(/^local:/, '')], _nofb: true }); if (d && !d.blocked) return [d.kind === 'local' ? 'local:' + d.model : `cloud:${d.providerId}:${d.model}`, ...(d.fallbacks || [])].filter((x) => x !== pickedId).slice(0, 3); } catch {}
    return [];
  }
  // What ForgeAI has learned: per task type, each model's success rate and speed from real requests (last 30 days).
  taskScores() {
    if (this._taskScores && Date.now() - this._taskScores.at < 60000) return this._taskScores.v;
    const v = {}; const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const add = (rows) => { for (const r of rows) { const t = r.task || 'chat'; (v[t] = v[t] || {}); const x = (v[t][r.model] = v[t][r.model] || { n: 0, ok: 0, tps: null }); x.n += r.n; x.ok += r.ok; if (r.tps) x.tps = r.tps; x.success = x.n ? x.ok / x.n : 0.5; } };
    try { for (const o of this.store.listOrgs()) { const db = this.store.openOrg(o.id); try { add(db.all("SELECT model, task, COUNT(*) n, SUM(ok) ok, AVG(CASE WHEN ok=1 AND ms>0 AND output_tokens>3 THEN output_tokens*1000.0/ms END) tps FROM usage WHERE ts>=? AND provider='local' GROUP BY model, task", since)); } catch {} } } catch {}
    this._taskScores = { at: Date.now(), v }; return v;
  }

  /**
   * @param o { orgDb, mode, model, sensitivity, web, needVision, text, tokens, approved, agent }
   * @returns { kind, providerType, providerId, model, reasons[], webSearch } or { blocked, approvable, reasons }
   */
  // "My models": a named profile (e.g. My AI Research) = engine + speed + instructions + limits.
  profile(id) { const p = this.store.get('SELECT * FROM profiles WHERE id=?', id); return p ? { ...p, org_ids: safeJSON(p.org_ids, null) } : null; }
  profilesFor(orgId) { return this.store.all('SELECT * FROM profiles WHERE enabled=1 ORDER BY sort, created_at').map((p) => ({ ...p, org_ids: safeJSON(p.org_ids, null) })).filter((p) => !p.org_ids || !p.org_ids.length || p.org_ids.includes(orgId)); }
  limitsCheck(orgDb, extra = {}) {
    const org = orgDb.org;
    if (!(org.calls_per_day > 0 || org.tokens_per_day > 0)) return null;
    const u = orgDb.dayUsage();
    if (org.calls_per_day > 0 && u.calls >= org.calls_per_day) return `${org.name} has used today's limit of ${org.calls_per_day} AI requests. It resets at midnight, or raise it in Organisation → Limits.`;
    if (org.tokens_per_day > 0 && u.tokens >= org.tokens_per_day) return `${org.name} has used today's limit of ${org.tokens_per_day.toLocaleString()} tokens. It resets at midnight, or raise it in Organisation → Limits.`;
    return null;
  }

  // What a request needs that a chosen model can't do: images, a long conversation. Tools are not a blocker (it answers without them).
  capabilityGap(m, o, org, provs, cloudOK) {
    const name = m.alias || m.id; const need = o.tokens || 0;
    const alt = (filter, cloudToo) => {
      const out = this.localCandidates(org, false).filter((x) => x.id !== m.id && filter(x)).sort((a, b) => (b.anyLoaded - a.anyLoaded) || ((b.context || 0) - (a.context || 0))).slice(0, 3)
        .map((x) => ({ value: 'm:local:' + x.id, label: `${x.alias || x.id} · ${(x.endpoints && x.endpoints[0] && x.endpoints[0].node) || 'this computer'}` }));
      if (cloudToo && cloudOK) for (const [t, cfg] of Object.entries(provs || {})) { const cm = this.pickCloudModel(cfg, 'best'); if (cm && out.length < 5) out.push({ value: `m:cloud:${cfg.id}:${cm}`, label: `${cm} · ${PROVIDER_TYPES[t].name} (paid, leaves your network)` }); }
      return out;
    };
    const capsKnown = ['engine', 'ollama', 'lmstudio'].includes(m.runtime) || (m.source && m.source.caps === 'reported');
    if (o.needVision && m.vision === false && capsKnown) return { text: `${name} can’t read images, and this message has one. Next: pick a model that can see images${alt((x) => x.vision, true).length ? ' (below)' : ' — download a vision model such as Gemma 3 or Qwen 2.5 VL'}.`, alternatives: alt((x) => x.vision, true) };
    if ((o.needTools || o.web) && m.tools === false && capsKnown) return { text: `${name} can’t call tools, and this request needs them${o.web ? ' (web search)' : ''}. Next: pick a model that supports tools${alt((x) => x.tools, true).length ? ' (below)' : ' — most Llama 3.1+, Qwen 2.5+, Mistral and Gemma 3 models do'}.`, alternatives: alt((x) => x.tools, true) };
    const ctx = m.loadedContext || m.context;
    if (ctx && need > ctx * 0.95) return { text: `This conversation is about ${need.toLocaleString()} tokens, but ${name} can only hold ${ctx.toLocaleString()}. Next: start a new chat, or pick a model with a bigger memory for conversation (context)${alt((x) => (x.context || 0) > need * 1.1, true).length ? ' (below)' : ''}.`, alternatives: alt((x) => (x.context || 0) > need * 1.1, true) };
    return null;
  }

  decide(o) {
    if (o.model && String(o.model).startsWith('profile:')) {
      const p = this.profile(String(o.model).slice(8));
      const orgId = o.orgDb.org.id;
      const fail = (m) => ({ blocked: true, approvable: false, reasons: [m] });
      if (!p || !p.enabled) return fail('That model was removed or switched off (Models → My models).');
      if (p.org_ids && p.org_ids.length && !p.org_ids.includes(orgId)) return fail(`${p.name} is not available to ${o.orgDb.org.name}.`);
      if (p.daily_limit > 0 && o.orgDb.dayUsage({ profileId: p.id }).calls >= p.daily_limit) return fail(`${p.name} has reached its limit of ${p.daily_limit} requests today. It resets at midnight, or change it in Models → My models.`);
      const eng = p.engine || 'auto';
      const sub = { ...o, web: o.web || !!p.web, speed: p.speed, model: /^(local|cloud):/.test(eng) ? eng : null, mode: /^(local|cloud):/.test(eng) ? 'other' : eng };
      const r = this.decide(sub);
      const prof = { id: p.id, name: p.name, instructions: p.instructions || '', temperature: p.temperature == null ? null : p.temperature, maxOutput: p.max_output || 0, tools: !!p.tools };
      if (r.blocked) return { ...r, profile: prof };
      return { ...r, profile: prof, label: `${p.name} · ${r.label}`, why: r.why ? `${p.name} → ${r.why.replace(/^.*?→ /, '')}` : null, reasons: [...r.reasons, `${p.name}: ${eng === 'auto' ? p.speed + ' engine' : 'fixed engine'}`] };
    }
    const org = o.orgDb.org, pol = o.orgDb.policy();
    const lim = this.limitsCheck(o.orgDb); if (lim) return { blocked: true, approvable: false, reasons: [lim] };
    const reasons = []; const trace = ['Router analysing…']; const req = requirements(o); trace.push('Requires: ' + (req.list.length ? req.list.join(' + ') : 'normal conversation'));
    const finish = (d) => { if (!d || d.blocked) return d; d.trace = [...trace, ...(d.trace || [])]; d.whyNot = d.whyNot || []; d.req = req.list; return d; };
    let cloudOK = true, cloudNeedsApproval = false;
    if (req.where && !o.model) { cloudOK = false; reasons.push(`Limited to ${req.where === 'local' ? 'this computer' : req.where === 'cluster' ? 'the cluster' : req.where} (where to run)`); }
    const sens = o.sensitivity || 'normal';
    if (pol.default_mode === 'local_only') { cloudOK = false; reasons.push(org.kind === 'owner' ? 'Owner AI: local models only (cloud can be enabled in Owner AI settings)' : 'Organisation policy: local models only'); }
    if (pol.default_mode === 'ask_cloud' && !o.approved) { cloudNeedsApproval = true; reasons.push('Organisation policy: ask before any data goes to a cloud provider'); }
    if (sens === 'confidential' && pol.confidential === 'local_only') { cloudOK = false; reasons.push('Confidential data → local only'); }
    if (sens === 'finance') {
      if (pol.finance === 'local_only') { cloudOK = false; reasons.push('Finance data → local only'); }
      else if (pol.finance === 'approval' && !o.approved) { cloudNeedsApproval = true; reasons.push('Finance data needs approval before any external model'); }
    }
    if (sens === 'research' && pol.research === 'local_only') { cloudOK = false; reasons.push('Research → local only by policy'); }
    const spend = o.orgDb.monthSpend();
    if (org.cloud_budget_month > 0 && spend >= org.cloud_budget_month) { cloudOK = false; reasons.push(`Monthly cloud budget reached ($${spend.toFixed(2)} of $${org.cloud_budget_month})`); }

    let provs = this.providersFor(org.id);
    for (const [t, cfg] of Object.entries(provs)) {
      if (pol[ALLOW_KEY[t]] === false) delete provs[t];
      else if (cfg.budget_month > 0 && this.providerMonthSpend(cfg.id) >= cfg.budget_month) { delete provs[t]; reasons.push(`${PROVIDER_TYPES[t].name} credential budget reached`); }
    }
    let web = !!o.web;
    if (web && !pol.allow_web_search) { web = false; reasons.push('Web search not authorised for this organisation'); }
    const complexity = assessComplexity(o.text);
    const task = taskType(o.text, o.needVision, o.tokens);
    const localTier = complexity === 'low' || pol.speed_critical ? 'fast' : 'powerful';
    const tokK = o.tokens ? `~${o.tokens >= 1000 ? Math.round(o.tokens / 1000) + 'k' : o.tokens} tokens` : '';

    const prefs = pol.task_models || {}; const prefTask = req.coding ? 'code' : task; const preferred = prefs[prefTask] || null;
    const local = (tier, why, extra = {}) => {
      const t2 = [];
      let pick = null;
      if (preferred && preferred.startsWith('local:') && !(o.excludeIds || []).includes(preferred.slice(6))) { // the organisation chose a model for this kind of task
        pick = this.pickLocalScored(org, { tier, task, tokens: o.tokens || estTokens(o.text), needVision: o.needVision, needTools: o.needTools, pol, noInternet: !cloudOK && !pol.remote_as_own, req, excludeIds: o.excludeIds || [], onlyIds: [preferred.slice(6)], trace: t2 });
        if (pick) { pick.why = `preferred for ${TASK_NAMES[prefTask].toLowerCase()}s in Organisation → Settings; ` + pick.why; why = `Preferred model for ${TASK_NAMES[prefTask].toLowerCase()}s`; } else t2.push(`Preferred model ${preferred.slice(6)} is not usable right now — choosing automatically`);
      }
      if (!pick) pick = this.pickLocalScored(org, { tier, task, tokens: o.tokens || estTokens(o.text), needVision: o.needVision, needTools: o.needTools, pol, noInternet: !cloudOK && !pol.remote_as_own, req, excludeIds: o.excludeIds || [], trace: t2, ...extra });
      trace.push(...t2);
      if (!pick) return null;
      const m = pick.m; const localNode = this.cluster.nodes().find((n) => n.is_local); const epMatch = (e) => !req.where || (req.where === 'local' ? (!e.node || (localNode && e.node === localNode.name)) && !e.cluster : req.where === 'cluster' ? !!e.cluster : e.node === req.where || e.name === req.where);
      const ep = ((m.endpoints || []).find(epMatch)) || (m.endpoints && m.endpoints[0]) || m.endpoint || {};
      reasons.push(why);
      return { kind: 'local', where: req.where || null, model: m.id, runtime: m.runtime, memBytes: m.memBytes, context: m.context, label: `${m.alias || m.id} · ${ep.node || 'local'}`, reasons, complexity, task, scope: ep.scope || 'local', noInternet: !cloudOK && !pol.remote_as_own,
        why: `${TASK_NAMES[task]}${tokK ? ' · ' + tokK : ''} → ${m.alias || m.id} on ${ep.node || 'this computer'}: ${pick.why}`, whyNot: pick.whyNot, fallbacks: pick.fallbacks.map((id) => 'local:' + id), warning: m.avoidWarning || null };
    };
    const cloud = (types, tier, why) => {
      if (!cloudOK) { trace.push('Cloud models not allowed for this request'); return null; }
      const whyNot = [];
      for (const t of types) {
        const cfg = provs[t];
        if (!cfg) continue;
        const model = this.pickCloudModel(cfg, tier);
        if (!model) continue;
        const av = this.health ? this.health.avoid({ model: `cloud:${cfg.id}:${model}`, endpoint: PROVIDER_TYPES[t].name }) : null;
        if (av && !this.health.probeAllowed({ model: `cloud:${cfg.id}:${model}` })) { whyNot.push(`${model}: ${av.text.toLowerCase()}`); trace.push(`Removed ${model}: ${av.text}`); continue; }
        if ((o.excludeIds || []).includes(`cloud:${cfg.id}:${model}`)) { whyNot.push(`${model}: already failed for this request`); continue; }
        if (cloudNeedsApproval) return { blocked: true, approvable: true, reasons, want: { providerType: t, model } };
        reasons.push(why);
        const pz = this.price(model);
        trace.push(`Selected ${model} (${PROVIDER_TYPES[t].name})`);
        const others = types.filter((x) => x !== t && provs[x]).map((x) => { const mm = this.pickCloudModel(provs[x], tier); return mm ? `cloud:${provs[x].id}:${mm}` : null; }).filter(Boolean);
        return { kind: 'cloud', providerType: t, providerId: cfg.id, model, webSearch: web && t !== 'openai_compat', label: `${model} · ${cfg.label || PROVIDER_TYPES[t].name}`, reasons, complexity, task, scope: 'internet',
          why: `${TASK_NAMES[task]}${tokK ? ' · ' + tokK : ''} → ${model} (${PROVIDER_TYPES[t].name}, leaves your network): ${why.replace(/^Auto: /, '')}; ≈$${pz.input_per_m}/$${pz.output_per_m} per M tokens`, whyNot, fallbacks: others };
      }
      return null;
    };
    const anyCloud = ['anthropic', 'openai', 'google', 'openai_compat'];
    if (req.imageGen) return { blocked: true, approvable: false, capability: true, reasons: [...reasons, 'None of the connected models can generate images — they write text and can read images. Next: describe the image you want in words (for a designer or an image tool), or attach an image and ask about it.'], alternatives: [], whyNot: [], trace: [...trace], req: req.list };
    const fail = (msg) => { const wn0 = this._lastWhyNot || []; const wn = req.where ? wn0.filter((r) => !/^not (on|served by)/.test(r.why)) : wn0; if (req.where) msg = `No model on ${req.where === 'local' ? 'this computer' : req.where === 'cluster' ? 'the cluster' : req.where} can do this request right now.`; this._lastWhyNot = null; const soft = wn.filter((r) => r.soft); const hint = soft.length ? ` Not used right now: ${soft.slice(0, 3).map((r) => `${r.name}${r.node ? ' on ' + r.node : ''} (${r.why})`).join('; ')}.` : ''; return { blocked: true, approvable: false, reasons: [...reasons, msg + hint], whyNot: wn, trace: [...trace], req: req.list }; };
    const mode = o.mode || 'auto';

    // Explicit model ("other" picker): "local:<id>" or "cloud:<providerId>:<model>"
    if (o.model) {
      if (o.model.startsWith('local:')) {
        const id = o.model.slice(6); const noNet = !cloudOK && !pol.remote_as_own; const m = this.localCandidates(org, false, false, noNet, { manual: true }).find((x) => x.id === id);
        const ep = m && ((m.endpoints && m.endpoints[0]) || m.endpoint || {});
        // Can this model do what the request needs? If not, say so and offer models that can.
        if (m) { const cap = this.capabilityGap(m, o, org, provs, cloudOK); if (cap) return { blocked: true, approvable: false, capability: true, reasons: [...reasons, cap.text], alternatives: cap.alternatives }; }
        if (m) { const av = this.health ? this.health.avoid({ model: id }) : null; if (av) reasons.push(`Warning: ${av.text}`); trace.push(`Chosen manually: ${m.alias || id}` + (av ? ` (${av.text})` : '')); }
        return m ? finish({ kind: 'local', noInternet: noNet, model: id, runtime: m.runtime, memBytes: m.memBytes, context: m.context, noTools: !!(o.needTools && m.tools === false), label: `${m.alias || id} · ${ep.node || 'local'}`, scope: ep.scope || 'local', why: `Chosen by you → ${m.alias || id} on ${ep.node || 'this computer'} (${ep.name || m.runtime})`, reasons: [...reasons, 'Model chosen manually'], manual: true, task, fallbacks: this.fallbacksFor(o, id) }) : noNet && this.localCandidates(org, false).some((x) => x.id === id) ? fail(`${id} runs on a server outside your network, and this request may not leave it (${reasons[0] || 'policy'}). Next: pick a model on this computer or your network — or allow it in Organisation → AI Policy.`) : fail(`Local model ${id} is not available (offline, or above this organisation's RAM quota). Next: refresh Models or pick another model.`);
      }
      if (o.model.startsWith('cloud:')) {
        const [, pid, ...rest] = o.model.split(':'); const model = rest.join(':');
        const cfg = Object.values(provs).find((c) => c.id === pid);
        if (!cfg) return fail('That provider is not allowed or not connected for this organisation');
        if (!cloudOK) return fail('Policy blocks external models for this request');
        if (cloudNeedsApproval) return { blocked: true, approvable: true, reasons, want: { providerType: cfg.provider, model } };
        return finish({ kind: 'cloud', providerType: cfg.provider, providerId: cfg.id, model, webSearch: web, label: `${model} · ${cfg.label || PROVIDER_TYPES[cfg.provider].name}`, scope: 'internet', why: `Chosen by you → ${model} (${PROVIDER_TYPES[cfg.provider].name}, leaves your network)`, reasons: [...reasons, 'Model chosen manually'], manual: true, task, fallbacks: this.fallbacksFor(o, o.model) });
      }
    }
    const famTypes = { openai: ['openai'], claude: ['anthropic'], google: ['google'], other: ['openai_compat'] };
    if (mode === 'cloud') return finish(cloud(anyCloud, 'best', 'Cloud selected') || fail(cloudOK ? 'No cloud provider is connected. Next: connect one under AI Providers.' : 'Policy blocks external models for this request.'));
    // Purpose modes from the model menu.
    if (mode === 'fastest') return finish(local('fast', 'Fastest: quickest loaded local model') || cloud(anyCloud, 'fast', 'Fastest: quick cloud tier') || fail('No model available.'));
    if (mode === 'best_quality') return finish(cloud(anyCloud, 'best', 'Best quality: most capable cloud model') || local('powerful', 'Best quality: most capable local model') || fail('No model available.'));
    if (mode === 'best_local' || mode === 'private') return finish(local('powerful', mode === 'private' ? 'Private: local models only' : 'Best local: most capable model on your computers') || fail('No local model is available. Next: download one under Models → Get Models.'));
    if (mode === 'best_coding' || mode === 'best_reasoning' || mode === 'best_vision') {
      const want = mode.slice(5); const taskFor = { coding: 'code', reasoning: 'reasoning', vision: 'vision' }[want];
      const R = this.report(org, { vision: want === 'vision' || o.needVision, tools: o.needTools, tokens: o.tokens }, { noInternet: !cloudOK && !pol.remote_as_own, pol });
      const capable = R.eligible.filter((m) => want === 'vision' ? m.vision : want === 'coding' ? m.coding : m.reasoning);
      if (capable.length) { const r = local('powerful', `Best ${want}: strongest local ${want} model`, { onlyIds: capable.map((m) => m.id) }); if (r) { r.task = taskFor; return finish(r); } }
      const c = cloud(want === 'coding' ? ['anthropic', 'openai', 'google', 'openai_compat'] : anyCloud, 'best', `Best ${want}: no local ${want} model, using the cloud`); if (c) return finish(c);
      return finish(local('powerful', `Best ${want}: no dedicated ${want} model — using the most capable local model`) || fail(`No ${want} model available.`));
    }
    if (mode === 'cheapest') return finish(local(localTier, 'Cheapest: local models are free') || cloud(anyCloud, 'fast', 'Cheapest: smallest cloud tier') || fail('No model available.'));
    if (mode === 'local_fast' || mode === 'local_powerful') {
      return finish(local(mode === 'local_fast' ? 'fast' : 'powerful', mode === 'local_fast' ? 'Local fast selected' : 'Local powerful selected') || fail('No local model is available. Next: download one under Models → Get Models.'));
    }
    if (famTypes[mode]) {
      const r = cloud(famTypes[mode], 'best', `${mode} selected`);
      if (r) return finish(r);
      if (!cloudOK) return fail('Policy blocks external models for this request');
      return fail(`${mode === 'claude' ? 'Anthropic' : mode} is not connected or not allowed for this organisation (Settings → AI Providers)`);
    }

    // AUTO — user rules first
    if (pol.prefer_local_under_tokens > 0 && (o.tokens || estTokens(o.text)) < pol.prefer_local_under_tokens && !web) {
      const r = local(localTier, `Rule: prefer local under ${pol.prefer_local_under_tokens.toLocaleString()} tokens`); if (r) return finish(r);
    }
    if (task === 'long' && !web) {
      const r = local('powerful', 'Auto: long context → a local model whose context fits'); if (r && (r.context || 0) >= (o.tokens || 0) * 1.15) return finish(r);
      const c = cloud(anyCloud, 'best', 'Auto: long context → cloud model with a large context window'); if (c) return finish(c);
    }
    if (o.speed === 'fast' && !web) {
      const r = local('fast', 'Fast model: quickest local') || cloud(anyCloud, 'fast', 'Fast model: quick cloud tier'); if (r) return finish(r);
    }
    if (o.speed === 'best') {
      const r = cloud(web ? ['anthropic', 'openai', 'google'] : anyCloud, 'best', 'Best model: most capable cloud model') || local('powerful', 'Best model: most capable local model'); if (r) return finish(r);
    }
    if (!cloudOK && !cloudNeedsApproval) {
      return finish(local(localTier, `Auto: local (${complexity} complexity)`) || fail('Policy requires a local model but none is available. Install Ollama and a model (Models page).'));
    }
    if (web) {
      const r = cloud(['anthropic', 'openai', 'google'], 'best', 'Auto: web search needs a cloud model');
      if (r) return finish(r);
    }
    if (pol.speed_critical) { const r = local('fast', 'Auto: speed-critical → fastest local'); if (r) return finish(r); }
    const bigCtx = (o.tokens || 0) > 24000;
    if (pol.default_mode === 'cloud_allowed') {
      // No preference: quality decides. Complex work or images go to the best model wherever it is; simple work stays local.
      if (complexity === 'high' || bigCtx || o.needVision) { const c = cloud(anyCloud, 'best', 'Auto: complex task → best model (cloud allowed)'); if (c) return finish(c); }
      return finish(local(localTier, `Auto: local (${complexity} complexity)`) || cloud(anyCloud, complexity === 'low' ? 'fast' : 'best', 'Auto: no local model available → cloud') || fail('No model available.'));
    }
    if (pol.default_mode === 'cloud_first') {
      return finish(cloud(anyCloud, complexity === 'low' ? 'fast' : 'best', 'Auto: organisation is cloud-first') || local(localTier, 'Auto: no cloud available → local') || fail('No model available. Connect a provider or install a local model.'));
    }
    // local_first
    if (sens === 'finance' || sens === 'confidential') {
      const r = local(localTier, 'Auto: sensitive data → local first'); if (r) return finish(r);
    }
    if (complexity === 'high' || bigCtx || (o.needVision && !this.pickLocal(org, 'powerful', true))) {
      const r = cloud(anyCloud, 'best', bigCtx ? 'Auto: long context → cloud' : complexity === 'high' ? 'Auto: complex task → cloud (local-first org)' : 'Auto: image needs a vision model');
      if (r) return finish(r);
    }
    return finish(local(localTier, `Auto: local-first (${complexity} complexity)`) || cloud(anyCloud, complexity === 'low' ? 'fast' : 'best', 'Auto: no local model available → cloud') || fail('No model available. Connect a provider (Settings → AI Providers) or install Ollama with a model.'));
  }

  // Execute a routing decision.
  // Execute a decision. Streams text (onDelta) and thinking (onThinking), records usage + timings, retries transient
  // network errors with backoff (only before any text arrived — a model call has no side effects).
  async run(decision, { orgDb, system, messages, onDelta, onThinking, onStats, onProgress, onFallback, trace, signal, agentId, kind = 'chat', maxTokens, stage, text, tokens, sensitivity, needVision, noFallback }) {
    return this._exec(decision, { orgDb, system, messages, onDelta, onThinking, onStats, onProgress, onFallback, trace, signal, agentId, kind, maxTokens, stage, tools: null, text, tokens, sensitivity, needVision, noFallback });
  }
  // Runs a decision with automatic recovery: one attempt per model, then (if nothing has been streamed yet and the
  // failure is the model's or its app's fault) the next compatible model, telling the user each time. Every attempt
  // is recorded against the model, app and machine so repeated failures take that model out of automatic routing.
  async _exec(decision, o) {
    const tried = []; let cur = decision; let fallbackFrom = null; const pol = o.orgDb.policy ? o.orgDb.policy() : {};
    const maxFallbacks = pol.auto_fallback === false ? 0 : 2;
    for (let hop = 0; ; hop++) {
      try { return await this._attempt(cur, o, { fallbackFrom, tried }); }
      catch (e) {
        const info = e.info || classify(e, { aborted: o.signal && o.signal.aborted });
        tried.push(cur.kind === 'local' ? 'local:' + cur.model : `cloud:${cur.providerId}:${cur.model}`);
        const can = info.kind !== 'USER_CANCELLED' && KINDS[info.kind] && KINDS[info.kind].retryOther && !e.streamed && hop < maxFallbacks && !o.noFallback;
        const next = can ? (cur.fallbacks || []).find((f) => !tried.includes(f)) : null;
        if (!next) throw e;
        const d = this.decide({ orgDb: o.orgDb, mode: 'other', model: next, sensitivity: o.sensitivity, needVision: o.needVision, needTools: !!o.tools, text: o.text || '', tokens: o.tokens, excludeIds: tried.map((t) => t.replace(/^local:/, '')) });
        if (!d || d.blocked) throw e;
        const fromName = cur.label || cur.model; fallbackFrom = { model: fromName, kind: info.kind, text: info.text, cooldown: e.cooldown || null };
        o.trace && o.trace(`${fromName} failed (${KINDS[info.kind].title.toLowerCase()}) — continuing with ${d.label}`);
        o.onFallback && o.onFallback({ from: fromName, to: d.label, reason: info.text, kind: info.kind, cooldown: e.cooldown || null });
        cur = { ...d, fallbacks: [...(d.fallbacks || []), ...(cur.fallbacks || [])].filter((f) => !tried.includes(f)) };
      }
    }
  }
  async _attempt(decision, o, { fallbackFrom, tried }) {
    const { orgDb } = o; const org = orgDb.org; const pf = decision.profile || {};
    let system = o.system;
    if (pf.instructions && system !== undefined) system = `${system || ''}\n\n# ${pf.name}\n${pf.instructions}`.trim();
    const maxTokens = o.maxTokens || pf.maxOutput || org.max_answer_tokens || undefined;
    const temperature = pf.temperature == null ? undefined : pf.temperature;
    if (o.tools) { const lim = this.limitsCheck(orgDb); if (lim) throw new Error(lim); }
    const t0 = Date.now();
    // Resolve where it runs.
    let p = null, cfg = null, adapter, endpoint, scope, provider, node = null;
    if (decision.kind === 'local') {
      p = this.cluster.pick(decision.model, { noInternet: decision.noInternet, where: decision.where, orgId: org.id });
      if (!p && this.cluster._lastPickOrgBlocked) throw Object.assign(new Error(`${decision.model} runs only on computers that are not shared with ${org.name}. Next: the owner can share a computer with this organisation under Computers → the computer → Shared with.`), { info: { kind: 'BACKEND_FAILED', title: KINDS.BACKEND_FAILED.title, text: `No computer shared with ${org.name} offers ${decision.model}.`, causes: ['This organisation is limited to certain computers'], next: 'Ask the owner to share a computer with this organisation.', raw: '' } });
      if (!p) throw Object.assign(new Error(`Model ${decision.model} is no longer available on any computer. Next: refresh Models, or pick another model.`), { info: { kind: 'BACKEND_FAILED', title: KINDS.BACKEND_FAILED.title, text: `${decision.model} is no longer offered by any computer.`, causes: ['The app serving it closed', 'The computer went offline'], next: 'Refresh Models or pick another model.', raw: '' } });
      const quota = (org.quota_ram_gb || 0) * GB; const inUse = this.cluster.orgRam.get(org.id) || 0;
      if (quota && inUse + (p.model.memBytes || 0) > quota) throw new Error(`Memory limit reached for ${org.name} (${(inUse / GB).toFixed(1)} of ${org.quota_ram_gb} GB in use). Next: try again when current jobs finish, or raise it in Organisation → Limits.`);
      adapter = p.adapter; endpoint = (p.model.endpoint && p.model.endpoint.url) || p.node.url; scope = (p.model.endpoint && p.model.endpoint.scope) || 'local'; provider = 'local'; node = p.node;
    } else {
      cfg = this.store.get('SELECT * FROM providers WHERE id=?', decision.providerId);
      if (!cfg) throw new Error('Provider configuration missing. Next: reconnect it under AI Providers.');
      adapter = this.cloudAdapter(cfg); endpoint = cfg.base_url || PROVIDER_TYPES[cfg.provider].defaultBase; scope = 'internet'; provider = cfg.provider;
    }
    const appName = provider === 'local' ? (p.model.endpoint ? p.model.endpoint.name : p.model.runtime) : PROVIDER_TYPES[provider].name;
    const label = `${appName} · ${hostOf(endpoint)}`;
    const hkeys = { model: provider === 'local' ? decision.model : `cloud:${cfg.id}:${decision.model}`, endpoint: provider === 'local' ? endpoint : PROVIDER_TYPES[provider].name, machine: node ? node.name : null };
    const busy = node ? this.cluster.inflight.get(node.id) || 0 : 0;
    const pid = this.perf ? this.perf.start({ model: decision.model, provider, node: node ? node.name : PROVIDER_TYPES[provider].name, endpoint: hostOf(endpoint), scope, org: org.name, kind: o.kind, stage: o.stage || null, busyAtStart: busy, trace: decision.trace || [] }) : null;
    const trace = (t) => { this.perf && this.perf.trace(pid, t); o.trace && o.trace(t); };
    // Queue: each app serves a limited number of requests at once; the rest wait their turn (and the wait is measured).
    const qKey = provider === 'local' ? endpoint : `cloud:${cfg.id}`; const slot = this.scheduler ? await this.scheduler.acquire(qKey, { priority: o.kind === 'chat' ? 0 : o.kind === 'benchmark' ? 2 : 1, signal: o.signal, onWait: (n, why) => { if (why === 'yield') { trace('Paused: your other apps need this computer right now'); o.onProgress && o.onProgress({ phase: 'queue', text: 'Paused — your other apps need this computer; continues when they are done', where: label }); return; } trace(`Waiting in queue (${n} ahead)`); o.onProgress && o.onProgress({ phase: 'queue', text: `Waiting — ${n} request${n > 1 ? 's' : ''} ahead on ${appName}`, where: label }); } }) : { release() {}, waitMs: 0 };
    const queueMs = slot.waitMs || 0; if (queueMs && this.perf) this.perf.set(pid, { queueMs });
    if (node) this.cluster.begin(node.id, org.id, p.model.memBytes, decision.model);
    this.health && this.health.begin(hkeys.model);
    let firstAt = null; let loadMs = 0; let streamed = false;
    const onProgress = (pg) => { if (pg.phase === 'loaded' && pg.ms) { loadMs = pg.ms; trace(`Loaded in ${(pg.ms / 1000).toFixed(1)}s`); } else if (pg.phase === 'loading') trace('Loading model…'); this.perf && this.perf.progress(pid, pg); o.onProgress && o.onProgress({ ...pg, where: label }); };
    const onDelta = (d) => { if (!firstAt) { firstAt = Date.now(); streamed = true; trace('Generating…'); o.onStats && o.onStats({ ttftMs: firstAt - t0 - queueMs }); } this.perf && this.perf.token(pid, d.length); o.onDelta && o.onDelta(d); };
    const args = { model: decision.model, runtime: p && p.model.runtime, system, messages: o.messages, onDelta, onThinking: o.onThinking, onProgress, signal: o.signal, maxTokens, temperature, webSearch: decision.webSearch };
    if (o.tools) { args.tools = decision.noTools ? [] : o.tools; if (p) args.numCtx = Math.min(Math.max(8192, p.model.context || 16384), 32768); }
    let r, err, attempt = 0;
    try {
      if (p && this.cluster.ensureReady) await this.cluster.ensureReady(p, onProgress, o.signal);
      onProgress({ phase: 'sending', text: provider === 'local' ? 'Reading your message' : `Sent to ${PROVIDER_TYPES[provider].name} — waiting for the first words` });
      for (;;) {
        try { r = o.tools ? await adapter.chatTools(args) : await adapter.chat(args); err = null; break; }
        catch (e) { err = e; if (o.signal && o.signal.aborted) break; if (firstAt || attempt >= 2 || !isTransient(e)) break; attempt++; trace(`Retrying (${attempt}) after a transient error`); this.perf && this.perf.stage(pid, `retrying (${attempt})`); await new Promise((ok) => setTimeout(ok, 800 * 2 ** (attempt - 1))); }
      }
    } catch (e) { err = e; }
    finally { slot.release(); this.health && this.health.done(hkeys.model); }
    const ms = Date.now() - t0; const ttft = firstAt ? firstAt - t0 - queueMs : null;
    if (node) this.cluster.end(node.id, org.id, p.model.memBytes, r && r.outputTokens, ms, decision.model, o.tools ? null : ttft);
    const pr = this.perf ? this.perf.finish(pid, err ? { error: err.message } : r) : null;
    const bottleneck = pr ? pr.bottleneck : null;
    let cost = 0;
    if (provider !== 'local' && r) { const pz = this.price(decision.model); cost = (r.inputTokens * pz.input_per_m + r.outputTokens * pz.output_per_m) / 1e6; }
    let info = null, cooldowns = [];
    if (err) {
      info = classify(err, { where: hostOf(endpoint), model: decision.model, node: node ? node.name : null, appName, remote: scope !== 'local', aborted: o.signal && o.signal.aborted });
      if (this.health) cooldowns = this.health.failure(hkeys, info);
      trace(`${KINDS[info.kind].title}: ${info.text}`);
    } else if (this.health) this.health.success(hkeys, { tps: pr && pr.tps, ttftMs: ttft, loadMs });
    orgDb.run('INSERT INTO usage(ts,provider,provider_id,model,node,input_tokens,output_tokens,cost,ok,error,agent_id,kind,ms,profile_id,ttft_ms,endpoint,scope,stop,bottleneck,task,error_kind,queue_ms,load_ms,fallback_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      now(), provider, cfg ? cfg.id : null, decision.model, node ? node.name : null, r ? r.inputTokens : 0, r ? r.outputTokens : 0, cost, err ? 0 : 1, err ? String(err.message || err).slice(0, 500) : null, o.agentId || null, o.kind, ms, pf.id || null, ttft, hostOf(endpoint), scope, r ? r.stop || null : null, bottleneck ? bottleneck.kind : null, decision.task || null, info ? info.kind : null, queueMs, loadMs || null, fallbackFrom ? fallbackFrom.model : null);
    if (err) {
      if (cfg) this.store.run('UPDATE providers SET status_detail=? WHERE id=?', (info.kind === 'RATE_LIMITED' ? 'Rate limited: ' : 'Last error: ') + err.message.slice(0, 200), cfg.id);
      if (o.signal && o.signal.aborted) throw Object.assign(err, { info, streamed });
      const x = explainNet(err, endpoint, `Asking ${decision.model}`);
      const cd = cooldowns.find((c) => c.scope === 'model') || cooldowns[0];
      x.message = `${info.title}: ${info.text}${cd ? ` ForgeAI has set ${cd.scope === 'model' ? decision.model : cd.scope === 'endpoint' ? appName : cd.id} aside for automatic routing for ${cd.minutes} minutes after ${cd.n} failures.` : ''}${info.next ? ' Next: ' + info.next : ''}`;
      x.info = { ...info, model: decision.model, where: label }; x.cooldown = cd || null; x.endpoint = hostOf(endpoint); x.retryable = true; x.streamed = streamed; throw x;
    }
    const stats = { ttftMs: ttft, totalMs: ms, tps: pr && pr.tps, inputTokens: r.inputTokens, outputTokens: r.outputTokens, retries: attempt, bottleneck, serverTimings: r.serverTimings || null, loadMs: loadMs || null, queueMs: queueMs || null };
    o.onStats && o.onStats(stats);
    return { ...r, cost, node: node ? node.name : undefined, model: provider === 'local' ? (p.model.alias || decision.model) : decision.model, modelId: decision.model, provider, endpoint: hostOf(endpoint), endpointUrl: endpoint, endpointLabel: label, scope, stats, fallbackFrom: fallbackFrom || undefined, trace: (pr && pr.trace) || decision.trace || [], whyNot: decision.whyNot || [], why: decision.why };
  }
}

// Tool-calling turn (non-streaming). Same accounting, quotas, endpoint tracking and retries as run().
ModelService.prototype.runTools = async function (decision, { orgDb, system, messages, tools, signal, agentId, kind = 'agent', maxTokens, onThinking, onProgress, onFallback, trace, stage, text, tokens, sensitivity, needVision }) {
  return this._exec(decision, { orgDb, system, messages, tools: tools || [], signal, agentId, kind, maxTokens, onThinking, onProgress, onFallback, trace, stage, text, tokens, sensitivity, needVision });
};

const hostOf = (u) => { if (String(u).startsWith('forgeai-engine:')) return 'built in'; try { return new URL(u).host; } catch { return u || ''; } };
const TASK_NAMES = { code: 'Code task', reasoning: 'Reasoning task', vision: 'Image task', long: 'Long-context task', chat: 'Chat' };
function taskType(text, needVision, tokens) {
  const t = String(text || '');
  if (needVision) return 'vision';
  if ((tokens || 0) > 16000) return 'long';
  if (/```|\b(function|def|class|const|import|SELECT|regex|stack ?trace|traceback|exception|compile|bug|refactor|typescript|python|javascript|sql)\b/i.test(t)) return 'code';
  if (/(strateg|analy[sz]|compare|forecast|evaluate|trade-?off|prove|derive|calculate|solve|step by step|plan|why )/i.test(t) && t.length > 60) return 'reasoning';
  return 'chat';
}
function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

module.exports = { taskType, TASK_NAMES, ModelService, assessComplexity, estTokens, safeJSON, FAMILY_OF };
