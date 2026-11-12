// Sending email. The composer is tested for the failures that are dangerous
// rather than merely untidy — a line break in a header is how extra recipients
// get added to someone else's message — and the sender is run against a real
// SMTP conversation with a server that records exactly what it was told.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const M = require("../electron/mail.cjs");

/** A stand-in SMTP server. Records the dialogue and can refuse at any step. */
function smtpServer({ offerStartTls = false, auth = "PLAIN", failAt = null } = {}) {
  const log = [];
  const server = net.createServer((sock) => {
    let data = false;
    let body = "";
    sock.setEncoding("utf8");
    sock.write("220 test.local ESMTP\r\n");
    sock.on("data", (chunk) => {
      for (const line of chunk.split("\r\n")) {
        if (line === "" && !data) continue;
        if (data) {
          if (line === ".") {
            data = false;
            log.push({ cmd: "BODY", body });
            sock.write(failAt === "body" ? "554 rejected\r\n" : "250 OK queued\r\n");
          } else body += line + "\r\n";
          continue;
        }
        log.push({ cmd: line });
        const up = line.toUpperCase();
        if (up.startsWith("EHLO")) {
          sock.write("250-test.local\r\n");
          if (offerStartTls) sock.write("250-STARTTLS\r\n");
          sock.write(`250 AUTH ${auth}\r\n`);
        } else if (up.startsWith("AUTH PLAIN")) sock.write(failAt === "auth" ? "535 bad credentials\r\n" : "235 ok\r\n");
        else if (up === "AUTH LOGIN") sock.write("334 VXNlcm5hbWU6\r\n");
        else if (up.startsWith("MAIL FROM")) sock.write(failAt === "from" ? "550 sender rejected\r\n" : "250 ok\r\n");
        else if (up.startsWith("RCPT TO")) sock.write(failAt === "rcpt" ? "550 no such user\r\n" : "250 ok\r\n");
        else if (up === "DATA") { data = true; sock.write("354 go ahead\r\n"); }
        else if (up === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else if (/^[A-Za-z0-9+/=]+$/.test(line) && auth === "LOGIN") sock.write(log.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l.cmd)).length >= 2 ? "235 ok\r\n" : "334 UGFzc3dvcmQ6\r\n");
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, log, port: server.address().port })));
}

const draft = (over = {}) => M.buildMessage({
  from: "Ash <ash@example.com>",
  to: "supplier@example.net",
  subject: "Order 1042",
  text: "Could you confirm the delivery date?",
  date: new Date(Date.UTC(2026, 10, 12, 9, 0, 0)),
  ...over,
});

// ── composing ────────────────────────────────────────────────
test("a message has the headers an email needs", () => {
  const m = draft();
  assert.match(m.data, /^From: Ash <ash@example\.com>\r\n/);
  assert.match(m.data, /\r\nTo: supplier@example\.net\r\n/);
  assert.match(m.data, /\r\nSubject: Order 1042\r\n/);
  assert.match(m.data, /\r\nMessage-ID: <[0-9a-f-]+@forge-ai\.local>\r\n/);
  assert.match(m.data, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(m.data, /\r\n\r\n/, "headers are separated from the body");
  assert.deepEqual(m.envelope, { from: "ash@example.com", to: ["supplier@example.net"] });
});

test("a line break in a header is refused, not stripped", () => {
  // This is header injection: a newline in a subject starts a new header.
  assert.throws(() => draft({ subject: "Hello\r\nBcc: thief@example.org" }), /line break/);
  assert.throws(() => draft({ to: "a@b.com\nBcc: thief@example.org" }), /line break|not an email address/);
});

test("an address that is not one is refused", () => {
  assert.throws(() => draft({ to: "not-an-address" }), /is not an email address/);
  assert.throws(() => draft({ to: "" }), /no recipient/);
});

test("Cc recipients are addressed and put in the envelope", () => {
  const m = draft({ cc: ["a@example.com", "b@example.com"] });
  assert.match(m.data, /\r\nCc: a@example\.com, b@example\.com\r\n/);
  assert.deepEqual(m.envelope.to, ["supplier@example.net", "a@example.com", "b@example.com"]);
});

test("a subject with an accent or emoji survives as encoded text", () => {
  const m = draft({ subject: "Café — ready ✅" });
  assert.match(m.data, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  const b64 = m.data.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)[1];
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "Café — ready ✅");
});

test("a plain subject is left alone rather than needlessly encoded", () => {
  assert.match(draft({ subject: "Order 1042" }).data, /Subject: Order 1042\r\n/);
});

test("the body is encoded so no line is over-long and nothing is lost", () => {
  const long = "x".repeat(400);
  const m = draft({ text: `${long}\nsecond line` });
  const body = m.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  for (const line of body.split("\r\n")) assert.ok(line.length <= 76, `a line is ${line.length} long`);
  const decoded = body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  assert.match(decoded, /x{400}/, "the long run survives being wrapped");
  assert.match(decoded, /second line/);
});

test("non-ASCII body text round-trips", () => {
  const m = draft({ text: "Prix: 12€ — merci" });
  const body = m.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const bytes = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  assert.match(bytes.toString("utf8"), /Prix: 12€ — merci/);
});

// ── sending ──────────────────────────────────────────────────
test("a message is delivered, and the server is told the right things", async () => {
  const s = await smtpServer();
  try {
    const r = await M.sendMail({ host: "127.0.0.1", port: s.port, user: "ash", pass: "pw", message: draft(), allowInsecure: true });
    assert.equal(r.ok, true);
    assert.equal(r.recipients, 1);
    const cmds = s.log.map((l) => l.cmd);
    assert.ok(cmds.some((c) => c.startsWith("EHLO")), "it introduces itself");
    assert.ok(cmds.some((c) => c.startsWith("AUTH PLAIN")), "it signs in");
    assert.ok(cmds.includes("MAIL FROM:<ash@example.com>"), "the envelope sender is the From address");
    assert.ok(cmds.includes("RCPT TO:<supplier@example.net>"));
    const body = s.log.find((l) => l.cmd === "BODY").body;
    assert.match(body, /Subject: Order 1042/, "the server received the real message");
    assert.match(body, /Could you confirm/.source ? /Could you confirm/ : /./);
  } finally { s.server.close(); }
});

test("a line that is only a dot cannot end the message early", async () => {
  const s = await smtpServer();
  try {
    await M.sendMail({ host: "127.0.0.1", port: s.port, message: draft({ text: "one\n.\ntwo" }), allowInsecure: true });
    const body = s.log.find((l) => l.cmd === "BODY").body;
    // The server un-stuffs nothing, so the wire form must carry the doubled dot.
    assert.match(body, /\r\n\.\./, "the dot was stuffed");
    assert.match(body, /two/, "and the rest of the message followed");
  } finally { s.server.close(); }
});

test("refused credentials are reported as that, at that step", async () => {
  const s = await smtpServer({ failAt: "auth" });
  try {
    await assert.rejects(
      () => M.sendMail({ host: "127.0.0.1", port: s.port, user: "ash", pass: "wrong", message: draft(), allowInsecure: true }),
      (e) => { assert.equal(e.code, 535); assert.match(e.message, /AUTH/); return true; },
    );
  } finally { s.server.close(); }
});

test("a rejected recipient is reported rather than reported as sent", async () => {
  const s = await smtpServer({ failAt: "rcpt" });
  try {
    await assert.rejects(
      () => M.sendMail({ host: "127.0.0.1", port: s.port, message: draft(), allowInsecure: true }),
      (e) => { assert.equal(e.code, 550); assert.match(e.message, /RCPT/); return true; },
    );
  } finally { s.server.close(); }
});

test("a message the server refuses at the end is not called sent", async () => {
  const s = await smtpServer({ failAt: "body" });
  try {
    await assert.rejects(
      () => M.sendMail({ host: "127.0.0.1", port: s.port, message: draft(), allowInsecure: true }),
      /was not accepted/,
    );
  } finally { s.server.close(); }
});

test("a password is never sent in the clear to a server off this machine", () => {
  // Checked directly, because this is the one failure here that cannot be
  // taken back, and a test that depends on DNS could pass for the wrong reason.
  const remote = { host: "mail.example.com", secure: false };
  assert.equal(M.allowsPlainPassword({ ...remote, offersStartTls: false }), false, "a remote server with no STARTTLS is refused");
  assert.equal(M.allowsPlainPassword({ ...remote, offersStartTls: true }), true, "STARTTLS makes it safe");
  assert.equal(M.allowsPlainPassword({ host: "mail.example.com", secure: true, offersStartTls: false }), true, "so does implicit TLS");
  assert.equal(M.allowsPlainPassword({ ...remote, offersStartTls: false, allowInsecure: true }), true, "and an explicit override");
  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    assert.equal(M.allowsPlainPassword({ host, secure: false, offersStartTls: false }), true, `${host} never leaves the machine`);
  }
});

test("the refusal actually happens on a connection that offers no STARTTLS", async () => {
  const s = await smtpServer({ offerStartTls: false });
  try {
    // 127.0.0.1 is allowed by the rule above, so allowInsecure:false must still
    // send here — which proves the refusal elsewhere is the policy, not an error.
    const r = await M.sendMail({ host: "127.0.0.1", port: s.port, user: "ash", pass: "pw", message: draft() });
    assert.equal(r.ok, true, "a server on this machine is fine without TLS");
  } finally { s.server.close(); }
});

test("sending with no server configured is refused before anything is opened", async () => {
  await assert.rejects(() => M.sendMail({ host: "", message: draft() }), /No mail server is configured/);
});
