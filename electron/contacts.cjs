/**
 * Who people are, built up from your own mail — and never asserted.
 *
 * The rule this whole file exists to enforce: nothing a model or a parser
 * worked out counts as true until a person says it does. A guess shown as a
 * fact is worse than no record at all, because it will be repeated back later
 * in an email with someone's name on it.
 *
 * So every piece of information carries a state — suggested, confirmed or
 * rejected — and the source it came from. `known()` returns only what was
 * confirmed. A rejected suggestion is remembered as rejected so the same wrong
 * guess is not offered again next week.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LIMITS = { people: 5000, factsPerPerson: 40, value: 300, note: 2000 };
const FIELDS = ["name", "organisation", "role", "phone", "location", "note"];

let file = "";
let people = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const clip = (v, n) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, n);

/** An address is the identity here: names change, addresses are the anchor. */
function normalise(address) {
  const s = String(address ?? "").trim();
  const m = s.match(/<([^<>]+)>/);
  const email = (m ? m[1] : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/** "Dana Patel <dana@x.com>" → Dana Patel, when there is a name at all. */
function displayName(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^\s*"?([^"<]+?)"?\s*<[^<>]+>\s*$/);
  const name = m ? m[1].trim() : "";
  // An address used as a name tells us nothing.
  if (!name || normalise(name)) return "";
  return clip(name, 120);
}

function load(dir) {
  file = path.join(dir, "contacts.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    people = new Map((Array.isArray(raw) ? raw : []).map((p) => [p.email, p]));
  } catch {
    people = new Map();
  }
  return people.size;
}

const persist = () => {
  if (!file) return;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify([...people.values()], null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* a contact book that will not save is not worth failing a mail read over */
  }
};

function person(email) {
  const key = normalise(email);
  if (!key) return null;
  if (!people.has(key)) {
    if (people.size >= LIMITS.people) return null;
    people.set(key, { id: newId(), email: key, created: Date.now(), updated: Date.now(), facts: [], seen: 0, last_seen: null });
  }
  return people.get(key);
}

/**
 * Records a suggestion. Identical suggestions are counted rather than
 * duplicated — seeing the same signature ten times is evidence, and the count
 * is shown so a person can weigh it.
 */
function suggest(email, field, value, source = "") {
  if (!FIELDS.includes(field)) return null;
  const p = person(email);
  const v = clip(value, field === "note" ? LIMITS.note : LIMITS.value);
  if (!p || !v) return null;

  const same = p.facts.find((f) => f.field === field && f.value.toLowerCase() === v.toLowerCase());
  if (same) {
    // A fact a person already rejected is not offered again.
    if (same.state === "rejected") return same;
    same.times = (same.times || 1) + 1;
    same.last_source = clip(source, 200);
    p.updated = Date.now();
    persist();
    return same;
  }
  if (p.facts.length >= LIMITS.factsPerPerson) return null;
  const fact = {
    id: newId(), field, value: v, state: "suggested",
    times: 1, source: clip(source, 200), last_source: clip(source, 200), at: Date.now(),
  };
  p.facts.push(fact);
  p.updated = Date.now();
  persist();
  return fact;
}

/** A person says yes or no. Only this makes something true. */
function decide(email, factId, state) {
  if (!["confirmed", "rejected"].includes(state)) return null;
  const p = people.get(normalise(email));
  const fact = p?.facts.find((f) => f.id === factId);
  if (!fact) return null;
  fact.state = state;
  fact.decided_at = Date.now();
  // Only one value per field can be confirmed; confirming a new one retires
  // the old rather than leaving two answers to the same question.
  if (state === "confirmed" && fact.field !== "note") {
    for (const other of p.facts) {
      if (other !== fact && other.field === fact.field && other.state === "confirmed") other.state = "superseded";
    }
  }
  p.updated = Date.now();
  persist();
  return fact;
}

/** Something a person typed themselves. Confirmed by definition. */
function state(email, field, value) {
  if (!FIELDS.includes(field)) return null;
  const p = person(email);
  const v = clip(value, field === "note" ? LIMITS.note : LIMITS.value);
  if (!p || !v) return null;
  for (const other of p.facts) {
    if (other.field === field && other.state === "confirmed" && field !== "note") other.state = "superseded";
  }
  const fact = { id: newId(), field, value: v, state: "confirmed", times: 1, source: "you told Forge AI", at: Date.now(), decided_at: Date.now() };
  p.facts.push(fact);
  p.updated = Date.now();
  persist();
  return fact;
}

/** What is actually known about someone: confirmed only. */
function known(email) {
  const p = people.get(normalise(email));
  if (!p) return null;
  const out = { email: p.email, notes: [] };
  for (const f of p.facts) {
    if (f.state !== "confirmed") continue;
    if (f.field === "note") out.notes.push(f.value);
    else out[f.field] = f.value;
  }
  return out;
}

const pending = (email) => (people.get(normalise(email))?.facts || []).filter((f) => f.state === "suggested");

/**
 * Learns what it can from one message's headers. Only the name is taken from
 * a header: a signature block is a guess about a person and belongs in the
 * suggestion list, which is what `suggestFromBody` is for.
 */
function fromMessage({ from, date, subject }) {
  const email = normalise(from);
  if (!email) return null;
  const p = person(email);
  if (!p) return null;
  p.seen = (p.seen || 0) + 1;
  p.last_seen = Date.parse(date || "") || Date.now();
  p.updated = Date.now();
  const name = displayName(from);
  if (name) suggest(email, "name", name, subject ? `email: ${clip(subject, 80)}` : "an email");
  else persist();
  return p;
}

/**
 * Reads a signature block for things worth asking about. Everything it finds
 * is a suggestion — the whole point is that a signature is someone's claim
 * about themselves in a format nobody standardised.
 */
function suggestFromBody(email, text, source = "") {
  const key = normalise(email);
  if (!key || !text) return [];
  const tail = String(text).split(/\n/).slice(-14).join("\n");
  const out = [];

  const phone = tail.match(/(?:^|\s)(\+?\d[\d\s().-]{7,17}\d)(?=\s|$)/m);
  if (phone) out.push(suggest(key, "phone", phone[1], source));

  // "Head of Operations, Acme Ltd" on one line: a common shape, not a standard.
  const role = tail.match(/^\s*([A-Z][A-Za-z ]{2,40}(?:Manager|Director|Officer|Head|Lead|Engineer|Analyst|Coordinator|Owner|Founder|President))\s*(?:[,|–-]\s*(.+))?$/m);
  if (role) {
    out.push(suggest(key, "role", role[1], source));
    if (role[2]) out.push(suggest(key, "organisation", role[2], source));
  }
  const domain = key.split("@")[1];
  if (domain && !/gmail|outlook|hotmail|yahoo|icloud|proton|live\.|me\.com/i.test(domain)) {
    const guess = domain.split(".")[0].replace(/[-_]/g, " ");
    out.push(suggest(key, "organisation", guess.charAt(0).toUpperCase() + guess.slice(1), `their email address is at ${domain}`));
  }
  return out.filter(Boolean);
}

function list({ onlyPending = false } = {}) {
  const rows = [...people.values()].map((p) => ({
    id: p.id, email: p.email, seen: p.seen || 0, last_seen: p.last_seen,
    known: known(p.email),
    pending: p.facts.filter((f) => f.state === "suggested"),
    facts: p.facts,
  }));
  const filtered = onlyPending ? rows.filter((r) => r.pending.length) : rows;
  return filtered.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
}

function forget(email) {
  const key = normalise(email);
  const had = people.delete(key);
  if (had) persist();
  return had;
}

/** What a model may be told. Confirmed facts only, never a suggestion. */
function forPrompt(addresses = []) {
  const lines = [];
  for (const a of addresses) {
    const k = known(a);
    if (!k) continue;
    const bits = FIELDS.filter((f) => f !== "note" && k[f]).map((f) => `${f}: ${k[f]}`);
    if (!bits.length && !k.notes.length) continue;
    lines.push(`${k.email}${bits.length ? ` — ${bits.join(", ")}` : ""}${k.notes.length ? `\n  ${k.notes.join("\n  ")}` : ""}`);
  }
  return lines.length ? `What you know about these people, because they confirmed it:\n${lines.join("\n")}` : "";
}

module.exports = { load, person, suggest, decide, state, known, pending, fromMessage, suggestFromBody, list, forget, forPrompt, normalise, displayName, FIELDS, LIMITS };
