'use strict';
// Storage layer.
// - platform.sqlite holds platform-wide records (organisations, users, nodes, grants, provider configs).
// - Every organisation gets its OWN database file (orgs/<id>/org.sqlite) and its own files folder.
//   Code can only reach an organisation's data through openOrg(orgId), which the API layer calls
//   only after an authorisation check. There is no query that spans organisations.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const now = () => new Date().toISOString();
const uid = (p = '') => p + crypto.randomBytes(8).toString('hex');

const PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'company', color TEXT DEFAULT '#4f7cff',
  logo TEXT, domain TEXT, created_at TEXT, archived INTEGER DEFAULT 0,
  quota_ram_gb REAL DEFAULT 0, quota_storage_gb REAL DEFAULT 0, cloud_budget_month REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT, pass_hash TEXT,
  platform_role TEXT DEFAULT 'none', created_at TEXT, disabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS memberships (user_id TEXT, org_id TEXT, role TEXT, PRIMARY KEY (user_id, org_id));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, expires_at TEXT, ip TEXT, kind TEXT DEFAULT 'web');
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, kind TEXT, source_org TEXT, target_org TEXT, scopes TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, url TEXT, secret_ref TEXT, ram_gb REAL DEFAULT 0,
  enabled INTEGER DEFAULT 1, is_local INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, provider TEXT, org_id TEXT, label TEXT, secret_ref TEXT, base_url TEXT,
  status TEXT, status_detail TEXT, models TEXT, budget_month REAL DEFAULT 0, created_at TEXT, checked_at TEXT);
CREATE TABLE IF NOT EXISTS prices (pattern TEXT PRIMARY KEY, input_per_m REAL, output_per_m REAL);
CREATE TABLE IF NOT EXISTS platform_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, org_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS owner_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, role TEXT, content TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, provider TEXT, provider_id TEXT, model TEXT, node TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost REAL, ok INTEGER, error TEXT, agent_id TEXT, kind TEXT, ms INTEGER);
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, path TEXT, mode TEXT DEFAULT 'read', created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, org_id TEXT, name TEXT, transport TEXT, command TEXT, args TEXT, env_ref TEXT, url TEXT, headers_ref TEXT,
  oauth_ref TEXT, enabled INTEGER DEFAULT 1, status TEXT, status_detail TEXT, tools TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, key_hash TEXT, hint TEXT, created_by TEXT, created_at TEXT, last_used TEXT);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT, color TEXT, icon TEXT, purpose TEXT, engine TEXT DEFAULT 'auto', speed TEXT DEFAULT 'balanced',
  instructions TEXT, temperature REAL, max_output INTEGER DEFAULT 0, web INTEGER DEFAULT 0, tools INTEGER DEFAULT 1,
  daily_limit INTEGER DEFAULT 0, org_ids TEXT, enabled INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at TEXT);
`;

const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, instructions TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, model_mode TEXT DEFAULT 'auto', sensitivity TEXT DEFAULT 'normal',
  web INTEGER DEFAULT 0, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conv_id TEXT, role TEXT, content TEXT, meta TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, conv_id TEXT, message_id TEXT, name TEXT, mime TEXT, size INTEGER, path TEXT, text TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, path TEXT, text TEXT, share_owner_ai INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, content TEXT, source TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT, description TEXT, instructions TEXT, model_mode TEXT DEFAULT 'auto',
  sensitivity TEXT DEFAULT 'normal', schedule TEXT, schedule_prompt TEXT, can_talk_to TEXT DEFAULT '["*"]',
  requires_approval INTEGER DEFAULT 0, web INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT, last_run TEXT, next_run TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, input TEXT, status TEXT, output TEXT, error TEXT,
  created_by TEXT, parent_task TEXT, due_at TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, model_used TEXT, route TEXT);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, kind TEXT, title TEXT, detail TEXT, payload TEXT, status TEXT DEFAULT 'pending',
  requested_by TEXT, decided_by TEXT, created_at TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, provider TEXT, provider_id TEXT, model TEXT, node TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost REAL, ok INTEGER, error TEXT, agent_id TEXT, kind TEXT, ms INTEGER);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS steps (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, tool TEXT, args TEXT, content TEXT, files TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id);
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY, name TEXT, email TEXT, imap_host TEXT, imap_port INTEGER, imap_secure INTEGER, smtp_host TEXT, smtp_port INTEGER,
  smtp_secure INTEGER, username TEXT, secret_ref TEXT, status TEXT, status_detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, title TEXT, instruction TEXT, agent_id TEXT, repeat TEXT, next_run TEXT, last_run TEXT, enabled INTEGER DEFAULT 1,
  conv_id TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, title TEXT, body TEXT, link TEXT, read INTEGER DEFAULT 0, created_at TEXT);
`;
const ORG_MIGRATIONS = [
  "ALTER TABLE agents ADD COLUMN color TEXT", "ALTER TABLE agents ADD COLUMN autonomy TEXT DEFAULT 'ask_risky'",
  "ALTER TABLE agents ADD COLUMN tools TEXT", "ALTER TABLE agents ADD COLUMN folders TEXT", "ALTER TABLE agents ADD COLUMN mailboxes TEXT",
  "ALTER TABLE agents ADD COLUMN mcp TEXT", "ALTER TABLE agents ADD COLUMN max_steps INTEGER DEFAULT 30", "ALTER TABLE agents ADD COLUMN confirm_payments INTEGER DEFAULT 1",
  "ALTER TABLE agents ADD COLUMN inbox_watch TEXT", "ALTER TABLE agents ADD COLUMN title TEXT",
  "ALTER TABLE conversations ADD COLUMN model_pick TEXT", "ALTER TABLE usage ADD COLUMN ttft_ms INTEGER", "ALTER TABLE usage ADD COLUMN endpoint TEXT", "ALTER TABLE usage ADD COLUMN scope TEXT", "ALTER TABLE usage ADD COLUMN stop TEXT", "ALTER TABLE usage ADD COLUMN bottleneck TEXT", "ALTER TABLE usage ADD COLUMN profile_id TEXT", "CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts)",
  "ALTER TABLE mailboxes ADD COLUMN tls_pin TEXT", "ALTER TABLE mailboxes ADD COLUMN read_ok INTEGER", "ALTER TABLE mailboxes ADD COLUMN send_ok INTEGER", "ALTER TABLE mailboxes ADD COLUMN read_detail TEXT", "ALTER TABLE mailboxes ADD COLUMN send_detail TEXT", "ALTER TABLE mailboxes ADD COLUMN signature TEXT",
  "ALTER TABLE agents ADD COLUMN runs_per_day INTEGER DEFAULT 0", "ALTER TABLE agents ADD COLUMN budget_month REAL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN state TEXT", "ALTER TABLE tasks ADD COLUMN kind TEXT", "ALTER TABLE tasks ADD COLUMN conv_id TEXT", "ALTER TABLE tasks ADD COLUMN current TEXT",
  "ALTER TABLE agents ADD COLUMN place TEXT",
  "ALTER TABLE usage ADD COLUMN task TEXT", "ALTER TABLE usage ADD COLUMN error_kind TEXT", "ALTER TABLE usage ADD COLUMN queue_ms INTEGER", "ALTER TABLE usage ADD COLUMN load_ms INTEGER", "ALTER TABLE usage ADD COLUMN fallback_from TEXT",
];

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'orgs'), { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'platform.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(PLATFORM_SCHEMA);
    for (const m of ['ALTER TABLE nodes ADD COLUMN link_id TEXT', 'ALTER TABLE nodes ADD COLUMN org_ids TEXT', 'ALTER TABLE nodes ADD COLUMN grants TEXT', 'ALTER TABLE nodes ADD COLUMN cert_pin TEXT', 'ALTER TABLE nodes ADD COLUMN preset TEXT', 'ALTER TABLE nodes ADD COLUMN api_key_ref TEXT', 'ALTER TABLE nodes ADD COLUMN headers_ref TEXT', "ALTER TABLE nodes ADD COLUMN tls_mode TEXT DEFAULT 'verify'", 'ALTER TABLE nodes ADD COLUMN timeout_ms INTEGER DEFAULT 0', 'ALTER TABLE orgs ADD COLUMN calls_per_day INTEGER DEFAULT 0', 'ALTER TABLE orgs ADD COLUMN tokens_per_day INTEGER DEFAULT 0', 'ALTER TABLE orgs ADD COLUMN max_answer_tokens INTEGER DEFAULT 0', 'ALTER TABLE usage ADD COLUMN profile_id TEXT', 'ALTER TABLE usage ADD COLUMN ttft_ms INTEGER', 'ALTER TABLE usage ADD COLUMN endpoint TEXT', 'ALTER TABLE usage ADD COLUMN scope TEXT', 'ALTER TABLE usage ADD COLUMN stop TEXT', 'ALTER TABLE usage ADD COLUMN bottleneck TEXT', 'ALTER TABLE usage ADD COLUMN task TEXT', 'ALTER TABLE usage ADD COLUMN error_kind TEXT', 'ALTER TABLE usage ADD COLUMN queue_ms INTEGER', 'ALTER TABLE usage ADD COLUMN load_ms INTEGER', 'ALTER TABLE usage ADD COLUMN fallback_from TEXT']) { try { this.db.exec(m); } catch {} }
    this.orgDbs = new Map();
  }
  // ---- generic helpers
  all(sql, ...a) { return this.db.prepare(sql).all(...a); }
  get(sql, ...a) { return this.db.prepare(sql).get(...a); }
  run(sql, ...a) { return this.db.prepare(sql).run(...a); }

  getSetting(key, dflt = null) {
    const r = this.get('SELECT value FROM settings WHERE key=?', key);
    return r ? JSON.parse(r.value) : dflt;
  }
  setSetting(key, value) {
    this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }
  audit(actor, action, orgId, detail) {
    this.run('INSERT INTO platform_audit(ts,actor,action,org_id,detail) VALUES(?,?,?,?,?)', now(), actor || 'system', action, orgId || null, typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
  }

  // ---- organisations
  listOrgs() { return this.all('SELECT * FROM orgs WHERE archived=0 ORDER BY kind=\'personal\', created_at, name'); }
  getOrg(id) { return this.get('SELECT * FROM orgs WHERE id=?', id); }
  createOrg({ name, kind = 'company', color = '#4f7cff' }) {
    const id = uid('org_');
    this.run('INSERT INTO orgs(id,name,kind,color,created_at) VALUES(?,?,?,?,?)', id, name, kind, color, now());
    // normalise early installs: 'company' is the old name for 'business'; keep DB value, map on read elsewhere.
    const o = this.openOrg(id);
    o.setPolicy(defaultPolicy(kind));
    return this.getOrg(id);
  }
  orgDir(id) {
    if (!/^org_[a-f0-9]{16}$/.test(id)) throw new Error('Invalid organisation id');
    return path.join(this.dataDir, 'orgs', id);
  }
  openOrg(id) {
    if (this.orgDbs.has(id)) return this.orgDbs.get(id);
    const org = this.getOrg(id);
    if (!org) throw Object.assign(new Error('Organisation not found'), { status: 404 });
    const dir = this.orgDir(id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'org.sqlite'));
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec(ORG_SCHEMA);
    for (const m of ORG_MIGRATIONS) { try { db.exec(m); } catch {} }
    const handle = new OrgDB(this, id, dir, db);
    this.orgDbs.set(id, handle);
    return handle;
  }
  closeOrg(id) {
    const h = this.orgDbs.get(id);
    if (h) { try { h.db.close(); } catch {} this.orgDbs.delete(id); }
  }
}

class OrgDB {
  constructor(store, id, dir, db) { this.store = store; this.id = id; this.dir = dir; this.db = db; }
  all(sql, ...a) { return this.db.prepare(sql).all(...a); }
  get(sql, ...a) { return this.db.prepare(sql).get(...a); }
  run(sql, ...a) { return this.db.prepare(sql).run(...a); }
  exec(sql) { return this.db.exec(sql); }
  get org() { return this.store.getOrg(this.id); }
  kv(key, dflt = null) { const r = this.get('SELECT value FROM kv WHERE key=?', key); return r ? JSON.parse(r.value) : dflt; }
  setKv(key, v) { this.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(v)); }
  policy() { return { ...defaultPolicy(this.org.kind), ...(this.kv('policy') || {}) }; }
  setPolicy(p) { this.setKv('policy', p); }
  audit(actor, action, detail) {
    this.run('INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)', now(), actor || 'system', action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
  }
  monthSpend() {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    return this.get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts>=?', start.toISOString()).c;
  }
  // Today's use (server's local day) — optionally for one agent or one of "My models".
  dayUsage({ agentId, profileId } = {}) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    let sql = 'SELECT COUNT(*) calls, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=?'; const a = [start.toISOString()];
    if (agentId) { sql += ' AND agent_id=?'; a.push(agentId); }
    if (profileId) { sql += ' AND profile_id=?'; a.push(profileId); }
    return this.get(sql, ...a);
  }
  agentMonthSpend(agentId) {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    return this.get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts>=? AND agent_id=?', start.toISOString(), agentId).c;
  }
  storageBytes() { return dirSize(path.join(this.dir, 'files')); }
}

function dirSize(p) {
  let t = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      t += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
  } catch {}
  return t;
}

function defaultPolicy(kind) {
  return {
    default_mode: 'local_first',        // local_first | cloud_first | local_only
    confidential: 'local_only',         // how "Confidential" conversations are handled
    finance: 'approval',                // local_only | approval | allowed  (external models for finance data)
    research: 'cloud_allowed',          // cloud_allowed | local_only
    allow_openai: true, allow_anthropic: true, allow_google: true,
    allow_web_search: true,
    speed_critical: false,
    backup: { enabled: true, every_hours: 24, keep: 14, dest: '' },
  };
}

module.exports = { Store, OrgDB, now, uid, defaultPolicy };
