/**
 * Live web research.
 *
 * Every provider here makes a real HTTP request to a real service with the
 * person's own API key. There is no fallback that invents results: if a
 * provider is not configured or the call fails, the caller is told, and the
 * model is given nothing rather than something made up.
 */
const https = require("node:https");

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      url,
      {
        method,
        headers: {
          "User-Agent": "ForgeAI",
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: 90_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("the provider did not answer within 90 seconds")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const explain = (name, status, text) => {
  const data = parse(text);
  const msg = data?.error?.message || data?.error || data?.message || text.slice(0, 200);
  if (status === 401 || status === 403) return `${name} rejected the API key (HTTP ${status}).`;
  if (status === 429) return `${name} is rate limiting or out of credit (HTTP 429).`;
  return `${name} returned HTTP ${status}: ${msg}`;
};

/** Perplexity: an answer with citations, from the live web. */
async function perplexity({ key, query, model }) {
  const res = await request("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: model || "sonar",
      messages: [
        { role: "system", content: "Answer from current sources. Be concise and factual, and say when sources disagree." },
        { role: "user", content: query },
      ],
    },
  });
  if (res.status !== 200) throw new Error(explain("Perplexity", res.status, res.text));
  const data = parse(res.text);
  const choice = data?.choices?.[0]?.message?.content ?? "";
  const citations = Array.isArray(data?.citations)
    ? data.citations
    : Array.isArray(data?.search_results)
      ? data.search_results.map((s) => s.url)
      : [];
  const results = Array.isArray(data?.search_results) ? data.search_results : [];
  return {
    provider: "perplexity",
    answer: String(choice),
    sources: (citations.length ? citations : results.map((r) => r.url)).filter(Boolean).map((url, i) => ({
      url,
      title: results[i]?.title ?? "",
      date: results[i]?.date ?? "",
    })),
    fetched_at: Date.now(),
  };
}

/** Firecrawl: the readable content of one page, as Markdown. */
async function firecrawlScrape({ key, url }) {
  const res = await request("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { url, formats: ["markdown"], onlyMainContent: true },
  });
  if (res.status !== 200) throw new Error(explain("Firecrawl", res.status, res.text));
  const data = parse(res.text);
  const md = data?.data?.markdown ?? data?.markdown ?? "";
  if (!md) throw new Error("Firecrawl returned no readable content for that page.");
  return {
    provider: "firecrawl",
    answer: String(md).slice(0, 60_000),
    sources: [{ url, title: data?.data?.metadata?.title ?? "", date: data?.data?.metadata?.publishedTime ?? "" }],
    fetched_at: Date.now(),
  };
}

/** Firecrawl's own search, when there is no Perplexity key. */
async function firecrawlSearch({ key, query }) {
  const res = await request("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { query, limit: 6, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } },
  });
  if (res.status !== 200) throw new Error(explain("Firecrawl", res.status, res.text));
  const data = parse(res.text);
  const hits = Array.isArray(data?.data) ? data.data : [];
  if (!hits.length) throw new Error("Firecrawl found nothing for that search.");
  return {
    provider: "firecrawl",
    answer: hits
      .map((h, i) => `[${i + 1}] ${h.title ?? h.url}\n${String(h.markdown ?? h.description ?? "").slice(0, 1500)}`)
      .join("\n\n"),
    sources: hits.map((h) => ({ url: h.url, title: h.title ?? "", date: h.publishedTime ?? "" })),
    fetched_at: Date.now(),
  };
}

/** A cheap authenticated call, used only to prove a key works. */
async function verify(provider, key) {
  if (provider === "perplexity") {
    const res = await request("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: { model: "sonar", messages: [{ role: "user", content: "reply with the single word ok" }], max_tokens: 5 },
    });
    if (res.status !== 200) throw new Error(explain("Perplexity", res.status, res.text));
    return { ok: true, detail: "key accepted" };
  }
  if (provider === "firecrawl") {
    const res = await request("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: { url: "https://example.com", formats: ["markdown"], onlyMainContent: true },
    });
    if (res.status !== 200) throw new Error(explain("Firecrawl", res.status, res.text));
    return { ok: true, detail: "key accepted" };
  }
  throw new Error(`Forge AI does not know how to check a ${provider} key yet.`);
}

module.exports = { perplexity, firecrawlScrape, firecrawlSearch, verify };
