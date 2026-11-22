/**
 * What running this here instead of paying for it is worth.
 *
 * The honest version of a number people like seeing. It counts the tokens
 * actually processed on this machine and prices them at what a mid-range
 * hosted model charges, because that is the thing being avoided. Everything
 * about that comparison is an assumption, so the assumption is shown next to
 * the number rather than buried in a constant nobody sees.
 *
 * What it is not: a claim that the answers are equivalent. A 1.5B model on a
 * laptop is not a frontier model, and the page says so where the number is.
 */

/** Dollars per million tokens, for a mid-range hosted model. */
export const RATE = { input: 3, output: 15 };

export interface Usage {
  /** Tokens sent to the model, totalled over every reply. */
  prompt: number;
  /** Tokens it generated. */
  completion: number;
  /** How many replies this covers. */
  replies: number;
}

export const EMPTY: Usage = { prompt: 0, completion: 0, replies: 0 };

export function add(u: Usage, prompt: number, completion: number): Usage {
  return {
    prompt: u.prompt + Math.max(0, Math.round(prompt) || 0),
    completion: u.completion + Math.max(0, Math.round(completion) || 0),
    replies: u.replies + 1,
  };
}

/** What those tokens would have cost, in dollars. */
export function wouldHaveCost(u: Usage, rate = RATE): number {
  return (u.prompt / 1e6) * rate.input + (u.completion / 1e6) * rate.output;
}

/** The number as money, never rounded up into looking bigger than it is. */
export function money(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "under a cent";
  return `$${(Math.floor(n * 100) / 100).toFixed(2)}`;
}

export function describe(u: Usage): string {
  if (!u.replies) return "Nothing has run here yet.";
  const total = u.prompt + u.completion;
  return `${u.replies.toLocaleString()} ${u.replies === 1 ? "reply" : "replies"} · `
    + `${total.toLocaleString()} tokens on this computer · ${money(wouldHaveCost(u))} not spent`;
}
