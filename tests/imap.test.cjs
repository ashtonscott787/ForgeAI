// Reading mail. Run against a real IMAP dialogue over TLS with a server that
// answers like a provider does, because the parsing — not the connecting — is
// where this goes wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const I = require("../electron/imap.cjs");

// A self-signed certificate, made once, so the test speaks real TLS.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-imap-"));
const key = path.join(dir, "k.pem");
const cert = path.join(dir, "c.pem");
test.before(() => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
    "-days", "1", "-nodes", "-subj", "/CN=localhost"], { stdio: "pipe" });
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const CRLF = "\r\n";
const MESSAGE = [
  "From: Dana Patel <dana@supplier.example>",
  "To: you@example.com",
  "Subject: =?UTF-8?B?T3JkZXIgMTA0MiDigJQgZGVsYXllZA==?=",
  "Date: Thu, 20 Nov 2026 09:14:00 +0000",
  "Message-ID: <abc123@supplier.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="XY"',
  "",
  "--XY",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "The pallets are held at customs. New date is 3 December. Sorry =E2=80=94 Dana",
  "--XY",
  'Content-Type: text/html; charset="UTF-8"',
  "",
  "<p>Ignore me</p>",
  "--XY--",
].join("\n");

/** Answers like an IMAP server, and records what it was asked. */
function imapServer({ failLogin = false } = {}) {
  const log = [];
  const server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (sock) => {
    sock.setEncoding("utf8");
    sock.write(`* OK [CAPABILITY IMAP4rev1] test ready${CRLF}`);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const [tag, cmd, ...rest] = line.split(" ");
        log.push(line);
        const up = (cmd || "").toUpperCase();
        if (up === "LOGIN") {
          sock.write(failLogin ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${CRLF}` : `${tag} OK signed in${CRLF}`);
        } else if (up === "LIST") {
          sock.write(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}`);
          sock.write(`* LIST (\\HasNoChildren \\Sent) "/" "Sent"${CRLF}`);
          sock.write(`* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"${CRLF}`);
          sock.write(`${tag} OK done${CRLF}`);
        } else if (up === "SELECT") {
          sock.write(`* 2 EXISTS${CRLF}* OK [UIDVALIDITY 1]${CRLF}${tag} OK [READ-WRITE] selected${CRLF}`);
        } else if (up === "FETCH") {
          const head = MESSAGE.split("\n\n")[0].split("\n").filter((l) => /^(From|To|Subject|Date|Message-ID):/.test(l)).join(CRLF) + CRLF;
          sock.write(`* 1 FETCH (UID 101 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${head.length}}${CRLF}`);
          sock.write(head.split(CRLF).join(CRLF) + CRLF);
          sock.write(`)${CRLF}`);
          sock.write(`* 2 FETCH (UID 102 FLAGS () BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${head.length}}${CRLF}`);
          sock.write(head.split(CRLF).join(CRLF) + CRLF);
          sock.write(`)${CRLF}`);
          sock.write(`${tag} OK fetched${CRLF}`);
        } else if (up === "UID" && (rest[0] || "").toUpperCase() === "FETCH") {
          const body = MESSAGE.split("\n").join(CRLF);
          sock.write(`* 2 FETCH (UID 102 BODY[] {${body.length}}${CRLF}`);
          sock.write(body + CRLF);
          sock.write(`)${CRLF}${tag} OK fetched${CRLF}`);
        } else if (up === "LOGOUT") {
          sock.write(`* BYE${CRLF}${tag} OK bye${CRLF}`);
          sock.end();
        } else sock.write(`${tag} OK${CRLF}`);
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, log, port: server.address().port })));
}

const open = (s) => I.connect({ host: "127.0.0.1", port: s.port, user: "you@example.com", pass: "app-password" });

test.before(() => { process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; });   // self-signed, in-process
test.after(() => { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; });

test("signing in works, and the password is sent quoted", async () => {
  const s = await imapServer();
  try {
    const sess = await open(s);
    await I.close(sess);
    const login = s.log.find((l) => / LOGIN /.test(l));
    assert.ok(login, "it signed in");
    assert.match(login, /LOGIN "you@example\.com" "app-password"/);
  } finally { s.server.close(); }
});

test("a refused password says what kind of password is usually needed", async () => {
  const s = await imapServer({ failLogin: true });
  try {
    await assert.rejects(() => open(s), (e) => {
      assert.equal(e.stage, "auth");
      assert.match(e.message, /app-specific password/);
      return true;
    });
  } finally { s.server.close(); }
});

test("mailboxes are listed, and ones that cannot be opened are left out", async () => {
  const s = await imapServer();
  try {
    const sess = await open(s);
    const boxes = await I.listMailboxes(sess);
    await I.close(sess);
    assert.deepEqual(boxes.map((b) => b.name), ["INBOX", "Sent"], "the \\Noselect container is not offered");
  } finally { s.server.close(); }
});

test("recent messages come back newest first, with real subjects", async () => {
  const s = await imapServer();
  try {
    const sess = await open(s);
    const r = await I.recent(sess, "INBOX", 10);
    await I.close(sess);
    assert.equal(r.total, 2);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].uid, 102, "newest first");
    assert.equal(r.messages[0].subject, "Order 1042 — delayed", "the encoded subject is decoded");
    assert.equal(r.messages[0].from, "Dana Patel <dana@supplier.example>");
    assert.equal(r.messages[0].unread, true, "a message without \\Seen is unread");
    assert.equal(r.messages[1].unread, false);
  } finally { s.server.close(); }
});

test("one message's readable text is the plain part, decoded", async () => {
  const s = await imapServer();
  try {
    const sess = await open(s);
    const m = await I.message(sess, "INBOX", 102);
    await I.close(sess);
    assert.equal(m.subject, "Order 1042 — delayed");
    assert.match(m.text, /pallets are held at customs/);
    assert.match(m.text, /Sorry — Dana/, "quoted-printable and UTF-8 both decoded");
    assert.ok(!m.text.includes("Ignore me"), "the HTML alternative is not used when there is plain text");
  } finally { s.server.close(); }
});

// ── parsing, without a server ─────────────────────────────────
test("encoded subject lines are decoded, in both encodings", () => {
  assert.equal(I.decodeWords("=?UTF-8?B?T3JkZXIgMTA0Mg==?="), "Order 1042");
  assert.equal(I.decodeWords("=?UTF-8?Q?Caf=C3=A9_time?="), "Café time");
  assert.equal(I.decodeWords("Plain subject"), "Plain subject", "plain text is untouched");
  assert.equal(I.decodeWords("=?UTF-8?B?bm90IHZhbGlkIGJhc2U2NA?="), "not valid base64");
});

test("a malformed encoded word is left alone rather than mangled", () => {
  const odd = "=?UNKNOWN-CHARSET?X?zzz?=";
  assert.equal(I.decodeWords(odd), odd);
});

test("an HTML-only message still yields readable text", () => {
  const t = I.textFromHtml('<style>p{color:red}</style><h1>Invoice</h1><p>Due <b>Friday</b>.</p><script>bad()</script>');
  assert.match(t, /Invoice/);
  assert.match(t, /Due Friday\./);
  assert.ok(!t.includes("color:red"), "style content is dropped");
  assert.ok(!t.includes("bad()"), "script content is dropped");
});

test("base64 and quoted-printable bodies decode to the same text", () => {
  const plain = "Prix: 12€ — merci";
  assert.equal(I.decodeBody(Buffer.from(plain, "utf8").toString("base64"), "base64", "utf-8"), plain);
  assert.equal(I.decodeBody("Prix: 12=E2=82=AC =E2=80=94 merci", "quoted-printable", "utf-8"), plain);
});

test("a folded header is read as one value", () => {
  const block = "Subject: a very long subject\r\n that was folded\r\nFrom: x@y.com";
  assert.equal(I.headerValue(block, "Subject"), "a very long subject that was folded");
});

test("a mailbox name with a quote in it cannot break the command", () => {
  assert.equal(I.quote('we"ird'), '"we\\"ird"');
  assert.equal(I.quote("back\\slash"), '"back\\\\slash"');
});

test("there is no way to write to a mailbox", () => {
  // Read-only is a property worth asserting, not just intending.
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "imap.cjs"), "utf8");
  for (const verb of ["STORE", "EXPUNGE", "DELETE", "APPEND", "COPY", "MOVE", "CREATE", "RENAME"]) {
    assert.ok(!new RegExp(`send\\(\`?${verb}\\b`, "i").test(src), `${verb} is never sent`);
  }
  assert.deepEqual(Object.keys(module.require("../electron/imap.cjs")).filter((k) => /delete|remove|write|send/i.test(k)), []);
});
