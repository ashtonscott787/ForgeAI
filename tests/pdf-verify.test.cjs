// The PDF generator needs Electron, which this environment does not have, so
// scripts/verify-pdf.cjs exists to prove it on the target machine. What CAN be
// proved here is that the script's check is not vacuous: a PDF with known text
// is built by hand and read back with the same library the script uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

async function textOf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  let out = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    out += content.items.map((i) => i.str).join(" ") + "\n";
  }
  return { text: out, pages: doc.numPages };
}

test("the verification method reads text back out of a real PDF", async () => {
  const file = path.join(os.tmpdir(), `forge-pdfcheck-${process.pid}.pdf`);
  fs.writeFileSync(file, tinyPdf("Forge AI PDF verification"));
  try {
    assert.equal(fs.readFileSync(file).subarray(0, 5).toString("latin1"), "%PDF-");
    const { text, pages } = await textOf(file);
    assert.equal(pages, 1);
    assert.match(text, /Forge AI PDF verification/, "the words that went in come back out");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the check fails on a file that is not a PDF, so a pass means something", async () => {
  const file = path.join(os.tmpdir(), `forge-notpdf-${process.pid}.pdf`);
  fs.writeFileSync(file, "this is plainly not a PDF");
  try {
    assert.notEqual(fs.readFileSync(file).subarray(0, 5).toString("latin1"), "%PDF-");
    await assert.rejects(() => textOf(file), "pdf.js refuses it");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the check notices when the expected text is absent", async () => {
  const file = path.join(os.tmpdir(), `forge-wrongtext-${process.pid}.pdf`);
  fs.writeFileSync(file, tinyPdf("Something else entirely"));
  try {
    const { text } = await textOf(file);
    assert.ok(!text.includes("Forge AI PDF verification"), "a PDF without the passage does not pass the check");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the PDF window allows the JavaScript printToPDF needs", () => {
  // Disabling JavaScript here aborts with DisallowJavascriptExecutionScope,
  // because printToPDF drives printing through the renderer. This is the bug
  // that stopped PDF generation working at all.
  const { PDF_WINDOW, PDF_OPTIONS } = require("../electron/documents.cjs");
  assert.equal(PDF_WINDOW.webPreferences.javascript, undefined, "JavaScript is not switched off");
  assert.equal(PDF_WINDOW.webPreferences.offscreen, undefined, "offscreen is not used with printToPDF");
  assert.equal(PDF_WINDOW.show, false, "the window stays hidden");
  assert.equal(PDF_WINDOW.webPreferences.sandbox, true, "the renderer is still sandboxed");
  assert.equal(PDF_WINDOW.webPreferences.nodeIntegration, false, "and has no Node");
  assert.equal(PDF_OPTIONS.printBackground, true);
});

test("the app and the verification script print with the same settings", () => {
  // A script that verified different options would prove nothing about the app.
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-pdf.cjs"), "utf8");
  for (const src of [main, script]) {
    assert.match(src, /PDF_WINDOW/, "both take the window options from one place");
    assert.match(src, /PDF_OPTIONS/, "and the print options too");
    assert.ok(!/javascript:\s*false/.test(src), "neither disables JavaScript");
  }
});

test("the verification script exists and is runnable with Electron", () => {
  const p = path.join(__dirname, "..", "scripts", "verify-pdf.cjs");
  assert.ok(fs.existsSync(p), "the script is in the repository");
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /printToPDF/, "it uses Electron's own print engine");
  assert.match(src, /pdfjs-dist/, "and reads the result back rather than trusting it");
  assert.match(src, /npx electron scripts\/verify-pdf\.cjs/, "it documents how to run it");
});
