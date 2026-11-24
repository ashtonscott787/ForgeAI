// Every colour the stylesheet asks for has to exist.
//
// This is here because of a real defect: the workspace menu used
// var(--bg-raised, var(--bg)), neither of which was ever a token in this
// file, so the fallback chain ended in nothing and the menu rendered with no
// background — the sidebar showed straight through the text. Four other
// names were in the same state (--accent, --bad, --muted, --card); they had
// hard-coded literals at the end of the chain, so they drew something, but
// the same literal in both themes, which is how a light-mode panel ends up
// with a dark-mode border.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/** Set from React with an inline style, so they are never in the stylesheet. */
const FROM_JS = new Set(["--lanes", "--lane", "--i", "--pane-w"]);

test("no rule asks for a custom property that does not exist", () => {
  const missing = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!defined.has(m[1]) && !FROM_JS.has(m[1])) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [], "undefined custom properties");
});

test("every colour token is defined for both themes", () => {
  const root = css.slice(css.indexOf(":root{"), css.indexOf('[data-theme="light"]'));
  const light = css.slice(css.indexOf('[data-theme="light"]{'));
  const lightBlock = light.slice(0, light.indexOf("\n}"));
  const names = (block) => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const inDark = names(root);
  const inLight = names(lightBlock);

  // Tokens that are not colours — geometry, timing, fonts, icons — are
  // defined once and are the same in both themes on purpose.
  const shared = /^--(r|r-lg|r-xl|r-pill|measure|gutter|ease|ease-out|ease-spring|t|t-fast|t-slow|ic-|serif|font|mono)/;
  const onlyDark = [...inDark].filter((n) => !inLight.has(n) && !shared.test(n));
  assert.deepEqual(onlyDark, [], "these have a dark value and no light one");
});

test("a fallback is never the only thing holding a colour up", () => {
  // var(--x, #hex) is fine where --x exists: the fallback is dead code. It is
  // not fine as the actual source of the colour, because it cannot change
  // with the theme. Checked by making sure every name used with a literal
  // fallback is also a real token.
  const withLiteral = [...css.matchAll(/var\((--[a-z0-9-]+)\s*,\s*(#|rgba?\()/g)];
  const unbacked = [...new Set(withLiteral.map((m) => m[1]).filter((n) => !defined.has(n) && !FROM_JS.has(n)))];
  assert.deepEqual(unbacked, [], "these only ever draw their fallback, in both themes");
});
