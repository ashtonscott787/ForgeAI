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
  const id = crypto.randomBytes(16).toString("hex");
  if (pages.size >= MAX_PAGES) pages.delete(pages.keys().next().value);
  pages.set(id, html);
  return { id, url: `${SCHEME}://${id}/` };
}

function forget(id) {
  if (typeof id === "string") pages.delete(id);
}

/** The response for a preview request: the page, or nothing for an unknown id. */
function respond(url) {
  let id;
  try { id = new URL(url).hostname; } catch { return { status: 404, headers: {}, body: "" }; }
  const html = pages.get(id);
  if (html === undefined) return { status: 404, headers: {}, body: "" };
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: html,
  };
}

module.exports = { SCHEME, APP_CSP, PREVIEW_CSP, register, forget, respond, MAX_BYTES, MAX_PAGES };
