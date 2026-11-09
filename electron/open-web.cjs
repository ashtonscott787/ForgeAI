/**
 * Keyless web information: Wikipedia's public API, and text extraction for pages
 * the person opens in the built-in browser.
 *
 * No key is needed. Wikipedia asks clients to identify themselves, so requests
 * carry a descriptive User-Agent. Nothing here searches a commercial engine by
 * scraping its result pages.
 */
const https = require("node:https");
const http = require("node:http");

const DEFAULT_BASE = "https://en.wikipedia.org";
const UA = "ForgeAI/0.5 (desktop app; keyless information lookup)";
const LIMITS = { timeoutMs: 15_000, bodyBytes: 512 * 1024, snippets: 5, textChars: 20_000 };

class WebError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "WebError";
    this.kind = kind;
  }
}

/** https only, or http to this computer (tests). No credentials in the address. */
function checkBase(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new WebError("That address is not valid.", "bad_request"); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new WebError("Only https:// addresses are allowed.", "bad_request");
  if (u.username || u.password) throw new WebError("Addresses may not contain credentials.", "bad_request");
  return u;
}

/** Only web pages on public https addresses may be opened in the browser. */
function checkPageUrl(raw) {
  const u = checkBase(raw);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") throw new WebError("Local addresses cannot be opened in the browser.", "bad_request");
  return u.toString();
}

// How requests leave the machine. Electron's net module uses the system proxy settings, which a
// corporate network needs; plain Node https ignores them. The app injects Electron's transport.
let transport = null;
function useTransport(fn) { transport = fn; }

function nodeGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": UA, Accept: "application/json" }, timeout: timeoutMs }, (res) => {
      let body = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        size += Buffer.byteLength(c);
        if (size > LIMITS.bodyBytes) { req.destroy(); reject(new WebError("The source sent too much data.", "limit")); return; }
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", () => reject(new WebError("The connection to the source was lost.", "network")));
    });
    req.on("timeout", () => req.destroy(new WebError("The source did not answer in time.", "timeout")));
    req.on("error", (e) => (e instanceof WebError ? reject(e) : reject(new WebError(`Could not reach the source: ${e.message}`, "network"))));
  });
}

async function getJSON(url, { timeoutMs = LIMITS.timeoutMs } = {}) {
  const r = transport
    ? await transport(url.toString(), { timeoutMs, maxBytes: LIMITS.bodyBytes, userAgent: UA })
    : await nodeGet(url, timeoutMs);
  if (r.status >= 300 && r.status < 400) throw new WebError("The source redirected the request, which Forge AI refuses.", "redirect");
  if (r.status === 429) throw new WebError("The source is rate-limiting requests from this computer. Try again in a minute.", "rate_limit");
  if (r.status !== 200) throw new WebError(`The source answered HTTP ${r.status}.`, "server");
  try { return JSON.parse(r.body); } catch { throw new WebError("The source sent a response that could not be read.", "malformed"); }
}

const strip = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * Wikipedia full-text search. Returns sources with their URLs, so every answer can cite them.
 */
async function wikipediaSearch(query, { base = DEFAULT_BASE, limit = LIMITS.snippets } = {}) {
  const q = String(query ?? "").trim().slice(0, 300);
  if (!q) throw new WebError("Nothing to search for.", "bad_request");
  const u = checkBase(base);
  u.pathname = "/w/api.php";
  u.search = new URLSearchParams({ action: "query", list: "search", srsearch: q, srlimit: String(Math.min(limit, 10)), format: "json", utf8: "1" }).toString();
  const data = await getJSON(u);
  const hits = data?.query?.search;
  if (!Array.isArray(hits)) throw new WebError("The source sent an unexpected reply.", "malformed");
  const sources = hits.slice(0, limit).map((h) => {
    const title = String(h.title ?? "");
    return {
      title,
      url: `${u.origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: strip(h.snippet ?? "").slice(0, 400),
    };
  });
  return {
    provider: "wikipedia",
    query: q,
    sources,
    answer: sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}`).join("\n\n"),
    fetched_at: Date.now(),
  };
}

/** The lead section of one article, for a model that wants more than a snippet. */
async function wikipediaSummary(title, { base = DEFAULT_BASE } = {}) {
  const t = String(title ?? "").trim();
  if (!t || t.length > 200) throw new WebError("That article title is not valid.", "bad_request");
  const u = checkBase(base);
  u.pathname = `/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`;
  u.search = "";
  const data = await getJSON(u);
  if (typeof data?.extract !== "string") throw new WebError("The article has no summary.", "malformed");
  return {
    title: String(data.title ?? t),
    text: data.extract.slice(0, LIMITS.textChars),
    url: data.content_urls?.desktop?.page ?? `${u.origin}/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`,
  };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Plain text from a page's HTML: scripts, styles and templates removed; block breaks kept as line breaks. */
function readablePageText(html, maxChars = LIMITS.textChars) {
  const text = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/?p|\/?div|\/?li|\/?h[1-6]|\/?tr|\/?section|\/?article|\/?header|\/?footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const lines = decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.join("\n").slice(0, maxChars);
}

module.exports = { wikipediaSearch, wikipediaSummary, readablePageText, checkPageUrl, useTransport, WebError, LIMITS };
