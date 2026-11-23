// Workspaces separate chats. What matters is that nothing falls between two
// of them, and that the claims made on screen are true of the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "src", "lib", "spaces.ts"));

test("a chat with no workspace recorded is in Personal", async () => {
  const { spaceOf, inSpace, PERSONAL } = await load();
  assert.equal(spaceOf({}), PERSONAL.id);
  assert.equal(spaceOf({ space: "work" }), "work");
  const list = [{ id: 1 }, { id: 2, space: "work" }, { id: 3, space: PERSONAL.id }];
  assert.deepEqual(inSpace(list, PERSONAL.id).map((c) => c.id), [1, 3]);
  assert.deepEqual(inSpace(list, "work").map((c) => c.id), [2]);
});

test("every chat is in exactly one workspace, so none can be lost", async () => {
  const { inSpace, spaceOf } = await load();
  const list = [{ id: 1 }, { id: 2, space: "work" }, { id: 3, space: "studio" }];
  const ids = [...new Set(list.map(spaceOf))];
  const seen = ids.flatMap((id) => inSpace(list, id).map((c) => c.id)).sort();
  assert.deepEqual(seen, [1, 2, 3]);
});

test("a name becomes a readable id, and never collides", async () => {
  const { idFor } = await load();
  assert.equal(idFor("Work Stuff", []), "work-stuff");
  assert.equal(idFor("  Ash & Co.  ", []), "ash-co");
  assert.equal(idFor("Work", ["work"]), "work-2");
  assert.equal(idFor("Work", ["work", "work-2"]), "work-3");
  assert.equal(idFor("!!!", []), "space", "a name with nothing usable in it still gets an id");
});

test("Personal survives a stored list that does not mention it", async () => {
  const { loadSpaces, PERSONAL } = await load();
  const store = { "forge.spaces.v1": JSON.stringify([{ id: "work", name: "Work", accent: "#000" }]) };
  global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
  };
  try {
    const list = loadSpaces();
    assert.equal(list[0].id, PERSONAL.id, "and it is first");
    assert.deepEqual(list.map((s) => s.id), [PERSONAL.id, "work"]);
  } finally {
    delete global.localStorage;
  }
});

test("rubbish in storage gives Personal rather than an empty sidebar", async () => {
  const { loadSpaces, PERSONAL } = await load();
  global.localStorage = { getItem: () => "{not json", setItem: () => {} };
  try {
    assert.deepEqual(loadSpaces(), [PERSONAL]);
  } finally {
    delete global.localStorage;
  }
});

test("a new workspace gets an unused id and one of the offered colours", async () => {
  const { makeSpace, PERSONAL, ACCENTS } = await load();
  const s = makeSpace("Work", [PERSONAL]);
  assert.equal(s.id, "work");
  assert.ok(ACCENTS.includes(s.accent));
  assert.equal(makeSpace("Work", [PERSONAL, s]).id, "work-2");
});

// The interface tells people a workspace is not a lock. That claim has to be
// in the code too, or it is only in a comment nobody reads.
test("deleting a workspace moves its chats rather than deleting them", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const fn = app.slice(app.indexOf("const deleteSpace"), app.indexOf("const deleteChat"));
  assert.match(fn, /space: PERSONAL\.id/, "its chats are moved to Personal");
  assert.doesNotMatch(fn, /setConvos\(\(l\) => l\.filter/, "nothing about it removes conversations");
});

test("the panel does not claim a workspace is private", () => {
  const ui = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SpaceSwitcher.tsx"), "utf8");
  assert.match(ui, /not a lock/i, "it says what it is not");
  assert.doesNotMatch(ui.replace(/\/\*[\s\S]*?\*\//g, ""), /\b(encrypt|private|secure|password-protected)\b/i);
});
