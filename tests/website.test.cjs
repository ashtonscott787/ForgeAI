// Multipage websites. The link check is the point: a site whose navigation goes
// nowhere is the usual failure, and the one a person only finds by clicking.
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../electron/website.cjs");
const preview = require("../electron/preview.cjs");
const extract = require("../electron/extract.cjs");

const REPLY = [
  "Here is the site.",
  "",
  "```html index.html",
  '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>',
  '<body><nav><a href="index.html">Home</a><a href="about.html">About</a></nav><h1>Home</h1></body></html>',
  "```",
  "",
  "```html about.html",
  '<!doctype html><html><body><nav><a href="index.html">Home</a></nav><h1>About</h1></body></html>',
  "```",
  "",
  "```css",
  "body { font-family: system-ui; }",
  "```",
].join("\n");

test("each page becomes its own file, named as the reply said", () => {
  const files = W.parseSite(REPLY);
  assert.deepEqual(Object.keys(files).sort(), ["about.html", "index.html", "styles.css"]);
  assert.match(files["index.html"], /<h1>Home<\/h1>/);
  assert.match(files["styles.css"], /font-family/);
});

test("a file name given as a comment is used", () => {
  const files = W.parseSite("```html\n<!-- file: contact.html -->\n<h1>Contact</h1>\n```");
  assert.deepEqual(Object.keys(files), ["contact.html"]);
  assert.ok(!files["contact.html"].includes("file: contact.html"), "the marker is not left in the page");
});

test("unnamed pages are numbered rather than guessed at", () => {
  const files = W.parseSite("```html\n<h1>One</h1>\n```\n```html\n<h1>Two</h1>\n```");
  assert.deepEqual(Object.keys(files), ["index.html", "page-2.html"]);
});

test("a site whose links all resolve is reported as sound", () => {
  const r = W.validateSite(W.parseSite(REPLY));
  assert.equal(r.ok, true);
  assert.equal(r.pages, 2);
  assert.equal(r.files, 3);
  assert.equal(r.hasIndex, true);
  assert.deepEqual(r.broken, []);
  assert.match(W.describe(r), /every internal link resolves/);
});

test("a broken internal link is found and named", () => {
  const files = W.parseSite('```html index.html\n<a href="missing.html">Gone</a>\n```');
  const r = W.validateSite(files);
  assert.equal(r.ok, false);
  assert.equal(r.broken.length, 1);
  assert.deepEqual(r.broken[0], { from: "index.html", href: "missing.html", target: "missing.html" });
  assert.match(W.describe(r), /broken link/);
  assert.match(W.describe(r), /index\.html → missing\.html/);
});

test("a page nothing links to is reported, because it cannot be reached", () => {
  const files = W.parseSite('```html index.html\n<h1>Home</h1>\n```\n```html hidden.html\n<h1>Hidden</h1>\n```');
  const r = W.validateSite(files);
  assert.equal(r.ok, true, "nothing is broken");
  assert.deepEqual(r.orphans, ["hidden.html"], "but it is unreachable");
  assert.match(W.describe(r), /Nothing links to hidden\.html/);
});

test("external links, anchors and mailto are not treated as broken", () => {
  for (const href of ["https://example.com", "//cdn.example.com/a.js", "#section", "mailto:a@b.com", "tel:123"]) {
    assert.equal(W.isExternal(href), true, `${href} is external`);
  }
  const r = W.validateSite(W.parseSite('```html index.html\n<a href="https://example.com">x</a><a href="#top">y</a>\n```'));
  assert.deepEqual(r.broken, []);
});

test("a link with a query or anchor still resolves to its page", () => {
  const files = W.parseSite('```html index.html\n<a href="about.html#team">Team</a>\n```\n```html about.html\n<h1>About</h1>\n```');
  assert.deepEqual(W.validateSite(files).broken, []);
});

test("a page cannot name itself outside the site", () => {
  const files = W.parseSite('```html ../../etc/passwd\n<h1>no</h1>\n```');
  assert.ok(!Object.keys(files).some((n) => n.includes("..")), "no escaping name survives");
});

test("the exported ZIP is a real archive containing every file", () => {
  const files = W.parseSite(REPLY);
  const entries = extract.zipEntries(W.siteZip(files));
  assert.deepEqual([...entries.keys()].sort(), ["about.html", "index.html", "styles.css"]);
  assert.match(entries.get("about.html")().toString("utf8"), /<h1>About<\/h1>/);
});

test("the preview serves every page, so internal links actually work", () => {
  const files = W.parseSite(REPLY);
  const { id } = preview.registerSite(files);
  const home = preview.respond(`forge-preview://${id}/`);
  assert.equal(home.status, 200);
  assert.match(home.body, /<h1>Home<\/h1>/, "the root serves index.html");

  const about = preview.respond(`forge-preview://${id}/about.html`);
  assert.equal(about.status, 200);
  assert.match(about.body, /<h1>About<\/h1>/, "following the nav link reaches the other page");

  const css = preview.respond(`forge-preview://${id}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers["Content-Type"], /text\/css/, "the stylesheet is served as CSS");
});

test("a link to a page that is not there says so, rather than showing nothing", () => {
  const { id } = preview.registerSite({ "index.html": "<h1>Home</h1>" });
  const missing = preview.respond(`forge-preview://${id}/nope.html`);
  assert.equal(missing.status, 404);
  assert.match(missing.body, /No page called nope\.html/);
  assert.match(missing.body, /index\.html/, "it lists what the site does have");
});

test("one site cannot read another, and no page can escape its site", () => {
  const a = preview.registerSite({ "index.html": "<h1>A</h1>", "secret.html": "<h1>secret</h1>" });
  const b = preview.registerSite({ "index.html": "<h1>B</h1>" });
  assert.equal(preview.respond(`forge-preview://${b.id}/secret.html`).status, 404, "B cannot see A's page");
  assert.equal(preview.respond(`forge-preview://${a.id}/../../etc/passwd`).status, 404);
  assert.equal(preview.respond(`forge-preview://${a.id}/secret.html`).status, 200, "its own page is fine");
});
