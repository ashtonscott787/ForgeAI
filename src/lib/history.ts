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
    localStorage.setItem(KEY, JSON.stringify(list.filter((c) => c.messages.length > 0 && !c.temporary)));
  } catch {
    /* storage full or unavailable: history is a convenience, never fatal */
  }
}

export const newTempConversation = (): Conversation => ({ ...newConversation(), title: "Temporary chat", temporary: true });

export const newConversation = (): Conversation => ({
  id: Math.random().toString(36).slice(2) + Date.now().toString(36),
  title: "New chat",
  messages: [],
  updated: Date.now(),
});

export const titleFrom = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 40) + "…" : t || "New chat";
};
