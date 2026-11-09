/**
 * Cloud model providers behind one streaming interface.
 *
 * Each adapter turns a provider's wire format into the same events:
 *   onToken(text), and a resolved { tokens, stopReason }, or a thrown ProviderError.
 * Keys come from the caller (the keychain); this module never stores them.
 * Base URLs must be https, or http to this computer (fixtures and local gateways).
 */
const DEFAULTS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

class ProviderError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind; // "auth" | "rate_limit" | "bad_request" | "server" | "network" | "cancelled" | "unsupported"
    this.status = status;
  }
}

function checkBase(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ProviderError("The provider address is not a valid URL.", "bad_request"); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new ProviderError("Providers must use https://.", "bad_request");
  }
  return u.toString().replace(/\/$/, "");
}

function mapStatus(status, body) {
  const detail = (body || "").slice(0, 200).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) return new ProviderError("The provider rejected the key. Check it in Settings.", "auth", status);
  if (status === 429) return new ProviderError("The provider is rate-limiting requests. Wait a moment and try again.", "rate_limit", status);
  if (status === 400 || status === 404 || status === 422) return new ProviderError(`The provider refused the request${detail ? `: ${detail}` : ""}.`, "bad_request", status);
  return new ProviderError(`The provider had a problem (HTTP ${status}).`, "server", status);
}

/** Reads SSE frames, calling onData with each `data:` payload. Frames end at a blank line. */
async function readSSE(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) onData(line.slice(5).trim());
      }
    }
  }
  buf += decoder.decode();
  if (buf.trim()) for (const line of buf.split("\n")) if (line.startsWith("data:")) onData(line.slice(5).trim());
}

async function send(url, init, signal) {
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw new ProviderError("Stopped.", "cancelled");
    throw new ProviderError(`Could not reach the provider: ${e && e.message ? e.message : e}`, "network");
  }
}

async function failIfNotOk(res) {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw mapStatus(res.status, text);
}

/** Anthropic Messages API, streaming. */
async function anthropicStream({ baseUrl, apiKey, model, system, messages, maxTokens = 1024, signal, onToken }) {
  const base = checkBase(baseUrl || DEFAULTS.anthropic);
  const res = await send(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system: system || undefined, messages }),
  }, signal);
  await failIfNotOk(res);
  let tokens = 0, stopReason = null;
  await readSSE(res.body, (data) => {
    if (!data) return;
    const ev = JSON.parse(data);
    if (ev.type === "error") throw new ProviderError(`The provider reported an error: ${ev.error?.message ?? "unknown"}`, "server");
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      tokens += 1; onToken(ev.delta.text);
    }
    if (ev.type === "message_delta" && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
  });
  return { tokens, stopReason };
}

/** OpenAI Chat Completions, streaming. */
async function openaiStream({ baseUrl, apiKey, model, system, messages, maxTokens = 1024, signal, onToken }) {
  const base = checkBase(baseUrl || DEFAULTS.openai);
  const all = system ? [{ role: "system", content: system }, ...messages] : messages;
  const res = await send(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: all }),
  }, signal);
  await failIfNotOk(res);
  let tokens = 0, stopReason = null;
  await readSSE(res.body, (data) => {
    if (!data || data === "[DONE]") return;
    const ev = JSON.parse(data);
    const piece = ev.choices?.[0]?.delta?.content;
    if (piece) { tokens += 1; onToken(piece); }
    if (ev.choices?.[0]?.finish_reason) stopReason = ev.choices[0].finish_reason;
  });
  return { tokens, stopReason };
}

const ADAPTERS = { anthropic: anthropicStream, openai: openaiStream };

/** Single entry point. Unknown providers are refused rather than guessed at. */
async function stream(provider, args) {
  const fn = ADAPTERS[provider];
  if (!fn) throw new ProviderError(`Forge AI has no adapter for "${provider}".`, "unsupported");
  if (!args.apiKey) throw new ProviderError("No key is saved for this provider.", "auth");
  return fn(args);
}

module.exports = { stream, ProviderError, checkBase, DEFAULTS, mapStatus };
