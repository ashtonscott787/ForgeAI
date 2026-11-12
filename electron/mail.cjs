/**
 * Sending email, with the person's own account.
 *
 * Forge AI drafts; a person sends. Nothing here is called without an explicit
 * approval from the UI, and the draft is shown in full before it goes.
 *
 * The message is built to RFC 5322 rather than string-concatenated, because the
 * failures of doing it loosely are the dangerous kind: a newline in a subject
 * line becomes a new header, and a header someone else controls is how extra
 * recipients get added to a message. Every header value is therefore checked
 * for line breaks and refused, not stripped — silently changing what someone
 * wrote is its own kind of wrong.
 */
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

const CRLF = "\r\n";
const LIMITS = { subject: 500, body: 500_000, recipients: 50, timeoutMs: 30_000 };

class MailError extends Error {
  constructor(message, { stage = "send", code = 0 } = {}) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

/** A header value may not contain a line break. That is how headers are forged. */
function header(name, value) {
  const v = String(value ?? "");
  if (/[\r\n]/.test(v)) throw new MailError(`The ${name} line contains a line break, which is not allowed in an email header.`, { stage: "compose" });
  return v;
}

const ASCII = (s) => !/[^\x20-\x7e]/.test(s);

/** RFC 2047, so a subject with an accent or an emoji survives the journey. */
function encodeHeaderText(s) {
  if (ASCII(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** "Name <a@b.com>" or "a@b.com", with the display part encoded if it needs it. */
function address(raw) {
  const s = header("address", raw).trim();
  const m = s.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  const email = (m ? m[2] : s).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MailError(`"${s}" is not an email address.`, { stage: "compose" });
  const name = m ? m[1].replace(/^"|"$/g, "").trim() : "";
  return name ? `${encodeHeaderText(name)} <${email}>` : email;
}

const addressOnly = (raw) => {
  const s = String(raw).trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s).trim();
};

const listOf = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);

/**
 * Lines longer than 998 octets are invalid, and a bare "." at the start of a
 * line ends the DATA block, so both are handled rather than hoped about.
 */
function quotedPrintable(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    let enc = "";
    for (const ch of line) {
      const code = ch.codePointAt(0);
      if (ch === "=" || code < 32 || code > 126) {
        for (const b of Buffer.from(ch, "utf8")) enc += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      } else enc += ch;
    }
    // Soft line breaks keep every line within the limit.
    const wrapped = [];
    while (enc.length > 73) {
      let cut = 73;
      while (cut > 0 && enc[cut - 1] === "=") cut--;        // never split an escape
      while (cut > 2 && /^=[0-9A-F]$/.test(enc.slice(cut - 2, cut))) cut--;
      wrapped.push(`${enc.slice(0, cut)}=`);
      enc = enc.slice(cut);
    }
    wrapped.push(enc);
    out.push(...wrapped);
  }
  return out.join(CRLF);
}

/** The full message, ready for DATA. */
function buildMessage({ from, to, cc = [], subject = "", text = "", date = new Date() }) {
  const toList = listOf(to).slice(0, LIMITS.recipients);
  const ccList = listOf(cc).slice(0, LIMITS.recipients);
  if (!toList.length) throw new MailError("The message has no recipient.", { stage: "compose" });
  const body = String(text ?? "");
  if (body.length > LIMITS.body) throw new MailError("That message is too long to send.", { stage: "compose" });
  const subj = header("subject", subject).slice(0, LIMITS.subject);

  const headers = [
    `From: ${address(from)}`,
    `To: ${toList.map(address).join(", ")}`,
    ...(ccList.length ? [`Cc: ${ccList.map(address).join(", ")}`] : []),
    `Subject: ${encodeHeaderText(subj)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@forge-ai.local>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
  ];
  return {
    envelope: { from: addressOnly(from), to: [...toList, ...ccList].map(addressOnly) },
    data: `${headers.join(CRLF)}${CRLF}${CRLF}${quotedPrintable(body)}${CRLF}`,
  };
}

/**
 * Whether a password may cross this connection. Separated out so the rule can
 * be checked directly rather than only observed through a socket: a password in
 * the clear is the one failure here that cannot be taken back.
 */
function allowsPlainPassword({ host, secure, offersStartTls, allowInsecure = false }) {
  if (secure || offersStartTls) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return Boolean(allowInsecure);
}

/** A line of SMTP, read to its terminator. */
function reader(socket) {
  let buffer = "";
  const waiters = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf(CRLF)) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const w = waiters[0];
      if (w) w.lines.push(line);
      // A multi-line reply has a hyphen after the code; the last line has a space.
      if (w && /^\d{3} /.test(line)) {
        waiters.shift();
        w.resolve(w.lines);
      }
    }
  });
  return () => new Promise((resolve, reject) => {
    waiters.push({ lines: [], resolve, reject });
    socket.once("error", reject);
  });
}

const codeOf = (lines) => Number(String(lines[lines.length - 1] ?? "").slice(0, 3)) || 0;

/**
 * Sends one message over SMTP. Implicit TLS when `secure`, STARTTLS otherwise,
 * and plain only when the server is on this machine — a password must not cross
 * a network in the clear, and refusing is better than quietly doing it.
 */
async function sendMail({ host, port = 587, secure = false, user, pass, message, allowInsecure = false }) {
  if (!host) throw new MailError("No mail server is configured.", { stage: "config" });
  const local = host === "localhost" || host === "127.0.0.1";
  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(LIMITS.timeoutMs, () => socket.destroy(new MailError("The mail server did not answer in time.", { stage: "connect" })));

  let read = reader(socket);
  const say = async (line, expect) => {
    socket.write(line + CRLF);
    const lines = await read();
    const code = codeOf(lines);
    if (expect && !expect.includes(code)) {
      throw new MailError(`The mail server refused "${line.split(" ")[0]}": ${lines.join(" ")}`, { stage: "send", code });
    }
    return lines;
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once(secure ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
    });
    const greeting = await read();
    if (codeOf(greeting) !== 220) throw new MailError(`The mail server did not greet us: ${greeting.join(" ")}`, { stage: "connect" });

    let ehlo = await say(`EHLO forge-ai.local`, [250]);
    if (!secure) {
      const offersTls = ehlo.some((l) => /STARTTLS/i.test(l));
      if (offersTls) {
        await say("STARTTLS", [220]);
        socket = tls.connect({ socket, host, servername: host });
        await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
        read = reader(socket);
        ehlo = await say("EHLO forge-ai.local", [250]);
      } else if (!allowsPlainPassword({ host, secure, offersStartTls: false, allowInsecure })) {
        throw new MailError(
          "That server does not offer STARTTLS, so the password would cross the network unencrypted. Forge AI will not do that.",
          { stage: "security" },
        );
      }
    }

    if (user) {
      const mechanisms = ehlo.find((l) => /AUTH/i.test(l)) || "";
      if (/PLAIN/i.test(mechanisms)) {
        await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass ?? ""}`, "utf8").toString("base64")}`, [235]);
      } else if (/LOGIN/i.test(mechanisms)) {
        await say("AUTH LOGIN", [334]);
        await say(Buffer.from(String(user), "utf8").toString("base64"), [334]);
        await say(Buffer.from(String(pass ?? ""), "utf8").toString("base64"), [235]);
      } else {
        throw new MailError("That server offers no sign-in method Forge AI can use.", { stage: "auth" });
      }
    }

    await say(`MAIL FROM:<${message.envelope.from}>`, [250]);
    for (const rcpt of message.envelope.to) await say(`RCPT TO:<${rcpt}>`, [250, 251]);
    await say("DATA", [354]);
    // Dot-stuffing: a line that is just "." would otherwise end the message.
    socket.write(message.data.replace(/^\./gm, "..") + CRLF + "." + CRLF);
    const done = await read();
    if (codeOf(done) !== 250) throw new MailError(`The message was not accepted: ${done.join(" ")}`, { stage: "send", code: codeOf(done) });
    try { await say("QUIT", [221]); } catch { /* the server may hang up first, which is fine */ }
    return { ok: true, response: done.join(" "), recipients: message.envelope.to.length };
  } finally {
    try { socket.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { buildMessage, sendMail, quotedPrintable, address, addressOnly, encodeHeaderText, allowsPlainPassword, MailError, LIMITS };
