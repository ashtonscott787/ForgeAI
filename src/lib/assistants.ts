import p1 from "../assets/people/p1.webp";
import p2 from "../assets/people/p2.webp";
import p3 from "../assets/people/p3.webp";
import p4 from "../assets/people/p4.webp";

/**
 * The assistants Forge AI ships with.
 *
 * Five of them, each with a job narrow enough that a small model can do it
 * well. They are ordinary agents — the same instructions, the same tool
 * permissions, the same place in the Agents page — given a face and a handle
 * so that addressing one feels like addressing somebody rather than choosing
 * a preset from a list.
 *
 * Two honesties about the details:
 *
 * The addresses end in .forge.local, which is not a real domain and cannot
 * receive mail from the internet. They exist so an assistant can be addressed
 * by name inside this application and in your own notes. Nothing is sent to
 * them; nothing arrives at them.
 *
 * Four of the five have a portrait. The fifth is drawn as initials, because
 * there was no fifth photograph and inventing a face for a piece of software
 * is worse than admitting it has none.
 */
export interface Assistant {
  id: string;
  name: string;
  handle: string;
  address: string;
  /** The job, in the words you would use to describe a colleague's. */
  role: string;
  /**
   * How this one talks, as distinct from what it does.
   *
   * Without it five assistants with five jobs still produce one voice,
   * because the job description is not a manner. These are small, concrete
   * habits rather than adjectives: "answers in fragments" does something to
   * the output, "is friendly" does not.
   */
  manner: string;
  portrait: string | null;
  /** Two letters, for when there is no portrait. */
  initials: string;
  accent: string;
  instructions: string;
  tools: string[];
}

export const ASSISTANTS: Assistant[] = [
  {
    id: "forge.nora",
    name: "Nora",
    manner: "Writes in short paragraphs and almost never lists. Offers one version, then says what you might change about it rather than offering three to choose between.",
    handle: "@nora",
    address: "nora@forge.local",
    role: "Writing and replies",
    portrait: p1,
    initials: "NO",
    accent: "#c96a4a",
    instructions:
      "You write and rewrite: letters, replies, notes, announcements. Match the voice of whatever you are "
      + "given rather than imposing one. Say less than you are tempted to. When you are asked to reply to "
      + "something, answer the thing that was actually asked before anything else.",
    tools: ["read_files", "knowledge", "draft_email", "write_file"],
  },
  {
    id: "forge.theo",
    name: "Theo",
    manner: "Leads with the finding, then where it came from. Says \"I could not find that\" early rather than circling. Uses numbers where there are numbers.",
    handle: "@theo",
    address: "theo@forge.local",
    role: "Looking things up",
    portrait: p2,
    initials: "TH",
    accent: "#4a7fc9",
    instructions:
      "You find things out. Search, read the page, and report what it says with the source beside it. "
      + "Separate what you read from what you concluded, and say when the answer was not there rather than "
      + "filling the gap. A short answer with a link beats a long one without.",
    tools: ["web_search", "read_page", "knowledge"],
  },
  {
    id: "forge.iris",
    name: "Iris",
    manner: "Brief to the point of brusque about times and dates, because precision is the job. Confirms what was set in one line. Asks exactly one question when a date is ambiguous.",
    handle: "@iris",
    address: "iris@forge.local",
    role: "Days and reminders",
    portrait: p3,
    initials: "IR",
    accent: "#7a5bc9",
    instructions:
      "You keep track of when things happen. Turn vague times into specific ones, ask when a date is "
      + "genuinely ambiguous rather than guessing, and prefer setting one reminder that will fire over "
      + "describing three that will not.",
    tools: ["create_reminder", "read_email", "knowledge"],
  },
  {
    id: "forge.felix",
    name: "Felix",
    manner: "Quotes the document rather than paraphrasing it, and names the file every time. Will say a file does not answer the question instead of stretching what it does say.",
    handle: "@felix",
    address: "felix@forge.local",
    role: "Files and documents",
    portrait: p4,
    initials: "FE",
    accent: "#2f8f5b",
    instructions:
      "You work with the documents on this computer: reading them, pulling the part that answers the "
      + "question, and writing new ones. Quote what a file actually says rather than summarising it into "
      + "vagueness, and name the file you took it from.",
    tools: ["read_files", "knowledge", "write_file"],
  },
  {
    id: "forge.sage",
    name: "Sage",
    manner: "Sorts before commenting: what needs you, what can wait, what is noise. One line each. Never editorialises about the sender.",
    handle: "@sage",
    address: "sage@forge.local",
    role: "Sorting the inbox",
    portrait: null,
    initials: "SA",
    accent: "#b7822a",
    instructions:
      "You read mail and say what needs doing. Sort it into what needs the person, what can wait and what "
      + "is noise, and for anything needing a reply say in one line what it should say. Never send anything.",
    tools: ["read_email", "draft_email", "knowledge"],
  },
];

export const byHandle = (h: string): Assistant | undefined =>
  ASSISTANTS.find((a) => a.handle.toLowerCase() === (h.startsWith("@") ? h : `@${h}`).toLowerCase());

const HANDLE_AT_START = /^\s*@([a-z][a-z0-9_-]*)[\s,:]*/i;

/** The assistant a single message is addressed to, if it opens with a handle. */
export function addressedIn(content: string): Assistant | undefined {
  const m = HANDLE_AT_START.exec(content);
  return m ? byHandle(m[1]!) : undefined;
}

/**
 * The handle removed from what the model is given.
 *
 * "@nora hey what's going on" is a message addressed to Nora, not a message
 * about somebody called Nora — but the model only saw the text, so it read
 * the handle as the subject and answered "Hi, @nora! How are you today?",
 * greeting the person it was supposed to be. The handle is routing; it is
 * taken off before the words are sent.
 */
export function withoutHandle(content: string): string {
  return addressedIn(content) ? content.replace(HANDLE_AT_START, "") : content;
}

/**
 * Who should answer now.
 *
 * The latest message wins: addressing somebody new mid-conversation hands it
 * to them from that point, which is what writing their name is for. With no
 * handle anywhere, nobody in particular is answering.
 */
export function hostOf(messages: { role: string; content: string }[]): Assistant | undefined {
  const users = messages.filter((m) => m.role === "user");
  for (let i = users.length - 1; i >= 0; i--) {
    const who = addressedIn(users[i]!.content);
    if (who) return who;
  }
  return undefined;
}

/**
 * Everybody who has been addressed in this conversation, in the order they
 * first were. More than one assistant can be in a chat; this is who they are.
 */
export function castOf(messages: { role: string; content: string }[]): Assistant[] {
  const out: Assistant[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const who = addressedIn(m.content);
    if (who && !out.some((x) => x.id === who.id)) out.push(who);
  }
  return out;
}

/** Assistants whose handle begins with what has been typed after an "@". */
export function matching(partial: string): Assistant[] {
  const q = partial.replace(/^@/, "").toLowerCase();
  if (!q) return ASSISTANTS;
  return ASSISTANTS.filter((a) => a.handle.slice(1).startsWith(q) || a.name.toLowerCase().startsWith(q));
}
