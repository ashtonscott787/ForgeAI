'use strict';
// Mailboxes: IMAP to read, SMTP to send. Passwords live in the vault; agents never see them.
// Connecting is automatic: from the address we find the provider (known domains + the domain's MX records),
// then try the usual servers and ports until one works, and explain failures in plain English.
const tls = require('node:tls');
const dns = require('node:dns').promises;

const PRESETS = {
  '1stdomains': { label: '1st Domains', imap_host: 'mail.1stdomains.co.nz', imap_port: 993, smtp_host: 'mail.1stdomains.co.nz', smtp_port: 465 },
  gmail: { label: 'Gmail / Google Workspace', imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 465, appPassword: 'https://myaccount.google.com/apppasswords' },
  outlook: { label: 'Outlook.com / Hotmail', imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp-mail.outlook.com', smtp_port: 587 },
  office365: { label: 'Microsoft 365 (work)', imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp.office365.com', smtp_port: 587 },
  icloud: { label: 'iCloud Mail', imap_host: 'imap.mail.me.com', imap_port: 993, smtp_host: 'smtp.mail.me.com', smtp_port: 587, appPassword: 'https://account.apple.com' },
  yahoo: { label: 'Yahoo Mail', imap_host: 'imap.mail.yahoo.com', imap_port: 993, smtp_host: 'smtp.mail.yahoo.com', smtp_port: 465, appPassword: 'https://login.yahoo.com/account/security' },
  zoho: { label: 'Zoho Mail', imap_host: 'imap.zoho.com', imap_port: 993, smtp_host: 'smtp.zoho.com', smtp_port: 465 },
  custom: { label: 'Other (enter settings)' },
};
const DOMAIN_PROVIDER = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook', 'outlook.co.nz': 'outlook', 'hotmail.co.nz': 'outlook', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud', 'yahoo.com': 'yahoo', 'yahoo.co.nz': 'yahoo', 'ymail.com': 'yahoo', 'zoho.com': 'zoho' };

// Port decides encryption: 993/465 = SSL from the start, 143/587/25 = upgrade with STARTTLS.
const secureFor = (port, flag) => (+port === 993 || +port === 465) ? true : (+port === 143 || +port === 587 || +port === 25) ? false : !!flag;
const T = 12000;

function tlsOpts(mb, host) {
  const o = { servername: host, minVersion: 'TLSv1.2' };
  if (mb.tls_pin) { // the user trusted this server's certificate (its name does not match the server address)
    o.checkServerIdentity = (h, cert) => (cert && cert.fingerprint256 === mb.tls_pin ? undefined : new Error('The server certificate changed since you trusted it'));
  }
  return o;
}

function providerOf(mb) {
  const hosts = `${mb.imap_host || ''} ${mb.smtp_host || ''}`;
  if (/gmail|google/i.test(hosts)) return 'gmail';
  if (/office365|outlook/i.test(hosts)) return /smtp\.office365/i.test(hosts) ? 'office365' : 'outlook';
  if (/me\.com|icloud/i.test(hosts)) return 'icloud';
  if (/yahoo/i.test(hosts)) return 'yahoo';
  if (/1stdomains/i.test(hosts)) return '1stdomains';
  return 'custom';
}

// Plain-English explanation of a mail error. side = 'read' | 'send'
function explain(e, side, mb, host, port) {
  const msg = String((e && (e.responseText || e.response || e.message)) || e);
  const code = (e && e.code) || '';
  const prov = providerOf(mb);
  const where = `${host}:${port}`;
  const auth = (e && e.authenticationFailed) || code === 'EAUTH' || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|username and password not accepted|\b535\b|\b534\b|LOGIN failed|incorrect password/i.test(msg);
  if (auth) {
    const tips = {
      gmail: 'Gmail does not accept your normal password in other apps. Turn on 2-Step Verification in your Google account, create an App Password (myaccount.google.com/apppasswords) and paste that 16-letter password here.',
      outlook: 'Microsoft is switching off passwords for Outlook.com / Hotmail in other apps and now expects a Microsoft sign-in (OAuth), which ForgeAI does not support yet. Use a 1st Domains, Gmail (app password) or other IMAP mailbox instead.',
      office365: 'Microsoft 365 often blocks password sign-in for other apps. Your admin must allow "Authenticated SMTP" and IMAP for this mailbox, or use an app password if your organisation allows them.',
      icloud: 'iCloud needs an app-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords.',
      yahoo: 'Yahoo needs an app password: Account security → Generate app password.',
      '1stdomains': 'Check the mailbox password in your 1st Domains control panel. The username is the full email address.',
    };
    return { code: 'auth', message: `Wrong username or password (${side === 'read' ? 'reading' : 'sending'}). ${tips[prov] || 'Check the password. The username is usually the full email address.'}`, detail: msg.slice(0, 200) };
  }
  if (code === 'ENOTFOUND' || /getaddrinfo|ENOTFOUND/i.test(msg)) return { code: 'dns', message: `The server name ${host} does not exist. Check the ${side === 'read' ? 'incoming' : 'outgoing'} server.`, detail: msg };
  if (/ERR_TLS_CERT_ALTNAME_INVALID|altnames|Hostname\/IP does not match/i.test(code + msg)) return { code: 'cert_name', message: `${host} answered, but its security certificate is for a different name. You can trust this server's certificate, or use the server name on the certificate.`, detail: msg };
  if (/SELF_SIGNED|self.signed|CERT_HAS_EXPIRED|certificate has expired|UNABLE_TO_VERIFY|unable to get local issuer/i.test(code + msg)) return { code: 'cert_untrusted', message: `${host}'s security certificate is not trusted (${/expired/i.test(msg) ? 'expired' : 'self-signed or unknown issuer'}).`, detail: msg };
  if (/wrong version number|ssl3_get_record|packet length too long|EPROTO/i.test(code + msg)) return { code: 'tls_mode', message: `Port ${port} on ${host} does not use SSL that way. Try ${side === 'read' ? '993' : '465 or 587'}.`, detail: msg };
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return { code: 'refused', message: `${where} refused the connection. That port is closed on the server — try a different port.`, detail: msg };
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timed? ?out|Greeting never received|socket hang up/i.test(msg)) return { code: 'timeout', message: `Could not reach ${where}. Your network or internet provider may block that port (many block 25 and some block 465), or the server is down.`, detail: msg };
  if (/relay|not permitted to send|sender address rejected|553|550 5\.7/i.test(msg)) return { code: 'sender', message: `The server refused to send as this address. The "from" address must be the mailbox itself (or an alias it owns). ${msg.slice(0, 160)}`, detail: msg };
  return { code: 'other', message: `${side === 'read' ? 'Reading' : 'Sending'} failed: ${msg.slice(0, 240)}`, detail: msg };
}

class Mailer {
  constructor(vault) { this.vault = vault; }
  creds(mb, pass) { return { user: mb.username || mb.email, pass: pass !== undefined ? pass : this.vault.reveal(mb.secret_ref) }; }

  async imap(mb, fn, pass) {
    const { ImapFlow } = require('imapflow');
    const { user } = this.creds(mb, pass);
    const c = new ImapFlow({ host: mb.imap_host, port: +mb.imap_port, secure: secureFor(mb.imap_port, mb.imap_secure), auth: { user, pass: this.creds(mb, pass).pass }, tls: tlsOpts(mb, mb.imap_host), logger: false, connectionTimeout: T, greetingTimeout: T, socketTimeout: 60000 });
    c.on('error', () => {});
    await c.connect();
    try { return await fn(c); } finally { try { await c.logout(); } catch {} }
  }
  transport(mb, pass) {
    const nodemailer = require('nodemailer');
    const secure = secureFor(mb.smtp_port, mb.smtp_secure);
    return nodemailer.createTransport({ host: mb.smtp_host, port: +mb.smtp_port, secure, requireTLS: !secure && +mb.smtp_port === 587, auth: this.creds(mb, pass), tls: tlsOpts(mb, mb.smtp_host), connectionTimeout: T, greetingTimeout: T, socketTimeout: 60000 });
  }
  async testRead(mb, pass) { try { await this.imap(mb, async (c) => { await c.mailboxOpen('INBOX'); }, pass); return { ok: true }; } catch (e) { return { ok: false, ...explain(e, 'read', mb, mb.imap_host, mb.imap_port) }; } }
  async testSend(mb, pass) { const t = this.transport(mb, pass); try { await t.verify(); return { ok: true }; } catch (e) { return { ok: false, ...explain(e, 'send', mb, mb.smtp_host, mb.smtp_port) }; } finally { t.close(); } }
  async test(mb) {
    const [read, send] = await Promise.all([this.testRead(mb), this.testSend(mb)]);
    return { read, send };
  }

  // Certificate details, so the user can decide to trust a server whose certificate has another name.
  static certInfo(host, port) {
    return new Promise((ok) => {
      const s = tls.connect({ host, port: +port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
        const c = s.getPeerCertificate() || {}; s.end();
        ok({ subject: c.subject && c.subject.CN, names: String(c.subjectaltname || '').split(',').map((x) => x.trim().replace(/^DNS:/, '')).filter(Boolean).slice(0, 12), issuer: c.issuer && (c.issuer.O || c.issuer.CN), validTo: c.valid_to, fingerprint: c.fingerprint256, authorized: s.authorized });
      });
      s.on('error', () => ok(null)); s.on('timeout', () => { s.destroy(); ok(null); });
    });
  }

  // Work out the settings from just an address + password.
  async detect(email, password, log = () => {}) {
    const domain = String(email).split('@')[1].toLowerCase();
    let prov = DOMAIN_PROVIDER[domain] || null; let mx = [];
    try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()); } catch {}
    const mxs = mx.join(' ');
    if (!prov) {
      if (/google\.com|googlemail\.com/.test(mxs)) prov = 'gmail';
      else if (/protection\.outlook\.com/.test(mxs)) prov = 'office365';
      else if (/1stdomains/.test(mxs)) prov = '1stdomains';
      else if (/zoho/.test(mxs)) prov = 'zoho';
      else if (/icloud\.com|me\.com/.test(mxs)) prov = 'icloud';
      else if (/yahoodns/.test(mxs)) prov = 'yahoo';
    }
    const p = PRESETS[prov];
    const guess = [...new Set([p && p.imap_host, `mail.${domain}`, `imap.${domain}`, mx[0]].filter(Boolean))];
    const sguess = [...new Set([p && p.smtp_host, `mail.${domain}`, `smtp.${domain}`, mx[0]].filter(Boolean))];
    const base = { email, username: email, name: '' };
    const found = { provider: prov || 'custom', providerLabel: p ? p.label : 'Your email host', mx: mx.slice(0, 3), imap: null, smtp: null, tried: [] };

    const tryAll = async (side, hosts, ports) => {
      let firstAuth = null, cert = null, last = null;
      for (const host of hosts) {
        for (const port of ports) {
          const mb = side === 'read' ? { ...base, imap_host: host, imap_port: port } : { ...base, smtp_host: host, smtp_port: port };
          log(`${side === 'read' ? 'Incoming' : 'Outgoing'}: trying ${host}:${port}`);
          const r = side === 'read' ? await this.testRead(mb, password) : await this.testSend(mb, password);
          found.tried.push({ side, host, port, ok: r.ok, code: r.code });
          if (r.ok) return { ok: true, host, port };
          if (r.code === 'auth') { firstAuth = firstAuth || { ok: false, host, port, ...r }; break; } // server is right, password is wrong: stop guessing hosts
          if (/^cert/.test(r.code)) { cert = cert || { ok: false, host, port, ...r, cert: await Mailer.certInfo(host, port) }; continue; }
          if (r.code === 'dns') { last = last || { ok: false, host, port, ...r }; break; }
          last = { ok: false, host, port, ...r };
        }
        if (firstAuth) break;
      }
      return firstAuth || cert || last || { ok: false, message: 'No mail server found for ' + domain };
    };
    const [imap, smtp] = await Promise.all([tryAll('read', guess, [993, 143]), tryAll('send', sguess, [465, 587, 25])]);
    found.imap = imap; found.smtp = smtp;
    return found;
  }

  async folders(mb) { return this.imap(mb, async (c) => (await c.list()).map((f) => ({ path: f.path, name: f.name, special: f.specialUse || null }))); }
  async list(mb, { folder = 'INBOX', unreadOnly = false, limit = 20, query = '' } = {}) {
    return this.imap(mb, async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const crit = {}; if (unreadOnly) crit.seen = false; if (query) crit.or = [{ subject: query }, { from: query }, { body: query }];
        let uids = await c.search(Object.keys(crit).length ? crit : { all: true }, { uid: true });
        uids = (uids || []).slice(-Math.min(100, limit));
        const out = [];
        if (!uids.length) return out;
        for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const f = (m.envelope.from || [])[0] || {};
          out.push({ uid: m.uid, date: m.internalDate, from: (m.envelope.from || []).map((a) => `${a.name || ''} <${a.address}>`).join(', '), fromName: f.name || f.address || '', fromAddress: f.address || '', to: (m.envelope.to || []).map((a) => a.address).join(', '), subject: m.envelope.subject || '(no subject)', unread: !m.flags.has('\\Seen') });
        }
        return out.reverse();
      } finally { lock.release(); }
    });
  }
  async read(mb, uid, folder = 'INBOX', { html = false } = {}) {
    const { simpleParser } = require('mailparser');
    return this.imap(mb, async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
        if (!m) throw new Error('Email not found');
        await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
        const p = await simpleParser(m.source);
        return { uid, from: p.from && p.from.text, fromAddress: p.from && p.from.value && p.from.value[0] && p.from.value[0].address, to: p.to && p.to.text, cc: p.cc && p.cc.text, date: p.date, subject: p.subject, messageId: p.messageId, references: p.references,
          text: (p.text || (p.html ? String(p.html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '')).slice(0, 30000),
          html: html && p.html ? String(p.html).slice(0, 400000) : undefined,
          attachments: (p.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size, content: a.content })) };
      } finally { lock.release(); }
    });
  }
  async move(mb, uid, dest, folder = 'INBOX') {
    return this.imap(mb, async (c) => { const lock = await c.getMailboxLock(folder); try { await c.messageMove(String(uid), dest, { uid: true }); } finally { lock.release(); } });
  }
  async send(mb, { to, cc, bcc, subject, text, html, attachments, inReplyTo, references }) {
    const t = this.transport(mb);
    let info;
    try {
      info = await t.sendMail({ from: mb.name ? `"${mb.name.replace(/"/g, '')}" <${mb.email}>` : mb.email, to, cc, bcc, subject, text, html, attachments, inReplyTo, references });
    } catch (e) { const x = explain(e, 'send', mb, mb.smtp_host, mb.smtp_port); throw Object.assign(new Error(x.message), { code: x.code }); }
    finally { t.close(); }
    // Keep a copy in Sent where the server does not do it automatically (Gmail and Microsoft already do).
    let savedToSent = /gmail|office365|outlook/i.test(mb.smtp_host);
    if (!savedToSent) try {
      const MailComposer = require('nodemailer/lib/mail-composer');
      const raw = await new Promise((ok, bad) => new MailComposer({ from: mb.name ? `"${mb.name.replace(/"/g, '')}" <${mb.email}>` : mb.email, to, cc, subject, text, html, attachments, messageId: info.messageId, inReplyTo, references, date: new Date() }).compile().build((e, m) => (e ? bad(e) : ok(m))));
      await this.imap(mb, async (c) => { const box = (await c.list()).find((f) => f.specialUse === '\\Sent') || { path: 'Sent' }; await c.append(box.path, raw, ['\\Seen']); });
      savedToSent = true;
    } catch {}
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, savedToSent };
  }
}

module.exports = { Mailer, PRESETS, secureFor, explain };
