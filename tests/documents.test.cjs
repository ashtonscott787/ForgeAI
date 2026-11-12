// Documents must be real files, not downloads with the right extension.
// Everything written here is read back by the app's own extractor — the same
// code that opens a .docx someone else sent — so a file that only looks right
// cannot pass.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const D = require("../electron/documents.cjs");
const extract = require("../electron/extract.cjs");

test("the ZIP it writes is readable by the app's own ZIP reader", () => {
  const buf = D.zip([
    { name: "hello.txt", data: "Hello there" },
    { name: "nested/deep/file.json", data: JSON.stringify({ a: 1 }) },
  ]);
  const entries = extract.zipEntries(buf);
  assert.ok(entries.has("hello.txt"), "the first entry is found");
  assert.ok(entries.has("nested/deep/file.json"), "a nested path survives");
  assert.equal(entries.get("hello.txt")().toString("utf8"), "Hello there");
  assert.deepEqual(JSON.parse(entries.get("nested/deep/file.json")().toString("utf8")), { a: 1 });
});

test("a large, compressible entry round-trips byte for byte", () => {
  // Deflate is used when it helps; the reader must still return the original.
  const big = "the quick brown fox. ".repeat(5000);
  const entries = extract.zipEntries(D.zip([{ name: "big.txt", data: big }]));
  assert.equal(entries.get("big.txt")().toString("utf8"), big);
});

test("binary data is not corrupted by the writer", () => {
  const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  const entries = extract.zipEntries(D.zip([{ name: "b.bin", data: bytes }]));
  assert.ok(entries.get("b.bin")().equals(bytes), "every byte comes back");
});

test("the ZIP has the signatures a real archive has", () => {
  const buf = D.zip([{ name: "a.txt", data: "x" }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "local file header");
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])), "central directory");
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), "end of central directory");
});

test("the DOCX it writes is read back as a document by the app's DOCX reader", async () => {
  const blocks = D.blocksFromMarkdown("# Quarterly report\n\nRevenue rose.\n\n- North up\n- South flat\n");
  const file = path.join(os.tmpdir(), `forge-doc-${process.pid}.docx`);
  fs.writeFileSync(file, D.docx(blocks));
  try {
    const read = await extract.readAttachment(file);
    assert.ok(read.readable !== false, "the reader accepts it as a document");
    assert.match(read.text, /Quarterly report/);
    assert.match(read.text, /Revenue rose/);
    assert.match(read.text, /North up/);
    assert.match(read.text, /South flat/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a DOCX keeps the text that Word would otherwise trim", async () => {
  const file = path.join(os.tmpdir(), `forge-space-${process.pid}.docx`);
  fs.writeFileSync(file, D.docx([{ text: "  leading and trailing  " }]));
  try {
    const read = await extract.readAttachment(file);
    assert.match(read.text, /leading and trailing/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("characters that would break the XML are escaped, not dropped", async () => {
  const file = path.join(os.tmpdir(), `forge-esc-${process.pid}.docx`);
  fs.writeFileSync(file, D.docx([{ text: 'Tom & Jerry <script> "quoted"' }]));
  try {
    const read = await extract.readAttachment(file);
    assert.match(read.text, /Tom & Jerry/);
    assert.match(read.text, /<script>/, "the angle brackets survive as text");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("CSV quotes exactly the cells that need it", () => {
  const out = D.csv([
    ["name", "note", "amount"],
    ["Plain", "no commas here", "10"],
    ["Comma", "a, b", "20"],
    ["Quote", 'he said "hi"', "30"],
    ["Newline", "line one\nline two", "40"],
    ["Empty", "", null],
  ]);
  const lines = out.split("\r\n");
  assert.equal(lines[1], "Plain,no commas here,10", "nothing is quoted without cause");
  assert.equal(lines[2], 'Comma,"a, b",20');
  assert.equal(lines[3], 'Quote,"he said ""hi""",30', "inner quotes are doubled");
  assert.ok(out.includes('"line one\nline two"'), "a newline is kept inside quotes");
  assert.equal(lines[lines.length - 1], "Empty,,", "null and empty both become empty cells");
});

test("markdown becomes headings, bullets and paragraphs", () => {
  const b = D.blocksFromMarkdown("# Title\n## Sub\n- one\n- two\nPlain **bold** text\n");
  assert.deepEqual(b[0], { text: "Title", heading: 1 });
  assert.deepEqual(b[1], { text: "Sub", heading: 2 });
  assert.deepEqual(b[2], { text: "one", bullet: true });
  assert.equal(b[4].text, "Plain bold text", "markdown emphasis is not left as asterisks");
});

test("the HTML document is a complete page with its list structure intact", () => {
  const html = D.htmlDocument("Report", D.blocksFromMarkdown("# Report\n- a\n- b\n\nEnd.\n"));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Report<\/title>/);
  assert.match(html, /<h1>Report<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/, "bullets are wrapped in one list");
  assert.match(html, /<p>End\.<\/p>/);
});

test("a title or body that contains HTML cannot inject markup into the page", () => {
  const html = D.htmlDocument('<img src=x onerror=alert(1)>', [{ text: "<script>alert(2)</script>" }]);
  assert.ok(!html.includes("<img src=x"), "the title is escaped");
  assert.ok(!html.includes("<script>alert(2)"), "the body is escaped");
  assert.match(html, /&lt;script&gt;/);
});
