/**
 * Proves PDF generation actually works, on a machine that has Electron.
 *
 * This environment has no Electron, so the PDF path in Forge AI has never been
 * executed here. Rather than claim it works, this script makes the claim
 * testable on the target machine: it renders a document, writes it, reopens it
 * with pdf.js — the same library the app uses to read PDFs people attach — and
 * checks that the words that went in come back out.
 *
 * Run it from the project root:
 *
 *   npx electron scripts/verify-pdf.cjs
 *
 * It exits 0 when the PDF is real and readable, and non-zero with a reason
 * otherwise. Nothing is written outside a temporary directory.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const documents = require("../electron/documents.cjs");

const MARKERS = [
  "Forge AI PDF verification",
  "The quick brown fox jumps over the lazy dog",
  "Second heading",
  "A bullet that must survive",
];

const SOURCE = [
  `# ${MARKERS[0]}`,
  "",
  MARKERS[1],
  "",
  `## ${MARKERS[2]}`,
  "",
  `- ${MARKERS[3]}`,
  "- Another bullet",
].join("\n");

async function render(html) {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ printBackground: true, margins: { marginType: "default" } });
  } finally {
    try { w.destroy(); } catch { /* already gone */ }
  }
}

/** Reads the PDF back with pdf.js and returns its text. */
async function textOf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  let out = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str).join(" ") + "\n";
  }
  return { text: out, pages: doc.numPages };
}

const fail = (why) => { console.error(`FAIL: ${why}`); app.exit(1); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pdf-"));
  const file = path.join(dir, "verification.pdf");
  try {
    const blocks = documents.blocksFromMarkdown(SOURCE);
    const pdf = await render(documents.htmlDocument(MARKERS[0], blocks));
    fs.writeFileSync(file, pdf);

    const bytes = fs.statSync(file).size;
    if (bytes < 1000) return fail(`the PDF is only ${bytes} bytes, which is too small to contain this document`);

    const head = fs.readFileSync(file).subarray(0, 5).toString("latin1");
    if (head !== "%PDF-") return fail(`the file does not begin with %PDF- (got ${JSON.stringify(head)})`);

    const { text, pages } = await textOf(file);
    const missing = MARKERS.filter((m) => !text.replace(/\s+/g, " ").includes(m));
    if (missing.length) return fail(`the PDF opened, but this text did not come back: ${missing.join(" | ")}`);

    console.log("PASS: PDF generation verified");
    console.log(`  file     ${file}`);
    console.log(`  bytes    ${bytes}`);
    console.log(`  pages    ${pages}`);
    console.log(`  checked  ${MARKERS.length} passages read back with pdf.js`);
    console.log(`  electron ${process.versions.electron}`);
    app.exit(0);
  } catch (e) {
    fail(e instanceof Error ? e.stack || e.message : String(e));
  }
});
