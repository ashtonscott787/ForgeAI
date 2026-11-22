// A picture for an agent: what is accepted, and what is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const agents = require("../electron/agents.cjs");

const url = (type, n) => `data:image/${type};base64,${"A".repeat(n)}`;

test("a png, jpeg or webp portrait is kept", () => {
  for (const t of ["png", "jpeg", "webp"]) {
    assert.ok(agents.validateAgent({ name: "x", portrait: url(t, 200) }).portrait.length > 0, t);
  }
});

test("an SVG is refused, because it is a document that can carry script", () => {
  assert.equal(agents.validateAgent({ name: "x", portrait: "data:image/svg+xml;base64,AAAA" }).portrait, "");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "electron", "agents.cjs"), "utf8"),
    /SVG is excluded on purpose/i, "and the reason is written down");
});

test("anything that is not a data URL at all is refused", () => {
  for (const bad of ["https://example.com/a.png", "javascript:alert(1)", "data:text/html;base64,AAA", "../../etc/passwd"]) {
    assert.equal(agents.validateAgent({ name: "x", portrait: bad }).portrait, "", bad);
  }
});

test("a photograph-sized picture is refused rather than quietly shrunk", () => {
  const huge = url("png", 400_000);
  assert.equal(agents.validateAgent({ name: "x", portrait: huge }).portrait, "");
});

test("an agent without a picture simply has none", () => {
  assert.equal(agents.validateAgent({ name: "x" }).portrait, "");
});

test("the picture travels with the agent when it is exported", () => {
  // It is a field on the record, not a file beside it.
  const a = agents.validateAgent({ name: "x", portrait: url("webp", 100) });
  assert.ok(Object.prototype.hasOwnProperty.call(a, "portrait"));
  assert.ok(JSON.stringify(a).includes("data:image/webp"));
});

test("the shrinker crops square and targets an avatar, not a photograph", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "avatar.ts"), "utf8");
  assert.match(src, /SIDE = 128/, "twice the size it is drawn at");
  assert.match(src, /Centre-crop to a square/i, "a portrait photograph is not squashed");
  assert.match(src, /MAX_INPUT_BYTES/, "and an absurd input is refused before it is decoded");
});
