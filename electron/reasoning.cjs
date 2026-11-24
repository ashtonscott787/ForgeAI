/**
 * Reasoning models, and why they came back empty.
 *
 * A reasoning model thinks in the open before it answers, and llama.cpp puts
 * that thinking in `reasoning_content` rather than `content`. With a token
 * limit sized for an ordinary model, the whole budget goes on the thinking,
 * the reply is cut off at the limit (`finish_reason: "length"`), and
 * `content` is the empty string. Every reader in this app then showed an
 * empty answer, or nothing at all.
 *
 * Three things follow, and all three are needed — any one alone still fails:
 *
 * 1. Recognise the model, so it can be given room. A 1.5B distill asked a
 *    simple question routinely spends 600 tokens deciding how to answer it.
 * 2. Separate the budget. The thinking is capped so it cannot eat the whole
 *    allowance, and the answer gets its own room underneath.
 * 3. Never present an empty reply as an answer. If the limit was reached
 *    with nothing said, that is a failure with a cause worth naming, not a
 *    blank message.
 *
 * This module is the shared judgement for all three readers: the chat
 * window, the share server and the MCP server.
 */

/**
 * Families that think before answering.
 *
 * Matched on the file name, which is all any of these paths has. It is a
 * list of substrings rather than anything cleverer because that is what a
 * GGUF file name reliably carries, and a wrong guess here is cheap in one
 * direction (a plain model gets more room than it needs) and expensive in
 * the other (a reasoning model comes back blank).
 */
const FAMILIES = [
  "deepseek-r1", "deepseek_r1", "r1-distill", "r1_distill",
  "qwq", "qwen3", "marco-o1", "openthinker", "magistral",
  "skywork-o1", "sky-t1", "thinking", "reasoner", "-o1", "phi-4-reasoning",
];

/** Does this model think out loud? */
function isReasoning(modelName) {
  const n = String(modelName || "").toLowerCase();
  return FAMILIES.some((f) => n.includes(f));
}

/** Room for an ordinary reply, when nothing else is said. */
const PLAIN_TOKENS = 1024;

/**
 * How much room to give, and how much of it the thinking may have.
 *
 * The multiplier is not generosity: it is the difference between an answer
 * and an empty string. Measured on the shipped DeepSeek-R1-Distill 1.5B,
 * "extract this invoice as JSON" spent over 900 tokens thinking before it
 * wrote a character of the answer.
 */
function budgetFor(modelName, asked) {
  const wanted = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : PLAIN_TOKENS;
  if (!isReasoning(modelName)) return { max_tokens: wanted, reasoning_budget: null, reasoning: false };
  // Four times the room, and at most two thirds of it on thinking, so there
  // is always an answer's worth left underneath.
  const total = Math.max(wanted * 4, 3072);
  return { max_tokens: total, reasoning_budget: Math.floor(total * 0.66), reasoning: true };
}

/**
 * The body fields to add to an OpenAI-shaped request.
 *
 * `reasoning_budget` is llama.cpp's own field and older builds reject
 * unknown fields outright, so a caller that gets a 4xx should retry without
 * them — the same shape the chat window already uses for sampling fields.
 */
function requestFields(modelName, asked) {
  const b = budgetFor(modelName, asked);
  const out = { max_tokens: b.max_tokens };
  if (b.reasoning) out.reasoning_budget = b.reasoning_budget;
  return out;
}

/**
 * What to say about a reply, given what came back.
 *
 * Returns null when the reply is fine. Otherwise a sentence naming what
 * happened, because "the model returned no text" is true of four different
 * failures and tells somebody which one none of the time.
 */
function explainEmpty({ content, reasoning, finishReason, modelLabel, maxTokens }) {
  const said = String(content || "").trim();
  if (said) return null;
  const name = modelLabel || "The model";
  const thought = String(reasoning || "").trim();

  if (finishReason === "length" && thought) {
    return `${name} used its whole ${maxTokens}-token limit thinking and never began the answer. `
      + `It is a reasoning model, so it needs more room: raise the reply length, or pick a model that answers directly.`;
  }
  if (finishReason === "length") {
    return `${name} reached its ${maxTokens}-token limit before writing anything. Raise the reply length.`;
  }
  if (thought) {
    return `${name} thought about the question but never wrote an answer. Its working is below. `
      + `Smaller reasoning models do this; asking again, or asking more plainly, usually gets one.`;
  }
  return `${name} returned no text at all, and no working either. The engine log says what it did.`;
}

module.exports = { FAMILIES, PLAIN_TOKENS, isReasoning, budgetFor, requestFields, explainEmpty };
