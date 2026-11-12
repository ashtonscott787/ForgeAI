/**
 * Multipage websites written by a model, checked before they are shown.
 *
 * A model writes each page as its own fenced html block. The file name comes
 * from the block's info string (```html about.html) or from a comment on the
 * first line (<!-- file: about.html -->). When neither says, the first page
 * becomes index.html and the rest are numbered — guessing a name from the
 * content would produce links that do not match.
 *
 * Every internal link is then resolved against the files that actually exist,
 * because a site whose nav goes nowhere is the usual failure and the one a
 * person only finds by clicking.
 */
const { zip } = require("./documents.cjs");
const { safeName } = require("./preview.cjs");

const FENCE = /```([A-Za-z0-9_.\-]*)[ \t]*([^\n]*)\n([\s\S]*?)```/g;

/** Pulls the pages and assets out of a reply. */
function parseSite(reply) {
  const files = {};
  let page = 0;
  for (const m of String(reply ?? "").matchAll(FENCE)) {
    const lang = (m[1] || "").toLowerCase();
    const info = (m[2] || "").trim();
    const body = m[3] ?? "";
    if (!["html", "css", "js", "javascript"].includes(lang)) continue;

    let name = safeName(info.replace(/^["'`]|["'`]$/g, ""));
    if (!name) {
      const comment = body.match(/^\s*(?:<!--|\/\*|\/\/)\s*file:\s*([^\s*>-]+)/i);
      if (comment) name = safeName(comment[1]);
    }
    if (!name) {
      if (lang === "css") name = "styles.css";
      else if (lang === "js" || lang === "javascript") name = "script.js";
      else name = page === 0 ? "index.html" : `page-${page + 1}.html`;
    }
    if (!/\.[a-z0-9]+$/i.test(name)) name += lang === "css" ? ".css" : lang === "html" ? ".html" : ".js";
    if (name.endsWith(".html")) page++;
    // A repeated name means the later block is a correction of the earlier one.
    files[name] = body.replace(/^\s*(?:<!--|\/\*|\/\/)\s*file:[^\n]*\n/i, "");
  }
  return files;
}

const isExternal = (href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.startsWith("#");

/** Every href and src a page points at, in order. */
function linksIn(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]);
  return out;
}

/**
 * Checks internal links against the files present. Returns what is broken and
 * what is unreachable, so both kinds of mistake are reported rather than one.
 */
function validateSite(files) {
  const names = new Set(Object.keys(files));
  const broken = [];
  const linked = new Set();
  for (const [from, body] of Object.entries(files)) {
    if (!from.endsWith(".html")) continue;
    for (const href of linksIn(body)) {
      if (isExternal(href)) continue;
      const target = safeName(href.split("#")[0].split("?")[0]);
      if (!target) continue;
      linked.add(target);
      if (!names.has(target)) broken.push({ from, href, target });
    }
  }
  const pages = [...names].filter((n) => n.endsWith(".html"));
  const orphans = pages.filter((p) => p !== "index.html" && !linked.has(p));
  return {
    ok: broken.length === 0,
    pages: pages.length,
    files: names.size,
    broken,
    orphans,
    hasIndex: names.has("index.html"),
  };
}

/** A one-line summary a person can act on. */
function describe(report) {
  if (!report.files) return "No website files were found in that reply.";
  const bits = [`${report.pages} page${report.pages === 1 ? "" : "s"}`];
  if (report.files > report.pages) bits.push(`${report.files - report.pages} other file${report.files - report.pages === 1 ? "" : "s"}`);
  const head = bits.join(", ");
  if (report.broken.length) {
    const first = report.broken.slice(0, 3).map((b) => `${b.from} → ${b.href}`).join(", ");
    return `${head}. ${report.broken.length} broken link${report.broken.length === 1 ? "" : "s"}: ${first}${report.broken.length > 3 ? "…" : ""}`;
  }
  if (report.orphans.length) return `${head}. Nothing links to ${report.orphans.join(", ")}.`;
  return `${head}, every internal link resolves.`;
}

/** The site as a ZIP, ready to save. */
const siteZip = (files) => zip(Object.entries(files).map(([name, data]) => ({ name, data })));

module.exports = { parseSite, validateSite, describe, linksIn, isExternal, siteZip };
