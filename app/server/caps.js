'use strict';
// Model capability registry and request classification.
// What each model can do is detected from the app that serves it (LM Studio / Ollama / llama.cpp / the engine report
// context, vision, tools, reasoning…), from its chat template, and from what the model family is known for — then
// merged with what ForgeAI has measured (speed, loading time, reliability) and with any manual overrides from Settings.
// Nothing is guessed from a file name alone: a guess is marked "guessed" and can be corrected in Settings.

const CODING_RE = /coder|codestral|devstral|starcoder|deepseek-coder|code-?llama|codegemma|granite-code|qwen2\.5-coder|qwen3-coder|magicoder|opencoder/i;
const REASONING_RE = /deepseek-r1|\bqwq\b|thinking|reasoning|\br1\b|o[1-9](-|$)|gpt-oss|phi-4-reasoning|magistral/i;
const CLOUD_CAPS = {
  anthropic: (id) => ({ vision: true, tools: true, coding: true, reasoning: /opus|sonnet/i.test(id), json: true, context: /claude-3/.test(id) ? 200000 : 200000, maxOutput: 8192 }),
  openai: (id) => ({ vision: !/o1-mini|o3-mini|gpt-3\.5|instruct/i.test(id), tools: !/o1-mini|o1-preview/i.test(id), coding: true, reasoning: /^o\d|gpt-5/i.test(id), json: true, context: /gpt-4o|gpt-4\.1|gpt-5|^o\d/i.test(id) ? 128000 : 32000, maxOutput: 16384 }),
  google: (id) => ({ vision: true, tools: true, coding: true, reasoning: /pro|thinking|2\.5|3/i.test(id), json: true, context: 1000000, maxOutput: 8192 }),
  openai_compat: () => ({ vision: null, tools: true, coding: null, reasoning: null, json: true, context: null, maxOutput: null }),
};

// What does this request need? Each flag is only set when there is a clear signal.
function requirements(o = {}) {
  const t = String(o.text || ''); const req = { vision: !!o.needVision, tools: !!o.needTools, web: !!o.web, fast: o.speed === 'fast', private: ['confidential', 'finance'].includes(o.sensitivity) };
  req.coding = /```|\b(function|def |class |const |import |SELECT |regex|stack ?trace|traceback|exception|compile|bug|refactor|typescript|javascript|python|sql|html|css|react|api endpoint|unit test|npm|pip install|git )\b/i.test(t) || /\b(write|build|fix|debug|create)\b.{0,40}\b(code|app|script|website|function|program|component|page)\b/i.test(t);
  req.reasoning = /(strateg|analy[sz]|compare|forecast|evaluate|trade-?off|prove|derive|calculate|solve|step by step|plan|why |should (we|i)|pros and cons|decide)/i.test(t) && t.length > 60;
  req.research = /\b(research|latest|current|news|recent|this (week|month|year)|today|up to date|look up|search the web|sources?)\b/i.test(t);
  req.structured = /\b(json|csv|table|spreadsheet|schema|structured)\b/i.test(t);
  req.documents = (o.attachmentChars || 0) > 4000;
  req.imageGen = /\b(generate|create|draw|make)\b.{0,30}\b(image|picture|logo|illustration|photo)\b/i.test(t) && !req.vision;
  req.long = (o.tokens || 0) > 16000;
  req.where = o.where && o.where !== 'auto' ? String(o.where).slice(0, 80) : null; // 'local' | 'cluster' | a computer name
  req.audioIn = !!o.audioIn; req.audioOut = !!o.audioOut;
  req.tokens = o.tokens || 0;
  req.list = Object.entries(req).filter(([k, v]) => v === true).map(([k]) => k); if (req.where) req.list.push('run on ' + (req.where === 'local' ? 'this computer' : req.where));
  return req;
}

class CapabilityRegistry {
  constructor(store, cluster, health) { this.store = store; this.cluster = cluster; this.health = health; }
  overrides() { return this.store.getSetting('model_caps', {}); }
  setOverride(id, patch) { const all = this.overrides(); all[id] = { ...(all[id] || {}), ...patch }; for (const k of Object.keys(all[id])) if (all[id][k] === null || all[id][k] === undefined) delete all[id][k]; if (!Object.keys(all[id]).length) delete all[id]; this.store.setSetting('model_caps', all); return all[id] || {}; }
  // Detected capabilities of one local catalog entry, each with where it came from.
  detectLocal(m) {
    const caps = m.caps || {}; const src = m.source || {}; const known = ['engine', 'ollama', 'lmstudio'].includes(m.runtime) || src.caps === 'reported';
    const id = String(m.id); const fam = String(m.family || '');
    const out = {
      chat: caps.chat !== false, vision: caps.vision != null ? !!caps.vision : !!m.vision, tools: caps.tools != null ? !!caps.tools : m.tools !== false, reasoning: !!caps.reasoning || REASONING_RE.test(id),
      coding: CODING_RE.test(id) || CODING_RE.test(fam), json: m.tools !== false, embeddings: !!caps.embeddings, imageGen: false, audioIn: false, audioOut: false, stt: false,
      context: m.context || null, maxOutput: null, parallel: m.runtime === 'engine' || m.runtime === 'llamacpp' || m.runtime === 'vllm' ? true : null,
      source: { vision: known ? 'reported' : 'guessed', tools: known ? 'reported' : 'guessed', reasoning: caps.reasoning ? 'reported' : REASONING_RE.test(id) ? 'name' : 'unknown', coding: CODING_RE.test(id + fam) ? 'name' : 'unknown', context: src.context || (m.context ? 'reported' : 'unknown') },
    };
    return out;
  }
  // The full registry: every model ForgeAI can use, with capabilities, hardware, measurements and health.
  list({ org = null, providers = [] } = {}) {
    const ov = this.overrides(); const bench = this.store.getSetting('benchmarks', {}); const out = [];
    for (const m of this.cluster.distinctModels()) {
      const det = this.detectLocal(m); const o = ov[m.id] || {}; const ep = (m.endpoints || [m.endpoint])[0] || {};
      const hs = this.health.stats('model', m.id) || {}; const b = bench[m.nodes[0] + '|' + m.id] || null;
      out.push({ id: m.id, name: m.alias || m.id, kind: 'local', family: m.family || '', params: m.params || '', quant: m.quant || '', memBytes: m.memBytes || 0, sizeBytes: m.sizeBytes || 0,
        backend: ep.appName || ep.name || m.runtime, runtime: m.runtime, machine: ep.node || m.nodes[0], machines: m.nodes, endpoints: m.endpoints, scope: ep.scope,
        caps: { chat: det.chat, vision: o.vision ?? det.vision, tools: o.tools ?? det.tools, coding: o.coding ?? det.coding, reasoning: o.reasoning ?? det.reasoning, json: o.json ?? det.json, embeddings: det.embeddings, imageGen: o.imageGen ?? false, audioIn: false, audioOut: false, stt: false, parallel: o.parallel ?? det.parallel },
        context: o.context || det.context, loadedContext: m.loadedContext || null, maxOutput: o.maxOutput || null,
        loaded: !!m.anyLoaded, loadedOnce: !!hs.loadedOnce || !!m.anyLoaded, startable: !!m.startable,
        tps: m.tps || hs.tps || (b && b.tps) || null, ttftMs: m.ttft || hs.ttftMs || (b && b.ttftMs) || null, loadMs: hs.loadMs || (b && b.coldTtftMs) || null,
        health: this.health.state('model', m.id), stats: hs, reliability: hs.ok + hs.fail ? +((hs.ok / (hs.ok + hs.fail)) || 0).toFixed(3) : null,
        avoid: this.health.avoid({ model: m.id, endpoint: ep.url, machine: ep.node }), excluded: !!o.excluded, note: o.note || null, source: det.source, overridden: Object.keys(o).filter((k) => k !== 'note'), cost: null });
    }
    for (const cfg of providers) {
      const list = (cfg.list || []).filter((x) => !x.kind || x.kind === 'chat');
      for (const x of list) { const id = x.id; const o = ov['cloud:' + cfg.id + ':' + id] || {}; const d = (CLOUD_CAPS[cfg.provider] || CLOUD_CAPS.openai_compat)(id); const hs = this.health.stats('model', 'cloud:' + cfg.id + ':' + id) || {};
        out.push({ id: 'cloud:' + cfg.id + ':' + id, modelId: id, name: id, kind: 'cloud', providerId: cfg.id, provider: cfg.provider, providerName: cfg.name, backend: cfg.name, machine: cfg.host, scope: 'internet',
          caps: { chat: true, vision: o.vision ?? d.vision, tools: o.tools ?? d.tools, coding: o.coding ?? d.coding, reasoning: o.reasoning ?? d.reasoning, json: d.json, embeddings: false, imageGen: false, parallel: true },
          context: o.context || x.context || d.context, maxOutput: o.maxOutput || d.maxOutput, loaded: true, loadedOnce: true, tps: hs.tps || null, ttftMs: hs.ttftMs || null, health: this.health.state('model', 'cloud:' + cfg.id + ':' + id), stats: hs,
          reliability: hs.ok + hs.fail ? +((hs.ok / (hs.ok + hs.fail)) || 0).toFixed(3) : null, avoid: this.health.avoid({ model: 'cloud:' + cfg.id + ':' + id, endpoint: cfg.host }), excluded: !!o.excluded, note: o.note || null, source: { vision: 'provider', tools: 'provider', coding: 'provider', reasoning: 'provider', context: x.context ? 'reported' : 'provider' }, overridden: Object.keys(o).filter((k) => k !== 'note'), cost: cfg.price ? cfg.price(id) : null }); }
    }
    return out;
  }
}

// Approximate memory a model needs to load with a given context: file size plus a KV cache estimate.
// KV per token ≈ 16 KB × billions of parameters (dense models without GQA; GQA models use less). Labelled an estimate.
function memoryNeeded(m, ctx) { const p = parseFloat(m.params) || (m.memBytes ? m.memBytes / 0.6e9 : 8); const kv = (ctx || 8192) * p * 16384; return { bytes: (m.memBytes || 0) + kv, kvBytes: kv, estimate: true }; }

module.exports = { CapabilityRegistry, requirements, memoryNeeded, CODING_RE, REASONING_RE };
