// Working out who hosts an email address.
const test = require("node:test");
const assert = require("node:assert/strict");
const mail = require("../electron/mail.cjs");

test("a well-known address is settled by its domain alone", async () => {
  let looked = false;
  const r = await mail.detectProvider("someone@gmail.com", async () => { looked = true; return []; });
  assert.equal(r.provider, "gmail");
  assert.equal(r.how, "the address itself");
  assert.equal(looked, false, "nothing was looked up");
});

test("a school address on its own domain is settled by where its mail goes", async () => {
  // This is the case the whole lookup exists for: the address says nothing,
  // the MX records say Google.
  const r = await mail.detectProvider("me@someuniversity.edu", async () => [
    { exchange: "ALT1.ASPMX.L.GOOGLE.COM", priority: 5 },
    { exchange: "aspmx.l.google.com", priority: 1 },
  ]);
  assert.equal(r.provider, "gmail");
  assert.equal(r.how, "where this domain delivers its mail");
});

test("a work domain on Microsoft is recognised", async () => {
  const r = await mail.detectProvider("me@acme.co", async () => [
    { exchange: "acme-co.mail.protection.outlook.com" },
  ]);
  assert.equal(r.provider, "microsoft");
});

test("only the domain is ever looked up, never the address", async () => {
  let asked = "";
  await mail.detectProvider("private.person@example.org", async (d) => { asked = d; return []; });
  assert.equal(asked, "example.org", "the part before the @ is not sent anywhere");
});

test("a domain that says nothing produces no guess", async () => {
  const r = await mail.detectProvider("me@nowhere.example", async () => [{ exchange: "mail.nowhere.example" }]);
  assert.equal(r.ok, true);
  assert.equal(r.provider, "", "it does not invent one");
});

test("a failed lookup is not an error, it is simply unknown", async () => {
  const r = await mail.detectProvider("me@offline.example", async () => { throw new Error("ENOTFOUND"); });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "");
});

test("something that is not an address is refused before anything is looked up", async () => {
  let looked = false;
  const r = await mail.detectProvider("not an address", async () => { looked = true; return []; });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not look like an email address/i);
  assert.equal(looked, false);
});

test("the provider that cannot work is still marked as such", () => {
  assert.equal(mail.PROVIDERS.microsoft.works, false);
  assert.match(mail.PROVIDERS.microsoft.note, /OAuth/);
});
