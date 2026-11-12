/**
 * Real files, not downloads that merely have the right extension.
 *
 * Forge AI deliberately carries almost no dependencies, so the writers here are
 * written out rather than pulled in. That is a defensible trade only if the
 * output is genuinely valid, so every format produced here is read back by the
 * app's own extractor in the tests: a .docx that this writes is parsed by the
 * same code that reads a .docx someone else sent.
 *
 * PDF is the exception and is produced by Electron's own print engine
 * (printToPDF) in main.cjs, because writing a PDF renderer by hand would be a
 * worse file than the browser already makes.
 */
const zlib = require("node:zlib");

// ── ZIP ───────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what a ZIP central directory stores. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * Writes a ZIP. Entries are {name, data}; data is a Buffer or string.
 * Deflated when that is smaller, stored when it is not — a tiny file is often
 * bigger compressed, and storing it keeps the archive honest about its size.
 */
function zip(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/^\/+/, ""), "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);       // version needed
    lh.writeUInt16LE(0, 6);        // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);       // version made by
    ch.writeUInt16LE(20, 6);       // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 38);       // external attributes
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + body.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ── text formats ──────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A CSV cell is quoted whenever it contains a comma, a quote or a newline, and
 * inner quotes are doubled. Anything less produces a file that opens wrong in a
 * spreadsheet exactly when the data is interesting.
 */
function csv(rows) {
  return rows
    .map((r) => r.map((c) => {
      const v = c === null || c === undefined ? "" : String(c);
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(","))
    .join("\r\n");
}

// ── DOCX ──────────────────────────────────────────────────────
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** One paragraph. Headings use Word's built-in outline styles. */
function para(block) {
  const text = esc(block.text ?? "");
  const style = block.heading ? `<w:pStyle w:val="Heading${Math.min(Math.max(block.heading, 1), 6)}"/>` : "";
  const bullet = block.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "";
  const bold = block.bold || block.heading ? "<w:rPr><w:b/></w:rPr>" : "";
  const props = style || bullet || bold ? `<w:pPr>${style}${bullet}</w:pPr>` : "";
  // xml:space preserve, or Word eats leading and trailing spaces.
  return `<w:p>${props}<w:r>${bold}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * Blocks are {text, heading?, bullet?, bold?}. Produces a real .docx: a ZIP of
 * OOXML parts that Word, Pages and the app's own reader all open.
 */
function docx(blocks, when = new Date()) {
  const body = (Array.isArray(blocks) ? blocks : [{ text: String(blocks ?? "") }]).map(para).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: document },
  ], when);
}

/** Markdown to document blocks, so one answer can become any of these formats. */
function blocksFromMarkdown(md) {
  const out = [];
  for (const line of String(md ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ text: h[2].trim(), heading: h[1].length }); continue; }
    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b) { out.push({ text: b[1].trim(), bullet: true }); continue; }
    const t = line.trim();
    if (t) out.push({ text: t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1") });
    else out.push({ text: "" });
  }
  return out.length ? out : [{ text: "" }];
}

/** A plain, readable HTML document, for printing to PDF or saving as a page. */
function htmlDocument(title, blocks) {
  const body = blocks.map((b) => {
    if (!b.text) return "";
    if (b.heading) return `<h${b.heading}>${esc(b.text)}</h${b.heading}>`;
    if (b.bullet) return `<li>${esc(b.text)}</li>`;
    return `<p>${esc(b.text)}</p>`;
  }).join("\n").replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font: 15px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; color: #111; max-width: 46em; margin: 3em auto; padding: 0 1.5em; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.6em 0 .5em; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  ul { padding-left: 1.3em; } li { margin: .3em 0; }
  @media print { body { margin: 0; max-width: none; } }
</style></head>
<body>${body}</body></html>`;
}

/**
 * The window printToPDF needs.
 *
 * JavaScript must be ON. printToPDF drives printing through the renderer, so a
 * window created with `javascript: false` aborts with
 * DisallowJavascriptExecutionScope before producing anything. That setting was
 * added here as a precaution and was the whole reason PDF generation crashed.
 *
 * It is safe to allow: the page is built by htmlDocument, which escapes every
 * value it is given, it is loaded from a data: URL so it has no origin and no
 * network, and the renderer is sandboxed with no Node and no preload.
 *
 * `offscreen` is also off: combined with printToPDF it is a known source of
 * blank output and hangs, and `show: false` already keeps the window hidden.
 */
const PDF_WINDOW = {
  show: false,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
};

const PDF_OPTIONS = { printBackground: true, margins: { marginType: "default" } };

module.exports = { zip, crc32, csv, docx, para, blocksFromMarkdown, htmlDocument, esc, PDF_WINDOW, PDF_OPTIONS };
