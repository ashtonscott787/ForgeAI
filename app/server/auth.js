'use strict';
const crypto = require('crypto');
const { uid, now } = require('./db');

const ROLE_RANK = { read_only: 1, user: 2, manager: 3, org_admin: 4, org_owner: 5 };
const ACTION_MIN = { view: 1, chat: 2, tasks: 2, edit: 2, approve: 3, agents: 3, manage: 4, own: 5 };
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'base64');
  return want.length === calc.length && crypto.timingSafeEqual(want, calc);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Auth {
  constructor(store) { this.store = store; this.attempts = new Map(); }
  hasUsers() { return !!this.store.get('SELECT 1 FROM users LIMIT 1'); }
  createUser({ username, password, displayName, platformRole = 'none' }) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._@-]{2,64}$/.test(username)) throw Object.assign(new Error('Username: 2–64 letters, numbers, . _ @ -'), { status: 400 });
    if (String(password || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
    if (this.store.get('SELECT 1 FROM users WHERE username=?', username)) throw Object.assign(new Error('That username already exists'), { status: 400 });
    const id = uid('usr_');
    this.store.run('INSERT INTO users(id,username,display_name,pass_hash,platform_role,created_at) VALUES(?,?,?,?,?,?)', id, username, displayName || username, hashPassword(password), platformRole, now());
    return this.store.get('SELECT * FROM users WHERE id=?', id);
  }
  setPassword(userId, pw) {
    if (String(pw || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
    this.store.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(pw), userId);
    this.store.run('DELETE FROM sessions WHERE user_id=? AND kind=\'web\'', userId);
  }
  // Brute-force protection: 8 failures per 15 minutes per IP+username.
  login(username, password, ip) {
    const key = ip + '|' + String(username).toLowerCase();
    const a = this.attempts.get(key) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 8) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'), { status: 429 });
    const u = this.store.get('SELECT * FROM users WHERE username=? AND disabled=0', String(username || '').trim().toLowerCase());
    if (!u || !verifyPassword(password, u.pass_hash)) {
      a.n++; this.attempts.set(key, a);
      this.store.audit(username, 'login.failed', null, { ip });
      throw Object.assign(new Error('Wrong username or password'), { status: 401 });
    }
    this.attempts.delete(key);
    this.store.audit(u.username, 'login', null, { ip });
    return this.newSession(u.id, ip, 'web');
  }
  newSession(userId, ip, kind = 'web', days = SESSION_DAYS) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,kind) VALUES(?,?,?,?,?,?)', sha(token), userId, now(), new Date(Date.now() + days * 864e5).toISOString(), ip || '', kind);
    return token;
  }
  userFromToken(token) {
    if (!token) return null;
    const s = this.store.get('SELECT * FROM sessions WHERE token_hash=?', sha(token));
    if (!s || s.expires_at < now()) return null;
    const u = this.store.get('SELECT * FROM users WHERE id=? AND disabled=0', s.user_id);
    return u || null;
  }
  logout(token) { if (token) this.store.run('DELETE FROM sessions WHERE token_hash=?', sha(token)); }

  role(user, orgId) {
    if (!user) return null;
    if (user.platform_role === 'owner' || user.platform_role === 'admin') return 'org_owner';
    const m = this.store.get('SELECT role FROM memberships WHERE user_id=? AND org_id=?', user.id, orgId);
    return m ? m.role : null;
  }
  can(user, orgId, action) {
    const r = this.role(user, orgId);
    return !!r && ROLE_RANK[r] >= ACTION_MIN[action];
  }
  orgsFor(user) {
    const all = this.store.listOrgs();
    if (user.platform_role === 'owner' || user.platform_role === 'admin') return all.map((o) => ({ ...o, role: 'org_owner' }));
    const ms = new Map(this.store.all('SELECT org_id, role FROM memberships WHERE user_id=?', user.id).map((m) => [m.org_id, m.role]));
    return all.filter((o) => ms.has(o.id)).map((o) => ({ ...o, role: ms.get(o.id) }));
  }
}

module.exports = { Auth, ROLE_RANK, hashPassword, verifyPassword, sha };
