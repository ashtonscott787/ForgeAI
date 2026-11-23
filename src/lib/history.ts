import type { ChatMessage } from "./chat";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updated: number;
  /**
   * A temporary chat. Never written to storage and dropped as soon as it stops
   * being the open one, so closing the app or moving away ends it.
   */
  temporary?: boolean;
  /**
   * When a reply finished in a chat that was not on screen. Cleared the moment
   * the chat is opened. A model answering while you are on another page is
   * worth a mark: there is nothing else to tell you it happened.
   */
  unseen?: number;
  /**
   * Which workspace this chat belongs to. Absent means Personal: every chat
   * made before workspaces existed has no mark on it, and they belong
   * somewhere rather than nowhere.
   */
  space?: string;
  /**
   * The messages as they were before this chat was compacted, so compacting
   * can be undone. Cleared once another message is sent, because an undo that
   * silently discards what was said since would be worse than no undo.
   */
  before?: ChatMessage[];
}

const KEY = "forge.conversations.v1";

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Conversation[]) : [];
    return Array.isArray(list) ? list.sort((a, b) => b.updated - a.updated) : [];
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]) {
  try {
    // `before` is a whole second copy of the conversation and only exists to
    // undo a compaction in this sitting, so it is not written to storage.
    const keep = list
      .filter((c) => c.messages.length > 0 && !c.temporary)
      .map(({ before: _before, ...c }) => c);
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* storage full or unavailable: history is a convenience, never fatal */
  }
}

export const newTempConversation = (space?: string): Conversation => ({
  ...newConversation(space),
  title: "Temporary chat",
  temporary: true,
});

export const newConversation = (space?: string): Conversation => ({
  id: Math.random().toString(36).slice(2) + Date.now().toString(36),
  title: "New chat",
  messages: [],
  updated: Date.now(),
  ...(space ? { space } : {}),
});

export const titleFrom = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 40) + "…" : t || "New chat";
};
