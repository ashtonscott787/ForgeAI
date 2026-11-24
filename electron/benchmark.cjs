/**
 * How fast this machine actually is.
 *
 * The catalogue carries a reference_tok_s for every model and every one of
 * them is 0.0 — a placeholder that has never been filled in. A number from
 * somebody else's machine would be no better: the same model runs at 13
 * tokens a second on an 8 GB laptop and 90 on a workstation, so a figure
 * that is not from this computer tells nobody anything.
 *
 * So it is measured here, once, on the model that is loaded, and kept. Every
 * later recommendation is scaled from that measurement by parameter count,
 * which is rough but is at least rooted in something real — and the
 * interface says which number is measured and which is scaled from it.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Short enough not to be a wait, long enough not to be noise. */
const PROMPT = "Count from one to twenty in words, separated by commas.";
const TOKENS = 64;

/**
 * Runs one short generation and times it.
 *
 * Time to first token is excluded from the rate: it is loading and prompt
 * processing, not generation, and including it makes a fast machine on a
 * cold model look slow.
 */
async function measure({ baseUrl, apiKey, fetchImpl = fetch, now = () => Date.now() }) {
  const started = now();
  const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: TOKENS,
      temperature: 0,
      stream: false,
    }),
  });
  if (!res.ok) return { ok: false, why: `the engine answered ${res.status}` };
  const body = await res.json();
  const elapsed = (now() - started) / 1000;
  const used = body?.usage?.completion_tokens;
  const text = body?.choices?.[0]?.message?.content || "";
  // The engine's own count where it gives one; four characters a token
  // otherwise, and the result says which it was.
  const counted = Number.isFinite(used) && used > 0;
  const tokens = counted ? used : Math.max(1, Math.round(text.length / 4));
  if (elapsed <= 0) return { ok: false, why: "the clock did not move" };
  return {
    ok: true,
    tok_s: tokens / elapsed,
    tokens,
    seconds: elapsed,
    counted,
  };
}

/**
 * Generation speed scales roughly with the reciprocal of model size: a model
 * twice as large runs at about half the rate, because the work per token is
 * reading the weights. It is a rule of thumb and is labelled as one wherever
 * it is shown.
 */
function scale(measured, { fromParams, toParams }) {
  if (!measured || !fromParams || !toParams) return null;
  return measured * (fromParams / toParams);
}

/** Words a person reads per second, which is what the rate means to them. */
const asWords = (tokS) => tokS * 0.75;

function describe(tokS) {
  if (!Number.isFinite(tokS) || tokS <= 0) return "not measured yet";
  const words = asWords(tokS);
  return `about ${words < 10 ? words.toFixed(1) : Math.round(words)} words a second`;
}

/** Where the measurement is kept, beside the settings. */
function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function save(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a stored measurement still means anything.
 *
 * A measurement made on a different model, or before the machine's settings
 * changed, is not a measurement of what is happening now. Rather than age it
 * out on a timer, it is kept only while the thing it measured is the thing
 * running.
 */
function stillValid(record, { model_file, tier }) {
  if (!record || !record.tok_s) return false;
  return record.model_file === model_file && record.tier === tier;
}

module.exports = { PROMPT, TOKENS, measure, scale, asWords, describe, load, save, stillValid };
