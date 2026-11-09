/**
 * User-built skills: named instructions the person writes once and switches on
 * per chat. An enabled skill is added to the system prompt for every message.
 *
 * Skills are plain text. They cannot run code, reach the network or call tools
 * on their own — that is what connectors are for, and connectors need approval.
 */
const fs = require("node:fs");
const path = require("node:path");

let file = "";
let items = [];
const LIMITS = { name: 60, description: 200, instructions: 8000 };

const id = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const save = () => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, file);
};

function load(dir) {
  file = path.join(dir, "skills.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    items = Array.isArray(raw) ? raw.filter(valid) : [];
  } catch {
    items = [];
  }
  return items;
}

function clean(input) {
  const name = String(input.name ?? "").trim().slice(0, LIMITS.name);
  const description = String(input.description ?? "").trim().slice(0, LIMITS.description);
  const instructions = String(input.instructions ?? "").trim().slice(0, LIMITS.instructions);
  if (!name) throw new Error("A skill needs a name.");
  if (!instructions) throw new Error("A skill needs instructions.");
  return { name, description, instructions };
}

const valid = (s) => s && typeof s.id === "string" && typeof s.name === "string" && typeof s.instructions === "string";

const list = () => items.slice().sort((a, b) => a.name.localeCompare(b.name));

function add(input) {
  const row = { id: id(), ...clean(input), enabled: input.enabled !== false, created: Date.now(), updated: Date.now() };
  items.push(row);
  save();
  return row;
}

function update(patch) {
  const row = items.find((s) => s.id === patch.id);
  if (!row) throw new Error("That skill no longer exists.");
  if ("enabled" in patch) row.enabled = Boolean(patch.enabled);
  if (["name", "description", "instructions"].some((k) => k in patch)) {
    Object.assign(row, clean({ ...row, ...patch }));
  }
  row.updated = Date.now();
  save();
  return row;
}

function remove(skillId) {
  items = items.filter((s) => s.id !== skillId);
  save();
}

/** What the model is told: only enabled skills, with the name and the instructions. */
const forPrompt = () => items.filter((s) => s.enabled).map((s) => ({ name: s.name, instructions: s.instructions }));

const exportAll = () => items.map(({ name, description, instructions, enabled }) => ({ name, description, instructions, enabled }));

/** Imports skills as new entries; existing skills are never overwritten. */
function importAll(list) {
  if (!Array.isArray(list)) throw new Error("That file is not a list of skills.");
  let added = 0;
  for (const s of list.slice(0, 200)) {
    try {
      add({ ...clean(s), enabled: s.enabled !== false });
      added += 1;
    } catch {
      /* skip entries that are not valid skills */
    }
  }
  return { added };
}

module.exports = { load, list, add, update, remove, forPrompt, exportAll, importAll, LIMITS };
