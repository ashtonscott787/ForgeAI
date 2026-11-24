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
 * The room for thinking is added ON TOP of what was asked for, never
 * instead of it. The first version multiplied the caller's number by four
 * and took a floor of 3072, so `max_tokens: 20` produced roughly six
 * hundred tokens that stopped mid-word. A limit the caller sets is a limit
 * on the answer; the thinking is this module's business and is budgeted
 * separately.
 *
 * The thinking budget is not small. Measured on the shipped
 * DeepSeek-R1-Distill 1.5B, "extract this invoice as JSON" spent over 900
 * tokens thinking before it wrote a character of the answer.
 */
const THINKING_ROOM = 2048;

function budgetFor(modelName, asked) {
  const wanted = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : PLAIN_TOKENS;
  if (!isReasoning(modelName)) return { max_tokens: wanted, answer_tokens: wanted, reasoning_budget: null, reasoning: false };
  const thinking = THINKING_ROOM;
  return {
    // What the engine is allowed to generate in total.
    max_tokens: wanted + thinking,
    // What of that is the answer, which is what the caller asked about.
    answer_tokens: wanted,
    reasoning_budget: thinking,
    reasoning: true,
  };
}

/**
 * The name of the field that caps thinking.
 *
 * `thinking_budget_tokens`, verified against the shipped engine's own
 * strings rather than recalled. 0.7.2 sent `reasoning_budget`, which this
 * build accepts without complaint and silently ignores — so nothing capped
 * the thinking, a twenty-token answer took twenty-five seconds, and the
 * code that was supposed to notice saw no error and reported success.
 *
 * A field name is the kind of thing that feels like knowledge and is
 * actually memory. There is a test that reads it out of the binary.
 */
const BUDGET_FIELD = "thinking_budget_tokens";

/**
 * The smallest budget worth sending.
 *
 * At 0 the engine ends the thinking immediately and the answer begins with
 * a stray `</think>`, because the closing tag is emitted for a block that
 * never opened. 32 tokens is enough for the model to close the block
 * properly and costs a fraction of a second.
 */
const MIN_BUDGET = 32;

/**
 * The body fields to add to an OpenAI-shaped request.
 *
 * An engine that does not know the field ignores it rather than refusing,
 * so there is nothing to retry — and nothing to conclude from the absence
 * of an error either. Whether it was honoured is judged from the reply.
 */
function requestFields(modelName, asked) {
  const b = budgetFor(modelName, asked);
  const out = { max_tokens: b.max_tokens };
  if (b.reasoning) out[BUDGET_FIELD] = Math.max(MIN_BUDGET, b.reasoning_budget);
  return out;
}

/**
 * Did the engine honour the budget?
 *
 * Judged from how much thinking came back, not from whether the request
 * succeeded. The first version set this true whenever no error was
 * returned, which is true of an engine that ignored the field entirely —
 * so the note that was meant to report exactly this case could never fire.
 *
 * The margin is generous: a model stops at a sentence end rather than
 * exactly on the token, and calling a near miss a failure would cry wolf.
 */
function budgetHonoured({ reasoning, budget, margin = 1.5 }) {
  if (!budget) return null;
  const text = String(reasoning || "");
  if (!text) return true; // no thinking at all is within any budget
  // Four characters to the token, the same estimate used elsewhere.
  const spent = text.length / 4;
  return spent <= budget * margin + MIN_BUDGET;
}

/**
 * Removes a closing tag for a block that never opened.
 *
 * With the budget at 0 the engine ends the thinking before it starts and
 * the answer arrives beginning "</think>". The budget has a floor now so
 * this should not happen, but an answer that starts with a stray tag is
 * worth stripping wherever it comes from.
 */
const stripStrayThink = (text) => String(text || "").replace(/^\s*<\/think>\s*/, "");

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

/**
 * An answer that stopped because it ran out of room, rather than because it
 * had finished.
 *
 * Returns null when the reply is whole. Otherwise a sentence to go with the
 * text — not instead of it: the partial answer is usually still worth
 * having, and throwing it away to report a failure helps nobody. What is
 * not acceptable is handing back six hundred tokens ending mid-word with
 * nothing to say they were cut.
 */
function explainTruncated({ content, finishReason, answerTokens }) {
  if (finishReason !== "length") return null;
  if (!String(content || "").trim()) return null; // empty is explainEmpty's business
  return `Answer was cut off at the ${answerTokens}-token limit.`;
}

/**
 * Holds the answer to the length the caller asked for, whatever the engine
 * did.
 *
 * `reasoning_budget` is llama.cpp's own field, and an engine that does not
 * know it either refuses the request — in which case the retry sends no
 * budget at all — or ignores it. Either way nothing caps the thinking, and
 * a caller who asked for 20 tokens can receive six hundred. So the cap is
 * applied here as well, where it does not depend on the engine agreeing.
 *
 * The cut is by characters, at a word boundary, from an estimate of four
 * characters to the token. That is approximate, and the note says the
 * answer was cut rather than claiming an exact count.
 */
function capAnswer(text, answerTokens) {
  const limit = Number.isFinite(answerTokens) && answerTokens > 0 ? answerTokens * 4 : Infinity;
  const whole = String(text || "");
  if (whole.length <= limit) return { text: whole, cut: false };
  const slice = whole.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  // Mid-word is what the original defect looked like; a word boundary at
  // least reads as a sentence that stops.
  return { text: (lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd(), cut: true };
}

/** True when the reply ran out of room mid-sentence. */
const wasTruncated = ({ content, finishReason }) =>
  finishReason === "length" && Boolean(String(content || "").trim());

module.exports = {
  FAMILIES, PLAIN_TOKENS, THINKING_ROOM, BUDGET_FIELD, MIN_BUDGET,
  isReasoning, budgetFor, requestFields, explainEmpty,
  explainTruncated, wasTruncated, capAnswer, budgetHonoured, stripStrayThink,
};
