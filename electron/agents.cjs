/**
 * Agents: a saved worker, not a separate AI.
 *
 * An agent is a configuration wrapped around a model that is already here: a
 * name, a job, standing instructions, the model it runs on, and an explicit
 * list of what it may do. Nothing is implied — a tool that is not ticked cannot
 * be called, and the check is made here rather than trusted to the model, which
 * is the whole point. A model can be talked into asking for anything; it cannot
 * talk this file into allowing it.
 *
 * What makes it an agent rather than a preset is the loop: it is given a goal,
 * it proposes steps, and the steps are carried out one at a time with the
 * results fed back. Reading happens freely. Anything that changes the world
 * stops and waits for a person, unless that exact tool has been pre-approved
 * for that agent.
 *
 * Honest limits, kept here so they are not forgotten:
 * - Small models are poor at this. Deciding what to do, calling a tool
 *   correctly and recovering from a failure needs a 7B-class instruction model.
 *   A 1.5B model will do the wrong thing confidently. `advice()` says so against
 *   the machine's real memory rather than letting someone find out slowly.
 * - Tools that do not exist yet (mail, calendar) are absent, not stubbed. An
 *   agent cannot be given a permission for something the app cannot do.
 */
const crypto = require("node:crypto");

const VERSION = 1;
const FORMAT = "forge-agent";

/**
 * Every tool an agent can be granted. `changes` marks the ones that alter
 * something outside the conversation; those stop for approval.
 */
const TOOLS = [
  { id: "web_search", label: "Search the web", changes: false, note: "Open-source lookups. No key needed." },
  { id: "read_page", label: "Read a web page", changes: false },
  { id: "read_files", label: "Read files in a folder you choose", changes: false },
  { id: "knowledge", label: "Use your knowledge packs", changes: false },
  { id: "write_file", label: "Write or change a file", changes: true },
  { id: "create_reminder", label: "Create a reminder", changes: true },
  { id: "write_memory", label: "Save something to memory", changes: true },
];
const TOOL_IDS = TOOLS.map((t) => t.id);
const byId = (id) => TOOLS.find((t) => t.id === id) || null;

const LIMITS = { name: 80, role: 200, instructions: 8000, goal: 2000, steps: 20 };

const newId = () => crypto.randomBytes(8).toString("hex");
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function emptyAgent(name = "New agent") {
  return {
    format: FORMAT,
    version: VERSION,
    id: newId(),
    name: clip(name, LIMITS.name) || "New agent",
    role: "",
    instructions: "",
    model: null,
    tools: [],
    preapproved: [],
    created: Date.now(),
    updated: Date.now(),
  };
}

/**
 * Takes anything and returns an agent, or throws. Used for what the UI sends
 * and for an imported file alike, because both are input from outside.
 */
function validateAgent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("That is not an agent.");
  const name = clip(raw.name, LIMITS.name);
  if (!name) throw new Error("An agent needs a name.");
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && TOOL_IDS.includes(x)) : []);
  const tools = [...new Set(list(raw.tools))];
  // Pre-approval is meaningless for a tool the agent does not have, and
  // dangerous to keep around in case the tool is granted later.
  const preapproved = [...new Set(list(raw.preapproved))].filter((t) => tools.includes(t));
  return {
    format: FORMAT,
    version: VERSION,
    id: typeof raw.id === "string" && /^[a-f0-9]{8,32}$/i.test(raw.id) ? raw.id : newId(),
    name,
    role: clip(raw.role, LIMITS.role),
    instructions: clip(raw.instructions, LIMITS.instructions),
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim().slice(0, 200) : null,
    tools,
    preapproved,
    created: Number(raw.created) || Date.now(),
    updated: Date.now(),
  };
}

/** May this agent use this tool at all? */
const can = (agent, toolId) => Boolean(agent && Array.isArray(agent.tools) && agent.tools.includes(toolId));

/**
 * Does this call have to stop for a person? Anything unknown is treated as
 * world-changing: a tool this file does not recognise is not one to take on trust.
 */
function needsApproval(agent, toolId) {
  if (!can(agent, toolId)) return true;
  const tool = byId(toolId);
  if (!tool) return true;
  if (!tool.changes) return false;
  return !(Array.isArray(agent.preapproved) && agent.preapproved.includes(toolId));
}

/**
 * The single decision point for a requested call. The UI and the loop both go
 * through this, so there is one place where a refusal is decided.
 */
function decide(agent, toolId) {
  if (!byId(toolId)) return { allow: false, approval: false, reason: `There is no tool called "${toolId}".` };
  if (!can(agent, toolId)) {
    return { allow: false, approval: false, reason: `${agent.name} is not allowed to ${byId(toolId).label.toLowerCase()}. Tick it in the agent's permissions first.` };
  }
  return needsApproval(agent, toolId)
    ? { allow: true, approval: true, reason: `${byId(toolId).label} changes something, so it needs your yes.` }
    : { allow: true, approval: false, reason: "" };
}

/** The standing instructions the model is given, built only from what is granted. */
function systemPromptFor(agent) {
  const granted = (agent.tools || []).map((id) => byId(id)).filter(Boolean);
  const lines = [
    `You are ${agent.name}${agent.role ? `, ${agent.role}` : ""}.`,
    "",
    "You work towards a goal in steps. First write a short plan as a numbered list, then carry out one step at a time, saying what you did and what it produced. If a step fails, say so and either try a different way or stop and explain. Never claim to have done something you did not do.",
  ];
  if (agent.instructions) lines.push("", "Your standing instructions:", agent.instructions);
  lines.push("", granted.length ? "You may use only these tools:" : "You have no tools. Work from what you already know, and say when you cannot do something without one.");
  for (const t of granted) {
    lines.push(`- ${t.id}: ${t.label}${t.changes ? " (changes something — it will be shown to the person for approval before it runs)" : ""}`);
  }
  if (granted.length) {
    lines.push(
      "",
      "To use one, write a fenced block tagged forge-act containing JSON: {\"tool\": \"<id>\", \"input\": \"<what you want>\", \"why\": \"<one line>\"}. Ask for one tool at a time and wait for its result. Do not invent tools, and do not pretend a tool returned something.",
    );
  }
  return lines.join("\n");
}

/** Pulls the tool calls out of a reply. Anything malformed is ignored, not guessed at. */
function parseActions(text) {
  const out = [];
  const re = /```forge-act\s*\n([\s\S]*?)```/g;
  for (const m of String(text ?? "").matchAll(re)) {
    try {
      const d = JSON.parse(m[1]);
      const tool = typeof d?.tool === "string" ? d.tool.trim() : "";
      if (!tool) continue;
      out.push({ tool, input: clip(d.input, 4000), why: clip(d.why, 300) });
    } catch { /* a half-written block during streaming is not an action */ }
  }
  return out;
}

/** The numbered plan, if the reply opens with one. */
function parsePlan(text) {
  const steps = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(\d{1,2})[.)]\s+(.{3,200})$/);
    if (m) steps.push(m[2].trim());
    if (steps.length >= LIMITS.steps) break;
  }
  return steps;
}

/**
 * Whether this machine can realistically run an agent loop, judged on memory
 * rather than optimism. Returning "no" is more useful than a decoration.
 */
function advice({ usableBytes = 0, modelBytes = 0 } = {}) {
  const gb = usableBytes / 2 ** 30;
  if (modelBytes && modelBytes > usableBytes) {
    return { ok: false, text: "That model does not fit in this machine's memory, so the agent would stall on its first step." };
  }
  // A 7B at Q4 is roughly 4.5 GB of weights before any context, so 5 GB usable
  // is not "tight", it is too small. The boundary sits above that deliberately.
  if (gb < 6) {
    return { ok: false, text: `This machine has about ${gb.toFixed(1)} GB usable. Agent loops need a 7B-class model to decide, call a tool correctly and recover from a failure; smaller models do the wrong thing confidently. Expect this to be unreliable here.` };
  }
  if (gb < 8) {
    return { ok: true, warn: true, text: `About ${gb.toFixed(1)} GB usable. A 7B model will be tight but should run. Keep goals to a few steps.` };
  }
  return { ok: true, warn: false, text: "This machine has enough memory for a 7B-class model, which is what an agent loop needs." };
}

/**
 * Reads the parameter count out of a model's file name, so the assistant can be
 * called what it actually is. Returns "" when the name does not say, rather
 * than guessing a number that would then be wrong on the label.
 */
function paramsOf(fileName) {
  const m = String(fileName || "").match(/(?:^|[-_.])(\d+(?:\.\d+)?)\s*([bBmM])(?=[-_.]|$)/);
  return m ? `${m[1]}${m[2].toUpperCase()}` : "";
}

/**
 * The built-in assistant: one agent, set up to do the things people expect of
 * a general assistant, over whichever model is installed.
 *
 * It is a configuration, not a trained model. Nothing here changes any weights,
 * and the name carries the base model's parameter count so it is never mistaken
 * for something larger than it is.
 *
 * The instructions lean hard on admitting ignorance, because that is the single
 * failure that makes a small model useless: a 2B model asked for a fact it does
 * not have will invent one fluently.
 */
function forgeAssistant(modelFile) {
  const params = paramsOf(modelFile);
  return validateAgent({
    name: `Forge AI${params ? ` ${params}` : ""}`,
    role: "general assistant on this computer",
    model: modelFile || null,
    tools: ["web_search", "read_page", "read_files", "knowledge", "write_file", "create_reminder", "write_memory"],
    preapproved: [],
    instructions: [
      "You are a general assistant running on this person's own computer. Nothing they say leaves the machine unless a tool you call sends it.",
      "",
      "Being right matters more than being helpful. If you do not know something, say so in one plain sentence and stop. If you are unsure, say which part you are unsure about. Never invent a fact, a name, a number, a quotation or an address. If a question needs something recent or specific, look it up with search or by reading the page rather than answering from memory.",
      "",
      "When you look something up, say where it came from. When you cannot check something, say that it is unchecked.",
      "",
      "Work in steps for anything with more than one part: say what you are going to do, do it, and say what came back, including when it failed.",
      "",
      "You can read images that are attached, if the model running you supports it. If you cannot see an attached image, say so rather than describing what you imagine is in it.",
      "",
      "For a web page, write complete HTML in a fenced html block, with its CSS in a <style> tag and any script inline — it is rendered in a sandboxed frame, so it cannot load outside files. For more than one page, write each page in its own html block, say which file each one is, and link them with plain relative hrefs such as about.html.",
      "",
      "For an email, start with a line 'To: ', then 'Subject: ', then a blank line, then the body. Do not send it; the person does.",
      "",
      "Say plainly when something is beyond you: you cannot send email, open other applications, or use anything that is not in your permissions.",
    ].join("\n"),
  });
}

const exportAgent = (a) => JSON.stringify({ ...a, format: FORMAT, version: VERSION }, null, 2);

function importAgent(text) {
  if (typeof text !== "string") throw new Error("An agent must be a text file.");
  if (text.length > 1024 * 1024) throw new Error("That file is too large to be an agent.");
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not valid JSON."); }
  if (raw?.format !== FORMAT) throw new Error("That file is not a Forge AI agent.");
  if (Number(raw.version) > VERSION) throw new Error("That agent was made by a newer version of Forge AI.");
  // A fresh id, so importing the same agent twice does not overwrite the first.
  return validateAgent({ ...raw, id: undefined });
}

module.exports = {
  FORMAT, VERSION, TOOLS, TOOL_IDS, LIMITS,
  emptyAgent, validateAgent, can, needsApproval, decide,
  systemPromptFor, parseActions, parsePlan, advice, exportAgent, importAgent,
  forgeAssistant, paramsOf,
};
