/**
 * Workspaces: keeping one life's chats out of another's.
 *
 * Work and home on one machine is the ordinary case, and a single list that
 * mixes a contract negotiation with a recipe is the wrong shape for it. A
 * workspace is a named box: chats belong to exactly one, and switching
 * changes what is listed and what a new chat joins.
 *
 * What this does NOT do, stated here so nothing in the interface has to
 * imply otherwise: it is not a security boundary. Everything is on the same
 * computer in the same files, there is no password on a workspace, and
 * memory, connected accounts and installed models are shared across all of
 * them. It separates work from work. It does not hide anything from anybody
 * who has the machine.
 */

export interface Space {
  id: string;
  name: string;
  /** A colour to tell them apart at a glance. */
  accent: string;
  /** Built in, and therefore not deletable. */
  fixed?: boolean;
}

export const PERSONAL: Space = { id: "personal", name: "Personal", accent: "#b4703f", fixed: true };

/** Offered when a workspace is created, so nobody has to invent a colour. */
export const ACCENTS = ["#b4703f", "#3f6fb4", "#4f8a5b", "#8a4f7d", "#9a7b2f", "#4f7d8a"];

const KEY = "forge.spaces.v1";
const CURRENT = "forge.space.current.v1";

export function loadSpaces(): Space[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Space[]) : [];
    if (!Array.isArray(list) || !list.length) return [PERSONAL];
    // Personal is always present and always first: it is where every chat
    // that predates workspaces lives, and losing it would orphan all of them.
    const rest = list.filter((s) => s && s.id && s.id !== PERSONAL.id);
    return [PERSONAL, ...rest];
  } catch {
    return [PERSONAL];
  }
}

export function saveSpaces(list: Space[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter((s) => s.id !== PERSONAL.id)));
  } catch {
    /* a workspace list is a convenience; failing to store it is not fatal */
  }
}

export function loadCurrent(spaces: Space[]): string {
  try {
    const id = localStorage.getItem(CURRENT);
    return id && spaces.some((s) => s.id === id) ? id : PERSONAL.id;
  } catch {
    return PERSONAL.id;
  }
}

export function saveCurrent(id: string) {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    /* as above */
  }
}

/** A readable id from a name, kept unique against the ones already in use. */
export function idFor(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "space";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const tried = `${base}-${n}`;
    if (!taken.includes(tried)) return tried;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function makeSpace(name: string, spaces: Space[]): Space {
  const clean = name.trim().slice(0, 32) || "Workspace";
  return {
    id: idFor(clean, spaces.map((s) => s.id)),
    name: clean,
    accent: ACCENTS[spaces.length % ACCENTS.length]!,
  };
}

/**
 * Which workspace a chat belongs to.
 *
 * A chat with nothing recorded is in Personal: every chat made before
 * workspaces existed has no mark on it, and they belong somewhere.
 */
export function spaceOf(convo: { space?: string }): string {
  return convo.space || PERSONAL.id;
}

export function inSpace<T extends { space?: string }>(list: T[], id: string): T[] {
  return list.filter((c) => spaceOf(c) === id);
}
