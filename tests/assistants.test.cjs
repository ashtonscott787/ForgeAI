// The assistants Forge AI ships with.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "assistants.ts"), "utf8");
/** The file with comment wrapping flattened, for matching prose that spans lines. */
const flat = src.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
/** Only the roster itself, so the interface above it is not mistaken for data. */
const roster = src.slice(src.indexOf("export const ASSISTANTS"));
const names = [...src.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
const handles = [...src.matchAll(/handle: "([^"]+)"/g)].map((m) => m[1]);
const addresses = [...src.matchAll(/address: "([^"]+)"/g)].map((m) => m[1]);

test("there are five of them, each distinct", () => {
  assert.equal(names.length, 5);
  assert.equal(new Set(names).size, 5, "no two share a name");
  assert.equal(new Set(handles).size, 5, "nor a handle");
  assert.equal(new Set(addresses).size, 5, "nor an address");
});

test("every handle matches its name, so neither has to be remembered separately", () => {
  for (let i = 0; i < names.length; i++) {
    assert.equal(handles[i], `@${names[i].toLowerCase()}`);
    assert.equal(addresses[i], `${names[i].toLowerCase()}@forge.local`);
  }
});

test("the addresses cannot be mistaken for real mailboxes", () => {
  // .local is reserved and cannot be routed on the internet. Anything else
  // here would look like a mailbox that silently swallows mail.
  for (const a of addresses) assert.match(a, /@forge\.local$/);
  assert.match(flat, /cannot receive mail from the internet/i, "and the file says so");
});

test("the one without a photograph is drawn as initials, not given an invented face", () => {
  const portraits = [...roster.matchAll(/portrait: ([^,\n]+)/g)].map((m) => m[1].trim());
  assert.equal(portraits.filter((p) => p === "null").length, 1, "exactly one has no portrait");
  assert.equal(portraits.filter((p) => p !== "null").length, 4, "and four do");
  assert.match(flat, /inventing a face for a piece of software/i, "the reason is written down");
});

test("each one asks for only the tools its job needs", () => {
  const toolSets = [...src.matchAll(/tools: \[([^\]]*)\]/g)].map((m) =>
    m[1].split(",").map((t) => t.trim().replace(/"/g, "")).filter(Boolean));
  assert.equal(toolSets.length, 5);
  for (const set of toolSets) {
    assert.ok(set.length >= 1 && set.length <= 4, `a narrow set, got ${set.length}`);
    assert.ok(!set.includes("send_email"), "none of them may send mail on its own");
  }
});

test("the one that reads mail is told never to send any", () => {
  const sage = src.slice(src.indexOf('name: "Sage"'));
  assert.match(sage.slice(0, sage.indexOf("},")), /Never send anything/i);
});

test("the portraits are small enough to ship", () => {
  const dir = path.join(__dirname, "..", "src", "assets", "people");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webp"));
  assert.equal(files.length, 4);
  for (const f of files) {
    const bytes = fs.statSync(path.join(dir, f)).size;
    assert.ok(bytes < 40_000, `${f} is ${bytes} bytes, which is more than an avatar needs`);
  }
});

test("nothing in here is written in a language nobody asked for", () => {
  // A stray Cyrillic word got into an instruction once. Em dashes and curly
  // quotes are fine; letters from another script are not.
  const strays = src.match(/[Ѐ-ӿͰ-Ͽ一-鿿]/g);
  assert.equal(strays, null, `found ${strays && strays.join("")}`);
});
