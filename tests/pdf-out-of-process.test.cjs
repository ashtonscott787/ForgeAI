// pdf.js must not run inside the Electron main process. On macOS it ends that
// process with SIGSEGV — no exception, no handler, the app simply disappears —
// which the release check in CI found by rendering a PDF and reading it back.
// A PDF someone attached would have done the same thing.
//
// So the reading happens in a process of its own. These tests hold that line:
// the text still comes back, and when the reader dies the app is told the
// attachment could not be read instead of dying with it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const READER = path.join(__dirname, "..", "electron", "pdf-text.cjs");
const { readAttachment } = require("../electron/extract.cjs");

/** A minimal, valid PDF containing one line of text. */
function tinyPdf(text) {
  const content = `BT /F1 18 Tf 40 150 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function withFile(bytes, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forge-pdfoop-")), "doc.pdf");
  fs.writeFileSync(file, bytes);
  return Promise.resolve(fn(file)).finally(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
}

test("an attached PDF is read, and its text comes back", async () => {
  await withFile(tinyPdf("A bullet that must survive"), async (file) => {
    const read = await readAttachment(file);
    assert.equal(read.kind, "pdf");
    assert.equal(read.readable, true, read.note);
    assert.equal(read.pages, 1);
    assert.match(read.text, /A bullet that must survive/);
  });
});

test("extract.cjs does not import pdf.js itself", () => {
  // The whole point: this module runs in the Electron main process, so a
  // require of pdf.js here would put the crash back where it was.
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "extract.cjs"), "utf8");
  assert.ok(!/require\(\s*["']pdfjs-dist/.test(src), "no require of pdf.js");
  assert.ok(!/import\(\s*["']pdfjs-dist/.test(src), "and no dynamic import either");
  assert.match(src, /pdf-text\.cjs/, "it spawns the separate reader instead");
});

test("the reader is spawned as a child process, not called in-process", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "extract.cjs"), "utf8");
  assert.match(src, /spawn\(\s*process\.execPath/, "started with this runtime's own binary");
  assert.match(src, /ELECTRON_RUN_AS_NODE/, "which Electron needs in order to behave as node");
});

test("the reader prints nothing but JSON on stdout", async () => {
  // pdf.js announces missing polyfills with console.log the moment it loads.
  // On stdout those lines sit in front of the result and nothing parses.
  const { execFileSync } = require("node:child_process");
  await withFile(tinyPdf("Only JSON please"), (file) => {
    const out = execFileSync(process.execPath, [READER, file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const parsed = JSON.parse(out);
    assert.equal(parsed.pages[0].text, "Only JSON please");
  });
});

test("a file that is not a PDF is reported, not thrown through the app", async () => {
  await withFile(Buffer.from("this is plainly not a PDF"), async (file) => {
    const read = await readAttachment(file);
    assert.equal(read.readable, false);
    assert.match(read.note, /could not be read/i);
  });
});

test("the app survives the reader being killed the way pdf.js killed it", async (t) => {
  // Stands in for the SIGSEGV: the reader dies without saying anything. The
  // attachment is lost; the app is not.
  const real = fs.readFileSync(READER);
  t.after(() => fs.writeFileSync(READER, real));
  fs.writeFileSync(READER, 'process.kill(process.pid, "SIGSEGV");\n');
  await withFile(tinyPdf("never read"), async (file) => {
    const read = await readAttachment(file);
    assert.equal(read.readable, false);
    assert.match(read.note, /SIGSEGV/, "and says what happened rather than going quiet");
  });
});
