// The palette has to stay readable.
//
// Colours get adjusted by eye, and by eye a muted grey on warm paper looks
// fine right up to the point where someone cannot read it. One of the values
// taken from the reference app measured 2.77:1 against its own background —
// below even the 3:1 allowed for large text. These numbers are the floor.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

/** The tokens declared inside one [data-theme="..."] block. */
function theme(name) {
  const start = CSS.indexOf(`[data-theme="${name}"]{`);
  assert.ok(start >= 0, `the ${name} theme is declared`);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  assert.ok(m, `${v} is a plain six-digit hex colour`);
  return m[1];
};

function luminance(h) {
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// WCAG AA for text at these sizes.
const FLOOR = 4.5;

for (const name of ["dark", "light"]) {
  const t = theme(name);

  test(`${name}: body text is readable on the page it sits on`, () => {
    const r = contrast(t.surface, t.fg);
    assert.ok(r >= 7, `--fg on --surface is ${r.toFixed(2)}:1, wanted at least 7:1`);
  });

  test(`${name}: the two muted greys are readable, not merely visible`, () => {
    for (const token of ["fg-2", "fg-3"]) {
      const r = contrast(t.surface, t[token]);
      assert.ok(r >= FLOOR, `--${token} on --surface is ${r.toFixed(2)}:1, wanted at least ${FLOOR}:1`);
    }
  });

  test(`${name}: a label on the accent colour can be read`, () => {
    // This is the one that catches white-on-terracotta, which looks right and
    // measures about 2.6:1.
    const r = contrast(t.ember, t["on-ember"]);
    assert.ok(r >= FLOOR, `--on-ember on --ember is ${r.toFixed(2)}:1, wanted at least ${FLOOR}:1`);
  });

  test(`${name}: the sidebar is distinguishable from the main area`, () => {
    assert.notEqual(t.sunken, t.surface, "the sidebar and the main area are not the same colour");
  });
}
