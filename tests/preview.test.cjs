// Run with: pnpm test. Content-Security-Policy and generated-page isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { APP_CSP, PREVIEW_CSP, register, forget, respond, SCHEME, MAX_BYTES, MAX_PAGES } = require("../electron/preview.cjs");

const directive = (csp, name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "");

test("the app policy blocks inline and eval script everywhere", () => {
  assert.equal(directive(APP_CSP, "script-src"), "script-src 'self'");
  assert.doesNotMatch(APP_CSP, /unsafe-eval/);
  assert.match(APP_CSP, /object-src 'none'/);
  assert.match(APP_CSP, /base-uri 'none'/);
});

test("the app policy lets frames load only generated pages", () => {
  assert.equal(directive(APP_CSP, "frame-src"), `frame-src ${SCHEME}:`);
});

test("a generated page's policy allows its own inline code and nothing else", () => {
  assert.match(PREVIEW_CSP, /connect-src 'none'/, "no network");
  assert.match(PREVIEW_CSP, /default-src 'none'/);
  assert.match(PREVIEW_CSP, /frame-src 'none'/);
  assert.match(PREVIEW_CSP, /form-action 'none'/);
  assert.doesNotMatch(PREVIEW_CSP, /https?:|\*/, "no remote origins or wildcards");
});

test("a registered page is served with the preview policy under an unguessable address", () => {
  const { id, url } = register("<p>hi</p>");
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(url, `${SCHEME}://${id}/`);
  const r = respond(url);
  assert.equal(r.status, 200);
  assert.equal(r.body, "<p>hi</p>");
  assert.equal(r.headers["Content-Security-Policy"], PREVIEW_CSP);
  forget(id);
  assert.equal(respond(url).status, 404, "a forgotten page is no longer served");
});

test("unknown and malformed addresses get nothing", () => {
  assert.equal(respond(`${SCHEME}://deadbeef/`).status, 404);
  assert.equal(respond("not a url").status, 404);
});

test("oversized pages and empty input are refused", () => {
  assert.throws(() => register("x".repeat(MAX_BYTES + 1)), /too large/);
  assert.throws(() => register(""), /no page/);
  assert.throws(() => register(42), /no page/);
});

test("the store is bounded", () => {
  const ids = [];
  for (let i = 0; i < MAX_PAGES + 5; i++) ids.push(register(`<i>${i}</i>`).id);
  assert.equal(respond(`${SCHEME}://${ids[0]}/`).status, 404, "the oldest page was evicted");
  assert.equal(respond(`${SCHEME}://${ids.at(-1)}/`).status, 200);
});

test("the policy in index.html is identical to the one in code", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");
  const m = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(m, "index.html carries a CSP meta tag");
  assert.equal(m[1], APP_CSP);
});
