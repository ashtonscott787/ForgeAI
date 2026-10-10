'use strict';
// Model / backend / machine health: what failed, how often, and whether automatic routing should avoid it for a while.
// Every failure is classified into one of a few plain kinds (never a vague "fetch failed"), recorded against the
// model, its backend (endpoint) and its machine, and a circuit breaker takes a repeatedly failing one out of
// automatic selection for a cooldown. Manual picks still work (with a warning), so the user stays in control.

const KINDS = {
  MODEL_FAILED: { title: 'The model crashed or could not start', cooldownMs: 30 * 60000, after: 3, scope: 'model', retryOther: true },
  BACKEND_FAILED: { title: 'The model app stopped answering', cooldownMs: 5 * 60000, after: 2, scope: 'endpoint', retryOther: true },
  MACHINE_UNREACHABLE: { title: 'The computer could not be reached', cooldownMs: 2 * 60000, after: 1, scope: 'machine', retryOther: true },
  NETWORK_FAILED: { title: 'Network problem', cooldownMs: 60000, after: 2, scope: 'endpoint', retryOther: true },
  API_KEY_INVALID: { title: 'The API key was refused', cooldownMs: 10 * 60000, after: 1, scope: 'endpoint', retryOther: true },
  RATE_LIMITED: { title: 'The provider is rate-limiting requests', cooldownMs: 2 * 60000, after: 1, scope: 'endpoint', retryOther: true },
  OUT_OF_MEMORY: { title: 'Not enough memory for this model', cooldownMs: 30 * 60000, after: 1, scope: 'model', retryOther: true },
  TIMEOUT: { title: 'No answer in time', cooldownMs: 2 * 60000, after: 2, scope: 'endpoint', retryOther: true },
  REQUEST_REJECTED: { title: 'The request was rejected', cooldownMs: 0, after: 99, scope: 'model', retryOther: false },
  USER_CANCELLED: { title: 'Stopped', cooldownMs: 0, after: 99, scope: null, retryOther: false },
  UNKNOWN: { title: 'Something went wrong', cooldownMs: 5 * 60000, after: 3, scope: 'model', retryOther: true },
};

// Turn any error into { kind, title, text, causes, next, raw }. The raw text is kept for "technical details".
function classify(e, ctx = {}) {
  const raw = String((e && e.stack) || (e && e.message) || e || '').slice(0, 4000);
  const msg = String((e && e.message) || e || ''); const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  const status = e && (e.status || (e.cause && e.cause.status));
  const where = ctx.where || 'the model server'; const model = ctx.model || 'The model';
  const mk = (kind, text, causes = [], next = null) => ({ kind, title: KINDS[kind].title, text, causes, next, raw, status: status || null, code: code || null });
  if (e && (e.name === 'AbortError' || code === 'ABORT_ERR') && ctx.aborted) return mk('USER_CANCELLED', 'You stopped this request.', []);
  if (/out of memory|insufficient memory|failed to allocate|cannot allocate|OOM|not enough memory|exceeds (available|free) memory|does not fit/i.test(msg)) return mk('OUT_OF_MEMORY', `${model} needs more memory than ${ctx.node || 'this computer'} has free right now.`, ['Other models are loaded and using memory', 'The context length is set high', 'The model is simply too big for this computer'], 'Unload idle models, lower the context length, use a smaller quantisation, or run it on another computer or as a cluster.');
  if (/Failed to load model|model has crashed|Engine protocol startup was aborted|Model unloaded by user or API request|engine.*(crash|abort)|generation.*(crash|failed)|llama_decode|Metal.*(error|fail)|MLX.*(error|crash)|exited (with )?code|model loading error|not supported by this (engine|backend)|unknown model architecture|unsupported architecture/i.test(msg)) {
    const incompatible = /unknown model architecture|unsupported|not supported by this/i.test(msg);
    return mk('MODEL_FAILED', `${model} ${incompatible ? 'is not supported by' : 'crashed or could not start in'} ${ctx.appName || where}.`, incompatible ? ['The model format or architecture is newer than the app understands', 'The file is damaged'] : ['Not enough free memory', 'A bug in the model app’s engine (MLX, llama.cpp…)', 'An incompatible or damaged model file', 'The model was unloaded while answering'], incompatible ? 'Update the app, or download a different build of the model.' : 'Try again once, try a smaller quantisation, or use another model. ForgeAI has set this model aside for automatic routing for a while.');
  }
  if (status === 401 || status === 403 || /API key was rejected|access denied \(403\)|Invalid API token|invalid_api_key/i.test(msg)) return mk('API_KEY_INVALID', `${where} refused the API key or token${status ? ` (${status})` : ''}.`, ['The key is wrong, expired or revoked', 'The key lacks permission for this model'], 'Check the key under AI providers (or the token under Models → Engines).');
  if (status === 429 || /rate limit|rate-limit|too many requests/i.test(msg)) return mk('RATE_LIMITED', `${where} is rate-limiting requests right now.`, ['Too many requests in a short time', 'The provider tier is small'], 'Wait a minute, lower usage in Limits, or let Auto use a local model.');
  if (code === 'ECONNREFUSED' || /connection refused|not running and listening/i.test(msg)) return mk('BACKEND_FAILED', `${ctx.appName || where} is not running (connection refused).`, ['The app quit or crashed', 'Its server is switched off', 'It listens on a different port'], 'ForgeAI will try to start it again on the next request; or open it yourself.');
  if (/ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|host name could not be found|no response \(timed out\)|Check the computer is on/i.test(msg + code) && ctx.remote) return mk('MACHINE_UNREACHABLE', `${ctx.node || where} could not be reached.`, ['The computer is off or asleep', 'It is on a different network or the VPN is down', 'A firewall blocks the port'], 'Wake the computer, check it is on the same network or VPN, then try again.');
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|TimeoutError|timed out|timeout|took too long|did not become ready/i.test(msg + code) || code === '23') return mk('TIMEOUT', `${where} did not answer in time.`, ['The model is still loading', 'The computer is overloaded', 'The network is slow'], 'Try again in a moment, raise the timeout for this server, or pick a smaller model.');
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed|connection was dropped|fetch failed|operation was aborted|terminated/i.test(msg + code)) return mk(ctx.remote ? 'NETWORK_FAILED' : 'BACKEND_FAILED', ctx.remote ? `The connection to ${where} dropped mid-request.` : `${ctx.appName || where} dropped the connection mid-request — it probably crashed.`, ctx.remote ? ['Wi-Fi or VPN hiccup', 'The server restarted'] : ['The model app crashed while generating', 'The model was unloaded by the app', 'Out of memory inside the app'], ctx.remote ? 'Try again; if it keeps happening, use a cable or check the server.' : 'Try again or use another model. ForgeAI will avoid this one automatically for a while if it keeps failing.');
  if (status === 400 || status === 413 || status === 422 || /was rejected \(4\d\d\)|context length|too many tokens|maximum context/i.test(msg)) return mk('REQUEST_REJECTED', `${where} rejected this request: ${msg.replace(/^.*?rejected \(\d+\): /, '').slice(0, 200)}`, ['The conversation is longer than the model’s context', 'An attachment is too large', 'An option the model does not support'], 'Start a new chat, remove large attachments, or pick a model with a bigger context.');
  if (status >= 500) return mk('BACKEND_FAILED', `${where} reported a server error (${status}).`, ['The app has no model loaded', 'The app hit an internal error'], 'Check the app, then try again.');
  return mk('UNKNOWN', msg.slice(0, 300) || 'The request failed.', [], 'Try again, or use another model. Open technical details for the raw error.');
}

class Health {
  constructor(store) { this.store = store; this.data = store.getSetting('health', {}); this._dirty = false; this.inflight = new Map(); setInterval(() => this.flush(), 15000).unref(); }
  flush() { if (this._dirty) { this.store.setSetting('health', this.data); this._dirty = false; } }
  key(kind, id) { return `${kind}:${id}`; }
  rec(k) { return (this.data[k] = this.data[k] || { ok: 0, fail: 0, crashes: 0, consecutive: 0, lastError: null, lastOk: null, lastFail: null, cooldownUntil: 0, cooldownWhy: null, loadMs: null, ttftMs: null, tps: null, loadedOnce: false, failKinds: {} }); }
  begin(k) { this.inflight.set(k, (this.inflight.get(k) || 0) + 1); }
  done(k) { this.inflight.set(k, Math.max(0, (this.inflight.get(k) || 1) - 1)); }
  busy(k) { return this.inflight.get(k) || 0; }
  ema(old, v) { return old == null ? v : old * 0.7 + v * 0.3; }
  // Record one request. keys = { model, endpoint, machine } (any may be null). stats = { tps, ttftMs, loadMs }.
  success(keys, stats = {}) {
    for (const [scope, id] of Object.entries(keys)) { if (!id) continue; const r = this.rec(this.key(scope, id)); r.ok++; r.consecutive = 0; r.lastOk = Date.now(); r.loadedOnce = true; if (r.cooldownUntil && r.cooldownWhy && r.cooldownWhy.probe) { r.cooldownUntil = 0; r.cooldownWhy = null; }
      if (scope === 'model') { if (stats.tps) r.tps = this.ema(r.tps, stats.tps); if (stats.ttftMs != null) r.ttftMs = this.ema(r.ttftMs, stats.ttftMs); if (stats.loadMs) r.loadMs = this.ema(r.loadMs, stats.loadMs); } }
    this._dirty = true;
  }
  failure(keys, info) {
    const K = KINDS[info.kind] || KINDS.UNKNOWN; const out = [];
    for (const [scope, id] of Object.entries(keys)) {
      if (!id) continue; const r = this.rec(this.key(scope, id));
      if (info.kind === 'USER_CANCELLED') continue;
      r.fail++; r.lastFail = Date.now(); r.lastError = { kind: info.kind, text: info.text, at: Date.now() }; r.failKinds[info.kind] = (r.failKinds[info.kind] || 0) + 1;
      if (['MODEL_FAILED', 'OUT_OF_MEMORY', 'BACKEND_FAILED'].includes(info.kind) && scope === 'model') r.crashes++;
      const counts = scope === K.scope || (K.scope === 'model' && scope === 'model') || (K.scope === 'endpoint' && scope === 'endpoint') || (K.scope === 'machine' && scope === 'machine');
      if (counts) { r.consecutive++; if (r.consecutive >= K.after && K.cooldownMs) { r.cooldownUntil = Date.now() + K.cooldownMs; r.cooldownWhy = { kind: info.kind, text: info.text, n: r.consecutive, probe: false }; out.push({ scope, id, until: r.cooldownUntil, minutes: Math.round(K.cooldownMs / 60000), n: r.consecutive }); } }
    }
    this._dirty = true; return out;
  }
  // Why automatic routing is avoiding something right now (null = fine). Manual picks are allowed with this as a warning.
  avoid(keys) {
    const nowT = Date.now();
    for (const [scope, id] of Object.entries(keys)) { if (!id) continue; const r = this.data[this.key(scope, id)]; if (r && r.cooldownUntil > nowT) { const left = Math.ceil((r.cooldownUntil - nowT) / 60000); return { scope, id, kind: r.cooldownWhy && r.cooldownWhy.kind, text: `${scope === 'model' ? 'Model' : scope === 'endpoint' ? 'App' : 'Computer'} set aside for ${left} more min after ${r.cooldownWhy ? r.cooldownWhy.n + '× ' + KINDS[r.cooldownWhy.kind].title.toLowerCase() : 'failures'}`, minutesLeft: left }; } }
    return null;
  }
  // Allow one automatic test of a cooled-down item once half the cooldown has passed (recovery probing).
  probeAllowed(keys) { const nowT = Date.now(); for (const [scope, id] of Object.entries(keys)) { const r = this.data[this.key(scope, id)]; if (r && r.cooldownUntil > nowT && r.cooldownWhy && !r.cooldownWhy.probe && (r.cooldownUntil - nowT) < (KINDS[r.cooldownWhy.kind] || KINDS.UNKNOWN).cooldownMs / 2) { r.cooldownWhy.probe = true; this._dirty = true; return true; } } return false; }
  clear(scope, id) { const r = this.data[this.key(scope, id)]; if (r) { r.cooldownUntil = 0; r.cooldownWhy = null; r.consecutive = 0; this._dirty = true; } }
  disable(scope, id, on) { const r = this.rec(this.key(scope, id)); r.disabled = !!on; this._dirty = true; }
  get(scope, id) { return this.data[this.key(scope, id)] || null; }
  // One word for the dashboard.
  state(scope, id, live = {}) {
    const r = this.get(scope, id); const nowT = Date.now();
    if (r && r.disabled) return 'Disabled';
    if (live.incompatible) return 'Incompatible';
    if (live.loading) return 'Loading';
    if (r && r.cooldownUntil > nowT) return r.cooldownWhy && r.cooldownWhy.kind === 'OUT_OF_MEMORY' ? 'Out of memory' : 'Crashed';
    if (!r || (!r.ok && !r.fail)) return 'Unknown';
    if (r.lastFail && (!r.lastOk || r.lastFail > r.lastOk) && r.consecutive > 0) return 'Crashed';
    if (r.tps != null && r.tps < 5) return 'Slow';
    return 'Healthy';
  }
  stats(scope, id) { const r = this.get(scope, id); if (!r) return null; const total = r.ok + r.fail; return { ok: r.ok, fail: r.fail, crashes: r.crashes, crashRate: total ? r.crashes / total : 0, failRate: total ? r.fail / total : 0, tps: r.tps, ttftMs: r.ttftMs, loadMs: r.loadMs, lastError: r.lastError, lastOk: r.lastOk, lastFail: r.lastFail, cooldownUntil: r.cooldownUntil > Date.now() ? r.cooldownUntil : null, cooldownWhy: r.cooldownUntil > Date.now() ? r.cooldownWhy : null, disabled: !!r.disabled, loadedOnce: r.loadedOnce, failKinds: r.failKinds }; }
}

module.exports = { Health, classify, KINDS };
