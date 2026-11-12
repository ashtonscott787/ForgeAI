// Knowledge packs: your own material, chunked, ranked and shareable.
// Imported packs come from other people, so the import path is tested as
// hostile input rather than as a happy path.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../electron/knowledge.cjs");

const DOC_BIKE = `Derailleur adjustment.
The limit screws set how far the derailleur can travel. The H screw sets the
highest gear and the L screw the lowest. If the chain falls off the cassette
into the spokes, the L screw is too loose.

Cable tension is set with the barrel adjuster. Turning it anticlockwise adds
tension, which moves the chain towards larger sprockets.`;

const DOC_BREAD = `Sourdough starter.
Feed a starter with equal weights of flour and water, once a day at room
temperature. A starter that smells of acetone is hungry and wants feeding more
often. Discard half before each feed, or it grows out of its jar.`;

function packOfTwo() {
  let p = K.emptyPack("Workshop notes", "Mine");
  p = K.addDocument(p, { name: "Bike.md", text: DOC_BIKE });
  p = K.addDocument(p, { name: "Bread.md", text: DOC_BREAD });
  return p;
}

test("a document is split into passages and counted", () => {
  const p = K.addDocument(K.emptyPack("P"), { name: "Bike.md", text: DOC_BIKE });
  assert.equal(p.documents.length, 1);
  assert.equal(p.documents[0].name, "Bike.md");
  assert.ok(p.chunks.length >= 1, "at least one passage");
  assert.equal(p.documents[0].chunks, p.chunks.length, "the count matches the passages kept");
  assert.ok(p.chunks.every((c) => c.doc === p.documents[0].id), "every passage belongs to the document");
});

test("long text is split with overlap, and nothing is lost from the start or end", () => {
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about maintenance and tools.`).join("\n\n");
  const pieces = K.chunk(body, 400, 80);
  assert.ok(pieces.length > 3, "a long document becomes several passages");
  assert.ok(pieces[0].includes("Paragraph 0"), "the beginning is kept");
  assert.ok(pieces[pieces.length - 1].includes("Paragraph 59"), "the end is kept");
  assert.ok(pieces.every((p) => p.length <= 400 + 80), "no passage runs away");
});

test("an empty document is refused rather than stored as nothing", () => {
  assert.throws(() => K.addDocument(K.emptyPack("P"), { name: "x", text: "   " }), /no text/);
});

test("search finds the right document and ignores the other", () => {
  const hits = K.search(packOfTwo(), "which screw stops the chain hitting the spokes", 3);
  assert.ok(hits.length > 0, "something matched");
  assert.equal(hits[0].document, "Bike.md", "the bike note ranks first");
  assert.match(hits[0].text, /L screw/);
});

test("search on the other topic returns the other document", () => {
  const hits = K.search(packOfTwo(), "how often should I feed a starter", 3);
  assert.equal(hits[0].document, "Bread.md");
  assert.match(hits[0].text, /flour and water/);
});

test("a query matching nothing returns nothing, rather than the first passage", () => {
  assert.deepEqual(K.search(packOfTwo(), "quantum chromodynamics lepton", 3), []);
  assert.deepEqual(K.search(packOfTwo(), "", 3), []);
});

test("common words alone do not make a match", () => {
  // Every passage contains "the"; a query of only stop words must find nothing.
  assert.deepEqual(K.search(packOfTwo(), "the and of a with", 3), []);
});

test("the context handed to a model says which document each passage came from", () => {
  const ctx = K.contextFor(packOfTwo(), "barrel adjuster cable tension", 2);
  assert.match(ctx, /From "Bike\.md"/);
  assert.match(ctx, /barrel adjuster/);
});

test("removing a document takes its passages with it", () => {
  const p = packOfTwo();
  const bike = p.documents.find((d) => d.name === "Bike.md");
  const after = K.removeDocument(p, bike.id);
  assert.equal(after.documents.length, 1);
  assert.ok(after.chunks.every((c) => c.doc !== bike.id), "no orphaned passages");
  assert.deepEqual(K.search(after, "L screw spokes", 3).map((h) => h.document).filter((d) => d === "Bike.md"), []);
});

test("a pack survives export and import, and still answers the same question", () => {
  const p = packOfTwo();
  const back = K.importPack(K.exportPack(p));
  assert.equal(back.name, "Workshop notes");
  assert.equal(back.documents.length, 2);
  assert.equal(back.chunks.length, p.chunks.length);
  assert.equal(K.search(back, "which screw stops the chain hitting the spokes", 1)[0].document, "Bike.md");
});

test("an imported pack gets fresh ids, so importing twice does not collide", () => {
  const p = packOfTwo();
  const a = K.importPack(K.exportPack(p));
  const b = K.importPack(K.exportPack(p));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.documents[0].id, b.documents[0].id);
  assert.notEqual(a.documents[0].id, p.documents[0].id, "ids are not carried over from the file");
});

test("files that are not packs are refused, each with a reason", () => {
  assert.throws(() => K.importPack("not json at all"), /not valid JSON/);
  assert.throws(() => K.importPack("[]"), /not a knowledge pack/);
  assert.throws(() => K.importPack(JSON.stringify({ format: "something-else" })), /not a Forge AI knowledge pack/);
  assert.throws(() => K.importPack(JSON.stringify({ format: K.FORMAT, version: 99 })), /newer version/);
  assert.throws(() => K.importPack(42), /text file/);
});

test("a pack whose passages point at documents it does not have is refused", () => {
  const bad = JSON.stringify({
    format: K.FORMAT, version: 1, name: "Bad",
    documents: [{ id: "d1", name: "Real" }],
    chunks: [{ doc: "somewhere-else", text: "smuggled passage", i: 0 }],
  });
  assert.throws(() => K.importPack(bad), /no readable passages/);
});

test("rubbish inside an otherwise valid pack is dropped, not imported", () => {
  const mixed = JSON.stringify({
    format: K.FORMAT, version: 1, name: "Mixed",
    documents: [{ id: "d1", name: "Real", source: "x" }, null, 7, { noId: true }],
    chunks: [
      { doc: "d1", text: "a real passage about gears", i: 0 },
      { doc: "d1", text: 12345, i: 1 },
      null,
      { doc: "d1", i: 2 },
    ],
  });
  const p = K.importPack(mixed);
  assert.equal(p.documents.length, 1, "only the well-formed document survived");
  assert.equal(p.chunks.length, 1, "only the passage with real text survived");
  assert.equal(p.chunks[0].text, "a real passage about gears");
});

test("an overlong passage is cut to the limit rather than imported whole", () => {
  const huge = "x".repeat(K.LIMITS.chunkChars + 5000);
  const p = K.importPack(JSON.stringify({
    format: K.FORMAT, version: 1, name: "Big",
    documents: [{ id: "d1", name: "D" }],
    chunks: [{ doc: "d1", text: huge, i: 0 }],
  }));
  assert.equal(p.chunks[0].text.length, K.LIMITS.chunkChars);
});

test("a file too large to be a pack is refused before it is parsed", () => {
  assert.throws(() => K.importPack("x".repeat(K.LIMITS.packBytes + 1)), /too large/);
});
