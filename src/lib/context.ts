/**
 * What is actually in the context window, and how much room is left.
 *
 * Every message, the house rules, the approved memory, the switched-on skills
 * and any attached document are sent to the model on every single turn. That
 * is invisible until the moment the window fills and answers start getting
 * worse for no apparent reason. This measures it and names each part, so the
 * question "why is this chat going slow and strange" has an answer on screen
 * rather than a guess.
 *
 * Two ways of counting, and the difference is stated rather than hidden:
 *
 *  - An estimate, from the length of the text. Instant, works with no engine
 *    running, and wrong by a few percent in either direction.
 *  - A count from the engine itself, which tokenises with the model's own
 *    vocabulary. Exact for the model that is loaded, and only available while
 *    that model is loaded.
 *
 * The interface says which of the two it is showing. A number that might be
 * an estimate and might be a measurement, with no way to tell, is worse than
 * either.
 */

/**
 * Characters per token, for the estimate.
 *
 * English prose on a byte-pair vocabulary lands near four. Code and other
 * alphabets run denser, so the estimate reads low on a chat full of code;
 * that is the direction to be wrong in, because it never promises more room
 * than there is... except it does. Hence the engine count, used whenever the
 * engine is there.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** One named thing taking up room. */
export interface Piece {
  id: string;
  label: string;
  text: string;
}

export interface Part {
  id: string;
  label: string;
  tokens: number;
  /** Of the whole window, not of what is used. The bar is the window. */
  share: number;
}

export interface Reading {
  parts: Part[];
  used: number;
  limit: number;
  /** Never below zero: a window that is over full has no free space, it has an overflow. */
  free: number;
  over: number;
  /** True when the numbers came from text length rather than from the engine. */
  estimated: boolean;
}

export function measure(pieces: Piece[], limit: number, counts?: Record<string, number>): Reading {
  const parts: Part[] = pieces.map((p) => {
    const tokens = counts && typeof counts[p.id] === "number" ? counts[p.id]! : estimateTokens(p.text);
    return { id: p.id, label: p.label, tokens, share: limit > 0 ? Math.min(1, tokens / limit) : 0 };
  });
  const used = parts.reduce((n, p) => n + p.tokens, 0);
  return {
    parts,
    used,
    limit,
    free: Math.max(0, limit - used),
    over: Math.max(0, used - limit),
    estimated: !counts,
  };
}

/**
 * The exact count, from the model that is loaded.
 *
 * llama.cpp's server tokenises on /tokenize with the vocabulary of the model
 * it is currently serving, which is the only thing that can answer this
 * exactly. Any failure — no engine, old build, model still loading — returns
 * null rather than a number, and the caller keeps the estimate and keeps
 * saying it is one.
 */
export async function countWithEngine(baseUrl: string, text: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tokens?: unknown };
    return Array.isArray(body.tokens) ? body.tokens.length : null;
  } catch {
    return null;
  }
}

/** Exact counts for every piece, or null if the engine could not give them. */
export async function countAll(
  baseUrl: string,
  pieces: Piece[],
  signal?: AbortSignal,
): Promise<Record<string, number> | null> {
  const out: Record<string, number> = {};
  for (const p of pieces) {
    if (!p.text) {
      out[p.id] = 0;
      continue;
    }
    const n = await countWithEngine(baseUrl, p.text, signal);
    // One failure makes the whole reading a mixture of measured and guessed
    // numbers, which is exactly the thing this module exists to avoid.
    if (n === null) return null;
    out[p.id] = n;
  }
  return out;
}

/** 0–1. What the person is told when it is high, and when it is nearly full. */
export const TIGHT = 0.75;
export const FULL = 0.92;

export function pressure(r: Reading): "fine" | "tight" | "full" | "over" {
  if (r.over > 0) return "over";
  const used = r.limit > 0 ? r.used / r.limit : 0;
  if (used >= FULL) return "full";
  if (used >= TIGHT) return "tight";
  return "fine";
}
