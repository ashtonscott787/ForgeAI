/**
 * Internet search, from more than one place.
 *
 * Forge AI shipped with Wikipedia only, which is keyless and dependable but is
 * not the internet. This adds real search engines behind one interface:
 *
 *   wikipedia  keyless, always available, encyclopaedic only
 *   searxng    keyless, points at an instance the person names (their own, or
 *              a public one). Many public instances disable the JSON API, so a
 *              refusal here is expected and is reported as itself.
 *   brave      needs the person's own key
 *   tavily     needs the person's own key
 *
 * Rules that hold for every provider:
 *
 * - No key is ever compiled in. Keys come from the OS keychain at call time.
 * - A failure is reported as a failure. There is no silent fallback to another
 *   provider and no invented result, because a search that quietly became a
 *   different search is worse than one that plainly did not run.
 * - Every result carries the URL it came from, so a citation can be checked.
 */
const { URL } = require("node:url");

const UA = "ForgeAI/1.0 (local desktop assistant)";
const LIMITS = { results: 8, snippet: 400, timeoutMs: 20_000, bodyBytes: 2_000_000 };

class SearchError extends Error {
  constructor(message, { provider, kind = "failed", status = 0 } = {}) {
    super(message);
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

// Injected so Electron's net (which honours system proxies) is used in the app
// and plain https in tests.
let transport = null;
function useTransport(fn) { transport = fn; }

function httpJson(url, { headers = {}, method = "GET", body } = {}) {
  if (transport) return transport(url, { headers, method, body });
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: LIMITS.timeoutMs,
    }, (res) => {
      let text = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        size += c.length;
        if (size > LIMITS.bodyBytes) { res.destroy(); return; }
        text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the search timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const clean = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.snippet);

/** Keeps only results with a usable https URL, and drops duplicates. */
function tidy(rows, provider) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    let url;
    try { url = new URL(r.url); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: clean(r.title) || url.hostname, url: key, snippet: clean(r.snippet), source: url.hostname, provider });
    if (out.length >= LIMITS.results) break;
  }
  return out;
}

async function parse(res, provider) {
  if (res.status === 401 || res.status === 403) {
    throw new SearchError(`${provider} refused the key. Check it in Settings.`, { provider, kind: "auth", status: res.status });
  }
  if (res.status === 429) {
    throw new SearchError(`${provider} is rate-limiting this computer. Try again shortly.`, { provider, kind: "rate_limit", status: res.status });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SearchError(`${provider} answered HTTP ${res.status}.`, { provider, status: res.status });
  }
  try { return JSON.parse(res.text); }
  catch { throw new SearchError(`${provider} did not return JSON, so nothing could be read from it.`, { provider, kind: "bad_response" }); }
}

// ── providers ────────────────────────────────────────────────
async function brave(query, { key }) {
  if (!key) throw new SearchError("No Brave key is saved. Add one in Settings, or choose another provider.", { provider: "brave", kind: "no_key" });
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${LIMITS.results}`;
  const data = await parse(await httpJson(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" } }), "Brave");
  const rows = (data?.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
  return tidy(rows, "brave");
}

async function tavily(query, { key }) {
  if (!key) throw new SearchError("No Tavily key is saved. Add one in Settings, or choose another provider.", { provider: "tavily", kind: "no_key" });
  const data = await parse(await httpJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { query, max_results: LIMITS.results, search_depth: "basic" },
  }), "Tavily");
  const rows = (data?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  return tidy(rows, "tavily");
}

/**
 * A SearXNG instance the person chooses. Public instances commonly turn the
 * JSON API off; that refusal is reported plainly rather than being retried
 * somewhere else.
 */
async function searxng(query, { instance }) {
  const base = String(instance || "").trim();
  if (!base) throw new SearchError("No SearXNG address is set. Put one in Settings, or choose another provider.", { provider: "searxng", kind: "no_key" });
  let url;
  try {
    url = new URL("./search", base.endsWith("/") ? base : `${base}/`);
  } catch {
    throw new SearchError(`"${base}" is not a usable address.`, { provider: "searxng", kind: "bad_config" });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new SearchError("A SearXNG address must be https, unless it is on this computer.", { provider: "searxng", kind: "bad_config" });
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await httpJson(url.toString(), { headers: { Accept: "application/json" } });
  if (res.status === 403) {
    throw new SearchError("That SearXNG instance does not allow its JSON API. Use your own instance, or another provider.", { provider: "searxng", kind: "json_disabled", status: 403 });
  }
  const data = await parse(res, "SearXNG");
  const rows = (data?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  return tidy(rows, "searxng");
}

const PROVIDERS = {
  wikipedia: { label: "Wikipedia", keyless: true, needs: null },
  searxng: { label: "SearXNG", keyless: true, needs: "instance" },
  brave: { label: "Brave Search", keyless: false, needs: "key" },
  tavily: { label: "Tavily", keyless: false, needs: "key" },
};

/**
 * Runs one search. `wikipediaSearch` is injected because it already exists and
 * already has its own transport and limits.
 */
async function search(provider, query, config = {}) {
  const q = String(query || "").trim();
  if (!q) throw new SearchError("There is nothing to search for.", { provider, kind: "empty" });
  if (!PROVIDERS[provider]) throw new SearchError(`There is no search provider called "${provider}".`, { provider, kind: "unknown" });

  const started = Date.now();
  let results;
  if (provider === "wikipedia") {
    const r = await config.wikipedia(q);
    results = tidy((r?.sources ?? []).map((s) => ({ title: s.title, url: s.url, snippet: s.snippet })), "wikipedia");
  } else if (provider === "brave") results = await brave(q, config);
  else if (provider === "tavily") results = await tavily(q, config);
  else results = await searxng(q, config);

  return {
    provider,
    label: PROVIDERS[provider].label,
    query: q,
    fetched_at: Date.now(),
    took_ms: Date.now() - started,
    results,
    // Said out loud so a caller never has to infer it from an empty array.
    found: results.length,
    note: results.length ? "" : `${PROVIDERS[provider].label} returned no results for that search.`,
  };
}

/** The passage a model is given, with every source numbered so it can cite them. */
function asContext(run) {
  if (!run.results.length) return `A ${run.label} search for "${run.query}" returned no results. Say so rather than answering from memory.`;
  const lines = run.results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.snippet || "(no summary)"}`);
  return [
    `${run.label} search for "${run.query}", run at ${new Date(run.fetched_at).toISOString()}:`,
    "",
    ...lines,
    "",
    "Cite these by their number, like [1]. Use only what is here; if it does not answer the question, say so rather than filling the gap.",
  ].join("\n");
}

module.exports = { search, asContext, useTransport, PROVIDERS, SearchError, LIMITS, tidy };
