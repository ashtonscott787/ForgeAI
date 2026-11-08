/**
 * What Forge AI is allowed to remember.
 *
 * Two rules shape this file. Nothing is stored without the person approving it,
 * and what is stored is visible, editable and removable. The model can propose
 * a memory; only the person can save one.
 */
const fs = require("node:fs");
const path = require("node:path");

let file = "";
let items = [];

const save = () => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, file);
};
const id = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const alive = (m) => !m.expires || m.expires > Date.now();

function load(dir) {
  file = path.join(dir, "memory.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    items = Array.isArray(raw) ? raw : [];
  } catch {
    items = [];
  }
  return items;
}

const list = () =>
  items
    .filter(alive)
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created - a.created);

function add({ text, scope, project, pinned, expires, source }) {
  const body = String(text || "").trim();
  if (!body) throw new Error("a memory needs some text");
  if (body.length > 600) throw new Error("that is too long for a memory; keep it to a sentence or two");
  const m = {
    id: id(),
    text: body,
    scope: scope === "project" ? "project" : "personal",
    project: scope === "project" ? String(project || "").trim() : "",
    pinned: Boolean(pinned),
    expires: Number.isFinite(expires) ? expires : null,
    source: String(source || "you").slice(0, 60),
    created: Date.now(),
  };
  items.push(m);
  save();
  return m;
}

function update(patch) {
  const m = items.find((x) => x.id === patch.id);
  if (!m) throw new Error("that memory no longer exists");
  if (patch.text !== undefined) m.text = String(patch.text).trim().slice(0, 600);
  if (patch.pinned !== undefined) m.pinned = Boolean(patch.pinned);
  if (patch.expires !== undefined) m.expires = Number.isFinite(patch.expires) ? patch.expires : null;
  if (patch.scope !== undefined) m.scope = patch.scope === "project" ? "project" : "personal";
  if (patch.project !== undefined) m.project = String(patch.project).trim();
  save();
  return m;
}

function remove(mid) {
  items = items.filter((x) => x.id !== mid);
  save();
}

/**
 * The slice of memory that goes into a prompt: pinned first, then recent,
 * scoped to the active project. Capped, because memory that crowds out the
 * conversation makes answers worse rather than better.
 */
function forPrompt({ project, limit = 14 } = {}) {
  const scoped = list().filter((m) => m.scope === "personal" || (project && m.project === project));
  return scoped.slice(0, limit).map((m) => m.text);
}

const exportAll = () => ({ schema: 1, exported: Date.now(), memories: items.filter(alive) });

function importAll(payload, { replace } = {}) {
  const incoming = Array.isArray(payload?.memories) ? payload.memories : null;
  if (!incoming) throw new Error("that file does not look like a Forge AI memory export");
  const clean = incoming
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      id: id(),
      text: String(m.text).trim().slice(0, 600),
      scope: m.scope === "project" ? "project" : "personal",
      project: String(m.project || "").slice(0, 80),
      pinned: Boolean(m.pinned),
      expires: Number.isFinite(m.expires) ? m.expires : null,
      source: String(m.source || "import").slice(0, 60),
      created: Number.isFinite(m.created) ? m.created : Date.now(),
    }));
  // Importing twice should not double everything up.
  const seen = new Set(replace ? [] : items.map((m) => `${m.scope}:${m.project}:${m.text}`));
  const merged = replace ? [] : items.slice();
  let added = 0;
  for (const m of clean) {
    const key = `${m.scope}:${m.project}:${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
    added += 1;
  }
  items = merged;
  save();
  return { added, total: items.length };
}

module.exports = { load, list, add, update, remove, forPrompt, exportAll, importAll };
