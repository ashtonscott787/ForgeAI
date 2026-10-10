'use strict';
// Model provider adapters. The rest of the platform only talks to this interface:
//   listModels() -> [{ id, label }]
//   chat({ model, system, messages, maxTokens, webSearch, onDelta, signal }) -> { text, inputTokens, outputTokens }
// messages: [{ role: 'user'|'assistant', content: string, images?: [{ mime, b64 }] }]
// Adding a provider = adding an adapter here and a row in PROVIDER_TYPES. Nothing else is provider-specific.

const estTokens = (s) => Math.ceil(String(s || '').length / 4);
const { netFetch } = require('./net');

async function httpError(res, who) {
  let body = '';
  try { body = await res.text(); } catch {}
  let msg = body;
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || j.message || body; } catch {}
  const e = new Error(`${who} error ${res.status}: ${String(msg).slice(0, 300)}`);
  e.status = res.status;
  if (res.status === 429) e.rateLimited = true;
  return e;
}

// Parses a server-sent-events stream, calling onEvent(eventName, dataString).
async function readSSE(res, onEvent) {
  const dec = new TextDecoder();
  let buf = '', ev = null, data = [];
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { if (data.length) onEvent(ev, data.join('\n')); ev = null; data = []; continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) onEvent(ev, data.join('\n'));
}

async function readNDJSON(res, onObj) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) onObj(JSON.parse(line));
    }
  }
  if (buf.trim()) onObj(JSON.parse(buf.trim()));
}

function mergeTurns(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
      last.images = [...(last.images || []), ...(m.images || [])];
    } else out.push({ role: m.role, content: m.content || '', images: [...(m.images || [])] });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(conversation start)', images: [] });
  return out;
}

// ---------------- OpenAI (and OpenAI-compatible local servers) ----------------
class OpenAIAdapter {
  constructor({ apiKey, baseUrl, compat = false, label = 'OpenAI', net = null, progress = false }) {
    this.apiKey = apiKey; this.base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.compat = compat; this.label = label; this.net = net; this.progress = progress; // llama.cpp servers can report prompt-reading progress
  }
  headers() {
    const h = { 'content-type': 'application/json', ...((this.net && this.net.headers) || {}) };
    if (this.apiKey) h.authorization = 'Bearer ' + this.apiKey;
    return h;
  }
  _fetch(url, init) { return this.net ? netFetch(url, init, this.net) : fetch(url, init); }
  async listModels() {
    const res = await this._fetch(this.base + '/models', { headers: this.headers(), signal: AbortSignal.timeout((this.net && this.net.timeoutMs) || 10000) });
    if (!res.ok) throw await httpError(res, this.label);
    const j = await res.json();
    // Every model the server reports is kept (no cap); non-chat models are tagged so pickers can filter them.
    const isChat = (id) => (this.compat ? !/(embed|rerank|whisper|tts|moderation)/i.test(id) : /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|moderation|instruct|search)/.test(id));
    return (j.data || []).map((m) => ({ id: m.id, label: m.id, kind: isChat(m.id) ? 'chat' : 'other', context: m.max_model_len || m.context_length || m.max_context_length || null, owned_by: m.owned_by || null })).sort((a, b) => a.id.localeCompare(b.id));
  }
  async chat(o) {
    if (o.webSearch && !this.compat) return this.chatResponses(o);
    const msgs = [];
    if (o.system) msgs.push({ role: 'system', content: o.system });
    for (const m of mergeTurns(o.messages)) {
      if (m.images && m.images.length) {
        msgs.push({ role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }))] });
      } else msgs.push({ role: m.role, content: m.content });
    }
    const body = { model: o.model, messages: msgs, stream: true, stream_options: { include_usage: true } };
    if (o.maxTokens) body[this.compat ? 'max_tokens' : 'max_completion_tokens'] = o.maxTokens;
    if (this.compat && o.temperature != null) body.temperature = o.temperature;
    if (this.progress) body.return_progress = true;
    const res = await this._fetch(this.base + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw await httpError(res, this.label);
    let text = '', usage = null, stop = null, timings = null;
    await readSSE(res, (_e, data) => {
      if (data === '[DONE]') return;
      const j = JSON.parse(data);
      if (j.prompt_progress && o.onProgress) { const pp = j.prompt_progress; o.onProgress({ phase: 'prompt', processed: pp.processed, total: pp.total, cache: pp.cache, ms: pp.time_ms }); }
      const c = j.choices && j.choices[0]; const delta = (c && c.delta) || {};
      const th = delta.reasoning_content || delta.reasoning; if (th && o.onThinking) o.onThinking(th);
      if (delta.content) { text += delta.content; o.onDelta && o.onDelta(delta.content); }
      if (c && c.finish_reason) stop = c.finish_reason;
      if (j.usage) usage = j.usage; if (j.timings) timings = j.timings;
    });
    return { text, stop: stop === 'length' ? 'length' : stop || 'stop', inputTokens: usage ? usage.prompt_tokens : estTokens(JSON.stringify(msgs)), outputTokens: usage ? usage.completion_tokens : estTokens(text), estimated: !usage, serverTimings: timings };
  }
  // Responses API is used when web search is requested.
  async chatResponses(o) {
    const input = mergeTurns(o.messages).map((m) => {
      if (m.role === 'user' && m.images && m.images.length) {
        return { role: 'user', content: [{ type: 'input_text', text: m.content }, ...m.images.map((im) => ({ type: 'input_image', image_url: `data:${im.mime};base64,${im.b64}` }))] };
      }
      return { role: m.role, content: m.content };
    });
    const body = { model: o.model, input, instructions: o.system || undefined, tools: [{ type: 'web_search' }], stream: true };
    const res = await this._fetch(this.base + '/responses', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw await httpError(res, this.label);
    let text = '', usage = null, stop = 'stop';
    await readSSE(res, (ev, data) => {
      const j = JSON.parse(data);
      const type = j.type || ev;
      if (type === 'response.incomplete') stop = 'length';
      if (type === 'response.output_text.delta' && j.delta) { text += j.delta; o.onDelta && o.onDelta(j.delta); }
      if (type === 'response.completed' && j.response && j.response.usage) usage = j.response.usage;
      if (type === 'error' || type === 'response.failed') throw new Error('OpenAI: ' + JSON.stringify(j).slice(0, 300));
    });
    return { text, stop, inputTokens: usage ? usage.input_tokens : estTokens(JSON.stringify(input)), outputTokens: usage ? usage.output_tokens : estTokens(text), estimated: !usage };
  }
}


// ---------- tool calling (shared internal format) ----------
// messages: {role:'user'|'assistant'|'tool', content, images?, toolCalls?:[{id,name,args}], toolCallId?, name?, raw?}
// tools: [{name, description, parameters(JSON schema)}] -> returns { text, toolCalls, inputTokens, outputTokens, raw }
const safeParse = (s) => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}); } catch { return {}; } };
function openaiToolMessages(system, messages) {
  const out = []; if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content || '') });
      if (m.images && m.images.length) out.push({ role: 'user', content: [{ type: 'text', text: `(Image returned by ${m.name})` }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }))] });
    } else if (m.role === 'assistant') {
      const x = { role: 'assistant', content: m.content || null };
      if (m.toolCalls && m.toolCalls.length) x.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      out.push(x);
    } else if (m.images && m.images.length) out.push({ role: 'user', content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }))] });
    else out.push({ role: 'user', content: m.content || ' ' });
  }
  return out;
}
OpenAIAdapter.prototype.chatTools = async function (o) {
  const body = { model: o.model, messages: openaiToolMessages(o.system, o.messages) };
  if (o.tools && o.tools.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (o.maxTokens) body[this.compat ? 'max_tokens' : 'max_completion_tokens'] = o.maxTokens;
  if (this.compat && o.temperature != null) body.temperature = o.temperature;
  const res = await this._fetch(this.base + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await httpError(res, this.label);
  const j = await res.json(); const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  if ((msg.reasoning_content || msg.reasoning) && o.onThinking) o.onThinking(msg.reasoning_content || msg.reasoning);
  return { text: msg.content || '', toolCalls: (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: safeParse(c.function.arguments) })),
    inputTokens: j.usage ? j.usage.prompt_tokens : estTokens(JSON.stringify(body.messages)), outputTokens: j.usage ? j.usage.completion_tokens : estTokens(msg.content) };
};

// ---------------- Anthropic ----------------
class AnthropicAdapter {
  constructor({ apiKey, baseUrl }) { this.apiKey = apiKey; this.base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, ''); }
  headers() { return { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }; }
  async listModels() {
    // Follow pagination so every model is listed.
    const out = []; let after = null;
    for (let page = 0; page < 50; page++) {
      const res = await fetch(this.base + '/v1/models?limit=1000' + (after ? '&after_id=' + encodeURIComponent(after) : ''), { headers: this.headers(), signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw await httpError(res, 'Anthropic');
      const j = await res.json();
      for (const m of j.data || []) out.push({ id: m.id, label: m.display_name || m.id, kind: 'chat' });
      if (!j.has_more || !j.last_id) break; after = j.last_id;
    }
    return out;
  }
  async chat(o) {
    const messages = mergeTurns(o.messages).map((m) => ({
      role: m.role,
      content: [
        ...(m.images || []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })),
        { type: 'text', text: m.content || ' ' },
      ],
    }));
    const body = { model: o.model, max_tokens: o.maxTokens || 8000, messages, stream: true };
    if (o.system) body.system = o.system;
    if (o.temperature != null) body.temperature = Math.min(1, o.temperature);
    if (o.webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    const res = await fetch(this.base + '/v1/messages', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw await httpError(res, 'Anthropic');
    let text = '', inTok = 0, outTok = 0, stop = 'stop';
    await readSSE(res, (_ev, data) => {
      const j = JSON.parse(data);
      if (j.type === 'message_start' && j.message && j.message.usage) inTok = j.message.usage.input_tokens || 0;
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') { text += j.delta.text; o.onDelta && o.onDelta(j.delta.text); }
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta' && o.onThinking) o.onThinking(j.delta.thinking);
      if (j.type === 'message_delta' && j.delta && j.delta.stop_reason === 'max_tokens') stop = 'length';
      if (j.type === 'message_delta' && j.usage) { outTok = j.usage.output_tokens || outTok; if (j.usage.input_tokens) inTok = j.usage.input_tokens; }
      if (j.type === 'error') throw new Error('Anthropic: ' + ((j.error && j.error.message) || data).slice(0, 300));
    });
    return { text, stop, inputTokens: inTok, outputTokens: outTok };
  }
}


AnthropicAdapter.prototype.chatTools = async function (o) {
  const msgs = [];
  const push = (role, blocks) => { const last = msgs[msgs.length - 1]; if (last && last.role === role) last.content.push(...blocks); else msgs.push({ role, content: blocks }); };
  for (const m of o.messages) {
    if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: [{ type: 'text', text: String(m.content || ' ') }, ...(m.images || []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } }))] }]);
    else if (m.role === 'assistant') push('assistant', [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))]);
    else push('user', [...(m.images || []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })), { type: 'text', text: m.content || ' ' }]);
  }
  if (msgs.length && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
  const body = { model: o.model, max_tokens: o.maxTokens || 8000, messages: msgs };
  if (o.system) body.system = o.system;
  if (o.temperature != null) body.temperature = Math.min(1, o.temperature);
  if (o.tools && o.tools.length) body.tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const res = await fetch(this.base + '/v1/messages', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await httpError(res, 'Anthropic');
  const j = await res.json();
  const blocks = j.content || [];
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    inputTokens: (j.usage && j.usage.input_tokens) || 0, outputTokens: (j.usage && j.usage.output_tokens) || 0 };
};

// ---------------- Google Gemini ----------------
class GeminiAdapter {
  constructor({ apiKey, baseUrl }) { this.apiKey = apiKey; this.base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''); }
  headers() { return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey }; }
  async listModels() {
    const all = []; let token = '';
    for (let page = 0; page < 50; page++) {
      const res = await fetch(this.base + '/models?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: this.headers(), signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw await httpError(res, 'Google');
      const j = await res.json(); all.push(...(j.models || []));
      if (!j.nextPageToken) break; token = j.nextPageToken;
    }
    return all.map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name, context: m.inputTokenLimit || null,
      kind: (m.supportedGenerationMethods || []).includes('generateContent') && !/(embedding|tts|audio)/.test(m.name) ? 'chat' : 'other' }));
  }
  async chat(o) {
    const contents = mergeTurns(o.messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || ' ' }, ...(m.images || []).map((im) => ({ inline_data: { mime_type: im.mime, data: im.b64 } }))],
    }));
    const body = { contents };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    if (o.webSearch) body.tools = [{ google_search: {} }];
    if (o.maxTokens || o.temperature != null) body.generationConfig = { ...(o.maxTokens ? { maxOutputTokens: o.maxTokens } : {}), ...(o.temperature != null ? { temperature: o.temperature } : {}) };
    const res = await fetch(`${this.base}/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw await httpError(res, 'Google');
    let text = '', usage = null, stop = 'stop';
    await readSSE(res, (_ev, data) => {
      const j = JSON.parse(data);
      const cand = j.candidates && j.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      for (const p of parts) if (p.text) { if (p.thought) { o.onThinking && o.onThinking(p.text); continue; } text += p.text; o.onDelta && o.onDelta(p.text); }
      if (cand && cand.finishReason === 'MAX_TOKENS') stop = 'length';
      if (j.usageMetadata) usage = j.usageMetadata;
    });
    return { text, stop, inputTokens: usage ? usage.promptTokenCount || 0 : estTokens(JSON.stringify(contents)), outputTokens: usage ? usage.candidatesTokenCount || 0 : estTokens(text) };
  }
}


// Gemini accepts an OpenAPI subset for parameters; strip keywords it rejects.
function geminiSchema(x) {
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== 'object') return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) { if (['additionalProperties', '$schema', 'default', 'examples', 'title'].includes(k)) continue; o[k] = geminiSchema(v); }
  return o;
}
GeminiAdapter.prototype.chatTools = async function (o) {
  const contents = [];
  for (const m of o.messages) {
    if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: { result: String(m.content || '') } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part); else contents.push({ role: 'user', parts: [part] });
      if (m.images && m.images.length) contents.push({ role: 'user', parts: [{ text: `(Image returned by ${m.name})` }, ...m.images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.b64 } }))] });
    } else if (m.role === 'assistant') {
      if (m.raw && m.raw.gemini) contents.push({ role: 'model', parts: m.raw.gemini });
      else contents.push({ role: 'model', parts: [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }))] });
    } else contents.push({ role: 'user', parts: [{ text: m.content || ' ' }, ...(m.images || []).map((im) => ({ inline_data: { mime_type: im.mime, data: im.b64 } }))] });
  }
  const body = { contents };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  if (o.tools && o.tools.length) body.tools = [{ functionDeclarations: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
  const res = await fetch(`${this.base}/models/${encodeURIComponent(o.model)}:generateContent`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await httpError(res, 'Google');
  const j = await res.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  let n = 0;
  return { text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(''), toolCalls: parts.filter((p) => p.functionCall).map((p) => ({ id: 'g' + (n++) + '_' + Date.now(), name: p.functionCall.name, args: p.functionCall.args || {} })),
    raw: { gemini: parts }, inputTokens: (j.usageMetadata && j.usageMetadata.promptTokenCount) || 0, outputTokens: (j.usageMetadata && j.usageMetadata.candidatesTokenCount) || 0 };
};

// ---------------- Ollama (local) ----------------
const SHOW_CACHE = new Map();
class OllamaAdapter {
  constructor({ baseUrl, net = null, apiKey = null }) { this.base = (baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, ''); this.net = net; this.apiKey = apiKey; }
  _fetch(url, init = {}) {
    const headers = { ...(init.headers || {}), ...((this.net && this.net.headers) || {}) }; if (this.apiKey) headers.authorization = 'Bearer ' + this.apiKey;
    return this.net ? netFetch(url, { ...init, headers }, this.net) : fetch(url, { ...init, headers });
  }
  async discover() {
    const t = (this.net && this.net.timeoutMs) || 4000;
    const tagsRes = await this._fetch(this.base + '/api/tags', { signal: AbortSignal.timeout(t) });
    if (!tagsRes.ok) throw await httpError(tagsRes, 'Ollama');
    const [tags, ps] = await Promise.all([tagsRes.json(), this._fetch(this.base + '/api/ps', { signal: AbortSignal.timeout(t) }).then((r) => r.json()).catch(() => ({ models: [] }))]);
    const loaded = new Map((ps.models || []).map((m) => [m.name || m.model, m]));
    const out = [];
    for (const m of tags.models || []) {
      const name = m.name || m.model;
      const d = m.details || {};
      let ctx = null, caps = [];
      const ck = `${this.base}|${name}|${m.digest || m.modified_at || ''}`; const hit = SHOW_CACHE.get(ck);
      if (hit) { ctx = hit.ctx; caps = hit.caps; } else try {
        const s = await this._fetch(this.base + '/api/show', { method: 'POST', body: JSON.stringify({ model: name, name }), signal: AbortSignal.timeout(t) }).then((r) => r.json());
        const mi = s.model_info || {};
        for (const k of Object.keys(mi)) if (k.endsWith('.context_length')) ctx = mi[k];
        caps = s.capabilities || []; SHOW_CACHE.set(ck, { ctx, caps });
      } catch {}
      const l = loaded.get(name);
      out.push({
        id: name, runtime: 'ollama', family: d.family || '', params: d.parameter_size || '', quant: d.quantization_level || '',
        sizeBytes: m.size || 0, memBytes: l ? (l.size || m.size) : Math.round((m.size || 0) * 1.15), context: ctx,
        loaded: !!l, vision: caps.includes('vision'), tools: caps.includes('tools'),
        vramBytes: l && l.size_vram != null ? l.size_vram : null, loadedContext: l && l.context_length ? l.context_length : null,
        caps: { chat: caps.includes('completion') || !caps.length, vision: caps.includes('vision'), tools: caps.includes('tools'), thinking: caps.includes('thinking'), embeddings: caps.includes('embedding') },
        source: { params: 'reported', quant: 'reported', context: ctx ? 'reported' : 'unknown', size: 'reported', caps: caps.length ? 'reported' : 'unknown' },
      });
    }
    return out;
  }
  async chat(o) {
    const messages = [];
    if (o.system) messages.push({ role: 'system', content: o.system });
    for (const m of mergeTurns(o.messages)) {
      const x = { role: m.role, content: m.content };
      if (m.images && m.images.length) x.images = m.images.map((i) => i.b64);
      messages.push(x);
    }
    const body = { model: o.model, messages, stream: true };
    if (o.numCtx || o.temperature != null) body.options = { ...(o.numCtx ? { num_ctx: o.numCtx } : {}), ...(o.temperature != null ? { temperature: o.temperature } : {}) };
    if (o.maxTokens) body.options = { ...(body.options || {}), num_predict: o.maxTokens };
    const res = await this._fetch(this.base + '/api/chat', { method: 'POST', body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw await httpError(res, 'Ollama');
    let text = '', inTok = 0, outTok = 0, stop = 'stop', serverTimings = null;
    await readNDJSON(res, (j) => {
      if (j.error) throw new Error('Ollama: ' + j.error);
      const th = j.message && j.message.thinking; if (th && o.onThinking) o.onThinking(th);
      const d = j.message && j.message.content;
      if (d) { text += d; o.onDelta && o.onDelta(d); }
      if (j.done) { inTok = j.prompt_eval_count || 0; outTok = j.eval_count || 0; if (j.done_reason === 'length') stop = 'length'; serverTimings = { load_ms: (j.load_duration || 0) / 1e6, prompt_ms: (j.prompt_eval_duration || 0) / 1e6, gen_ms: (j.eval_duration || 0) / 1e6 }; }
    });
    return { text, stop, serverTimings, inputTokens: inTok || estTokens(JSON.stringify(messages)), outputTokens: outTok || estTokens(text) };
  }
}


OllamaAdapter.prototype.chatTools = async function (o) {
  const messages = []; if (o.system) messages.push({ role: 'system', content: o.system });
  for (const m of o.messages) {
    if (m.role === 'tool') { messages.push({ role: 'tool', content: String(m.content || ''), tool_name: m.name }); if (m.images && m.images.length) messages.push({ role: 'user', content: `(Image returned by ${m.name})`, images: m.images.map((i) => i.b64) }); }
    else if (m.role === 'assistant') { const x = { role: 'assistant', content: m.content || '' }; if (m.toolCalls && m.toolCalls.length) x.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args || {} } })); messages.push(x); }
    else { const x = { role: 'user', content: m.content || ' ' }; if (m.images && m.images.length) x.images = m.images.map((i) => i.b64); messages.push(x); }
  }
  const body = { model: o.model, messages, stream: false, options: { num_ctx: o.numCtx || 16384, ...(o.temperature != null ? { temperature: o.temperature } : {}) } };
  if (o.tools && o.tools.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const res = await this._fetch(this.base + '/api/chat', { method: 'POST', body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await httpError(res, 'Ollama');
  const j = await res.json(); const msg = j.message || {};
  if (msg.thinking && o.onThinking) o.onThinking(msg.thinking);
  let n = 0;
  return { text: msg.content || '', toolCalls: (msg.tool_calls || []).map((c) => ({ id: 'o' + (n++) + '_' + Date.now(), name: c.function.name, args: safeParse(c.function.arguments) })),
    inputTokens: j.prompt_eval_count || estTokens(JSON.stringify(messages)), outputTokens: j.eval_count || estTokens(msg.content) };
};

// Self-hosted OpenAI-compatible servers: LM Studio, llama.cpp llama-server, vLLM, exo, MLX, KoboldCpp, Jan, LocalAI…
// discover() reports what each server says about its models; every field carries where it came from.
class LocalCompatRuntime {
  constructor({ baseUrl, runtime, preset, apiKey = null, net = null }) {
    this.root = String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, ''); this.base = this.root; this.runtime = runtime || preset || 'openai-compatible'; this.preset = preset || runtime || 'generic';
    this.apiKey = apiKey; this.net = net;
    this.oa = new OpenAIAdapter({ baseUrl: this.root + '/v1', compat: true, label: PRESET_NAMES[this.preset] || this.runtime, apiKey, net, progress: this.preset === 'llamacpp' });
  }
  async j(path, ms) {
    const r = await this.oa._fetch(this.root + path, { headers: this.oa.headers(), signal: AbortSignal.timeout(ms || (this.net && this.net.timeoutMs) || 6000) });
    if (!r.ok) throw await httpError(r, PRESET_NAMES[this.preset] || 'Server');
    return r.json();
  }
  async discover() {
    let list;
    try { list = await this.j('/v1/models'); }
    catch (e) { if (this.preset === 'mlx' && /JSON/i.test(e.message)) list = { data: [{ id: 'default_model@' + new URL(this.root).host }] }; else throw e; } // mlx_lm.server serving a local folder lists no models: it answers as "default_model"
    const items = list.data || list.models || [];
    const byId = new Map();
    const add = (m) => byId.set(m.id, { runtime: this.runtime, family: '', params: '', quant: '', sizeBytes: 0, memBytes: 0, context: null, loadedContext: null, loaded: true, vision: false, tools: true, file: null, caps: {}, source: {}, ...m });
    for (const m of items) {
      const id = m.id || m.name; if (!id) continue;
      const meta = m.meta || {};
      const x = { id, params: guessParams(id), quant: guessQuant(id), source: { params: 'guessed', quant: 'guessed', context: 'unknown', size: 'unknown', caps: 'unknown' } };
      if (meta.n_ctx_train) { x.context = meta.n_ctx_train; x.source.context = 'reported'; }
      if (meta.n_params) { x.params = (meta.n_params / 1e9).toFixed(meta.n_params < 1e10 ? 1 : 0) + 'B'; x.source.params = 'reported'; }
      if (meta.size) { x.sizeBytes = meta.size; x.memBytes = Math.round(meta.size * 1.1); x.source.size = 'reported'; }
      if (m.max_model_len) { x.context = m.max_model_len; x.source.context = 'reported'; }
      if (m.root && m.root !== id) x.file = m.root;
      x.vision = /vl\b|vl-|vision|llava|gemma-?3|pixtral|qwen2\.5-vl|minicpm-v/i.test(id); x.caps = { chat: !/embed|rerank/i.test(id), vision: x.vision, tools: true, embeddings: /embed/i.test(id) };
      add(x);
    }
    if (this.preset === 'lmstudio') await this.lmstudio(byId).catch(() => {});
    if (this.preset === 'llamacpp') await this.llamacpp(byId).catch(() => {});
    return [...byId.values()];
  }
  // LM Studio's native REST API reports format, quantisation, size, context and which models are loaded.
  async lmstudio(byId) {
    let d = null; try { d = await this.j('/api/v1/models'); } catch { d = await this.j('/api/v0/models'); }
    const arr = Array.isArray(d) ? d : d.data || d.models || [];
    for (const m of arr) {
      const id = m.key || m.id || m.model_key; if (!id) continue;
      const cur = byId.get(id) || { id, runtime: this.runtime, tools: true, caps: {}, source: {} };
      const q = m.quantization; const insts = m.loaded_instances || [];
      const caps = m.capabilities || {};
      Object.assign(cur, {
        family: m.architecture || m.arch || cur.family || '', publisher: m.publisher || null, format: m.format || m.compatibility_type || null,
        quant: (q && (q.name || q)) || cur.quant || '', params: m.params_string || cur.params || '', sizeBytes: m.size_bytes || cur.sizeBytes || 0,
        context: m.max_context_length || cur.context || null, loaded: insts.length ? true : m.state ? m.state === 'loaded' : false,
        loadedContext: (insts[0] && insts[0].config && insts[0].config.context_length) || m.loaded_context_length || null,
        vision: caps.vision != null ? !!caps.vision : m.type === 'vlm' || cur.vision, tools: caps.trained_for_tool_use != null ? !!caps.trained_for_tool_use : cur.tools,
        kind: m.type === 'embedding' || m.type === 'embeddings' ? 'embeddings' : 'chat',
      });
      cur.memBytes = cur.sizeBytes ? Math.round(cur.sizeBytes * 1.1) : cur.memBytes || 0;
      cur.caps = { chat: cur.kind !== 'embeddings', vision: cur.vision, tools: cur.tools, reasoning: !!caps.reasoning, embeddings: cur.kind === 'embeddings' };
      cur.source = { params: m.params_string ? 'reported' : 'guessed', quant: q ? 'reported' : 'guessed', context: m.max_context_length ? 'reported' : 'unknown', size: m.size_bytes ? 'reported' : 'unknown', caps: m.capabilities || m.type ? 'reported' : 'unknown' };
      if (cur.kind === 'embeddings') { byId.delete(id); continue; }
      byId.set(id, cur);
    }
  }
  async llamacpp(byId) {
    const p = await this.j('/props');
    const n = p.default_generation_settings && (p.default_generation_settings.n_ctx || (p.default_generation_settings.params && p.default_generation_settings.params.n_ctx));
    for (const m of byId.values()) { if (n) { m.loadedContext = n; } if (p.model_path) m.file = p.model_path; m.source.loadedContext = n ? 'reported' : 'unknown'; if (p.modalities && p.modalities.vision != null) { m.vision = !!p.modalities.vision; m.caps.vision = m.vision; } }
  }
  // "default_model@host:port" is how ForgeAI tells apart several MLX servers that each call their model "default_model".
  chat(o) { return this.oa.chat(/^default_model@/.test(o.model) ? { ...o, model: 'default_model' } : o); }
  chatTools(o) { return this.oa.chatTools(/^default_model@/.test(o.model) ? { ...o, model: 'default_model' } : o); }
}
const PRESET_NAMES = { engine: 'ForgeAI Engine', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM', exo: 'exo', mlx: 'MLX', ollama: 'Ollama', generic: 'OpenAI-compatible', 'openai-compatible': 'OpenAI-compatible', koboldcpp: 'KoboldCpp', jan: 'Jan', localai: 'LocalAI', worker: 'ForgeAI computer' };
function guessParams(id) { const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(id); return m ? m[1] + 'B' : ''; }
function guessQuant(id) { const m = /(q\d[_a-z0-9]*|\d-?bit|fp16|bf16)/i.exec(id); return m ? m[1].toUpperCase() : ''; }

// HTTPS to a worker Mac that uses ForgeAI's self-signed certificate: trust-on-first-use pinning.
// The first connection records the certificate fingerprint; any later change is refused.
function pinnedFetch(url, { method = 'GET', headers = {}, body, signal, pin, onPin } = {}) {
  if (!url.startsWith('https:')) return fetch(url, { method, headers, body, signal });
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, rejectUnauthorized: false, signal, agent: false }, (res) => { // agent:false = no TLS session resumption, so the certificate is always presented
      const fp = res.socket.getPeerCertificate && res.socket.getPeerCertificate().fingerprint256;
      if (pin && fp !== pin) { res.destroy(); return reject(new Error('Worker certificate changed — possible interception. Re-save the node to trust the new certificate.')); }
      if (!pin && fp && onPin) onPin(fp);
      const text = () => new Promise((ok) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c); res.on('end', () => ok(d)); });
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res, text, json: async () => JSON.parse(await text()) });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Another Mac running ForgeAI in "worker" mode.
class WorkerNodeAdapter {
  constructor({ baseUrl, token, pin, onPin }) { this.base = baseUrl.replace(/\/$/, ''); this.token = token; this.pin = pin; this.onPin = onPin; }
  headers() { return { 'content-type': 'application/json', authorization: 'Bearer ' + this.token }; }
  async discover() {
    const res = await pinnedFetch(this.base + '/node/models', { headers: this.headers(), signal: AbortSignal.timeout(6000), pin: this.pin, onPin: this.onPin });
    if (!res.ok) throw await httpError(res, 'Worker node');
    return (await res.json()).models || [];
  }
  async chat(o) {
    const res = await pinnedFetch(this.base + '/node/chat', { method: 'POST', headers: this.headers(), signal: o.signal, pin: this.pin, onPin: this.onPin,
      body: JSON.stringify({ model: o.model, runtime: o.runtime, system: o.system, messages: o.messages, maxTokens: o.maxTokens, temperature: o.temperature }) });
    if (!res.ok) throw await httpError(res, 'Worker node');
    let result = null;
    await readNDJSON(res, (j) => {
      if (j.error) throw new Error('Worker node: ' + j.error);
      if (j.progress && o.onProgress) o.onProgress(j.progress);
      if (j.delta) o.onDelta && o.onDelta(j.delta);
      if (j.done) result = j.result;
    });
    if (!result) throw new Error('Worker node closed the stream early');
    return result;
  }
  async get(path, ms = 4000) { const res = await pinnedFetch(this.base + path, { headers: this.headers(), signal: AbortSignal.timeout(ms), pin: this.pin, onPin: this.onPin }); if (!res.ok) throw await httpError(res, 'Worker node'); return res.json(); }
  async post(path, body, ms = 15000) { const res = await pinnedFetch(this.base + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms), pin: this.pin, onPin: this.onPin }); if (!res.ok) throw await httpError(res, 'Worker node'); return res.json(); }
  async chatTools(o) {
    const res = await pinnedFetch(this.base + '/node/chat-tools', { method: 'POST', headers: this.headers(), signal: o.signal, pin: this.pin, onPin: this.onPin,
      body: JSON.stringify({ model: o.model, system: o.system, messages: o.messages, tools: o.tools, maxTokens: o.maxTokens, temperature: o.temperature }) });
    if (!res.ok) throw await httpError(res, 'Worker node');
    return res.json();
  }
}

const PROVIDER_TYPES = {
  openai: { name: 'OpenAI', family: 'openai', defaultBase: 'https://api.openai.com/v1', make: (c) => new OpenAIAdapter(c), keyHelp: 'Create a project API key at platform.openai.com → API keys. A ChatGPT subscription does not include API usage; API billing is separate.' },
  anthropic: { name: 'Anthropic (Claude)', family: 'claude', defaultBase: 'https://api.anthropic.com', make: (c) => new AnthropicAdapter(c), keyHelp: 'Create an API key at console.anthropic.com → API Keys. A Claude.ai subscription does not include API usage; API billing is separate.' },
  google: { name: 'Google Gemini', family: 'google', defaultBase: 'https://generativelanguage.googleapis.com', make: (c) => new GeminiAdapter(c), keyHelp: 'Create an API key at aistudio.google.com → Get API key.' },
  openai_compat: { name: 'Other (OpenAI-compatible)', family: 'other', make: (c) => new OpenAIAdapter({ ...c, compat: true, label: 'Provider' }), keyHelp: 'Any service with an OpenAI-compatible API (e.g. OpenRouter, Groq, Together, Mistral). Enter its base URL and key.' },
};

module.exports = { PRESET_NAMES, httpError, pinnedFetch, OpenAIAdapter, AnthropicAdapter, GeminiAdapter, OllamaAdapter, LocalCompatRuntime, WorkerNodeAdapter, PROVIDER_TYPES, estTokens, readNDJSON };
