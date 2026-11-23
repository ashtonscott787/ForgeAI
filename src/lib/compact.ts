import type { ChatMessage } from "./chat";

/**
 * Compacting a conversation by hand.
 *
 * A long chat eventually fills the window, and the usual remedy is to start a
 * new one and lose everything that was established. Compacting keeps the
 * thread: the older turns are replaced by a written summary of them, and the
 * recent turns are left exactly as they were.
 *
 * Three things this is careful about, because it is throwing away the
 * person's own conversation:
 *
 * 1. It never happens without being asked. There is no automatic compaction
 *    behind anybody's back.
 * 2. The original is kept. Undo puts the conversation back as it was, word
 *    for word, until the chat is closed.
 * 3. The recent turns are not touched. Summarising what was said two minutes
 *    ago is how a chat starts answering slightly wrong.
 */

/** How many of the most recent messages survive untouched. */
export const KEEP_RECENT = 6;

/** Below this there is nothing worth summarising, and it is refused. */
export const MIN_OLDER = 4;

/** How a summary message is recognised again later. */
export const SUMMARY_MARK = "[Summary of earlier messages]";

export function isSummary(m: ChatMessage): boolean {
  return m.role === "system" && m.content.startsWith(SUMMARY_MARK);
}

export interface Split {
  older: ChatMessage[];
  recent: ChatMessage[];
}

/**
 * Which messages would be summarised and which would be kept.
 *
 * An earlier summary falls into `older` and is therefore folded into the new
 * one, rather than accumulating a stack of summaries of summaries.
 */
export function splitFor(messages: ChatMessage[], keep: number = KEEP_RECENT): Split {
  const cut = Math.max(0, messages.length - keep);
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

export function canCompact(messages: ChatMessage[], keep: number = KEEP_RECENT): boolean {
  return splitFor(messages, keep).older.length >= MIN_OLDER;
}

/** The transcript handed to the model to be summarised. */
export function transcriptOf(older: ChatMessage[]): string {
  return older
    .map((m) => {
      const who = m.role === "user" ? "Person" : m.role === "assistant" ? "Assistant" : "Note";
      return `${who}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * What the model is asked for.
 *
 * Specific about what must survive, because a summary that loses the decision
 * everybody was working towards has cost more than it saved.
 */
export const COMPACT_INSTRUCTION = [
  "Summarise the conversation below so it can replace the original without losing anything that matters later.",
  "",
  "Keep: what the person asked for, decisions reached, facts they stated about themselves or their work, names, numbers, file paths, and anything left unfinished.",
  "Drop: pleasantries, repetition, and reasoning that led nowhere.",
  "",
  "Write it as plain notes under short headings. Do not address the person, do not add an introduction, and do not offer to help.",
].join("\n");

/**
 * The conversation after compaction: one summary message, then the recent
 * turns unchanged.
 */
export function applyCompaction(messages: ChatMessage[], summary: string, keep: number = KEEP_RECENT): ChatMessage[] {
  const { recent } = splitFor(messages, keep);
  const text = summary.trim();
  if (!text) return messages;
  return [{ role: "system", content: `${SUMMARY_MARK}\n${text}` }, ...recent];
}
