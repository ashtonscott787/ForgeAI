/**
 * Reads the text out of a PDF, in a process of its own.
 *
 * pdf.js runs here rather than inside Forge AI because on macOS it brings down
 * the whole Electron main process with SIGSEGV. That was found by the release
 * check in CI, which rendered a PDF and then tried to read it back: the read
 * killed the process outright, with no exception to catch. A PDF someone
 * attached would have done the same to the app.
 *
 * So it is kept out here. A crash costs the attachment, which is reported as a
 * file that could not be read, instead of costing the user their session.
 *
 * Usage:  node electron/pdf-text.cjs <file.pdf>
 *
 * Writes {"pages":[{"page":1,"text":"…"}]} to stdout, or {"error":"…"}, and
 * exits non-zero on failure. It reads one file and writes nothing.
 */
const fs = require("node:fs");

// pdf.js reports things like "Cannot polyfill DOMMatrix" with console.log, as
// soon as it is imported. stdout here carries one JSON document and nothing
// else, so everything written for a human is redirected to stderr for the
// whole of this script's life. The result is written with process.stdout.
console.log = (...a) => console.error(...a);

async function pagesOf(filePath) {
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

module.exports = { pagesOf };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    process.stdout.write(JSON.stringify({ error: "no file given" }));
    process.exit(2);
  }
  pagesOf(file).then(
    (pages) => process.stdout.write(JSON.stringify({ pages })),
    (e) => {
      process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      process.exit(1);
    },
  );
}
