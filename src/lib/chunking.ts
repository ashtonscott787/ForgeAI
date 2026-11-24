import { estimateTokens } from "./context.ts";

/**
 * Documents too long to send in one piece.
 *
 * An attached document goes into the prompt whole. Past the context size the
 * engine fails, and what the person sees is an error about tokens rather
 * than an answer about their document. The alternative is not to refuse: it
 * is to read it in pieces and then read the pieces.
 *
 * Map-reduce, in the plainest form:
 *
 *   split  → the document in parts that fit, cut at paragraph boundaries
 *   map    → each part summarised against the actual question
 *   reduce → the summaries answered as one
 *
 * It costs several passes, so it only happens when the document genuinely
 * does not fit, and the interface says it is happening rather than appearing
 * to hang.
 */

/** Room kept for the house rules, the question and the reply. */
export const OVERHEAD_TOKENS = 1200;

export interface Plan {
  /** Whether the document has to be split at all. */
  needed: boolean;
  parts: string[];
  /** Tokens the whole thing would take, estimated. */
  tokens: number;
  budget: number;
}

/**
 * Splits text into pieces that each fit the budget.
 *
 * Cut at a blank line where possible, then at a line break, then — only for
 * a block with neither — mid-text. A paragraph split across two pieces is
 * summarised twice and badly; the point of preferring boundaries is that
 * each piece is something that can be read on its own.
 */
export function splitText(text: string, budgetTokens: number): string[] {
  const chars = Math.max(400, budgetTokens * 4);
  const out: string[] = [];
  let rest = text;
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

/** Whether this document fits, and if not, the pieces it becomes. */
export function planFor(text: string, contextTokens: number, overhead = OVERHEAD_TOKENS): Plan {
  const tokens = estimateTokens(text);
  const budget = Math.max(500, contextTokens - overhead);
  if (tokens <= budget) return { needed: false, parts: [text], tokens, budget };
  // Half the budget per piece, so a piece and its summary-so-far both fit.
  return { needed: true, parts: splitText(text, Math.floor(budget / 2)), tokens, budget };
}

/** What each piece is asked, so the summary keeps what the question needs. */
export function mapPrompt(question: string, part: string, index: number, total: number): string {
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
export function reducePrompt(question: string, notes: string[]): string {
  const useful = notes.filter((n) => n.trim() && !/^nothing\.?$/i.test(n.trim()));
  return [
    `Answer this question: ${question}`,
    "",
    `These are notes taken from a document too long to read at once, in order. They are all you have; `
      + "do not invent anything that is not in them, and say so if they do not answer the question.",
    "",
    useful.map((n, i) => `--- notes from part ${i + 1} ---\n${n.trim()}`).join("\n\n"),
  ].join("\n");
}

/** One line for the person, so a multi-pass read does not look like a hang. */
export const describePlan = (p: Plan) =>
  p.needed
    ? `That document is about ${p.tokens.toLocaleString()} tokens and the window holds ${p.budget.toLocaleString()}. `
      + `Reading it in ${p.parts.length} parts, then answering from those.`
    : "";
