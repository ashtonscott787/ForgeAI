'use strict';
// Network layer for self-hosted model servers: any URL, auth headers, TLS (verify / trust-pinned / insecure opt-in),
// timeouts, plain-English errors, and "does this leave the local network?" classification.
const tls = require('node:tls');
const net = require('node:net');
const { fetch, Agent, buildConnector } = require('undici');

const agents = new Map();
function agentFor({ insecure = false, pin = null, connectTimeoutMs = 8000, headersTimeoutMs = 120000 } = {}) {
  const key = `${insecure ? 1 : 0}|${pin || ''}|${connectTimeoutMs}|${headersTimeoutMs}`;
  if (agents.has(key)) return agents.get(key);
  // No TLS session resumption when pinning: a resumed session presents no certificate to check.
  const base = buildConnector({ rejectUnauthorized: !(insecure || pin), timeout: connectTimeoutMs, ...(pin ? { maxCachedSessions: 0 } : {}) });
  const connect = (opts, cb) => base(opts, (err, sock) => {
    if (err) return cb(err);
    if (pin && opts.protocol === 'https:') {
      const c = sock.getPeerCertificate && sock.getPeerCertificate();
      if (!c || c.fingerprint256 !== pin) { sock.destroy(); return cb(Object.assign(new Error(`The certificate of ${opts.hostname} changed since you trusted it`), { code: 'CERT_PIN_MISMATCH' })); }
    }
    cb(null, sock);
  });
  const a = new Agent({ connect, headersTimeout: headersTimeoutMs, bodyTimeout: 0, keepAliveTimeout: 10000 });
  agents.set(key, a);
  return a;
}

// opts.net = { tlsMode: 'verify'|'pin'|'insecure', pin, timeoutMs }
function netFetch(url, init = {}, o = {}) {
  const { tlsMode = 'verify', pin = null, timeoutMs = 0 } = o;
  const dispatcher = agentFor({ insecure: tlsMode === 'insecure', pin: tlsMode === 'pin' ? pin : null, connectTimeoutMs: Math.min(timeoutMs || 8000, 30000), headersTimeoutMs: timeoutMs ? Math.max(timeoutMs, 5000) : 120000 });
  return fetch(url, { ...init, dispatcher });
}

// Server certificate details (for the "trust this certificate" opt-in).
function certInfo(url) {
  return new Promise((ok) => {
    let u; try { u = new URL(url); } catch { return ok(null); }
    if (u.protocol !== 'https:') return ok(null);
    const s = tls.connect({ host: u.hostname, port: +u.port || 443, servername: net.isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerCertificate() || {}; const authorized = s.authorized; const why = s.authorizationError; s.end();
      ok({ subject: c.subject && c.subject.CN, names: String(c.subjectaltname || '').split(',').map((x) => x.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean).slice(0, 10), issuer: c.issuer && (c.issuer.O || c.issuer.CN), validTo: c.valid_to, fingerprint: c.fingerprint256, trusted: authorized, problem: authorized ? null : String(why || '') });
    });
    s.on('error', () => ok(null)); s.on('timeout', () => { s.destroy(); ok(null); });
  });
}

// Where does a URL go? local = this computer, lan = private network, vpn = Tailscale/CGNAT range, internet = leaves your network.
function networkScope(url) {
  if (String(url).startsWith('forgeai-engine:')) return 'local';
  let h; try { h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return 'internet'; }
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return 'local';
  if (/\.local$|\.lan$|\.home\.arpa$|\.internal$/.test(h) || !h.includes('.') && !net.isIP(h)) return 'lan';
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return 'lan';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /\.ts\.net$/.test(h)) return 'vpn';
  return 'internet';
}
const SCOPE_LABEL = { local: 'This computer', lan: 'Your network', vpn: 'Private VPN', internet: 'Leaves your network' };

// Plain-English error: what failed, where, next action.
function explainNet(e, url, what = 'Connecting') {
  const c = (e && e.cause) || e || {}; const code = c.code || e.code || ''; const msg = String(c.message || e.message || e);
  let where = url; try { const u = new URL(url); where = u.host; } catch {}
  const r = (next, reason) => Object.assign(new Error(`${what} failed at ${where}: ${reason}. ${next}`), { code: code || 'NET', where, next, status: e && e.status });
  if (e && e.status === 401 || e && e.status === 403) return r('Check the API key or token in this provider’s settings.', e.status === 401 ? 'the API key was rejected (401)' : 'access denied (403)');
  if (e && e.status === 404) return r('Check the address — OpenAI-compatible servers usually end in /v1.', 'the endpoint was not found (404)');
  if (e && e.status === 429) return r('Wait a moment, or lower usage in Limits.', 'rate limited (429)');
  if (e && (e.status === 400 || e.status === 413 || e.status === 422)) return r('Shorten the conversation, remove large attachments, or try another model (Try Another Model…).', `the request was rejected (${e.status}): ${msg.replace(/^.*?error \d+: /, '').slice(0, 160)}`);
  if (e && e.status >= 500) return r('The server had a problem — check it is running and has a model loaded.', `server error ${e.status}`);
  if (code === 'ECONNREFUSED') return r('Make sure the server is running and listening on that port (and on the network, not only 127.0.0.1).', 'connection refused');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return r('Check the host name, or use the IP address.', 'the host name could not be found');
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(code)) return r('Check the computer is on, on the same network or VPN, and that a firewall is not blocking the port.', 'no response (timed out)');
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return r('The server is reachable but too slow to answer — it may be loading a model. Try again or raise the timeout.', 'the server took too long to respond');
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|ALTNAME|CERT_PIN_MISMATCH/.test(code + msg)) return r('If this is your own server, use “Trust this certificate” in the provider settings.', /PIN_MISMATCH/.test(code) ? 'its certificate changed since you trusted it' : 'its security certificate is not trusted');
  if (code === 'ECONNRESET' || /socket|other side closed/i.test(msg)) return r('If the server uses HTTPS, make sure the address starts with https://.', 'the connection was dropped');
  if (/timeout/i.test(e.name || '') || code === 23 || /due to timeout/i.test(msg)) return r('Check the computer is on and reachable (same network or VPN), or raise the timeout if the server is slow.', 'no response (timed out)');
  if (/abort/i.test(e.name || '') || code === 'ABORT_ERR') return r('Raise the timeout if the server is slow.', 'it timed out');
  return r('Check the address and that the server is running.', msg.slice(0, 160));
}
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ECONNREFUSED/;
const isTransient = (e) => !!e && ((e.status && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504)) || TRANSIENT.test(String((e.cause && e.cause.code) || e.code || '')));

module.exports = { netFetch, certInfo, networkScope, SCOPE_LABEL, explainNet, isTransient };
