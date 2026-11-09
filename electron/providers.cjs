/**
 * Cloud model providers behind one interface.
 *
 *   listModels(provider, opts)  → { models: [{ id, label }] }   authenticated, from the provider's own API
 *   stream(provider, opts)      → { tokens, stopReason, usage }  streams via onToken(text)
 *
 * Failures are ProviderError with a `kind`:
 *   auth | rate_limit | bad_request | not_found | server | network | timeout |
 *   redirect | malformed | cancelled | unsupported | limit
 *
 * Keys come from the caller (the keychain). They are never stored here, and any
 * key text that appears in an error message is replaced before it is returned.
 * Base URLs must be https, or http to this computer (fixtures and local gateways).
 * Redirects are refused, so a request cannot be bounced to another host.
 */
const DEFAULTS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const LIMITS = {
  testMs: 20_000,          // connection test and model listing
  streamMs: 10 * 60_000,   // one whole response
  requestBytes: 2 * 1024 * 1024,
  outputChars: 400_000,
  errorBodyChars: 400,
  listPages: 5,
  listModels: 1000,
};
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

class ProviderError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

function checkBase(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new ProviderError("The provider address is not a valid URL.", "bad_request"); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new ProviderError("Providers must use https://.", "bad_request");
  }
  if (u.username || u.password) throw new ProviderError("Put credentials in the key field, not in the address.", "bad_request");
  return u.toString().replace(/\/$/, "");
}

function checkModelId(id) {
  if (typeof id !== "string" || !MODEL_ID.test(id)) throw new ProviderError("That model name is not valid.", "bad_request");
  return id;
}

/** Removes the key from any text shown to the person or written to a log. */
function redact(text, key) {
  let s = String(text ?? "");
  if (key && key.length >= 8) s = s.split(key).join("[key removed]");
  return s;
}

function mapStatus(status, body, key) {
  const detail = redact((body || "").slice(0, LIMITS.errorBodyChars), key).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) return new ProviderError("The provider rejected this key. Check it, or that the key has access to this service.", "auth", status);
  if (status === 429) return new ProviderError("The provider is rate-limiting requests. Wait a moment and try again.", "rate_limit", status);
  if (status === 404) return new ProviderError(`That model or endpoint was not found${detail ? `: ${detail}` : "."} Check the model name, or whether this account can use it.`, "not_found", status);
  if (status === 400 || status === 422) return new ProviderError(`The provider refused the request${detail ? `: ${detail}` : "."}`, "bad_request", status);
  return new ProviderError(`The provider had a problem (HTTP ${status}).`, "server", status);
}

/** Turns any thrown fetch/read error into a ProviderError with the right kind. */
function classify(e, userSignal, timer, key) {
  if (e instanceof ProviderError) return e;
  if (userSignal && userSignal.aborted) return new ProviderError("Stopped.", "cancelled");
  if (timer && timer.aborted) return new ProviderError("The provider did not finish in time.", "timeout");
  const msg = redact(e && e.message ? e.message : String(e), key);
  return new ProviderError(`Could not reach the provider: ${msg}`, "network");
}

function signalsFor(userSignal, ms) {
  const timer = AbortSignal.timeout(ms);
  const parts = [timer, userSignal].filter(Boolean);
  return { timer, signal: parts.length > 1 ? AbortSignal.any(parts) : parts[0] };
}

async function send(url, init, { userSignal, ms, key }) {
  const { timer, signal } = signalsFor(userSignal, ms);
  let res;
  try {
    res = await fetch(url, { ...init, signal, redirect: "manual" });
  } catch (e) {
    throw classify(e, userSignal, timer, key);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError("The provider tried to redirect the request, and Forge AI refuses redirects.", "redirect", res.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw mapStatus(res.status, text, key);
  }
  return { res, timer, signal };
}

/** Reads SSE frames and hands each `data:` payload to onData. */
async function readSSE(body, onData, { userSignal, timer, key }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > LIMITS.outputChars * 4) throw new ProviderError("The response exceeded the size limit.", "limit");
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) if (line.startsWith("data:")) onData(line.slice(5).trim());
      }
    }
  } catch (e) {
    throw classify(e, userSignal, timer, key);
  }
  buf += decoder.decode();
  for (const line of buf.split("\n")) if (line.startsWith("data:")) onData(line.slice(5).trim());
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { throw new ProviderError("The provider sent a response Forge AI could not read.", "malformed"); }
}

// ── model listing ─────────────────────────────────────────────

const OPENAI_NON_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search|davinci|babbage|computer-use/i;

/** Lists models the key can use, from the provider's own endpoint. Pages are followed, with a cap. */
async function listModels(provider, { apiKey, baseUrl, signal, timeoutMs } = {}) {
  if (!DEFAULTS[provider]) throw new ProviderError(`Forge AI has no adapter for "${provider}".`, "unsupported");
  if (!apiKey) throw new ProviderError("No key is saved for this provider.", "auth");
  const base = checkBase(baseUrl || DEFAULTS[provider]);
  const out = [];
  if (provider === "anthropic") {
    let after = null;
    for (let page = 0; page < LIMITS.listPages; page++) {
      const q = new URLSearchParams({ limit: "100" });
      if (after) q.set("after_id", after);
      const { res, timer } = await send(`${base}/v1/models?${q}`, {
        method: "GET",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      }, { userSignal: signal, ms: timeoutMs ?? LIMITS.testMs, key: apiKey });
      const body = parseJSON(await res.text().catch(() => { throw classify(new Error("read failed"), signal, timer, apiKey); }));
      if (!Array.isArray(body?.data)) throw new ProviderError("The provider's model list had an unexpected shape.", "malformed");
      for (const m of body.data) {
        if (typeof m?.id === "string" && MODEL_ID.test(m.id)) out.push({ id: m.id, label: typeof m.display_name === "string" ? m.display_name.slice(0, 120) : m.id });
      }
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
  } else if (provider === "openai") {
    const { res } = await send(`${base}/v1/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    }, { userSignal: signal, ms: timeoutMs ?? LIMITS.testMs, key: apiKey });
    const body = parseJSON(await res.text());
    if (!Array.isArray(body?.data)) throw new ProviderError("The provider's model list had an unexpected shape.", "malformed");
    for (const m of body.data) {
      if (typeof m?.id === "string" && MODEL_ID.test(m.id) && !OPENAI_NON_CHAT.test(m.id)) out.push({ id: m.id, label: m.id });
    }
  } else {
    throw new ProviderError(`Forge AI has no adapter for "${provider}".`, "unsupported");
  }
  const unique = [...new Map(out.map((m) => [m.id, m])).values()].slice(0, LIMITS.listModels);
  unique.sort((a, b) => a.id.localeCompare(b.id));
  return { models: unique };
}

// ── streaming ─────────────────────────────────────────────────

async function anthropicStream({ baseUrl, apiKey, model, system, messages, maxTokens = 1024, signal, onToken, timeoutMs }) {
  const base = checkBase(baseUrl || DEFAULTS.anthropic);
  checkModelId(model);
  const body = JSON.stringify({ model, max_tokens: maxTokens, stream: true, system: system || undefined, messages });
  if (body.length > LIMITS.requestBytes) throw new ProviderError("The conversation is too long to send in one request. Start a new chat or remove attachments.", "limit");
  const { res, timer } = await send(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body,
  }, { userSignal: signal, ms: timeoutMs ?? LIMITS.streamMs, key: apiKey });
  let tokens = 0, chars = 0, stopReason = null;
  const usage = { input: null, output: null };
  await readSSE(res.body, (data) => {
    if (!data) return;
    const ev = parseJSON(data);
    if (ev.type === "error") throw new ProviderError(`The provider reported an error: ${redact(ev.error?.message ?? "unknown", apiKey)}`, "server");
    if (ev.type === "message_start" && typeof ev.message?.usage?.input_tokens === "number") usage.input = ev.message.usage.input_tokens;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      chars += ev.delta.text.length;
      if (chars > LIMITS.outputChars) throw new ProviderError("The reply exceeded the size limit and was stopped.", "limit");
      tokens += 1; onToken(ev.delta.text);
    }
    if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (typeof ev.usage?.output_tokens === "number") usage.output = ev.usage.output_tokens;
    }
  }, { userSignal: signal, timer, key: apiKey });
  return { tokens, stopReason, usage };
}

async function openaiStream({ baseUrl, apiKey, model, system, messages, maxTokens = 1024, signal, onToken, timeoutMs }) {
  const base = checkBase(baseUrl || DEFAULTS.openai);
  checkModelId(model);
  const all = system ? [{ role: "system", content: system }, ...messages] : messages;
  const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, messages: all });
  if (body.length > LIMITS.requestBytes) throw new ProviderError("The conversation is too long to send in one request. Start a new chat or remove attachments.", "limit");
  const { res, timer } = await send(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body,
  }, { userSignal: signal, ms: timeoutMs ?? LIMITS.streamMs, key: apiKey });
  let tokens = 0, chars = 0, stopReason = null;
  const usage = { input: null, output: null };
  await readSSE(res.body, (data) => {
    if (!data || data === "[DONE]") return;
    const ev = parseJSON(data);
    if (ev.error) throw new ProviderError(`The provider reported an error: ${redact(ev.error.message ?? "unknown", apiKey)}`, "server");
    const piece = ev.choices?.[0]?.delta?.content;
    if (typeof piece === "string" && piece) {
      chars += piece.length;
      if (chars > LIMITS.outputChars) throw new ProviderError("The reply exceeded the size limit and was stopped.", "limit");
      tokens += 1; onToken(piece);
    }
    if (ev.choices?.[0]?.finish_reason) stopReason = ev.choices[0].finish_reason;
    if (ev.usage) {
      usage.input = typeof ev.usage.prompt_tokens === "number" ? ev.usage.prompt_tokens : null;
      usage.output = typeof ev.usage.completion_tokens === "number" ? ev.usage.completion_tokens : null;
    }
  }, { userSignal: signal, timer, key: apiKey });
  return { tokens, stopReason, usage };
}

const ADAPTERS = { anthropic: anthropicStream, openai: openaiStream };

async function stream(provider, args) {
  const fn = ADAPTERS[provider];
  if (!fn) throw new ProviderError(`Forge AI has no adapter for "${provider}".`, "unsupported");
  if (!args.apiKey) throw new ProviderError("No key is saved for this provider.", "auth");
  return fn(args);
}

module.exports = { stream, listModels, ProviderError, checkBase, checkModelId, redact, DEFAULTS, LIMITS };
