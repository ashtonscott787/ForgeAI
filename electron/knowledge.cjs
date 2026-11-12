/**
 * Knowledge packs: your own material, searched and handed to the model.
 *
 * What this is, said plainly, because the word "training" invites a wrong idea.
 * This does not change a model's weights. Fine-tuning a 2B model needs a
 * training stack and many gigabytes of memory the machines this app targets do
 * not have, and a badly fine-tuned model is worse than the one it came from.
 * What actually makes a model answer from your material is retrieval: keep the
 * text, find the passages that match the question, and put them in the prompt.
 * That works on any model here, takes seconds rather than hours, needs no GPU,
 * and can be undone by switching the pack off.
 *
 * A pack is one JSON file. That makes exporting, sharing and importing the same
 * operation, and keeps the format readable by anything, not just this app.
 *
 * Ranking is BM25 over words. No embedding model is bundled, and pretending to
 * do semantic search with a model that is not there would be worse than lexical
 * search that is honest about what it is.
 */
const crypto = require("node:crypto");

const FORMAT = "forge-knowledge-pack";
const VERSION = 1;

// Caps. An imported pack is a file from someone else, so every one of these is
// a refusal rather than a truncation: silently keeping half a document would
// make a pack behave differently for the person who received it.
const LIMITS = {
  name: 200,
  documents: 2000,
  chunksPerPack: 50_000,
  chunkChars: 4000,
  packBytes: 64 * 1024 * 1024,
};

const CHUNK = 900;
const OVERLAP = 150;

const STOP = new Set(
  "a an and are as at be but by для for from has have he her his i if in is it its of on or she that the their them they this to was were will with you your".split(" "),
);

const newId = () => crypto.randomBytes(8).toString("hex");

/** Words, lowercased, without the ones that carry no signal. */
function terms(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && w.length < 40 && !STOP.has(w));
}

/**
 * Splits on paragraph boundaries where it can, so a chunk is usually a whole
 * thought rather than a fixed number of characters cut mid-sentence.
 */
function chunk(text, size = CHUNK, overlap = OVERLAP) {
  const clean = String(text).replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out = [];
  let at = 0;
  while (at < clean.length) {
    let end = Math.min(at + size, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence end, then a space.
      const window = clean.slice(at, end);
      const para = window.lastIndexOf("\n\n");
      const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const space = window.lastIndexOf(" ");
      const cut = para > size * 0.4 ? para : stop > size * 0.4 ? stop + 1 : space > size * 0.4 ? space : -1;
      if (cut > 0) end = at + cut;
    }
    const piece = clean.slice(at, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    at = Math.max(end - overlap, at + 1);
  }
  return out;
}

const emptyPack = (name, description = "") => ({
  format: FORMAT,
  version: VERSION,
  id: newId(),
  name: String(name || "Untitled pack").slice(0, LIMITS.name),
  description: String(description || "").slice(0, 2000),
  created: Date.now(),
  updated: Date.now(),
  documents: [],
  chunks: [],
});

/** Adds a document and its chunks. Returns the pack; never mutates in place. */
function addDocument(pack, { name, text, source = "" }) {
  const body = String(text || "").trim();
  if (!body) throw new Error("That document has no text in it.");
  if (pack.documents.length >= LIMITS.documents) throw new Error(`A pack holds at most ${LIMITS.documents} documents.`);
  const docId = newId();
  const pieces = chunk(body);
  if (pack.chunks.length + pieces.length > LIMITS.chunksPerPack) {
    throw new Error("That document would make the pack too large to search quickly.");
  }
  return {
    ...pack,
    updated: Date.now(),
    documents: [...pack.documents, { id: docId, name: String(name || "Untitled").slice(0, LIMITS.name), source: String(source).slice(0, 500), chars: body.length, chunks: pieces.length }],
    chunks: [...pack.chunks, ...pieces.map((t, i) => ({ id: newId(), doc: docId, i, text: t }))],
  };
}

function removeDocument(pack, docId) {
  return {
    ...pack,
    updated: Date.now(),
    documents: pack.documents.filter((d) => d.id !== docId),
    chunks: pack.chunks.filter((c) => c.doc !== docId),
  };
}

/**
 * BM25. Chosen over raw term counts because without the length normalisation a
 * long document wins every query simply by being long.
 */
function search(pack, query, k = 5) {
  const q = terms(query);
  if (!q.length || !pack.chunks.length) return [];
  const N = pack.chunks.length;
  const toks = pack.chunks.map((c) => terms(c.text));
  const avg = toks.reduce((s, t) => s + t.length, 0) / N || 1;

  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  const scored = pack.chunks.map((c, idx) => {
    const t = toks[idx];
    const len = t.length || 1;
    const counts = new Map();
    for (const w of t) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of new Set(q)) {
      const f = counts.get(w);
      if (!f) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg)));
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, Math.max(1, k))
    .map((s) => ({
      text: s.chunk.text,
      score: Number(s.score.toFixed(4)),
      document: pack.documents.find((d) => d.id === s.chunk.doc)?.name ?? "unknown",
    }));
}

/** The passages, labelled with where each came from, ready to go in a prompt. */
function contextFor(pack, query, k = 5) {
  const hits = search(pack, query, k);
  if (!hits.length) return "";
  return hits.map((h) => `From "${h.document}":\n${h.text}`).join("\n\n---\n\n");
}

const exportPack = (pack) => JSON.stringify({ ...pack, format: FORMAT, version: VERSION }, null, 2);

/**
 * An imported pack is a file from somewhere else, so nothing in it is trusted:
 * the shape, every type and every length is checked, and anything unexpected is
 * dropped rather than carried into the app. It is given a new id so importing
 * one twice cannot overwrite a pack already here.
 */
function importPack(text) {
  if (typeof text !== "string") throw new Error("A pack must be a text file.");
  if (Buffer.byteLength(text, "utf8") > LIMITS.packBytes) throw new Error("That file is too large to be a knowledge pack.");
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not a knowledge pack: it is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("That file is not a knowledge pack.");
  if (raw.format !== FORMAT) throw new Error("That file is not a Forge AI knowledge pack.");
  if (Number(raw.version) > VERSION) throw new Error(`That pack was made by a newer version of Forge AI (format ${raw.version}).`);

  const docs = Array.isArray(raw.documents) ? raw.documents : [];
  const chunks = Array.isArray(raw.chunks) ? raw.chunks : [];
  if (docs.length > LIMITS.documents) throw new Error("That pack holds more documents than Forge AI will import.");
  if (chunks.length > LIMITS.chunksPerPack) throw new Error("That pack holds more passages than Forge AI will import.");

  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  // Document ids are remapped, so a pack cannot point its passages anywhere else.
  const idMap = new Map();
  const documents = docs
    .filter((d) => d && typeof d === "object" && typeof d.id === "string")
    .map((d) => {
      const id = newId();
      idMap.set(d.id, id);
      return { id, name: str(d.name, LIMITS.name) || "Untitled", source: str(d.source, 500), chars: Number(d.chars) || 0, chunks: Number(d.chunks) || 0 };
    });

  const kept = chunks
    .filter((c) => c && typeof c === "object" && typeof c.text === "string" && idMap.has(c.doc))
    .map((c) => ({ id: newId(), doc: idMap.get(c.doc), i: Number(c.i) || 0, text: c.text.slice(0, LIMITS.chunkChars) }));

  if (!kept.length) throw new Error("That pack has no readable passages in it.");

  return {
    format: FORMAT,
    version: VERSION,
    id: newId(),
    name: str(raw.name, LIMITS.name) || "Imported pack",
    description: str(raw.description, 2000),
    created: Date.now(),
    updated: Date.now(),
    documents,
    chunks: kept,
  };
}

module.exports = { FORMAT, VERSION, LIMITS, emptyPack, addDocument, removeDocument, search, contextFor, exportPack, importPack, chunk, terms };
