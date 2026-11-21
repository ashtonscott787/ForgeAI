// Who people are. The rule the whole module exists to enforce: nothing counts
// as true until a person says so, because a guess repeated back later in an
// email with someone's name on it is worse than no record at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const C = require("../electron/contacts.cjs");

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-contacts-")); C.load(dir); });
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("an address is read out of any of the usual shapes", () => {
  assert.equal(C.normalise("Dana Patel <dana@supplier.example>"), "dana@supplier.example");
  assert.equal(C.normalise("  DANA@Supplier.Example  "), "dana@supplier.example");
  assert.equal(C.normalise("not an address"), "");
  assert.equal(C.normalise(""), "");
});

test("a name is taken only when there is one", () => {
  assert.equal(C.displayName("Dana Patel <dana@x.com>"), "Dana Patel");
  assert.equal(C.displayName('"Patel, Dana" <dana@x.com>'), "Patel, Dana");
  assert.equal(C.displayName("dana@x.com"), "", "an address is not a name");
  assert.equal(C.displayName("<dana@x.com>"), "");
});

test("a suggestion is not knowledge", () => {
  C.suggest("dana@x.com", "name", "Dana Patel", "an email");
  assert.deepEqual(C.known("dana@x.com"), { email: "dana@x.com", notes: [] }, "nothing is known yet");
  assert.equal(C.pending("dana@x.com").length, 1, "but something is waiting to be confirmed");
});

test("confirming makes it known; rejecting never does", () => {
  const a = C.suggest("dana@x.com", "name", "Dana Patel");
  C.decide("dana@x.com", a.id, "confirmed");
  assert.equal(C.known("dana@x.com").name, "Dana Patel");

  const b = C.suggest("jo@y.com", "organisation", "Wrong Ltd");
  C.decide("jo@y.com", b.id, "rejected");
  assert.equal(C.known("jo@y.com").organisation, undefined);
  assert.deepEqual(C.pending("jo@y.com"), [], "and it stops being asked about");
});

test("a rejected guess is not offered again", () => {
  const f = C.suggest("jo@y.com", "organisation", "Wrong Ltd");
  C.decide("jo@y.com", f.id, "rejected");
  C.suggest("jo@y.com", "organisation", "Wrong Ltd", "another email");
  assert.deepEqual(C.pending("jo@y.com"), [], "the same wrong guess does not come back next week");
});

test("the same suggestion seen repeatedly is counted, not duplicated", () => {
  C.suggest("dana@x.com", "name", "Dana Patel", "email 1");
  C.suggest("dana@x.com", "name", "Dana Patel", "email 2");
  C.suggest("dana@x.com", "name", "Dana Patel", "email 3");
  const p = C.pending("dana@x.com");
  assert.equal(p.length, 1);
  assert.equal(p[0].times, 3, "how often it was seen is evidence worth showing");
  assert.equal(p[0].last_source, "email 3");
});

test("confirming a new value retires the old one rather than keeping both", () => {
  const first = C.suggest("dana@x.com", "organisation", "Old Ltd");
  C.decide("dana@x.com", first.id, "confirmed");
  const second = C.suggest("dana@x.com", "organisation", "New Ltd");
  C.decide("dana@x.com", second.id, "confirmed");
  assert.equal(C.known("dana@x.com").organisation, "New Ltd", "one answer per question");
});

test("notes accumulate rather than replacing each other", () => {
  const a = C.state("dana@x.com", "note", "Prefers email to phone");
  const b = C.state("dana@x.com", "note", "Handles the Dunedin site");
  assert.equal(a.state, "confirmed");
  assert.deepEqual(C.known("dana@x.com").notes, ["Prefers email to phone", "Handles the Dunedin site"]);
  assert.equal(b.source, "you told Forge AI");
});

test("something a person typed is confirmed without being asked about", () => {
  C.state("dana@x.com", "role", "Operations Manager");
  assert.equal(C.known("dana@x.com").role, "Operations Manager");
  assert.deepEqual(C.pending("dana@x.com"), []);
});

test("an email teaches the address and suggests the name", () => {
  C.fromMessage({ from: "Dana Patel <dana@supplier.example>", date: "Thu, 20 Nov 2026 09:14:00 +0000", subject: "Order 1042" });
  const row = C.list()[0];
  assert.equal(row.email, "dana@supplier.example");
  assert.equal(row.seen, 1);
  assert.equal(row.pending[0].field, "name");
  assert.equal(row.pending[0].value, "Dana Patel");
  assert.match(row.pending[0].source, /Order 1042/, "it says which email it came from");
});

test("seeing someone again counts, without duplicating them", () => {
  for (let i = 0; i < 3; i++) C.fromMessage({ from: "Dana <dana@x.com>", date: "Thu, 20 Nov 2026 09:14:00 +0000" });
  assert.equal(C.list().length, 1);
  assert.equal(C.list()[0].seen, 3);
});

test("a signature yields suggestions, and only suggestions", () => {
  const body = [
    "Thanks,", "", "Dana Patel",
    "Operations Manager, Patel Logistics Ltd",
    "+64 21 555 0199",
  ].join("\n");
  C.suggestFromBody("dana@patellogistics.example", body, "their last email");
  const p = C.pending("dana@patellogistics.example");
  const byField = Object.fromEntries(p.map((f) => [f.field, f.value]));
  assert.equal(byField.role, "Operations Manager");
  assert.match(byField.phone, /555 0199/);
  assert.ok(byField.organisation, "an organisation was proposed");
  for (const f of p) assert.equal(f.state, "suggested", "a signature is a claim, not a fact");
  assert.equal(C.known("dana@patellogistics.example").role, undefined);
});

test("a personal email provider is not mistaken for an employer", () => {
  C.suggestFromBody("someone@gmail.com", "Thanks,\nSomeone", "an email");
  const orgs = C.pending("someone@gmail.com").filter((f) => f.field === "organisation");
  assert.deepEqual(orgs, [], "gmail is not a company someone works for");
});

test("a model is only ever told what was confirmed", () => {
  C.suggest("dana@x.com", "organisation", "Guessed Ltd");
  const confirmedName = C.suggest("dana@x.com", "name", "Dana Patel");
  C.decide("dana@x.com", confirmedName.id, "confirmed");
  C.state("dana@x.com", "note", "Prefers email");

  const prompt = C.forPrompt(["dana@x.com"]);
  assert.match(prompt, /Dana Patel/);
  assert.match(prompt, /Prefers email/);
  assert.ok(!prompt.includes("Guessed Ltd"), "an unconfirmed guess never reaches the model");
  assert.match(prompt, /because they confirmed it/, "and the model is told why it can rely on it");
});

test("nothing is said about someone with nothing confirmed", () => {
  C.suggest("jo@y.com", "name", "Jo");
  assert.equal(C.forPrompt(["jo@y.com"]), "", "silence rather than a guess");
  assert.equal(C.forPrompt(["nobody@nowhere.com"]), "");
});

test("contacts survive a reload, with their states intact", () => {
  const f = C.suggest("dana@x.com", "name", "Dana Patel");
  C.decide("dana@x.com", f.id, "confirmed");
  C.suggest("dana@x.com", "phone", "+64 21 555 0199");
  C.load(dir);
  assert.equal(C.known("dana@x.com").name, "Dana Patel");
  assert.equal(C.pending("dana@x.com").length, 1, "and the unanswered question is still waiting");
});

test("forgetting someone removes them entirely", () => {
  C.state("dana@x.com", "name", "Dana");
  assert.equal(C.forget("dana@x.com"), true);
  assert.equal(C.known("dana@x.com"), null);
  C.load(dir);
  assert.equal(C.known("dana@x.com"), null, "and they stay gone");
});

test("only fields the app understands are accepted", () => {
  assert.equal(C.suggest("dana@x.com", "salary", "100000"), null);
  assert.equal(C.state("dana@x.com", "password", "hunter2"), null);
  assert.deepEqual(C.pending("dana@x.com"), []);
});

test("an unusable address is refused rather than stored as a person", () => {
  assert.equal(C.suggest("not-an-address", "name", "Nobody"), null);
  assert.equal(C.list().length, 0);
});
