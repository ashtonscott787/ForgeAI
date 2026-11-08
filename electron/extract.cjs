/**
 * Turning an uploaded file into text the model can actually read.
 *
 * Office formats are ZIP containers of XML, so they are unpacked here with a
 * small central-directory reader rather than a dependency. PDFs go through
 * pdf.js. Anything this module cannot read says so plainly: a file that is
 * attached but not understood must never look like one that was.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".html", ".htm", ".css",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".php", ".sh", ".bash", ".zsh", ".sql",
  ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".log", ".env.example", ".srt", ".vtt",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".tiff"]);

// ── minimal ZIP reader ──────────────────────────────────────
function zipEntries(buf) {
  const end = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (end < 0) throw new Error("not a readable ZIP container");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
  }
  return out;
}

const strip = (xml) =>
  xml
    .replace(/<w:p[ >][\s\S]*?<\/w:p>|<\/w:p>/g, (m) => m + "\n")
    .replace(/<a:p>|<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

function fromDocx(buf) {
  const z = zipEntries(buf);
  const parts = ["word/document.xml", ...[...z.keys()].filter((k) => /^word\/(header|footer)\d*\.xml$/.test(k))];
  return parts.filter((p) => z.has(p)).map((p) => strip(z.get(p)().toString("utf8"))).join("\n").trim();
}

function fromPptx(buf) {
  const z = zipEntries(buf);
  const slides = [...z.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return slides
    .map((s, i) => `--- Slide ${i + 1} ---\n${strip(z.get(s)().toString("utf8")).trim()}`)
    .join("\n\n");
}

const colLetters = (ref) => (ref.match(/^[A-Z]+/) || ["A"])[0];
const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function fromXlsx(buf, maxRows = 400) {
  const z = zipEntries(buf);
  const shared = z.has("xl/sharedStrings.xml")
    ? [...z.get("xl/sharedStrings.xml")().toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => strip(m[1]))
    : [];
  const names = z.has("xl/workbook.xml")
    ? [...z.get("xl/workbook.xml")().toString("utf8").matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1])
    : [];
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  sheets.forEach((s, si) => {
    const xml = z.get(s)().toString("utf8");
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, maxRows);
    const lines = rows.map((r) => {
      const cells = [...r[1].matchAll(/<c r="([A-Z]+\d+)"(?:[^>]*t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)];
      const vals = [];
      for (const c of cells) {
        const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [, ""])[1];
        const inline = (c[3].match(/<is>([\s\S]*?)<\/is>/) || [, ""])[1];
        const text = c[2] === "s" ? (shared[Number(v)] ?? "") : inline ? strip(inline) : v;
        vals[colIndex(colLetters(c[1]))] = text;
      }
      return Array.from(vals, (x) => (x === undefined ? "" : x)).join("\t");
    });
    const truncated = [...xml.matchAll(/<row[^>]*>/g)].length > maxRows;
    out.push(`--- Sheet: ${names[si] ?? si + 1} ---\n${lines.join("\n")}${truncated ? `\n…(first ${maxRows} rows only)` : ""}`);
  });
  return out.join("\n\n");
}

async function fromPdf(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Keep line breaks: pdf.js marks the end of a visual line with hasEOL.
    let line = "";
    const lines = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push({ page: i, text: lines.join("\n").replace(/[ \t]{2,}/g, " ").trim() });
  }
  await doc.destroy();
  return pages;
}

/**
 * Reads one file. Returns the text plus an honest account of what happened,
 * including when nothing could be read.
 */
async function readAttachment(filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  const stat = fs.statSync(filePath);
  const base = { name, path: filePath, bytes: stat.size, ext };

  if (IMAGE_EXT.has(ext)) {
    const b64 = stat.size <= 6 * 1024 ** 2 ? fs.readFileSync(filePath).toString("base64") : null;
    return {
      ...base, kind: "image", text: "", pages: null, preview: b64,
      note: "Images are shown to you, but the text-only engine in this build cannot read them. Describe what you need from it, or attach a text version.",
      readable: false,
    };
  }

  if (stat.size > 80 * 1024 ** 2) {
    return { ...base, kind: "other", text: "", pages: null, readable: false, note: "Larger than 80 MB — too big to read into a prompt." };
  }

  try {
    if (ext === ".pdf") {
      const pages = await fromPdf(filePath);
      const text = pages.map((p) => `[page ${p.page}]\n${p.text}`).join("\n\n").trim();
      return {
        ...base, kind: "pdf", pages: pages.length, text, readable: text.length > 0,
        note: text.length === 0 ? "No text layer found — this looks like a scan, and this build has no OCR." : "",
      };
    }
    if (ext === ".docx") {
      const text = fromDocx(fs.readFileSync(filePath));
      return { ...base, kind: "docx", pages: null, text, readable: text.length > 0, note: "" };
    }
    if (ext === ".pptx") {
      const text = fromPptx(fs.readFileSync(filePath));
      return { ...base, kind: "pptx", pages: null, text, readable: text.length > 0, note: "" };
    }
    if (ext === ".xlsx" || ext === ".xlsm") {
      const text = fromXlsx(fs.readFileSync(filePath));
      return { ...base, kind: "xlsx", pages: null, text, readable: text.length > 0, note: "" };
    }
    if (TEXT_EXT.has(ext) || !ext) {
      const text = fs.readFileSync(filePath, "utf8");
      return { ...base, kind: ext === ".csv" || ext === ".tsv" ? "table" : "text", pages: null, text, readable: true, note: "" };
    }
    if (ext === ".doc" || ext === ".xls" || ext === ".ppt") {
      return { ...base, kind: "other", text: "", pages: null, readable: false,
        note: "That is the pre-2007 Office format. Re-save it as .docx, .xlsx or .pptx and attach it again." };
    }
    return { ...base, kind: "other", text: "", pages: null, readable: false, note: `Forge AI cannot read ${ext || "this kind of"} files yet.` };
  } catch (e) {
    return { ...base, kind: "other", text: "", pages: null, readable: false, note: `Could not be read: ${e.message}` };
  }
}

/**
 * Picks the parts of a document to send when the whole thing will not fit.
 * Keyword overlap with the question, not embeddings — crude, but it is honest
 * about being crude and it beats cutting the file off at the top.
 */
function selectRelevant(text, question, budget) {
  if (text.length <= budget) return { text, trimmed: false };
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const words = [...new Set((question.toLowerCase().match(/[a-z0-9]{4,}/g) || []))];
  if (!words.length) return { text: text.slice(0, budget), trimmed: true };
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    let score = 0;
    for (const w of words) if (low.includes(w)) score += 1;
    return { i, p, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.p.length > budget) continue;
    picked.push(s);
    used += s.p.length;
    if (used > budget * 0.95) break;
  }
  picked.sort((a, b) => a.i - b.i);
  return { text: picked.map((s) => s.p).join("\n\n"), trimmed: true };
}

module.exports = { readAttachment, selectRelevant, zipEntries };
