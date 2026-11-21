/**
 * Reading mail.
 *
 * Sending was built first; reading is what makes "read my emails" possible.
 * This speaks enough IMAP to list mailboxes, fetch recent headers, and pull one
 * message's text — not a general client, and it does not pretend to be.
 *
 * Deliberate limits:
 *
 * - Read only. Nothing here deletes, moves or marks anything. A tool that can
 *   quietly change a mailbox is a different risk from one that can read it, and
 *   the two should not arrive together.
 * - TLS always. There is no plaintext path and no STARTTLS downgrade: every
 *   provider worth connecting to offers implicit TLS on 993, and a mailbox
 *   password is not something to negotiate about.
 * - Bodies are capped and decoded defensively. A message is input from
 *   strangers.
 */
const tls = require("node:tls");

const CRLF = "\r\n";
const LIMITS = { headers: 200, bodyBytes: 512 * 1024, timeoutMs: 30_000, lineBytes: 1024 * 1024 };

class ImapError extends Error {
  constructor(message, { stage = "read", code = "" } = {}) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

/** A tagged IMAP conversation over one TLS socket. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    this.n = 0;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.feed(chunk));
  }

  feed(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > LIMITS.lineBytes * 8) {
      this.buffer = "";
      this.fail(new ImapError("The server sent more than Forge AI will read."));
      return;
    }
    let at;
    while ((at = this.buffer.indexOf(CRLF)) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const w = this.waiters[0];
      if (!w) continue;
      w.lines.push(line);
      // A tagged line ends the command; everything before it is its data.
      if (w.tag && line.startsWith(`${w.tag} `)) {
        this.waiters.shift();
        const status = line.slice(w.tag.length + 1).split(" ")[0].toUpperCase();
        if (status === "OK") w.resolve(w.lines);
        else w.reject(new ImapError(line.slice(w.tag.length + 1).trim(), { code: status }));
      } else if (!w.tag && line.startsWith("* ")) {
        // The greeting is untagged.
        this.waiters.shift();
        w.resolve(w.lines);
      }
    }
  }

  fail(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  greeting() {
    return new Promise((resolve, reject) => this.waiters.push({ tag: null, lines: [], resolve, reject }));
  }

  send(command) {
    const tag = `a${String(++this.n).padStart(3, "0")}`;
    return new Promise((resolve, reject) => {
      this.waiters.push({ tag, lines: [], resolve, reject });
      this.socket.write(`${tag} ${command}${CRLF}`);
    });
  }
}

/** An IMAP string, quoted and escaped. */
const quote = (s) => `"${String(s).replace(/([\\"])/g, "\\$1")}"`;

/** Opens a connection and signs in. Always TLS. */
async function connect({ host, port = 993, user, pass }) {
  if (!host) throw new ImapError("No incoming mail server is set.", { stage: "config" });
  const socket = tls.connect({ host, port, servername: host });
  socket.setTimeout(LIMITS.timeoutMs, () => socket.destroy(new ImapError("The mail server did not answer in time.", { stage: "connect" })));
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const s = new Session(socket);
  await s.greeting();
  try {
    // LOGIN rather than AUTHENTICATE: it is what every provider still accepts
    // with an app password, which is the route a person can actually set up.
    await s.send(`LOGIN ${quote(user)} ${quote(pass)}`);
  } catch (e) {
    socket.destroy();
    throw new ImapError(
      /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(e.message)
        ? "That username or password was refused. Most providers need an app-specific password here, not your normal one."
        : `Signing in failed: ${e.message}`,
      { stage: "auth" },
    );
  }
  return s;
}

/** The mailboxes on the account. */
async function listMailboxes(s) {
  const lines = await s.send('LIST "" "*"');
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"(.+)"|(\S+))\s*$/);
    if (!m) continue;
    const flags = m[1] || "";
    if (/\\Noselect/i.test(flags)) continue;
    out.push({ name: m[2] ?? m[3], flags: flags.split(/\s+/).filter(Boolean) });
  }
  return out;
}

const unfold = (raw) => raw.replace(/\r?\n[ \t]+/g, " ");

/** RFC 2047 encoded words, so a real subject line is readable. */
function decodeWords(s) {
  return String(s ?? "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return bytes.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
    } catch {
      return whole;
    }
  }).replace(/\?=\s+=\?/g, "");
}

function headerValue(block, name) {
  const m = unfold(block).match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return m ? decodeWords(m[1].trim()) : "";
}

/**
 * The most recent messages in a mailbox, newest first. Headers only — a list
 * of fifty bodies is not something anybody asked for.
 */
async function recent(s, mailbox = "INBOX", count = 25) {
  const sel = await s.send(`SELECT ${quote(mailbox)}`);
  const existsLine = sel.find((l) => /^\* (\d+) EXISTS/i.test(l));
  const total = existsLine ? Number(existsLine.match(/^\* (\d+) EXISTS/i)[1]) : 0;
  if (!total) return { mailbox, total: 0, messages: [] };

  const n = Math.max(1, Math.min(Number(count) || 25, LIMITS.headers));
  const from = Math.max(1, total - n + 1);
  const lines = await s.send(
    `FETCH ${from}:${total} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`,
  );

  const messages = [];
  let current = null;
  let collecting = false;
  for (const line of lines) {
    const start = line.match(/^\* (\d+) FETCH /);
    if (start) {
      if (current) messages.push(current);
      const uid = line.match(/UID (\d+)/);
      current = { seq: Number(start[1]), uid: uid ? Number(uid[1]) : null, flags: (line.match(/FLAGS \(([^)]*)\)/) || [, ""])[1].split(/\s+/).filter(Boolean), raw: "" };
      collecting = /\{\d+\}\s*$/.test(line);
      continue;
    }
    if (collecting && current) {
      if (line === ")") { collecting = false; continue; }
      current.raw += `${line}\n`;
    }
  }
  if (current) messages.push(current);

  return {
    mailbox,
    total,
    messages: messages.map((m) => ({
      uid: m.uid,
      seq: m.seq,
      unread: !m.flags.some((f) => /^\\Seen$/i.test(f)),
      from: headerValue(m.raw, "From"),
      to: headerValue(m.raw, "To"),
      subject: headerValue(m.raw, "Subject") || "(no subject)",
      date: headerValue(m.raw, "Date"),
      message_id: headerValue(m.raw, "Message-ID"),
    })).reverse(),
  };
}

/** Decodes a body part according to its own declared encoding. */
function decodeBody(raw, encoding, charset) {
  const enc = String(encoding || "").toLowerCase();
  let bytes;
  if (enc === "base64") bytes = Buffer.from(raw.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") {
    bytes = Buffer.from(
      raw.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    );
  } else bytes = Buffer.from(raw, "utf8");
  return bytes.toString(/utf-?8/i.test(charset || "utf-8") ? "utf8" : "latin1");
}

/** Strips tags from an HTML-only message so there is something to read. */
const textFromHtml = (html) =>
  String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * One message's readable text. Prefers text/plain; falls back to the HTML part
 * stripped of its tags, which is what most marketing mail is.
 */
async function message(s, mailbox, uid) {
  await s.send(`SELECT ${quote(mailbox)}`);
  const lines = await s.send(`UID FETCH ${Number(uid)} (BODY.PEEK[])`);
  const body = lines.filter((l) => !/^\* \d+ FETCH /.test(l) && l !== ")").join("\n");
  const split = body.indexOf("\n\n");
  const head = split >= 0 ? body.slice(0, split) : body;
  const rest = split >= 0 ? body.slice(split + 2) : "";

  const ctype = headerValue(head, "Content-Type");
  const boundary = (unfold(head).match(/boundary="?([^";\s]+)"?/i) || [])[1];

  let text = "";
  if (boundary) {
    const parts = rest.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*\\n`));
    let html = "";
    for (const part of parts) {
      const at = part.indexOf("\n\n");
      if (at < 0) continue;
      const ph = part.slice(0, at);
      const pb = part.slice(at + 2);
      const pt = headerValue(ph, "Content-Type");
      const enc = headerValue(ph, "Content-Transfer-Encoding");
      const charset = (unfold(ph).match(/charset="?([^";\s]+)"?/i) || [])[1];
      if (/text\/plain/i.test(pt) && !text) text = decodeBody(pb, enc, charset);
      else if (/text\/html/i.test(pt) && !html) html = decodeBody(pb, enc, charset);
    }
    if (!text && html) text = textFromHtml(html);
  } else {
    const enc = headerValue(head, "Content-Transfer-Encoding");
    const charset = (unfold(head).match(/charset="?([^";\s]+)"?/i) || [])[1];
    const decoded = decodeBody(rest, enc, charset);
    text = /text\/html/i.test(ctype) ? textFromHtml(decoded) : decoded;
  }

  return {
    uid: Number(uid),
    from: headerValue(head, "From"),
    to: headerValue(head, "To"),
    cc: headerValue(head, "Cc"),
    subject: headerValue(head, "Subject") || "(no subject)",
    date: headerValue(head, "Date"),
    message_id: headerValue(head, "Message-ID"),
    text: text.slice(0, LIMITS.bodyBytes).trim(),
    truncated: text.length > LIMITS.bodyBytes,
  };
}

async function close(s) {
  try { await s.send("LOGOUT"); } catch { /* the server may hang up first */ }
  try { s.socket.destroy(); } catch { /* already gone */ }
}

module.exports = { connect, listMailboxes, recent, message, close, decodeWords, decodeBody, textFromHtml, headerValue, quote, ImapError, LIMITS };
