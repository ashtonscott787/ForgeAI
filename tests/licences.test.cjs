// Which models a business may actually use.
//
// The catalogue has carried a licence name on every model since it was
// written and nothing has ever read one. qwen2.5-3b-instruct is under the
// Qwen research licence, which forbids commercial use, and it sits in the
// library beside the Apache ones with nothing to tell them apart.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lic = require(path.join(__dirname, "..", "electron", "licences.cjs"));

const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron", "catalogue.json"), "utf8"));
const models = catalogue.models || catalogue;

test("every licence in the catalogue is one we have actually classified", () => {
  const unknown = [...new Set(models.map((m) => m.license))].filter((n) => !lic.about(n).known);
  assert.deepEqual(unknown, [], "an unclassified licence tells nobody anything");
});

test("the research licence in the catalogue is marked as such", () => {
  const research = models.filter((m) => !lic.commercialOk(m.license));
  assert.ok(research.length >= 1, "there is at least one, and it was invisible before");
  assert.ok(research.some((m) => m.id === "qwen2.5-3b-instruct"), "including the one that prompted this");
  for (const m of research) {
    assert.match(lic.about(m.license).says, /not permitted|non-commercial/i, `${m.id} says why`);
  }
});

test("a licence with strings attached says what they are, and is still usable", () => {
  for (const name of ["llama-3.2", "gemma"]) {
    const a = lic.about(name);
    assert.equal(a.commercial_ok, true, `${name} permits commercial use`);
    assert.equal(a.kind, "conditions");
    assert.ok(a.says.length > 40, `${name} says what it asks for`);
  }
  assert.match(lic.about("llama-3.1").says, /700 million/, "the cap is named, not summarised away");
});

test("an unknown licence is unknown, never assumed to be permissive", () => {
  const a = lic.about("some-new-licence-2027");
  assert.equal(a.known, false);
  assert.equal(a.commercial_ok, null, "null, not false and not true");
  assert.equal(lic.commercialOk("some-new-licence-2027"), false, "and it does not pass the filter");
  assert.match(a.says, /Read it before/);
  // The one wrong answer here is the generous one: it tells somebody they
  // may sell what they build when nobody has checked.
  assert.notEqual(a.commercial_ok, true);
});

test("a missing licence is treated the same as an unknown one", () => {
  for (const nothing of ["", null, undefined]) {
    assert.equal(lic.about(nothing).known, false);
    assert.equal(lic.commercialOk(nothing), false);
  }
});

test("filtering for commercial use leaves out the research ones and the unknowns", () => {
  const list = [
    { id: "a", license: "apache-2.0" },
    { id: "b", license: "qwen-research" },
    { id: "c", license: "llama-3.2" },
    { id: "d", license: "who-knows" },
  ];
  assert.deepEqual(lic.forCommercialUse(list).map((m) => m.id), ["a", "c"]);
});

test("annotating adds what is known and changes nothing else", () => {
  const [one] = lic.annotate([{ id: "a", license: "mit", repo: "x/y" }]);
  assert.equal(one.id, "a");
  assert.equal(one.repo, "x/y", "the entry is not rewritten");
  assert.equal(one.licence.commercial_ok, true);
  assert.equal(one.licence.label, "MIT");
});

test("every model in the catalogue can be annotated without losing its fields", () => {
  const out = lic.annotate(models);
  assert.equal(out.length, models.length);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].id, models[i].id);
    assert.equal(out[i].repo, models[i].repo);
    assert.ok(out[i].licence.label);
  }
});
