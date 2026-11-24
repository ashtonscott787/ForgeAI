/**
 * Input longer than the context window.
 *
 * An attached document, or a prompt arriving through Claude Code, goes to
 * the engine whole. Past the context size the engine fails, and what comes
 * back is its raw JSON about token counts rather than an answer about the
 * thing that was asked. A ten-thousand-token prompt through the MCP server
 * failed exactly that way.
 *
 * The alternative is not to refuse: it is to read it in pieces and then
 * read the pieces.
 *
 *   split  → parts that fit, cut at paragraph boundaries
 *   map    → each part read against the actual question
 *   reduce → the notes answered as one
 *
 * This lives in the main process because both callers are here: the window
 * asks for a plan over IPC, and the MCP server calls it directly. The
 * renderer had its own copy, which is the arrangement that produced two
 * engine manifests and two command-line builders.
 */

/** Four characters to the token, for English prose on a byte-pair vocabulary. */
const CHARS_PER_TOKEN = 4;
const estimateTokens = (text) => (text ? Math.ceil(String(text).length / CHARS_PER_TOKEN) : 0);

/** Room kept for the house rules, the question and the reply. */
const OVERHEAD_TOKENS = 1200;

/**
 * Splits text into pieces that each fit the budget.
 *
 * Cut at a blank line where possible, then at a line break, then at a
 * sentence, and only for a block with none of those, mid-text. A paragraph
 * split across two pieces is read twice and badly.
 */
function splitText(text, budgetTokens) {
  const chars = Math.max(400, budgetTokens * CHARS_PER_TOKEN);
  const out = [];
  let rest = String(text || "");
  while (rest.length > chars) {
    const window = rest.slice(0, chars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < chars * 0.5) cut = window.lastIndexOf("\n");
    if (cut < chars * 0.5) cut = window.lastIndexOf(". ");
    if (cut < chars * 0.5) cut = chars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Whether this text fits, and if not, the pieces it becomes. */
function planFor(text, contextTokens, overhead = OVERHEAD_TOKENS) {
  const tokens = estimateTokens(text);
  const budget = Math.max(500, contextTokens - overhead);
  if (tokens <= budget) return { needed: false, parts: [String(text || "")], tokens, budget };
  // Half the budget per piece, so a piece and the notes so far both fit.
  return { needed: true, parts: splitText(text, Math.floor(budget / 2)), tokens, budget };
}

/** What each piece is asked, so the notes keep what the question needs. */
function mapPrompt(question, part, index, total) {
  return [
    `This is part ${index + 1} of ${total} of a longer document.`,
    "",
    `Pull out only what bears on this question: ${question}`,
    "",
    "Quote figures, dates and names exactly. If this part says nothing relevant, reply with the single word NOTHING.",
    "",
    "---",
    part,
  ].join("\n");
}

/** What the pieces are asked together, once each has been read. */
function reducePrompt(question, notes) {
  const useful = (notes || []).filter((n) => String(n || "").trim() && !/^nothing\.?$/i.test(String(n).trim()));
  return [
    `Answer this question: ${question}`,
    "",
    "These are notes taken from a document too long to read at once, in order. They are all you have; "
      + "do not invent anything that is not in them, and say so if they do not answer the question.",
    "",
    useful.map((n, i) => `--- notes from part ${i + 1} ---\n${String(n).trim()}`).join("\n\n"),
  ].join("\n");
}

/** One line for the person, so a multi-pass read does not look like a hang. */
const describePlan = (p) =>
  p.needed
    ? `That is about ${p.tokens.toLocaleString()} tokens and the window holds ${p.budget.toLocaleString()}. `
      + `Reading it in ${p.parts.length} parts, then answering from those.`
    : "";

/**
 * The engine's own token count, which is exact for the model that is
 * loaded, or null when it cannot be had.
 *
 * Worth the round trip before a long prompt: the estimate is out by a few
 * percent on prose and much more on code, and the difference between
 * fitting and not fitting is an answer or a raw engine error.
 */
async function countTokens({ baseUrl, apiKey, text, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${baseUrl}/tokenize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.tokens) ? body.tokens.length : null;
  } catch {
    return null;
  }
}

/**
 * What to say when something is too long and cannot be split.
 *
 * A single instruction of twelve thousand tokens is not a document to read
 * in pieces; it is one thing that will not fit. The person gets the two
 * numbers rather than the engine's JSON.
 */
function tooLong({ tokens, contextTokens, answerTokens = 0 }) {
  const room = contextTokens - answerTokens;
  return `That prompt is about ${tokens.toLocaleString()} tokens and this model has room for `
    + `${room.toLocaleString()}. Shorten it, or send it as a document so Forge AI can read it in parts.`;
}

module.exports = {
  CHARS_PER_TOKEN, OVERHEAD_TOKENS, estimateTokens, splitText, planFor,
  mapPrompt, reducePrompt, describePlan, countTokens, tooLong,
};
