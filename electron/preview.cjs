/**
 * Generated web pages, served from their own origin with their own policy.
 *
 * The app window has a strict Content-Security-Policy with no inline scripts.
 * A srcdoc frame inherits that policy, which would block every generated page's
 * JavaScript. So a page is stored here, and the frame loads it from the
 * `forge-preview:` scheme, whose response carries a separate policy. That policy
 * allows the page's own inline script and style, and nothing else: no network,
 * no frames, no forms, no base URL changes.
 */
const crypto = require("node:crypto");

const SCHEME = "forge-preview";
const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 20;

/** The app window: nothing executes from outside the bundle, and nothing reaches the network except the local engine and provider images. */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:*",
  `frame-src ${SCHEME}:`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A generated page: its own inline code runs, and it can reach nothing outside itself. */
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const pages = new Map();

/** Stores a page and returns the URL its frame should load. */
function register(html) {
  if (typeof html !== "string" || html.length === 0) throw new Error("There is no page to show.");
  if (Buffer.byteLength(html) > MAX_BYTES) throw new Error("That page is too large to preview.");
  return registerSite({ "index.html": html });
}

/**
 * Stores a whole site, so a link from one page to another resolves inside the
 * frame instead of dying. Without this a multipage site can be generated but
 * never walked through, which is the only way to find out it is wrong.
 *
 * Names are flattened to a safe relative path: no leading slash, no "..", no
 * backslashes. A page cannot reach outside its own site, and one site cannot
 * reach another.
 */
function registerSite(files) {
  const entries = Object.entries(files || {});
  if (!entries.length) throw new Error("There is no page to show.");
  const clean = new Map();
  let total = 0;
  for (const [rawName, content] of entries) {
    const name = safeName(rawName);
    if (!name) continue;
    const body = String(content ?? "");
    total += Buffer.byteLength(body);
    if (total > MAX_BYTES) throw new Error("That site is too large to preview.");
    clean.set(name, body);
  }
  if (!clean.size) throw new Error("There is no page to show.");
  if (!clean.has("index.html")) {
    // Something has to answer the root, or the frame opens on nothing.
    const first = [...clean.keys()].find((n) => n.endsWith(".html"));
    if (first) clean.set("index.html", clean.get(first));
  }
  const id = crypto.randomBytes(16).toString("hex");
  if (pages.size >= MAX_PAGES) pages.delete(pages.keys().next().value);
  pages.set(id, clean);
  return { id, url: `${SCHEME}://${id}/`, files: [...clean.keys()] };
}

/** A relative path with no way out of the site. */
function safeName(raw) {
  const n = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!n || n.includes("..") || n.startsWith("/")) return "";
  return n.split("/").filter(Boolean).join("/");
}

const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
};

function forget(id) {
  if (typeof id === "string") pages.delete(id);
}

/** The response for a preview request: the page, or nothing for an unknown id. */
function respond(url) {
  let id;
  let file = "index.html";
  try {
    const u = new URL(url);
    id = u.hostname;
    const p = safeName(decodeURIComponent(u.pathname));
    if (p) file = p;
  } catch { return { status: 404, headers: {}, body: "" }; }
  const site = pages.get(id);
  if (site === undefined) return { status: 404, headers: {}, body: "" };
  const html = site.get(file);
  if (html === undefined) {
    return {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PREVIEW_CSP },
      // A broken internal link is a fact about the site, so it is shown rather than hidden.
      body: `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:2em">
<h1>No page called ${file.replace(/[<&]/g, "")}</h1>
<p>This site has: ${[...site.keys()].map((k) => k.replace(/[<&]/g, "")).join(", ")}</p></body>`,
    };
  }
  const ext = (file.split(".").pop() || "html").toLowerCase();
  return {
    status: 200,
    headers: {
      "Content-Type": TYPES[ext] || "text/plain; charset=utf-8",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: html,
  };
}

module.exports = { SCHEME, APP_CSP, PREVIEW_CSP, register, registerSite, forget, respond, safeName, MAX_BYTES, MAX_PAGES };
