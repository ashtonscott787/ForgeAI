// Run with: pnpm test. IPC sender rule, no Electron needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { isTrustedSender } = require("../electron/trust.cjs");

const index = path.join("/app", "dist", "index.html");
const appUrl = pathToFileURL(index).href;
const frame = (url, parent = null) => ({ url, parent });

test("the app's own page is trusted", () => {
  assert.equal(isTrustedSender({ senderFrame: frame(appUrl) }, index), true);
});

test("a remote page, a web frame, or a different local file is refused", () => {
  assert.equal(isTrustedSender({ senderFrame: frame("https://evil.example/") }, index), false);
  assert.equal(isTrustedSender({ senderFrame: frame(appUrl + "?x=1#/../..") }, index), false);
  assert.equal(isTrustedSender({ senderFrame: frame(pathToFileURL("/app/other.html").href) }, index), false);
  assert.equal(isTrustedSender({ senderFrame: frame(appUrl, { url: appUrl }) }, index), false, "nested frame refused");
  assert.equal(isTrustedSender({ senderFrame: null }, index), false);
  assert.equal(isTrustedSender({}, index), false);
});
