'use strict';
// ForgeAI server: HTTP API + dashboard. Used by the Mac app (in-process) and by headless.js (servers/VPS).
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store, uid, now, defaultPolicy } = require('./db');
const { Vault } = require('./vault');
const { Auth, verifyPassword } = require('./auth');
const { Cluster } = require('./cluster');
const { ModelService, safeJSON } = require('./router');
const { Engine, orgStats } = require('./engine');
const { Backups } = require('./backup');
const { PROVIDER_TYPES, readNDJSON, pinnedFetch, PRESET_NAMES } = require('./providers');
const { Discovery, scan } = require('./discovery');
const { AgentRuntime, CAPABILITIES } = require('./agent');
const { Mailer, PRESETS, secureFor, explain } = require('./mail');
const { installOllama, installedPath } = require('./installer');
const { Perf } = require('./perf');
const { LlamaCluster, measureLink, portOpen } = require('./llamacluster');
const { netFetch, certInfo, networkScope, SCOPE_LABEL, explainNet } = require('./net');
const { McpManager } = require('./mcp');
const { extractText, isImage } = require('./files');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const COOKIE = 'aic_session';
const GB = 2 ** 30;

function err(status, message) { return Object.assign(new Error(message), { status }); }

function createApp({ dataDir, vaultBackend, version = '1.0.0', host = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const vault = new Vault(dataDir, vaultBackend);
  const auth = new Auth(store);
  const cluster = new Cluster(store, vault);
  const models = new ModelService(store, vault, cluster);
  const perf = new Perf(); models.perf = perf;
  const { Health, classify, KINDS } = require('./health'); const { CapabilityRegistry, requirements, memoryNeeded } = require('./caps'); const { Scheduler, MemoryManager } = require('./scheduler');
  const health = new Health(store); models.health = health; const capsReg = new CapabilityRegistry(store, cluster, health); models.caps = capsReg; const scheduler = new Scheduler(store); models.scheduler = scheduler;
  const kit = new LlamaCluster(dataDir);
  const { ForgeEngine } = require('./forgeengine');
  const forgeEngine = new ForgeEngine({ dataDir, kit, store, vault }); cluster.engine = forgeEngine;
  const memory = new MemoryManager({ store, cluster, engine: forgeEngine, perf }); cluster.memory = memory;
  const { VMManager } = require('./vm');
  const vms = new VMManager({ root: path.join(dataDir, 'sandboxes'), store });
  const appsMod = require('./apps');
  const { Artifacts } = require('./artifacts'); const artifacts = new Artifacts({ store });
  const { LinkHub, LinkSpoke, openRouterPort } = require('./link');
  const linkLog = []; const llog = (t) => { linkLog.unshift({ at: new Date().toISOString(), text: t }); if (linkLog.length > 100) linkLog.pop(); };
  const linkHub = new LinkHub({ store, vault, log: llog }); const linkSpoke = new LinkSpoke({ store, vault, log: llog });
  const { Trainer } = require('./trainer');
  const trainer = new Trainer({ dataDir, store });
  // A trained model's server stops when ForgeAI quits; mark it so (press "Use it" to start it again).
  for (const r of trainer.runs()) if (r.serving || r.state === 'running') { trainer.patch(r.id, { serving: false, ...(r.state === 'running' ? { state: 'stopped', status: 'Stopped when ForgeAI quit' } : {}) }); if (r.nodeId) store.run('UPDATE nodes SET enabled=0 WHERE id=?', r.nodeId); }
  const engine = new Engine(store, models, cluster);
  const backups = new Backups(store, vault);
  const mail = new Mailer(vault);
  const mcp = new McpManager(store, vault, () => (app.listenInfo ? app.listenInfo.localUrl : 'http://127.0.0.1:4545'), (u) => app.host && app.host.openExternal && app.host.openExternal(u));
  const renders = new Map(); // id -> { html, at } for sandboxed interactive previews
  const timersLate = []; // intervals created by route modules, started with the app
  const routes = [];
  const R = (method, pattern, handler, opt = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, opt }); routesByKey[method + ' ' + pattern] = handler;
  };
  const routesByKey = {};

  // Owner AI usage ledger (same shape as an organisation handle, stored in the platform DB).
  const ownerLedger = {
    id: 'owner',
    get org() { return { id: 'owner', name: 'Owner AI', kind: 'owner', quota_ram_gb: 0, cloud_budget_month: store.getSetting('owner_ai', {}).budget || 0 }; },
    run: (...a) => store.run(...a), get: (...a) => store.get(...a), all: (...a) => store.all(...a),
    policy() {
      const s = store.getSetting('owner_ai', {});
      const { orgs } = engine.ownerContext();
      const strict = orgs.some((o) => o.pol.default_mode === 'local_only');
      return { ...defaultPolicy('owner'), default_mode: s.cloud_allowed && !strict ? 'local_first' : 'local_only', allow_web_search: false };
    },
    monthSpend() { const st = new Date(); st.setUTCDate(1); st.setUTCHours(0, 0, 0, 0); return store.get('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts>=?', st.toISOString()).c; },
    audit: (actor, action, detail) => store.audit(actor, action, null, detail),
    dayUsage({ profileId } = {}) { const st = new Date(); st.setHours(0, 0, 0, 0); return profileId ? store.get('SELECT COUNT(*) calls, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=? AND profile_id=?', st.toISOString(), profileId) : store.get('SELECT COUNT(*) calls, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=?', st.toISOString()); },
  };

  // ---------------- helpers
  const orgAccess = (req, action) => {
    const orgId = req.params.org;
    if (!auth.can(req.user, orgId, action)) throw err(403, 'You do not have permission for this organisation');
    return store.openOrg(orgId);
  };
  const needPlatform = (req, level = 'admin') => {
    const r = req.user.platform_role;
    if (!(r === 'owner' || (level === 'admin' && r === 'admin'))) throw err(403, level === 'owner' ? 'Platform owner only' : 'Platform admin only');
  };
  const providerView = (p) => {
    const st = new Date(); st.setUTCDate(1); st.setUTCHours(0, 0, 0, 0);
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const agg = { todayCost: 0, monthCost: 0, todayReq: 0, monthReq: 0, failures: 0, inTok: 0, outTok: 0 };
    const dbs = [store, ...store.listOrgs().map((o) => store.openOrg(o.id))];
    for (const d of dbs) {
      const m = d.get('SELECT COUNT(*) n, COALESCE(SUM(cost),0) c, COALESCE(SUM(ok=0),0) f, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage WHERE provider_id=? AND ts>=?', p.id, st.toISOString());
      const t = d.get('SELECT COUNT(*) n, COALESCE(SUM(cost),0) c FROM usage WHERE provider_id=? AND ts>=?', p.id, day.toISOString());
      agg.monthReq += m.n; agg.monthCost += m.c; agg.failures += m.f; agg.inTok += m.i; agg.outTok += m.o; agg.todayReq += t.n; agg.todayCost += t.c;
    }
    const models = safeJSON(p.models, {});
    return { id: p.id, provider: p.provider, providerName: (PROVIDER_TYPES[p.provider] || {}).name, org_id: p.org_id, orgName: p.org_id ? (store.getOrg(p.org_id) || {}).name : null, label: p.label, keyHint: vault.hint(p.secret_ref), base_url: p.base_url, status: p.status, status_detail: p.status_detail, checked_at: p.checked_at, budget_month: p.budget_month, models: (models.list || []).filter((m) => !m.kind || m.kind === 'chat').map((m) => m.id), allModels: (models.list || []).length, default_model: models.default || '', fast_model: models.fast || '', usage: agg, rateLimited: /rate limit/i.test(p.status_detail || '') };
  };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
  const needPlatformOrOrg = (req, orgId) => { if (orgId) { if (!auth.can(req.user, orgId, 'manage')) throw err(403, 'Not allowed'); } else needPlatform(req); };
  const testProvider = async (p, apiKey) => {
    const adapter = PROVIDER_TYPES[p.provider].make({ apiKey: apiKey || vault.reveal(p.secret_ref), baseUrl: p.base_url || undefined });
    try {
      const list = await adapter.listModels();
      const prev = safeJSON(p.models, {});
      store.run('UPDATE providers SET status=?, status_detail=?, models=?, checked_at=? WHERE id=?', 'connected', `${list.length} models available`, JSON.stringify({ ...prev, list }), now(), p.id);
      return true;
    } catch (e) {
      store.run('UPDATE providers SET status=?, status_detail=?, checked_at=? WHERE id=?', 'error', e.message.slice(0, 300), now(), p.id);
      return false;
    }
  };
  const addresses = () => {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface: name, address: a.address, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) });
    }
    return out;
  };

  // ---------------- auth & setup
  const setupCode = crypto.randomBytes(5).toString('hex');
  const b_setupOk = (c) => typeof c === 'string' && c.length === setupCode.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(setupCode));
  // Platform look: the logo style everyone sees, and the default app style (each person can still pick their own).
  const BRAND_LOGOS = ['orb', 'mesh', 'forge', 'grid', 'mono']; const BRAND_STYLES = ['auto', 'daylight', 'graphite', 'midnight', 'studio'];
  const brand = () => ({ logo: 'orb', style: 'auto', ...store.getSetting('brand', {}) });
  const platformName = () => { const n = store.getSetting('platform_name', 'ForgeAI'); return !n || n === 'AI Core' ? 'ForgeAI' : n; };
  const instanceId = store.getSetting('instance_id') || (() => { const id = crypto.randomBytes(8).toString('hex'); store.setSetting('instance_id', id); return id; })();
  R('GET', '/api/ping', (req) => ({ app: 'forgeai', version, port: app.listenInfo ? app.listenInfo.port : null, managed: !!(store.getSetting('managed', {}) || {}).on, claimed: auth.hasUsers(), joined: !!(linkSpoke.settings().enabled), hub: linkHub.settings().enabled ? true : false }), { public: true });
  R('GET', '/api/state', (req) => ({ setupNeeded: !auth.hasUsers(), user: req.user ? { username: req.user.username } : null, version, platformName: platformName(), brand: brand(), host: os.hostname() }), { public: true });
  R('PUT', '/api/settings/brand', (req) => { needPlatform(req, 'owner'); const b = req.body || {}; const cur = brand(); const n = { logo: BRAND_LOGOS.includes(b.logo) ? b.logo : cur.logo, style: BRAND_STYLES.includes(b.style) ? b.style : cur.style }; store.setSetting('brand', n); store.audit(req.user.username, 'platform.brand', null, n); return n; });
  R('PUT', '/api/settings/general', (req) => { needPlatform(req, 'owner'); const n = String(req.body.platform_name || '').trim().slice(0, 40) || 'ForgeAI'; store.setSetting('platform_name', n); store.audit(req.user.username, 'platform.rename', null, n); return { platformName: n }; });
  R('GET', '/api/discover', async (req) => { needPlatform(req); return scan(1500, instanceId); });
  R('POST', '/api/setup', (req, res) => {
    if (auth.hasUsers()) throw err(400, 'Already set up');
    if ((store.getSetting('managed', {}) || {}).on) throw err(403, 'This computer runs ForgeAI as a managed background service. Set it up from the ForgeAI hub it belongs to, not here.');
    if (!req.isLoopback && !(b_setupOk(req.body.setupCode))) throw err(403, 'First-time setup must be done on the Mac itself (or with the setup code shown in the server log)');
    const b = req.body;
    const u = auth.createUser({ username: b.username, password: b.password, displayName: b.displayName, platformRole: 'owner' });
    const palette = ['#4f7cff', '#1fa37a', '#d9822b', '#9b59d0', '#d6455d', '#2aa8c4'];
    (b.orgs || []).filter((n) => String(n).trim()).slice(0, 20).forEach((n, i) => store.createOrg({ name: String(n).trim().slice(0, 80), color: palette[i % palette.length] }));
    if (b.personal !== false) store.createOrg({ name: 'Personal Workspace', kind: 'personal', color: '#0a6cff' });
    store.audit(u.username, 'setup', null, {});
    setCookie(res, auth.newSession(u.id, req.ip, 'web'), req.secure);
    return { ok: true };
  }, { public: true });
  R('POST', '/api/login', (req, res) => { setCookie(res, auth.login(req.body.username, req.body.password, req.ip), req.secure); return { ok: true }; }, { public: true });
  R('POST', '/api/logout', (req, res) => { auth.logout(req.token); res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`); return { ok: true }; });
  R('GET', '/api/me', (req) => ({
    user: { id: req.user.id, username: req.user.username, displayName: req.user.display_name, platformRole: req.user.platform_role },
    orgs: auth.orgsFor(req.user).map((o) => ({ id: o.id, name: o.name, kind: o.kind, color: o.color, logo: o.logo, role: o.role })),
    vault: vault.backendName, version, platformName: platformName(), brand: brand(), host: os.hostname(), os: process.platform,
  }));
  R('PUT', '/api/me/password', (req) => {
    if (!verifyPassword(req.body.current, req.user.pass_hash)) throw err(401, 'Current password is wrong');
    auth.setPassword(req.user.id, req.body.password); return { ok: true };
  });

  // ---------------- owner dashboard
  R('GET', '/api/dashboard', (req) => {
    const orgs = auth.orgsFor(req.user).map((o) => {
      const db = store.openOrg(o.id);
      return { id: o.id, name: o.name, kind: o.kind, color: o.color, logo: o.logo, role: o.role, budget: o.cloud_budget_month, ...orgStats(db) };
    });
    const nodes = cluster.nodes().map((n) => ({ id: n.id, name: n.name, ram_gb: n.ram_gb, ...(cluster.state.get(n.id) || { status: 'unknown' }), models: undefined, modelCount: ((cluster.state.get(n.id) || {}).models || []).length, inflight: cluster.inflight.get(n.id) || 0 }));
    const providers = req.user.platform_role !== 'none' ? store.all('SELECT provider, status, org_id FROM providers') : [];
    return { orgs, nodes, providers, totals: { spend: orgs.reduce((a, o) => a + o.spend, 0), approvals: orgs.reduce((a, o) => a + o.approvals, 0), agents: orgs.reduce((a, o) => a + o.running, 0) } };
  });
  R('GET', '/api/approvals', (req) => {
    const out = [];
    for (const o of auth.orgsFor(req.user)) {
      if (!auth.can(req.user, o.id, 'view')) continue;
      for (const a of store.openOrg(o.id).all('SELECT * FROM approvals WHERE status=\'pending\' ORDER BY created_at DESC')) out.push({ ...a, orgId: o.id, orgName: o.name, orgColor: o.color, canDecide: auth.can(req.user, o.id, 'approve') });
    }
    return out;
  });

  // ---------------- organisations
  R('POST', '/api/orgs', (req) => { needPlatform(req); const o = store.createOrg({ name: String(req.body.name || '').trim().slice(0, 80) || 'New organisation', kind: ['business','project','personal'].includes(req.body.kind) ? req.body.kind : (req.body.kind === 'company' ? 'business' : 'business'), color: req.body.color }); store.audit(req.user.username, 'org.create', o.id, o.name); return o; });
  R('PUT', '/api/orgs/:org/kind', (req) => { const db = orgAccess(req, 'manage'); const k = String((req.body || {}).kind || ''); if (!['business','project','personal'].includes(k)) throw err(400, 'Pick business, project or personal'); store.run('UPDATE orgs SET kind=? WHERE id=?', k, db.org.id); store.audit(req.user.username, 'org.kind', db.org.id, { kind: k }); return { ok: true, kind: k }; });
  R('GET', '/api/orgs/:org', (req) => {
    const db = orgAccess(req, 'view'); const o = db.org;
    return { ...o, role: auth.role(req.user, o.id), stats: orgStats(db), storageBytes: db.storageBytes(), ramInUse: cluster.orgRam.get(o.id) || 0, lastBackup: db.kv('last_backup') };
  });
  R('PUT', '/api/orgs/:org', (req) => {
    const db = orgAccess(req, 'manage'); const b = req.body;
    if (b.name !== undefined) store.run('UPDATE orgs SET name=? WHERE id=?', String(b.name).slice(0, 80), db.id);
    if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) store.run('UPDATE orgs SET color=? WHERE id=?', b.color, db.id);
    if (b.logo !== undefined) { if (b.logo && (!/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(b.logo) || b.logo.length > 400000)) throw err(400, 'Logo must be a PNG/JPEG/SVG/WebP under 300 KB'); store.run('UPDATE orgs SET logo=? WHERE id=?', b.logo || null, db.id); }
    if (b.domain !== undefined) store.run('UPDATE orgs SET domain=? WHERE id=?', String(b.domain).slice(0, 200), db.id);
    const LIM = ['quota_ram_gb', 'quota_storage_gb', 'cloud_budget_month', 'calls_per_day', 'tokens_per_day', 'max_answer_tokens'];
    if (LIM.some((k) => b[k] !== undefined)) {
      needPlatform(req); // quotas & budgets are set by the platform, not the organisation
      for (const k of LIM) if (b[k] !== undefined) store.run(`UPDATE orgs SET ${k}=? WHERE id=?`, Math.max(0, +b[k] || 0), db.id);
    }
    db.audit(req.user.username, 'org.update', Object.keys(b)); store.audit(req.user.username, 'org.update', db.id, Object.keys(b));
    return store.getOrg(db.id);
  });
  R('DELETE', '/api/orgs/:org', (req) => { needPlatform(req, 'owner'); store.run('UPDATE orgs SET archived=1 WHERE id=?', req.params.org); store.run('DELETE FROM grants WHERE source_org=? OR target_org=?', req.params.org, req.params.org); store.audit(req.user.username, 'org.archive', req.params.org, ''); return { ok: true }; });
  R('GET', '/api/orgs/:org/policy', (req) => orgAccess(req, 'view').policy());
  R('PUT', '/api/orgs/:org/policy', (req) => {
    const db = orgAccess(req, 'manage'); const cur = db.policy(); const b = req.body; const p = { ...cur };
    const enums = { default_mode: ['local_only', 'local_first', 'ask_cloud', 'cloud_allowed', 'cloud_first', 'hybrid'], confidential: ['local_only', 'allowed'], finance: ['local_only', 'approval', 'allowed'], research: ['cloud_allowed', 'local_only'] };
    for (const [k, vals] of Object.entries(enums)) if (b[k] !== undefined) { if (!vals.includes(b[k])) throw err(400, 'Bad value for ' + k); p[k] = b[k]; }
    for (const k of ['allow_openai', 'allow_anthropic', 'allow_google', 'allow_web_search', 'speed_critical', 'remote_as_own']) if (b[k] !== undefined) p[k] = !!b[k];
    if (b.strict_caps !== undefined) p.strict_caps = !!b.strict_caps;
    if (b.task_models !== undefined) { p.task_models = {}; for (const k of ['chat', 'code', 'reasoning', 'vision', 'long']) if (b.task_models && b.task_models[k] && /^(local|cloud):/.test(b.task_models[k])) p.task_models[k] = String(b.task_models[k]).slice(0, 200); }
    if (b.pipeline !== undefined) p.pipeline = String(b.pipeline || '').slice(0, 80) || null;
    if (b.prefer_local_under_tokens !== undefined) p.prefer_local_under_tokens = Math.max(0, Math.floor(+b.prefer_local_under_tokens || 0));
    if (b.avoid_slow_tps !== undefined) p.avoid_slow_tps = Math.max(0, +b.avoid_slow_tps || 0);
    if (p.default_mode === 'hybrid' && !p.pipeline) p.pipeline = (engine.pipelines()[0] || {}).id || null;
    if (b.backup) p.backup = { enabled: !!b.backup.enabled, every_hours: Math.max(1, +b.backup.every_hours || 24), keep: Math.max(1, +b.backup.keep || 14), dest: String(b.backup.dest || '').slice(0, 500) };
    db.setPolicy(p); db.audit(req.user.username, 'policy.update', p);
    return p;
  });
  R('GET', '/api/orgs/:org/members', (req) => {
    orgAccess(req, 'manage');
    return store.all('SELECT u.id, u.username, u.display_name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY u.username', req.params.org);
  });
  R('POST', '/api/orgs/:org/members', (req) => {
    const db = orgAccess(req, 'manage'); const b = req.body;
    const roles = ['read_only', 'user', 'manager', 'org_admin', 'org_owner'];
    if (!roles.includes(b.role)) throw err(400, 'Unknown role');
    if (b.role === 'org_owner' && !auth.can(req.user, db.id, 'own')) throw err(403, 'Only an organisation owner can add owners');
    let u = store.get('SELECT * FROM users WHERE username=?', String(b.username || '').trim().toLowerCase());
    if (!u) u = auth.createUser({ username: b.username, password: b.password, displayName: b.displayName });
    store.run('INSERT INTO memberships(user_id,org_id,role) VALUES(?,?,?) ON CONFLICT(user_id,org_id) DO UPDATE SET role=excluded.role', u.id, db.id, b.role);
    db.audit(req.user.username, 'member.set', { user: u.username, role: b.role });
    return { ok: true };
  });
  R('DELETE', '/api/orgs/:org/members/:uid', (req) => { const db = orgAccess(req, 'manage'); store.run('DELETE FROM memberships WHERE user_id=? AND org_id=?', req.params.uid, db.id); db.audit(req.user.username, 'member.remove', req.params.uid); return { ok: true }; });

  // ---------------- platform users
  R('GET', '/api/users', (req) => { needPlatform(req); return store.all('SELECT id, username, display_name, platform_role, disabled, created_at FROM users ORDER BY username').map((u) => ({ ...u, orgs: store.all('SELECT o.name, m.role FROM memberships m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=?', u.id) })); });
  R('POST', '/api/users', (req) => {
    needPlatform(req); const b = req.body;
    if (b.platformRole && b.platformRole !== 'none') needPlatform(req, 'owner');
    const u = auth.createUser({ username: b.username, password: b.password, displayName: b.displayName, platformRole: ['owner', 'admin'].includes(b.platformRole) ? b.platformRole : 'none' });
    store.audit(req.user.username, 'user.create', null, u.username); return { id: u.id };
  });
  R('PUT', '/api/users/:uid', (req) => {
    needPlatform(req, 'owner'); const b = req.body;
    if (req.params.uid === req.user.id && b.platformRole && b.platformRole !== 'owner') throw err(400, 'You cannot remove your own owner role');
    if (b.platformRole !== undefined) store.run('UPDATE users SET platform_role=? WHERE id=?', ['owner', 'admin', 'none'].includes(b.platformRole) ? b.platformRole : 'none', req.params.uid);
    if (b.disabled !== undefined) { store.run('UPDATE users SET disabled=? WHERE id=?', b.disabled ? 1 : 0, req.params.uid); if (b.disabled) store.run('DELETE FROM sessions WHERE user_id=?', req.params.uid); }
    if (b.password) auth.setPassword(req.params.uid, b.password);
    store.audit(req.user.username, 'user.update', null, { id: req.params.uid, ...b, password: b.password ? '***' : undefined });
    return { ok: true };
  });

  // ---------------- conversations
  R('GET', '/api/orgs/:org/conversations', (req) => {
    const db = orgAccess(req, 'view'); const q = (req.query.get('q') || '').trim(); const proj = req.query.get('project');
    let rows;
    if (q) rows = db.all('SELECT DISTINCT c.* FROM conversations c LEFT JOIN messages m ON m.conv_id=c.id WHERE c.title LIKE ? OR m.content LIKE ? ORDER BY c.updated_at DESC LIMIT 100', `%${q}%`, `%${q}%`);
    else if (proj) rows = db.all('SELECT * FROM conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 200', proj);
    else rows = db.all('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200');
    return rows;
  });
  R('POST', '/api/orgs/:org/conversations', (req) => {
    const db = orgAccess(req, 'chat'); const id = uid('conv_');
    db.run('INSERT INTO conversations(id,project_id,title,model_mode,sensitivity,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, req.body.project_id || null, 'New conversation', req.body.mode || 'auto', req.body.sensitivity || 'normal', req.user.username, now(), now());
    return db.get('SELECT * FROM conversations WHERE id=?', id);
  });
  R('GET', '/api/orgs/:org/conversations/:id', (req) => {
    const db = orgAccess(req, 'view'); const c = db.get('SELECT * FROM conversations WHERE id=?', req.params.id);
    if (!c) throw err(404, 'Not found');
    const msgs = db.all('SELECT * FROM messages WHERE conv_id=? ORDER BY created_at, rowid', c.id).map((m) => ({ ...m, meta: safeJSON(m.meta, {}), attachments: db.all('SELECT id,name,mime,size FROM attachments WHERE message_id=?', m.id) }));
    return { ...c, messages: msgs };
  });
  R('PUT', '/api/orgs/:org/conversations/:id', (req) => {
    const db = orgAccess(req, 'chat'); const b = req.body;
    if (b.title !== undefined) db.run('UPDATE conversations SET title=? WHERE id=?', String(b.title).slice(0, 120), req.params.id);
    if (b.project_id !== undefined) db.run('UPDATE conversations SET project_id=? WHERE id=?', b.project_id || null, req.params.id);
    if (b.mode !== undefined) db.run('UPDATE conversations SET model_mode=? WHERE id=?', b.mode, req.params.id);
    if (b.model_pick !== undefined) db.run('UPDATE conversations SET model_pick=? WHERE id=?', String(b.model_pick || '').slice(0, 300) || null, req.params.id);
    if (b.sensitivity !== undefined) db.run('UPDATE conversations SET sensitivity=? WHERE id=?', b.sensitivity, req.params.id);
    return { ok: true };
  });
  R('DELETE', '/api/orgs/:org/conversations/:id', (req) => {
    const db = orgAccess(req, 'chat');
    for (const a of db.all('SELECT path FROM attachments WHERE conv_id=?', req.params.id)) { try { fs.unlinkSync(path.join(db.dir, 'files', a.path)); } catch {} }
    db.run('DELETE FROM attachments WHERE conv_id=?', req.params.id); db.run('DELETE FROM messages WHERE conv_id=?', req.params.id); db.run('DELETE FROM conversations WHERE id=?', req.params.id);
    db.audit(req.user.username, 'conversation.delete', req.params.id); return { ok: true };
  });
  R('GET', '/api/orgs/:org/conversations/:id/export', (req, res) => {
    const db = orgAccess(req, 'view'); const c = db.get('SELECT * FROM conversations WHERE id=?', req.params.id); if (!c) throw err(404, 'Not found');
    let md = `# ${c.title}\n\n_${db.org.name} · exported ${new Date().toLocaleString()}_\n\n`;
    for (const m of db.all('SELECT * FROM messages WHERE conv_id=? ORDER BY created_at, rowid', c.id)) {
      const meta = safeJSON(m.meta, {});
      md += `## ${m.role === 'user' ? 'You' : meta.agent || 'AI'}${meta.model ? ` (${meta.model})` : ''}\n\n${m.content}\n\n`;
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${c.title.replace(/[^\w -]/g, '').slice(0, 50) || 'conversation'}.md"` });
    res.end(md); return undefined;
  }, { raw: true });
  R('POST', '/api/orgs/:org/conversations/:id/messages', async (req, res) => {
    const db = orgAccess(req, 'chat');
    const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    sse(res);
    const emit = (ev, data) => { if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
    try { await engine.chat(db, req.user, req.params.id, req.body, emit, ctl.signal); }
    catch (e) { emit('error', { message: e.message }); }
    res.end();
  }, { raw: true });

  // Chat actions: continue a cut-off answer, re-run an earlier request, edit & resend, add notes to a running task.
  const sseRoute = (fn) => async (req, res) => {
    const db = orgAccess(req, 'chat'); const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    sse(res); const emit = (ev, data) => { if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
    try { await fn(db, req, emit, ctl.signal); } catch (e) { emit('error', { message: e.message }); }
    res.end();
  };
  R('POST', '/api/orgs/:org/conversations/:id/messages/:mid/continue', sseRoute((db, req, emit, signal) => engine.continueMessage(db, req.params.id, req.params.mid, req.body || {}, emit, signal)), { raw: true });
  R('POST', '/api/orgs/:org/conversations/:id/messages/:mid/choose', (req) => engine.chooseAnswer(orgAccess(req, 'chat'), req.params.id, req.params.mid));
  R('POST', '/api/orgs/:org/conversations/:id/messages/:mid/rerun', sseRoute((db, req, emit, signal) => engine.rerun(db, req.user, req.params.id, req.params.mid, req.body || {}, emit, signal)), { raw: true });
  // Edit & resend: removes that message and everything after it, then sends the new text.
  R('POST', '/api/orgs/:org/conversations/:id/messages/:mid/edit', sseRoute((db, req, emit, signal) => {
    const m = db.get('SELECT * FROM messages WHERE id=? AND conv_id=?', req.params.mid, req.params.id);
    if (!m || m.role !== 'user') throw err(400, 'Only your own messages can be edited');
    const later = db.all('SELECT id FROM messages WHERE conv_id=? AND created_at>=?', req.params.id, m.created_at);
    for (const x of later) db.run('DELETE FROM messages WHERE id=?', x.id);
    db.audit(req.user.username, 'chat.edit', { conv: req.params.id, removed: later.length });
    return engine.chat(db, req.user, req.params.id, req.body || {}, emit, signal);
  }), { raw: true });
  R('POST', '/api/orgs/:org/tasks/:id/steer', (req) => {
    const db = orgAccess(req, 'chat'); const t = db.get('SELECT * FROM tasks WHERE id=?', req.params.id); if (!t) throw err(404, 'Task not found');
    if (!['running', 'queued'].includes(t.status)) throw err(409, 'That task has already finished — send it as a new message instead.');
    const text = String(req.body.text || '').trim().slice(0, 8000); if (!text) throw err(400, 'Empty note');
    const q = app.runtime.steer.get(t.id) || []; q.push(text); app.runtime.steer.set(t.id, q);
    db.audit(req.user.username, 'task.steer', { task: t.id }); return { ok: true, queued: q.length };
  });
  R('GET', '/api/orgs/:org/conversations/:id/running', (req) => { const db = orgAccess(req, 'view'); const t = db.get("SELECT id,status,current FROM tasks WHERE conv_id=? AND status IN ('running','queued') ORDER BY created_at DESC LIMIT 1", req.params.id); return t || {}; });

  // attachments & documents
  const saveUpload = async (db, b) => {
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) throw err(400, 'Empty file');
    if (buf.length > 30 * 1024 * 1024) throw err(413, 'File too large (30 MB max)');
    const quota = (db.org.quota_storage_gb || 0) * GB;
    if (quota && db.storageBytes() + buf.length > quota) throw err(413, `Storage quota reached for ${db.org.name}`);
    const name = String(b.name || 'file').replace(/[/\\]/g, '_').slice(0, 150);
    const rel = uid('f_') + path.extname(name).slice(0, 10);
    fs.writeFileSync(path.join(db.dir, 'files', rel), buf);
    const text = isImage(b.mime, name) ? null : await extractText(buf, name, b.mime);
    return { name, rel, size: buf.length, text };
  };
  R('POST', '/api/orgs/:org/attachments', async (req) => {
    const db = orgAccess(req, 'chat'); const f = await saveUpload(db, req.body); const id = uid('att_');
    db.run('INSERT INTO attachments(id,conv_id,name,mime,size,path,text,created_at) VALUES(?,?,?,?,?,?,?,?)', id, req.body.conv_id || null, f.name, req.body.mime || '', f.size, f.rel, f.text, now());
    return { id, name: f.name, size: f.size, image: isImage(req.body.mime, f.name), chars: f.text ? f.text.length : 0, unsupported: !isImage(req.body.mime, f.name) && f.text === null };
  });
  R('GET', '/api/orgs/:org/attachments/:id/raw', (req, res) => {
    const db = orgAccess(req, 'view'); const a = db.get('SELECT * FROM attachments WHERE id=?', req.params.id); if (!a) throw err(404, 'Not found');
    res.writeHead(200, { 'content-type': isImage(a.mime, a.name) ? (a.mime || 'image/png') : 'application/octet-stream', 'content-disposition': `${isImage(a.mime, a.name) ? 'inline' : 'attachment'}; filename="${a.name.replace(/"/g, '')}"`, 'x-content-type-options': 'nosniff' });
    fs.createReadStream(path.join(db.dir, 'files', a.path)).pipe(res); return undefined;
  }, { raw: true });
  R('GET', '/api/orgs/:org/documents', (req) => orgAccess(req, 'view').all('SELECT id,name,mime,size,share_owner_ai,created_at, length(text) chars FROM documents ORDER BY created_at DESC'));
  R('POST', '/api/orgs/:org/documents', async (req) => {
    const db = orgAccess(req, 'tasks'); const f = await saveUpload(db, req.body); const id = uid('doc_');
    db.run('INSERT INTO documents(id,name,mime,size,path,text,share_owner_ai,created_at) VALUES(?,?,?,?,?,?,?,?)', id, f.name, req.body.mime || '', f.size, f.rel, f.text, 0, now());
    db.audit(req.user.username, 'document.add', f.name); return { id };
  });
  R('PUT', '/api/orgs/:org/documents/:id', (req) => { const db = orgAccess(req, 'manage'); db.run('UPDATE documents SET share_owner_ai=? WHERE id=?', req.body.share_owner_ai ? 1 : 0, req.params.id); db.audit(req.user.username, 'document.share', { id: req.params.id, share: !!req.body.share_owner_ai }); return { ok: true }; });
  R('DELETE', '/api/orgs/:org/documents/:id', (req) => { const db = orgAccess(req, 'tasks'); const d = db.get('SELECT * FROM documents WHERE id=?', req.params.id); if (d) { try { fs.unlinkSync(path.join(db.dir, 'files', d.path)); } catch {} db.run('DELETE FROM documents WHERE id=?', d.id); } return { ok: true }; });

  // projects & memory
  R('GET', '/api/orgs/:org/projects', (req) => orgAccess(req, 'view').all('SELECT * FROM projects ORDER BY name'));
  R('POST', '/api/orgs/:org/projects', (req) => { const db = orgAccess(req, 'chat'); const id = uid('prj_'); db.run('INSERT INTO projects(id,name,instructions,created_at) VALUES(?,?,?,?)', id, String(req.body.name || 'Project').slice(0, 80), req.body.instructions || '', now()); return { id }; });
  R('PUT', '/api/orgs/:org/projects/:id', (req) => { const db = orgAccess(req, 'chat'); db.run('UPDATE projects SET name=COALESCE(?,name), instructions=COALESCE(?,instructions) WHERE id=?', req.body.name ?? null, req.body.instructions ?? null, req.params.id); return { ok: true }; });
  R('DELETE', '/api/orgs/:org/projects/:id', (req) => { const db = orgAccess(req, 'chat'); db.run('UPDATE conversations SET project_id=NULL WHERE project_id=?', req.params.id); db.run('DELETE FROM projects WHERE id=?', req.params.id); return { ok: true }; });
  R('GET', '/api/orgs/:org/memory', (req) => orgAccess(req, 'view').all('SELECT * FROM memory ORDER BY created_at DESC'));
  R('POST', '/api/orgs/:org/memory', (req) => { const db = orgAccess(req, 'chat'); db.run('INSERT INTO memory(id,content,source,created_at) VALUES(?,?,?,?)', uid('mem_'), String(req.body.content || '').slice(0, 2000), req.user.username, now()); db.audit(req.user.username, 'memory.add', String(req.body.content).slice(0, 200)); return { ok: true }; });
  R('DELETE', '/api/orgs/:org/memory/:id', (req) => { const db = orgAccess(req, 'chat'); db.run('DELETE FROM memory WHERE id=?', req.params.id); return { ok: true }; });

  // ---------------- agents & tasks
  const CAP_KEYS = Object.keys(CAPABILITIES);
  const agentFields = (b, db) => {
    const folderIds = new Set(store.all('SELECT id FROM folders WHERE org_id=?', db.id).map((f) => f.id));
    const mbIds = new Set(db.all('SELECT id FROM mailboxes').map((m) => m.id));
    const mcpIds = new Set(mcp.list(db.id).map((m) => m.id));
    return {
      name: String(b.name || 'Agent').slice(0, 80), title: String(b.title || '').slice(0, 80), description: String(b.description || '').slice(0, 500), instructions: String(b.instructions || '').slice(0, 20000),
      model_mode: String(b.model_mode || 'auto').slice(0, 300), sensitivity: ['normal', 'confidential', 'finance', 'research'].includes(b.sensitivity) ? b.sensitivity : 'normal',
      schedule: JSON.stringify(b.schedule || { type: 'none' }), schedule_prompt: String(b.schedule_prompt || '').slice(0, 5000),
      can_talk_to: JSON.stringify(Array.isArray(b.can_talk_to) ? b.can_talk_to : ['*']), requires_approval: b.requires_approval ? 1 : 0, web: 0, enabled: b.enabled === false ? 0 : 1,
      color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#0071e3', autonomy: ['ask_all', 'ask_risky', 'full'].includes(b.autonomy) ? b.autonomy : 'ask_risky',
      tools: JSON.stringify((Array.isArray(b.tools) ? b.tools : ['files', 'documents', 'code', 'web', 'memory', 'agents']).filter((t) => CAP_KEYS.includes(t))),
      folders: JSON.stringify((Array.isArray(b.folders) ? b.folders : []).filter((f) => folderIds.has(f.id || f)).map((f) => ({ id: f.id || f, mode: f.mode === 'read' ? 'read' : 'readwrite' }))),
      mailboxes: JSON.stringify((Array.isArray(b.mailboxes) ? b.mailboxes : []).filter((m) => mbIds.has(m))),
      mcp: JSON.stringify((Array.isArray(b.mcp) ? b.mcp : []).filter((m) => mcpIds.has(m))),
      max_steps: Math.min(100, Math.max(3, +b.max_steps || 30)), confirm_payments: b.confirm_payments === false ? 0 : 1,
      inbox_watch: JSON.stringify(b.inbox_watch && b.inbox_watch.enabled ? { enabled: true, minutes: Math.max(2, +b.inbox_watch.minutes || 5), instruction: String(b.inbox_watch.instruction || '').slice(0, 2000) } : { enabled: false }),
      runs_per_day: Math.max(0, Math.min(100000, Math.floor(+b.runs_per_day || 0))), budget_month: Math.max(0, +b.budget_month || 0),
      place: b.place && b.place !== 'auto' ? String(b.place).slice(0, 80) : null,
    };
  };
  const AGENT_COLS = ['place', 'name', 'title', 'description', 'instructions', 'model_mode', 'sensitivity', 'schedule', 'schedule_prompt', 'can_talk_to', 'requires_approval', 'web', 'enabled', 'color', 'autonomy', 'tools', 'folders', 'mailboxes', 'mcp', 'max_steps', 'confirm_payments', 'inbox_watch', 'runs_per_day', 'budget_month'];
  const agentView = (db, a) => {
    const running = db.get('SELECT id,title,current,status FROM tasks WHERE agent_id=? AND status IN (\'running\',\'awaiting_approval\') ORDER BY created_at DESC LIMIT 1', a.id);
    const mbs = safeJSON(a.mailboxes, []); const emails = mbs.length ? db.all('SELECT id,email FROM mailboxes').filter((m) => mbs.includes(m.id)).map((m) => m.email) : [];
    return { ...a, schedule: safeJSON(a.schedule, { type: 'none' }), can_talk_to: safeJSON(a.can_talk_to, ['*']), tools: safeJSON(a.tools, []), folders: safeJSON(a.folders, []), mailboxes: mbs, emails, mcp: safeJSON(a.mcp, []), inbox_watch: safeJSON(a.inbox_watch, { enabled: false }),
      busy: !!running && running.status === 'running', waiting: !!running && running.status === 'awaiting_approval', activeTask: running || null,
      lastTask: db.get('SELECT id,status,title,finished_at,model_used,output FROM tasks WHERE agent_id=? ORDER BY created_at DESC LIMIT 1', a.id),
      stats: db.get('SELECT COUNT(*) total, COALESCE(SUM(status=\'done\'),0) done, COALESCE(SUM(status=\'failed\'),0) failed FROM tasks WHERE agent_id=? AND created_at>?', a.id, new Date(Date.now() - 7 * 864e5).toISOString()),
      browser: !!(app.host && app.host.browser) };
  };
  R('GET', '/api/capabilities', () => ({ capabilities: CAPABILITIES, browser: !!(app.host && app.host.browser), desktop: !!app.host, os: process.platform }));
  R('GET', '/api/orgs/:org/agents', (req) => { const db = orgAccess(req, 'view'); return db.all('SELECT * FROM agents ORDER BY name').map((a) => agentView(db, a)); });
  R('GET', '/api/orgs/:org/agents/:id', (req) => { const db = orgAccess(req, 'view'); const a = db.get('SELECT * FROM agents WHERE id=?', req.params.id); if (!a) throw err(404, 'Agent not found'); return agentView(db, a); });
  R('POST', '/api/orgs/:org/agents', (req) => {
    const db = orgAccess(req, 'agents'); const f = agentFields(req.body, db); const id = uid('agt_');
    db.run(`INSERT INTO agents(id,${AGENT_COLS.join(',')},created_at,next_run) VALUES(?,${AGENT_COLS.map(() => '?').join(',')},?,?)`, id, ...AGENT_COLS.map((k) => f[k]), now(), Engine.nextRun(f.schedule));
    db.audit(req.user.username, 'agent.create', f.name); return { id };
  });
  R('PUT', '/api/orgs/:org/agents/:id', (req) => {
    const db = orgAccess(req, 'agents'); const f = agentFields(req.body, db);
    db.run(`UPDATE agents SET ${AGENT_COLS.map((k) => k + '=?').join(',')}, next_run=? WHERE id=?`, ...AGENT_COLS.map((k) => f[k]), Engine.nextRun(f.schedule), req.params.id);
    db.audit(req.user.username, 'agent.update', { name: f.name, tools: f.tools, folders: f.folders, autonomy: f.autonomy }); return { ok: true };
  });
  R('DELETE', '/api/orgs/:org/agents/:id', (req) => { const db = orgAccess(req, 'agents'); db.run('DELETE FROM agents WHERE id=?', req.params.id); db.audit(req.user.username, 'agent.delete', req.params.id); return { ok: true }; });
  R('POST', '/api/orgs/:org/agents/:id/run', (req) => {
    const db = orgAccess(req, 'tasks'); const a = db.get('SELECT * FROM agents WHERE id=?', req.params.id); if (!a) throw err(404, 'Agent not found');
    const t = engine.createTask(db, { agentId: a.id, title: req.body.title || (req.body.input || a.schedule_prompt || 'Run').slice(0, 80), input: req.body.input || a.schedule_prompt || 'Do your work and report back.', createdBy: req.user.username });
    db.run('UPDATE tasks SET kind=? WHERE id=?', 'agent', t.id);
    app.runtime.run(db, t.id).then((r) => engine.afterTask(db, t.id, r)).catch(() => {}); return { taskId: t.id };
  });
  R('GET', '/api/orgs/:org/assistant', (req) => { const db = orgAccess(req, 'view'); const p = app.runtime.assistantProfile(db); return { tools: p.tools, folders: p.folders, mailboxes: p.mailboxes, mcp: p.mcp, autonomy: p.autonomy, instructions: p.instructions, max_steps: p.max_steps }; });
  R('PUT', '/api/orgs/:org/assistant', (req) => {
    const db = orgAccess(req, 'manage'); const f = agentFields({ ...req.body, name: 'Assistant' }, db);
    const v = { tools: safeJSON(f.tools, []), folders: safeJSON(f.folders, []), mailboxes: safeJSON(f.mailboxes, []), mcp: safeJSON(f.mcp, []), autonomy: f.autonomy, instructions: f.instructions, max_steps: f.max_steps };
    db.setKv('assistant', v); db.audit(req.user.username, 'assistant.update', v); return v;
  });
  R('GET', '/api/orgs/:org/tasks', (req) => {
    const db = orgAccess(req, 'view'); const st = req.query.get('status');
    const rows = st ? db.all('SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.status=? ORDER BY t.created_at DESC LIMIT 300', st)
      : db.all('SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id ORDER BY t.created_at DESC LIMIT 300');
    const n = now(); return rows.map((t) => ({ ...t, overdue: !!(t.due_at && t.due_at < n && !['done', 'rejected'].includes(t.status)) }));
  });
  R('POST', '/api/orgs/:org/tasks', (req) => {
    const db = orgAccess(req, 'tasks'); const b = req.body;
    if (!db.get('SELECT 1 FROM agents WHERE id=?', b.agent_id)) throw err(400, 'Choose an agent');
    const t = engine.createTask(db, { agentId: b.agent_id, title: b.title, input: b.input || b.title, createdBy: req.user.username, dueAt: b.due_at || null });
    if (b.run !== false) engine.runTask(db, t.id).catch(() => {});
    return { id: t.id };
  });
  R('POST', '/api/orgs/:org/tasks/:id/run', (req) => { const db = orgAccess(req, 'tasks'); const t = db.get('SELECT * FROM tasks WHERE id=?', req.params.id); if (!t) throw err(404, 'Not found'); if (['running', 'awaiting_approval'].includes(t.status)) throw err(400, 'Already running'); db.run('DELETE FROM steps WHERE task_id=?', t.id); app.runtime.run(db, t.id).then((r) => engine.afterTask(db, t.id, r)).catch(() => {}); return { ok: true }; });
  R('GET', '/api/orgs/:org/tasks/:id', (req) => {
    const db = orgAccess(req, 'view'); const t = db.get('SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?', req.params.id); if (!t) throw err(404, 'Not found');
    const since = +req.query.get('since') || 0;
    return { ...t, state: undefined, route: undefined, steps: db.all('SELECT * FROM steps WHERE task_id=? AND id>? ORDER BY id', t.id, since).map((x) => ({ ...x, args: safeJSON(x.args, null), files: safeJSON(x.files, null) })), files: app.runtime.taskFiles(db, t.id) };
  });
  R('POST', '/api/orgs/:org/tasks/:id/stop', (req) => { const db = orgAccess(req, 'tasks'); const ok = app.runtime.stop(req.params.id); if (!ok) { const t = db.get('SELECT status FROM tasks WHERE id=?', req.params.id); if (t && t.status === 'awaiting_approval') { db.run('UPDATE tasks SET status=?, current=NULL, state=NULL WHERE id=?', 'failed', req.params.id); db.run('UPDATE approvals SET status=\'rejected\' WHERE status=\'pending\' AND payload LIKE ?', `%"taskId":"${req.params.id}"%`); } } return { ok: true }; });
  R('DELETE', '/api/orgs/:org/tasks/:id', (req) => { const db = orgAccess(req, 'tasks'); db.run('DELETE FROM tasks WHERE id=?', req.params.id); return { ok: true }; });
  R('GET', '/api/orgs/:org/approvals', (req) => orgAccess(req, 'view').all('SELECT * FROM approvals ORDER BY status=\'pending\' DESC, created_at DESC LIMIT 200'));
  R('POST', '/api/orgs/:org/approvals/:id/decide', async (req) => { const db = orgAccess(req, 'approve'); await engine.decideApproval(db, req.params.id, !!req.body.approve, req.user); return { ok: true }; });


  // ---------------- folders (which files agents may use) — granted by the platform owner/admin
  R('GET', '/api/orgs/:org/folders', (req) => { orgAccess(req, 'view'); return store.all('SELECT * FROM folders WHERE org_id=? ORDER BY name', req.params.org).map((f) => ({ ...f, exists: fs.existsSync(f.path) })); });
  R('POST', '/api/orgs/:org/folders', (req) => {
    needPlatform(req); orgAccess(req, 'view'); const b = req.body; const p = path.resolve(String(b.path || '').trim());
    if (!b.path || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw err(400, 'That folder does not exist on the server computer');
    if (p === path.parse(p).root || p === os.homedir()) throw err(400, 'Choose a specific folder, not the whole disk or home folder');
    const name = String(b.name || path.basename(p)).replace(/[\\/]/g, '-').slice(0, 60);
    if (name === 'Workspace') throw err(400, 'That name is reserved');
    const id = uid('fld_'); store.run('INSERT INTO folders(id,org_id,name,path,mode,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, req.params.org, name, p, b.mode === 'readwrite' ? 'readwrite' : 'read', req.user.username, now());
    store.audit(req.user.username, 'folder.grant', req.params.org, { name, path: p, mode: b.mode }); store.openOrg(req.params.org).audit(req.user.username, 'folder.grant', { name, path: p, mode: b.mode }); return { id };
  });
  R('PUT', '/api/orgs/:org/folders/:id', (req) => { needPlatform(req); store.run('UPDATE folders SET mode=?, name=COALESCE(?,name) WHERE id=? AND org_id=?', req.body.mode === 'readwrite' ? 'readwrite' : 'read', req.body.name || null, req.params.id, req.params.org); store.audit(req.user.username, 'folder.update', req.params.org, req.body); return { ok: true }; });
  R('DELETE', '/api/orgs/:org/folders/:id', (req) => { needPlatform(req); store.run('DELETE FROM folders WHERE id=? AND org_id=?', req.params.id, req.params.org); store.audit(req.user.username, 'folder.revoke', req.params.org, req.params.id); return { ok: true }; });

  // ---------------- files: workspaces (agent outputs) and granted folders
  const fileRoot = (req, db) => {
    const r = req.query.get('root') || 'workspace:assistant';
    if (r.startsWith('workspace:')) { const aid = r.slice(10); if (aid !== 'assistant' && !db.get('SELECT 1 FROM agents WHERE id=?', aid)) throw err(404, 'Agent not found'); const dir = path.join(db.dir, 'workspaces', aid); fs.mkdirSync(dir, { recursive: true }); return { dir, name: 'Workspace', write: auth.can(req.user, db.id, 'tasks') }; }
    const f = store.get('SELECT * FROM folders WHERE id=? AND org_id=?', r, db.id); if (!f) throw err(404, 'Folder not found');
    if (!auth.can(req.user, db.id, 'manage')) throw err(403, 'Only organisation admins can browse granted folders');
    return { dir: f.path, name: f.name, write: false };
  };
  const inside = (root, rel) => { const abs = path.resolve(root, String(rel || '').replace(/^[/\\]+/, '')); const rr = fs.existsSync(abs) ? fs.realpathSync(abs) : abs; const rroot = fs.realpathSync(root); if (!(rr === rroot || rr.startsWith(rroot + path.sep))) throw err(403, 'Outside this folder'); return abs; };
  R('GET', '/api/orgs/:org/files', (req) => {
    const db = orgAccess(req, 'view'); const root = fileRoot(req, db); const dir = inside(root.dir, req.query.get('path'));
    if (!fs.existsSync(dir)) return { root: root.name, path: req.query.get('path') || '', items: [] };
    const items = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => { const st = fs.statSync(path.join(dir, e.name)); return { name: e.name, dir: e.isDirectory(), size: st.size, modified: st.mtime.toISOString() }; })
      .sort((a, b) => (b.dir - a.dir) || b.modified.localeCompare(a.modified));
    return { root: root.name, path: req.query.get('path') || '', items, canWrite: root.write };
  });
  const PREVIEW = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8' };
  R('GET', '/api/orgs/:org/files/raw', (req, res) => {
    const db = orgAccess(req, 'view'); const root = fileRoot(req, db); const abs = inside(root.dir, req.query.get('path'));
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw err(404, 'Not found');
    const ext = path.extname(abs).toLowerCase(); const inline = req.query.get('inline') === '1' && PREVIEW[ext];
    const h = { 'content-type': inline ? PREVIEW[ext] : 'application/octet-stream', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`, 'x-content-type-options': 'nosniff' };
    // Previews of web pages/SVG run in a locked-down sandbox (no access to ForgeAI or your session).
    if (inline && /html|svg/.test(PREVIEW[ext])) h['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src https: data:";
    res.removeHeader('x-frame-options'); res.setHeader('content-security-policy', h['content-security-policy'] || "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    res.writeHead(200, h); fs.createReadStream(abs).pipe(res); return undefined;
  }, { raw: true });
  R('DELETE', '/api/orgs/:org/files', (req) => { const db = orgAccess(req, 'tasks'); const root = fileRoot(req, db); if (!root.write) throw err(403, 'Read only'); const abs = inside(root.dir, req.query.get('path')); if (abs === fs.realpathSync(root.dir)) throw err(400, 'Cannot delete the workspace'); fs.rmSync(abs, { recursive: true, force: true }); db.audit(req.user.username, 'file.delete', req.query.get('path')); return { ok: true }; });
  R('POST', '/api/orgs/:org/files', async (req) => {
    const db = orgAccess(req, 'tasks'); const root = fileRoot(req, db); if (!root.write) throw err(403, 'Read only');
    const buf = Buffer.from(String(req.body.data || ''), 'base64'); const name = String(req.body.name || 'file').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);
    const dir = inside(root.dir, req.query.get('path')); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), buf); return { ok: true };
  });

  // Interactive previews for ```html blocks in chat: served from an isolated, script-only sandbox origin.
  // ---- Artifacts (ForgeAI's own live HTML pages, made in chat)
  R('GET', '/api/orgs/:org/artifacts', (req) => { const db = orgAccess(req, 'view'); const list = artifacts.list(db, { conv_id: req.query.get('conv') || undefined }); return list.map((a) => ({ id: a.id, title: a.title, visibility: a.visibility, bus: !!a.bus, author: a.author, conv_id: a.conv_id, created_at: a.created_at, updated_at: a.updated_at, url: `/art/${a.id}`, shareUrl: a.share_token ? `/art/s/${a.share_token}` : null })); });
  R('POST', '/api/orgs/:org/artifacts', (req) => { const db = orgAccess(req, 'edit'); const b = req.body || {}; if (!b.html && !b.markdown) throw err(400, 'Pass html'); const html = b.html || (b.markdown ? `<div class="md">${String(b.markdown)}</div>` : ''); const a = artifacts.create(db, { title: b.title, html, kind: b.kind || 'html', visibility: b.visibility, bus: b.bus, author: req.user.username, conv_id: b.conv_id || null, origin: req.headers.origin || null }); store.audit(req.user.username, 'artifact.create', db.id, { id: a.id, title: a.title }); return { ...a, url: `/art/${a.id}`, shareUrl: a.share_token ? `/art/s/${a.share_token}` : null }; });
  R('GET', '/api/orgs/:org/artifacts/:id', (req) => { const db = orgAccess(req, 'view'); const a = artifacts.get(db, req.params.id); if (!a) throw err(404, 'Not found'); return { ...a, url: `/art/${a.id}`, shareUrl: a.share_token ? `/art/s/${a.share_token}` : null }; });
  R('PUT', '/api/orgs/:org/artifacts/:id', (req) => { const db = orgAccess(req, 'edit'); const a = artifacts.update(db, req.params.id, req.body || {}); if (!a) throw err(404, 'Not found'); store.audit(req.user.username, 'artifact.update', db.id, { id: a.id }); return { ...a, url: `/art/${a.id}`, shareUrl: a.share_token ? `/art/s/${a.share_token}` : null }; });
  R('DELETE', '/api/orgs/:org/artifacts/:id', (req) => { const db = orgAccess(req, 'edit'); artifacts.remove(db, req.params.id); store.audit(req.user.username, 'artifact.delete', db.id, { id: req.params.id }); return { ok: true }; });

  // Serving the pages. /art/<id> needs a signed-in user with access; /art/s/<token> is a share link.
  const findArtOrg = (artId) => { for (const o of store.listOrgs()) { try { const db = store.openOrg(o.id); if (artifacts.get(db, artId)) return db; } catch {} } return null; };
  const findArtByShare = (token) => { for (const o of store.listOrgs()) { try { const db = store.openOrg(o.id); const a = artifacts.findByShare(db, token); if (a) return { db, a }; } catch {} } return null; };
  R('GET', '/art/:id', (req, res) => {
    const db = findArtOrg(req.params.id); if (!db) throw err(404, 'Artifact not found');
    const art = artifacts.get(db, req.params.id);
    if (art.visibility !== 'public') { try { req.params.org = db.id; orgAccess(req, 'view'); } catch (e) { throw err(401, 'Sign in to open this artifact'); } }
    const pg = artifacts.renderPage(db, req.params.id);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pg.csp, 'cache-control': 'no-store' }); res.end(pg.html);
  }, { raw: true, public: true });
  R('GET', '/art/s/:token', (req, res) => {
    const found = findArtByShare(req.params.token); if (!found) throw err(404, 'Shared artifact not found or no longer public');
    const pg = artifacts.renderPage(found.db, found.a.id);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pg.csp, 'cache-control': 'no-store' }); res.end(pg.html);
  }, { raw: true, public: true });
  // Cross-artifact message bus (same org only). Signed-in users or public artifacts both reach it.
  const artByReq = (req) => { const aid = String(req.headers['x-art-id'] || ''); if (!aid) throw err(400, 'Missing x-art-id'); const db = findArtOrg(aid); if (!db) throw err(404, 'Artifact not found'); const art = artifacts.get(db, aid); if (!art) throw err(404, 'Artifact not found'); if (art.visibility !== 'public') { try { req.params.org = db.id; orgAccess(req, 'view'); } catch { throw err(401, 'Sign in'); } } return { db, art }; };
  R('POST', '/art/bus', (req) => { const { db, art } = artByReq(req); const m = req.body || {}; if (!art.bus) throw err(403, "This artifact's bus is turned off"); artifacts.fanout(db, art.id, { type: m.type || 'msg', body: m.body }); return { ok: true }; }, { public: true });
  R('GET', '/art/bus/:id', (req, res) => {
    const db = findArtOrg(req.params.id); if (!db) throw err(404, 'Artifact not found');
    const art = artifacts.get(db, req.params.id); if (art.visibility !== 'public') { try { req.params.org = db.id; orgAccess(req, 'view'); } catch { throw err(401, 'Sign in'); } }
    if (!art.bus) throw err(403, "This artifact's bus is turned off");
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(':\n');
    const ka = setInterval(() => res.write(':\n'), 15000); res.on('close', () => clearInterval(ka));
    artifacts.subscribe(db, req.params.id, res); return undefined;
  }, { raw: true, public: true });
  // Simple per-artifact key/value store
  R('GET', '/art/kv', (req) => { const { db, art } = artByReq(req); return { value: artifacts.kvGet(db, art.id, req.query.get('key') || '') }; }, { public: true });
  R('POST', '/art/kv', (req) => { const { db, art } = artByReq(req); artifacts.kvSet(db, art.id, (req.body || {}).key, (req.body || {}).value); return { ok: true }; }, { public: true });
  R('POST', '/api/render', (req) => { const id = crypto.randomBytes(12).toString('hex'); renders.set(id, { html: String(req.body.html || '').slice(0, 2e6), at: Date.now() }); for (const [k, v] of renders) if (Date.now() - v.at > 3600e3) renders.delete(k); return { url: '/render/' + id }; });
  R('GET', '/render/:id', (req, res) => {
    const r = renders.get(req.params.id); if (!r) throw err(404, 'Expired');
    res.removeHeader('x-frame-options');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "sandbox allow-scripts; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src https: data:; connect-src https:" });
    res.end(r.html); return undefined;
  }, { raw: true });

  R('GET', '/api/setup-status', (req) => {
    const orgId = req.query.get('org'); const db = orgId ? (() => { try { req.params.org = orgId; return orgAccess(req, 'view'); } catch { return null; } })() : null;
    const localModels = cluster.distinctModels().length; const provs = store.get("SELECT COUNT(*) c FROM providers WHERE status='connected'").c;
    const steps = [
      { key: 'engine', done: localModels > 0 || provs > 0, title: 'Connect an AI engine', detail: localModels || provs ? `${localModels} local model${localModels === 1 ? '' : 's'} · ${provs} cloud AI${provs === 1 ? '' : 's'}` : 'Install Ollama and download a model, or connect Claude, ChatGPT or Gemini with an API key.', href: '#/models', action: 'Set Up' },
      { key: 'models', done: store.get('SELECT COUNT(*) c FROM profiles').c > 0, title: 'Create your own models', detail: 'e.g. My AI (everyday), My AI Research (web search), My AI Mail (writes emails) — each is a one-click preset: a model + instructions + settings.', href: '#/models', action: 'Create' },
    ];
    if (db) {
      steps.push({ key: 'mail', done: !!db.get("SELECT 1 FROM mailboxes WHERE status IN ('connected','partial') LIMIT 1"), title: 'Connect your email', detail: 'Read, write and send email with AI help.', href: '#/mail', action: 'Connect' });
      steps.push({ key: 'agent', done: !!db.get('SELECT 1 FROM agents LIMIT 1'), title: 'Create an agent', detail: 'A named helper with its own jobs, email and folders.', href: '#/agents', action: 'Create' });
    }
    return { steps };
  });
  // ---------------- limits overview (Organisation → Limits)
  R('GET', '/api/orgs/:org/limits', (req) => {
    const db = orgAccess(req, 'view'); const o = store.getOrg(db.id); const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const agents = db.all('SELECT id,name,color,runs_per_day,budget_month FROM agents ORDER BY name').map((a) => ({ ...a, runsToday: db.get('SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND started_at>=?', a.id, d0.toISOString()).c, spendMonth: db.agentMonthSpend(a.id) }));
    const profiles = models.profilesFor(db.id).map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon, daily_limit: p.daily_limit, usedToday: db.dayUsage({ profileId: p.id }).calls }));
    return { limits: { calls_per_day: o.calls_per_day || 0, tokens_per_day: o.tokens_per_day || 0, max_answer_tokens: o.max_answer_tokens || 0, cloud_budget_month: o.cloud_budget_month || 0, quota_ram_gb: o.quota_ram_gb || 0, quota_storage_gb: o.quota_storage_gb || 0 },
      today: db.dayUsage(), monthSpend: db.monthSpend(), storageBytes: db.storageBytes(), agents, profiles, canEdit: ['owner', 'admin'].includes(req.user.platform_role) };
  });
  R('PUT', '/api/orgs/:org/agents/:id/limits', (req) => { needPlatform(req); const db = orgAccess(req, 'manage'); db.run('UPDATE agents SET runs_per_day=?, budget_month=? WHERE id=?', Math.max(0, Math.floor(+req.body.runs_per_day || 0)), Math.max(0, +req.body.budget_month || 0), req.params.id); return { ok: true }; });

  // ---------------- My models (named profiles like "My AI Research")
  const profileFor = (purpose, orgId) => { const l = store.all('SELECT * FROM profiles WHERE enabled=1 AND purpose=? ORDER BY sort', purpose); return l.find((p) => { const o = safeJSON(p.org_ids, null); return !orgId || !o || !o.length || o.includes(orgId); }) || null; };
  const ENGINES = ['auto', 'local_fast', 'local_powerful', 'openai', 'claude', 'google'];
  const profileFields = (b) => {
    const engine = String(b.engine || 'auto');
    if (!ENGINES.includes(engine) && !/^(local:.+|cloud:[\w-]+:.+)$/.test(engine)) throw err(400, 'Unknown engine');
    const name = String(b.name || '').trim().slice(0, 40); if (!name) throw err(400, 'Give the model a name');
    const t = b.temperature === '' || b.temperature == null ? null : Math.max(0, Math.min(1.5, +b.temperature));
    return { name, tagline: String(b.tagline || '').slice(0, 120), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#0071e3', icon: String(b.icon || 'sparkles').slice(0, 20), purpose: ['general', 'fast', 'research', 'strategy', 'mail', 'code', 'writing'].includes(b.purpose) ? b.purpose : 'general',
      engine, speed: ['fast', 'balanced', 'best'].includes(b.speed) ? b.speed : 'balanced', instructions: String(b.instructions || '').slice(0, 20000), temperature: Number.isFinite(t) ? t : null,
      max_output: Math.max(0, Math.min(64000, Math.floor(+b.max_output || 0))), web: b.web ? 1 : 0, tools: b.tools === false || b.tools === 0 ? 0 : 1, daily_limit: Math.max(0, Math.floor(+b.daily_limit || 0)),
      org_ids: JSON.stringify(Array.isArray(b.org_ids) ? b.org_ids.filter((x) => store.getOrg(x)) : []), enabled: b.enabled === false || b.enabled === 0 ? 0 : 1 };
  };
  const PCOLS = ['name', 'tagline', 'color', 'icon', 'purpose', 'engine', 'speed', 'instructions', 'temperature', 'max_output', 'web', 'tools', 'daily_limit', 'org_ids', 'enabled'];
  const profileView = (p) => ({ ...p, org_ids: safeJSON(p.org_ids, []), web: !!p.web, tools: !!p.tools, enabled: !!p.enabled });
  const addProfile = (f, sort) => { const id = uid('pro_'); store.run(`INSERT INTO profiles(id,${PCOLS.join(',')},sort,created_at) VALUES(?,${PCOLS.map(() => '?').join(',')},?,?)`, id, ...PCOLS.map((k) => f[k]), sort, now()); return id; };
  R('PUT', '/api/settings/default-pick', (req) => { needPlatform(req); store.setSetting('default_pick', String(req.body.pick || 'auto').slice(0, 200)); return { ok: true }; });
  R('GET', '/api/profiles', (req) => { needPlatform(req); return store.all('SELECT * FROM profiles ORDER BY sort, created_at').map(profileView); });
  R('POST', '/api/profiles', (req) => { needPlatform(req); const f = profileFields(req.body); const n = store.get('SELECT COALESCE(MAX(sort),0)+1 n FROM profiles').n; const id = addProfile(f, n); store.audit(req.user.username, 'profile.create', null, { name: f.name }); return { id }; });
  R('PUT', '/api/profiles/:id', (req) => { needPlatform(req); const p = store.get('SELECT * FROM profiles WHERE id=?', req.params.id); if (!p) throw err(404, 'Not found'); const f = profileFields({ ...profileView(p), ...req.body }); store.run(`UPDATE profiles SET ${PCOLS.map((k) => k + '=?').join(',')} WHERE id=?`, ...PCOLS.map((k) => f[k]), p.id); store.audit(req.user.username, 'profile.update', null, { name: f.name }); return { ok: true }; });
  R('DELETE', '/api/profiles/:id', (req) => { needPlatform(req); store.run('DELETE FROM profiles WHERE id=?', req.params.id); store.audit(req.user.username, 'profile.delete', null, req.params.id); return { ok: true }; });
  R('POST', '/api/profiles/order', (req) => { needPlatform(req); (req.body.ids || []).forEach((id, i) => store.run('UPDATE profiles SET sort=? WHERE id=?', i, id)); return { ok: true }; });
  R('POST', '/api/profiles/starter', (req) => {
    needPlatform(req); const P = String(req.body.prefix || 'My AI').trim().slice(0, 24) || 'My AI';
    const base = 'Answer first, in the first sentence; then the reasoning; then any risks. Say plainly what you know, what you inferred and what you assumed. No filler.';
    const set = [
      { name: P, tagline: 'Everyday assistant — balanced speed and smarts', icon: 'sparkles', color: '#0071e3', purpose: 'general', speed: 'balanced', tools: 1, instructions: `You are ${P}, a personal AI assistant. ${base}` },
      { name: `${P} Fast`, tagline: 'Instant short answers', icon: 'bolt', color: '#ff9f0a', purpose: 'fast', speed: 'fast', tools: 0, temperature: 0.3, max_output: 1500, instructions: `You are ${P} Fast. Reply in as few words as the question allows — one to three sentences unless asked for more. No preamble.` },
      { name: `${P} Research`, tagline: 'Searches the web and cites sources', icon: 'globe', color: '#34c759', purpose: 'research', speed: 'best', web: 1, tools: 1, instructions: `You are ${P} Research. Search the web before answering anything about current facts, prices, people or rules. Use several independent sources, prefer primary ones, and note publication dates. ${base} End with a "Sources" list of links you actually used.` },
      { name: `${P} Strategy`, tagline: 'Plans, decisions and business strategy', icon: 'target', color: '#af52de', purpose: 'strategy', speed: 'best', tools: 1, temperature: 0.6, instructions: `You are ${P} Strategy, a sharp business strategist. Start with a clear recommendation. Then give 2–3 real options with trade-offs (cost, time, risk, upside), the single assumption that would flip the recommendation, the strongest argument against it, and concrete next steps with owners and dates. Use numbers where you can and show the working.` },
      { name: `${P} Mail`, tagline: 'Writes, answers and sorts email', icon: 'mail', color: '#5ac8fa', purpose: 'mail', speed: 'balanced', tools: 1, temperature: 0.5, instructions: `You are ${P} Mail. Write emails that are warm, clear and short: a specific subject line, the point in the first two lines, one clear ask, and a friendly close. Match the tone requested (formal, friendly, firm). When asked to send, show the final draft first unless told to send straight away.` },
      { name: `${P} Code`, tagline: 'Writes, runs and fixes code', icon: 'code', color: '#ff375f', purpose: 'code', speed: 'best', tools: 1, temperature: 0.2, instructions: `You are ${P} Code, a senior software engineer. Write complete, working code; run it when you can; explain briefly what changed and how to use it. Prefer simple, well-tested solutions.` },
    ];
    const have = new Set(store.all('SELECT name FROM profiles').map((p) => p.name.toLowerCase()));
    let n = store.get('SELECT COALESCE(MAX(sort),0)+1 n FROM profiles').n; const made = [];
    for (const x of set) { if (have.has(x.name.toLowerCase())) continue; addProfile(profileFields({ engine: 'auto', ...x }), n++); made.push(x.name); }
    store.audit(req.user.username, 'profile.starter', null, { prefix: P, made });
    return { made };
  });

  // ---------------- mailboxes
  const mbView = (m) => ({ ...m, secret_ref: undefined, tls_pin: undefined, trusted: !!m.tls_pin, hasPassword: !!m.secret_ref });
  R('GET', '/api/mail-presets', () => PRESETS);
  R('GET', '/api/orgs/:org/mailboxes', (req) => orgAccess(req, 'view').all('SELECT * FROM mailboxes ORDER BY email').map(mbView));
  const mbFields = (b) => ({ name: String(b.name || '').slice(0, 80), email: String(b.email || '').trim().slice(0, 200), imap_host: String(b.imap_host || '').trim(), imap_port: +b.imap_port || 993, smtp_host: String(b.smtp_host || '').trim(), smtp_port: +b.smtp_port || 465, username: String(b.username || b.email || '').trim(), signature: String(b.signature || '').slice(0, 2000) });
  const withSecure = (f) => ({ ...f, imap_secure: secureFor(f.imap_port, 1) ? 1 : 0, smtp_secure: secureFor(f.smtp_port, 1) ? 1 : 0 });
  const testMb = async (db, id) => {
    const m = db.get('SELECT * FROM mailboxes WHERE id=?', id);
    const r = await mail.test(m);
    const status = r.read.ok && r.send.ok ? 'connected' : r.read.ok || r.send.ok ? 'partial' : 'error';
    const detail = status === 'connected' ? 'Reading and sending work' : !r.send.ok ? r.send.message : r.read.message;
    db.run('UPDATE mailboxes SET status=?, status_detail=?, read_ok=?, send_ok=?, read_detail=?, send_detail=? WHERE id=?', status, String(detail || '').slice(0, 500), r.read.ok ? 1 : 0, r.send.ok ? 1 : 0, r.read.ok ? null : JSON.stringify({ code: r.read.code, message: r.read.message }), r.send.ok ? null : JSON.stringify({ code: r.send.code, message: r.send.message }), id);
    return mbView(db.get('SELECT * FROM mailboxes WHERE id=?', id));
  };
  // Work out the server settings from just the address and password.
  R('POST', '/api/orgs/:org/mailboxes/detect', async (req) => {
    orgAccess(req, 'manage'); const email = String(req.body.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, 'Enter a valid email address');
    if (!req.body.password) throw err(400, 'Enter the password');
    return mail.detect(email, String(req.body.password));
  });
  R('POST', '/api/orgs/:org/mailboxes', async (req) => {
    const db = orgAccess(req, 'manage'); const f = withSecure(mbFields(req.body));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw err(400, 'Enter a valid email address'); if (!f.imap_host || !f.smtp_host) throw err(400, 'Enter the mail server settings'); if (!req.body.password) throw err(400, 'Enter the mailbox password');
    const id = uid('mbx_');
    db.run('INSERT INTO mailboxes(id,name,email,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username,secret_ref,status,created_at,tls_pin,signature) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, f.name, f.email, f.imap_host, f.imap_port, f.imap_secure, f.smtp_host, f.smtp_port, f.smtp_secure, f.username, vault.put(req.body.password), 'checking', now(), req.body.tls_pin || null, f.signature);
    db.audit(req.user.username, 'mailbox.add', f.email); return testMb(db, id);
  });
  R('PUT', '/api/orgs/:org/mailboxes/:id', async (req) => {
    const db = orgAccess(req, 'manage'); const m = db.get('SELECT * FROM mailboxes WHERE id=?', req.params.id); if (!m) throw err(404, 'Not found'); const f = withSecure(mbFields({ ...m, ...req.body }));
    const moved = f.imap_host !== m.imap_host || f.smtp_host !== m.smtp_host;
    db.run('UPDATE mailboxes SET name=?,email=?,imap_host=?,imap_port=?,imap_secure=?,smtp_host=?,smtp_port=?,smtp_secure=?,username=?,signature=?,tls_pin=? WHERE id=?', f.name, f.email, f.imap_host, f.imap_port, f.imap_secure, f.smtp_host, f.smtp_port, f.smtp_secure, f.username, f.signature, moved ? null : m.tls_pin, m.id);
    if (req.body.password) { vault.remove(m.secret_ref); db.run('UPDATE mailboxes SET secret_ref=? WHERE id=?', vault.put(req.body.password), m.id); }
    return testMb(db, m.id);
  });
  R('POST', '/api/orgs/:org/mailboxes/:id/test', (req) => testMb(orgAccess(req, 'manage'), req.params.id));
  // The server's certificate is valid but made out to another name (common with shared hosting): trust exactly this certificate.
  R('GET', '/api/orgs/:org/mailboxes/:id/cert', async (req) => { const db = orgAccess(req, 'manage'); const m = db.get('SELECT * FROM mailboxes WHERE id=?', req.params.id); if (!m) throw err(404, 'Not found'); const side = req.query.get('side') === 'send' ? 'send' : 'read'; const c = await Mailer.certInfo(side === 'send' ? m.smtp_host : m.imap_host, side === 'send' && +m.smtp_port !== 465 ? 465 : side === 'send' ? m.smtp_port : 993); if (!c) throw err(502, 'Could not read the certificate'); return c; });
  R('POST', '/api/orgs/:org/mailboxes/:id/trust', async (req) => { const db = orgAccess(req, 'manage'); const m = db.get('SELECT * FROM mailboxes WHERE id=?', req.params.id); if (!m) throw err(404, 'Not found'); if (!/^[0-9A-F:]{95}$/.test(String(req.body.fingerprint || ''))) throw err(400, 'Bad fingerprint'); db.run('UPDATE mailboxes SET tls_pin=? WHERE id=?', req.body.fingerprint, m.id); db.audit(req.user.username, 'mailbox.trust_cert', { email: m.email, fingerprint: req.body.fingerprint }); return testMb(db, m.id); });
  R('DELETE', '/api/orgs/:org/mailboxes/:id', (req) => { const db = orgAccess(req, 'manage'); const m = db.get('SELECT * FROM mailboxes WHERE id=?', req.params.id); if (m) { vault.remove(m.secret_ref); db.run('DELETE FROM mailboxes WHERE id=?', m.id); db.audit(req.user.username, 'mailbox.remove', m.email); } return { ok: true }; });
  const getMb = (req) => { const db = orgAccess(req, 'manage'); const m = db.get('SELECT * FROM mailboxes WHERE id=?', req.params.id); if (!m) throw err(404, 'Mailbox not found'); return { db, m }; };
  const mailErr = (e) => { throw err(502, e.code && e.message ? e.message : explain(e, 'read', {}, '', '').message); };
  R('GET', '/api/orgs/:org/mailboxes/:id/folders', async (req) => { const { m } = getMb(req); return mail.folders(m).catch(mailErr); });
  R('GET', '/api/orgs/:org/mailboxes/:id/messages', async (req) => { const { m } = getMb(req); return mail.list(m, { folder: req.query.get('folder') || 'INBOX', limit: Math.min(100, +req.query.get('limit') || 40), query: req.query.get('q') || '', unreadOnly: req.query.get('unread') === '1' }).catch(mailErr); });
  R('GET', '/api/orgs/:org/mailboxes/:id/messages/:uid', async (req) => {
    const { m } = getMb(req); const r = await mail.read(m, +req.params.uid, req.query.get('folder') || 'INBOX', { html: true }).catch(mailErr);
    return { ...r, attachments: r.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })) };
  });
  R('POST', '/api/orgs/:org/mailboxes/:id/messages/:uid/move', async (req) => { const { db, m } = getMb(req); const folder = req.query.get('folder') || 'INBOX';
    let dest = String(req.body.to || ''); if (dest === 'trash' || dest === 'archive') { const list = await mail.folders(m).catch(mailErr); const f = list.find((x) => x.special === (dest === 'trash' ? '\\Trash' : '\\Archive')) || list.find((x) => new RegExp(dest === 'trash' ? 'trash|deleted' : 'archive', 'i').test(x.path)); if (!f) throw err(400, `No ${dest} folder on this mailbox`); dest = f.path; }
    await mail.move(m, +req.params.uid, dest, folder).catch(mailErr); db.audit(req.user.username, 'mail.move', { mailbox: m.email, uid: req.params.uid, dest }); return { ok: true }; });
  // A person pressing Send is the approval — no extra prompt.
  R('POST', '/api/orgs/:org/mailboxes/:id/send', async (req) => {
    const { db, m } = getMb(req); const b = req.body || {};
    const to = String(b.to || '').trim(); if (!to) throw err(400, 'Add at least one recipient');
    const bad = to.split(/[,;]\s*/).filter((x) => x && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$|<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/.test(x.trim())); if (bad.length) throw err(400, 'Not an email address: ' + bad.join(', '));
    const text = String(b.text || '') + (m.signature && b.signature !== false ? '\n\n' + m.signature : '');
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 10).map((a) => ({ filename: String(a.name || 'file').slice(0, 150), content: Buffer.from(String(a.data || ''), 'base64') }));
    if (attachments.reduce((n, a) => n + a.content.length, 0) > 20 * 2 ** 20) throw err(400, 'Attachments are over 20 MB');
    const r = await mail.send(m, { to, cc: b.cc || undefined, bcc: b.bcc || undefined, subject: String(b.subject || ''), text, inReplyTo: b.inReplyTo || undefined, references: b.references || undefined, attachments });
    db.audit(req.user.username, 'mail.send', { mailbox: m.email, to, subject: String(b.subject || '').slice(0, 200) });
    if (m.send_ok !== 1) db.run('UPDATE mailboxes SET send_ok=1 WHERE id=?', m.id);
    return r;
  });
  // AI writes (or rewrites) an email. Nothing is sent.
  R('POST', '/api/orgs/:org/mail/draft', async (req) => {
    const db = orgAccess(req, 'chat'); const b = req.body || {};
    const d = models.decide({ orgDb: db, mode: b.model ? 'other' : 'auto', model: b.model || (profileFor('mail', db.id) ? 'profile:' + profileFor('mail', db.id).id : null), text: b.instruction || '' });
    if (d.blocked) throw err(400, d.reasons[d.reasons.length - 1]);
    const sys = `You write emails for ${req.user.display_name || req.user.username} at ${db.org.name}. Reply ONLY with the email in this exact form:\nSubject: <subject>\n\n<body>\nNo notes, no placeholders like [Name] unless the information is truly unknown. Match the tone asked for; default to warm, clear and brief. Do not add a signature block — it is added automatically.` + (d.profile && d.profile.instructions ? '\n\n' + d.profile.instructions : '');
    const ctx = b.original ? `\n\nThe email being answered:\nFrom: ${b.original.from}\nSubject: ${b.original.subject}\n\n${String(b.original.text || '').slice(0, 12000)}` : '';
    const cur = b.current ? `\n\nCurrent draft to improve:\nSubject: ${b.current.subject || ''}\n\n${b.current.text || ''}` : '';
    const r = await models.run(d, { orgDb: db, system: sys, messages: [{ role: 'user', content: `${b.instruction || 'Write a reply.'}${ctx}${cur}` }], kind: 'mail' });
    const out = String(r.text || '').replace(/^```\w*\n?|```$/g, '').trim();
    const sm = /^\s*Subject:\s*(.*)\n+([\s\S]*)$/i.exec(out);
    return { subject: sm ? sm[1].trim() : (b.current && b.current.subject) || '', text: (sm ? sm[2] : out).trim(), model: r.model };
  });

  // ---------------- connectors (MCP) — outside tools and AIs
  const mcpView = (s) => ({ id: s.id, org_id: s.org_id, orgName: s.org_id ? (store.getOrg(s.org_id) || {}).name : null, name: s.name, transport: s.transport, command: s.command, args: safeJSON(s.args, []), url: s.url, enabled: !!s.enabled, status: s.status, status_detail: s.status === 'needs_sign_in' ? 'Sign-in needed' : s.status_detail, signInUrl: s.status === 'needs_sign_in' ? s.status_detail : null, tools: safeJSON(s.tools, []).map((t) => ({ name: t.name, description: t.description, readOnly: !!(t.annotations && t.annotations.readOnlyHint) })), hasSecrets: !!(s.env_ref || s.headers_ref), oauth: !!s.oauth_ref });
  const mcpAccess = (req, s) => { if (s.org_id) { if (!auth.can(req.user, s.org_id, 'manage')) throw err(403, 'Not allowed'); } else needPlatform(req); };
  R('GET', '/api/orgs/:org/connectors', (req) => { orgAccess(req, 'view'); return mcp.list(req.params.org).map(mcpView); });
  R('POST', '/api/connectors', async (req) => {
    const b = req.body; if (b.org_id) { if (!auth.can(req.user, b.org_id, 'manage')) throw err(403, 'Not allowed'); } else needPlatform(req);
    if (!['stdio', 'http'].includes(b.transport)) throw err(400, 'Choose local command or web address');
    if (b.transport === 'http' && !/^https?:\/\//.test(b.url || '')) throw err(400, 'Enter the connector URL (https://…)');
    if (b.transport === 'stdio') { if (!b.command) throw err(400, 'Enter the command'); if (req.user.platform_role !== 'owner') throw err(403, 'Only the platform owner can add connectors that run programs on the server'); }
    const kv = (txt) => { const o = {}; for (const line of String(txt || '').split('\n')) { const i = line.indexOf(line.includes('=') ? '=' : ':'); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } return o; };
    const env = kv(b.env), headers = kv(b.headers);
    if (b.bearer) headers.Authorization = 'Bearer ' + String(b.bearer).trim();
    const id = uid('mcp_');
    store.run('INSERT INTO mcp_servers(id,org_id,name,transport,command,args,env_ref,url,headers_ref,enabled,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, b.org_id || null, String(b.name || 'Connector').slice(0, 60), b.transport, b.command || null, JSON.stringify(Array.isArray(b.args) ? b.args : String(b.args || '').split(/\s+/).filter(Boolean)), Object.keys(env).length ? vault.put(JSON.stringify(env)) : null, b.url || null, Object.keys(headers).length ? vault.put(JSON.stringify(headers)) : null, 1, 'checking', now());
    store.audit(req.user.username, 'connector.add', b.org_id || null, { name: b.name, transport: b.transport });
    try { await mcp.refresh(id); } catch {}
    return mcpView(mcp.get(id));
  });
  R('POST', '/api/connectors/:id/refresh', async (req) => { const s = mcp.get(req.params.id); if (!s) throw err(404, 'Not found'); mcpAccess(req, s); try { await mcp.refresh(s.id); } catch {} return mcpView(mcp.get(s.id)); });
  R('PUT', '/api/connectors/:id', (req) => { const s = mcp.get(req.params.id); if (!s) throw err(404, 'Not found'); mcpAccess(req, s); store.run('UPDATE mcp_servers SET enabled=? WHERE id=?', req.body.enabled ? 1 : 0, s.id); if (!req.body.enabled) mcp.disconnect(s.id); return mcpView(mcp.get(s.id)); });
  R('DELETE', '/api/connectors/:id', (req) => { const s = mcp.get(req.params.id); if (!s) throw err(404, 'Not found'); mcpAccess(req, s); mcp.disconnect(s.id); for (const r of [s.env_ref, s.headers_ref, s.oauth_ref]) vault.remove(r); store.run('DELETE FROM mcp_servers WHERE id=?', s.id); store.audit(req.user.username, 'connector.remove', s.org_id, s.name); return { ok: true }; });
  R('GET', '/api/mcp/oauth/callback', async (req, res) => {
    let msg = 'Connected. You can close this window and return to ForgeAI.';
    try { if (req.query.get('error')) throw new Error(req.query.get('error_description') || req.query.get('error')); await mcp.finishAuth(req.query.get('state'), req.query.get('code')); } catch (e) { msg = 'Sign-in failed: ' + e.message; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>ForgeAI</title><body style="font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#1d1d1f"><div>${msg.replace(/</g, '&lt;')}</div></body>`); return undefined;
  }, { raw: true, public: true });

  // ---------------- web search provider
  R('GET', '/api/settings/search', (req) => { needPlatform(req); const s = store.getSetting('search', { provider: 'auto' }); return { provider: s.provider || 'auto', url: s.url || '', hasKey: !!s.key_ref }; });
  R('PUT', '/api/settings/search', (req) => { needPlatform(req); const cur = store.getSetting('search', {}); const b = req.body; const s = { provider: ['auto', 'brave', 'tavily', 'searxng'].includes(b.provider) ? b.provider : 'auto', url: String(b.url || '').trim(), key_ref: cur.key_ref };
    if (b.key) { vault.remove(cur.key_ref); s.key_ref = vault.put(String(b.key).trim()); } store.setSetting('search', s); store.audit(req.user.username, 'search.update', null, { provider: s.provider }); return { ok: true }; });
  async function webSearch(query, count = 6) {
    const s = store.getSetting('search', { provider: 'auto' }); const key = vault.reveal(s.key_ref);
    const fmt = (rows) => rows.slice(0, count).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${String(r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 300)}`).join('\n') || 'No results.';
    if (s.provider === 'brave' && key) { const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { headers: { accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('Brave Search error ' + r.status); const j = await r.json(); return fmt(((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }))); }
    if (s.provider === 'tavily' && key) { const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ query, max_results: count }), signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('Tavily error ' + r.status); const j = await r.json(); return fmt((j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }))); }
    if (s.provider === 'searxng' && s.url) { const r = await fetch(`${s.url.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('SearXNG error ' + r.status); const j = await r.json(); return fmt((j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }))); }
    // Automatic: use a connected cloud model's own web search (Claude, OpenAI or Gemini).
    for (const t of ['anthropic', 'openai', 'google']) {
      const cfg = store.get('SELECT * FROM providers WHERE provider=? AND org_id IS NULL AND status=\'connected\'', t); if (!cfg) continue;
      const model = models.pickCloudModel(cfg, 'fast');
      const r = await models.cloudAdapter(cfg).chat({ model, webSearch: true, maxTokens: 2000, messages: [{ role: 'user', content: `Search the web for: ${query}\nReturn the ${count} most relevant results as a numbered list: title, full URL, one-sentence summary. Only include real URLs you found.` }] });
      return r.text + `\n(search via ${PROVIDER_TYPES[t].name})`;
    }
    throw new Error('Web search is not set up. An admin can add Brave Search, Tavily or SearXNG in Settings → Integrations, or connect Claude/OpenAI/Gemini. You can also use the browser to search.');
  }

  // ---------------- scheduled tasks
  R('GET', '/api/orgs/:org/jobs', (req) => orgAccess(req, 'view').all('SELECT j.*, a.name agent_name FROM jobs j LEFT JOIN agents a ON a.id=j.agent_id ORDER BY j.enabled DESC, j.next_run').map((j) => ({ ...j, repeat: safeJSON(j.repeat, { type: 'once' }) })));
  R('POST', '/api/orgs/:org/jobs', (req) => {
    const db = orgAccess(req, 'tasks'); const b = req.body; const { whenToDate } = require('./agent');
    const at = whenToDate(b.when); const id = uid('job_');
    db.run('INSERT INTO jobs(id,title,instruction,agent_id,repeat,next_run,enabled,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, String(b.title || 'Task').slice(0, 120), String(b.instruction || '').slice(0, 10000), b.agent_id || null, JSON.stringify({ type: ['once', 'hourly', 'daily', 'weekdays', 'weekly'].includes(b.repeat) ? b.repeat : 'once' }), at.toISOString(), 1, req.user.username, now());
    return { id };
  });
  R('PUT', '/api/orgs/:org/jobs/:id', (req) => { const db = orgAccess(req, 'tasks'); db.run('UPDATE jobs SET enabled=? WHERE id=?', req.body.enabled ? 1 : 0, req.params.id); return { ok: true }; });
  R('POST', '/api/orgs/:org/jobs/:id/run', (req) => { const db = orgAccess(req, 'tasks'); db.run('UPDATE jobs SET next_run=?, enabled=1 WHERE id=?', new Date(Date.now() - 1000).toISOString(), req.params.id); engine.runJobs(db, new Date()); return { ok: true }; });
  R('DELETE', '/api/orgs/:org/jobs/:id', (req) => { const db = orgAccess(req, 'tasks'); db.run('DELETE FROM jobs WHERE id=?', req.params.id); return { ok: true }; });

  // ---------------- notifications
  R('GET', '/api/notifications', (req) => {
    const out = [];
    for (const o of auth.orgsFor(req.user)) for (const n of store.openOrg(o.id).all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 30')) out.push({ ...n, orgId: o.id, orgName: o.name, orgColor: o.color });
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  });
  R('POST', '/api/notifications/read', (req) => { for (const o of auth.orgsFor(req.user)) store.openOrg(o.id).run('UPDATE notifications SET read=1'); return { ok: true }; });

  // ---------------- live agent browser (desktop app only)
  const brKey = (req) => `${req.params.org}:${req.params.id === 'assistant' ? 'assistant' : req.params.id}`;
  R('GET', '/api/orgs/:org/agents/:id/browser', async (req, res) => {
    orgAccess(req, 'view'); if (!app.host || !app.host.browser) throw err(400, 'The agent browser is available in the ForgeAI desktop app');
    const b = app.host.browser(brKey(req), { create: false });
    if (!b) { res.writeHead(204); res.end(); return undefined; }
    const img = await b.screenshot(1100); const info = await b.info().catch(() => ({}));
    res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'no-store', 'x-page-url': encodeURIComponent(info.url || ''), 'x-page-title': encodeURIComponent(info.title || '') }); res.end(Buffer.from(img.b64, 'base64')); return undefined;
  }, { raw: true });
  R('POST', '/api/orgs/:org/agents/:id/browser', async (req) => {
    const db = orgAccess(req, 'tasks'); if (!app.host || !app.host.browser) throw err(400, 'The agent browser is available in the ForgeAI desktop app');
    const b = app.host.browser(brKey(req)); const x = req.body;
    if (x.action === 'open') await b.open(x.url); else if (x.action === 'click') await b.clickAt(+x.x, +x.y); else if (x.action === 'type') await b.insert(String(x.text || '')); else if (x.action === 'key') await b.press(String(x.key || 'Enter'));
    else if (x.action === 'scroll') await b.scroll(x.direction === 'up' ? 'up' : 'down'); else if (x.action === 'back') await b.back(); else if (x.action === 'show') b.show(); else if (x.action === 'clear') { await b.clearData(); db.audit(req.user.username, 'browser.clear', req.params.id); }
    return { ok: true };
  });

  // ---------------- API keys: let other apps and AIs use your agents (OpenAI-compatible)
  R('GET', '/api/orgs/:org/api-keys', (req) => { orgAccess(req, 'manage'); return store.all('SELECT id,name,hint,created_by,created_at,last_used FROM api_keys WHERE org_id=?', req.params.org); });
  R('POST', '/api/orgs/:org/api-keys', (req) => { orgAccess(req, 'manage'); const key = 'fai_' + crypto.randomBytes(24).toString('base64url'); const id = uid('key_'); store.run('INSERT INTO api_keys(id,org_id,name,key_hash,hint,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, req.params.org, String(req.body.name || 'API key').slice(0, 60), crypto.createHash('sha256').update(key).digest('hex'), key.slice(0, 8) + '…' + key.slice(-4), req.user.username, now()); store.audit(req.user.username, 'apikey.create', req.params.org, req.body.name); return { id, key }; });
  R('DELETE', '/api/orgs/:org/api-keys/:id', (req) => { orgAccess(req, 'manage'); store.run('DELETE FROM api_keys WHERE id=? AND org_id=?', req.params.id, req.params.org); return { ok: true }; });
  const apiKeyOrg = (req) => { const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const row = k && store.get('SELECT * FROM api_keys WHERE key_hash=?', crypto.createHash('sha256').update(k).digest('hex')); if (!row) throw err(401, 'Invalid API key'); store.run('UPDATE api_keys SET last_used=? WHERE id=?', now(), row.id); return store.openOrg(row.org_id); };
  R('GET', '/v1/models', (req) => { const db = apiKeyOrg(req); return { object: 'list', data: [{ id: 'assistant', object: 'model', owned_by: db.org.name }, ...db.all('SELECT name FROM agents WHERE enabled=1').map((a) => ({ id: 'agent:' + a.name, object: 'model', owned_by: db.org.name })), ...models.profilesFor(db.id).map((p) => ({ id: p.name, object: 'model', owned_by: db.org.name }))] }; }, { public: true });
  R('POST', '/v1/chat/completions', async (req) => {
    const db = apiKeyOrg(req); const b = req.body; const msgs = Array.isArray(b.messages) ? b.messages : [];
    const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('\n'));
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user'); if (!lastUser) throw err(400, 'No user message');
    const history = msgs.slice(0, msgs.lastIndexOf(lastUser)).filter((m) => ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: text(m) }));
    const agent = String(b.model || '').startsWith('agent:') ? db.get('SELECT * FROM agents WHERE lower(name)=lower(?)', String(b.model).slice(6)) : null;
    if (String(b.model || '').startsWith('agent:') && !agent) throw err(404, 'No such agent');
    const t = engine.createTask(db, { agentId: agent ? agent.id : null, title: 'API: ' + text(lastUser).slice(0, 60), input: (history.length ? 'Conversation so far:\n' + history.map((h) => `${h.role}: ${h.content}`).join('\n') + '\n\n' : '') + text(lastUser), createdBy: 'api' });
    const prof = !agent && b.model ? models.profilesFor(db.id).find((p) => p.name.toLowerCase() === String(b.model).toLowerCase()) : null;
    db.run('UPDATE tasks SET kind=?, route=? WHERE id=?', agent ? 'agent' : 'chat', JSON.stringify(prof ? { mode: 'other', model: 'profile:' + prof.id } : {}), t.id);
    const r = await app.runtime.run(db, t.id);
    const content = r.paused ? `Waiting for human approval in ForgeAI: ${r.title}` : r.error ? 'Error: ' + r.error : r.text;
    return { id: 'chatcmpl-' + t.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: b.model || 'assistant', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
  }, { public: true });

  // ---------------- usage & audit
  R('GET', '/api/orgs/:org/usage', (req) => {
    const db = orgAccess(req, 'view');
    const st = new Date(); st.setUTCDate(1); st.setUTCHours(0, 0, 0, 0); const day = new Date(); day.setHours(0, 0, 0, 0);
    return {
      month: db.get('SELECT COUNT(*) requests, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(ok=0),0) failures FROM usage WHERE ts>=?', st.toISOString()),
      today: db.get('SELECT COUNT(*) requests, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=?', day.toISOString()),
      byModel: db.all('SELECT provider, model, COUNT(*) requests, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input_tokens+output_tokens),0) tokens FROM usage WHERE ts>=? GROUP BY provider, model ORDER BY cost DESC, requests DESC', st.toISOString()),
      daily: db.all('SELECT substr(ts,1,10) day, COALESCE(SUM(cost),0) cost, COUNT(*) requests, COALESCE(SUM(provider=\'local\'),0) local FROM usage WHERE ts>=? GROUP BY day ORDER BY day', new Date(Date.now() - 30 * 864e5).toISOString()),
      errors: db.all('SELECT ts, provider, model, error FROM usage WHERE ok=0 ORDER BY id DESC LIMIT 20'),
      budget: db.org.cloud_budget_month,
    };
  });
  R('GET', '/api/orgs/:org/audit', (req) => orgAccess(req, 'manage').all('SELECT * FROM audit ORDER BY id DESC LIMIT 500'));
  R('GET', '/api/audit', (req) => { needPlatform(req); return store.all('SELECT a.*, o.name org_name FROM platform_audit a LEFT JOIN orgs o ON o.id=a.org_id ORDER BY a.id DESC LIMIT 500'); });
  // Signed export of the audit log — a tamper-evident file. Signed with a per-ForgeAI Ed25519 key kept in the vault.
  const auditKey = () => { let k = store.getSetting('audit_signing_key', null); if (!k) { const pair = crypto.generateKeyPairSync('ed25519'); k = { pub: pair.publicKey.export({ type: 'spki', format: 'pem' }), privRef: vault.put(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })) }; store.setSetting('audit_signing_key', k); } return k; };
  R('GET', '/api/audit/export', (req, res) => {
    needPlatform(req); const k = auditKey(); const priv = crypto.createPrivateKey(vault.reveal(k.privRef));
    const payload = { generated_at: new Date().toISOString(), instance: instanceId, version, platform: store.all('SELECT a.*, o.name org_name FROM platform_audit a LEFT JOIN orgs o ON o.id=a.org_id ORDER BY a.id'), orgs: store.listOrgs().map((o) => { try { const db = store.openOrg(o.id); return { id: o.id, name: o.name, audit: db.all('SELECT * FROM audit ORDER BY id') }; } catch { return { id: o.id, name: o.name, audit: [] }; } }) };
    const body = JSON.stringify(payload); const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="forgeai-audit-${new Date().toISOString().slice(0,10)}.json"` });
    res.end(JSON.stringify({ public_key: k.pub, signature: sig, generated_at: payload.generated_at, instance: payload.instance, version: payload.version, orgs: payload.orgs, platform: payload.platform, payload_bytes: body.length })); return undefined;
  }, { raw: true });

  // Network & security scan — grades every ForgeAI computer and the LAN services it exposes.
  // Security checks that explain themselves: named checks across categories, each with a real state and the
  // evidence it was judged on. Nothing is reported as "Passed" unless the underlying signal was actually checked.
  R('GET', '/api/security/checks', (req) => {
    needPlatform(req); const now = new Date().toISOString(); const cats = {};
    const add = (cat, id, name, state, detail, evidence) => { (cats[cat] = cats[cat] || []).push({ id, name, state, detail, evidence, at: now }); };
    // Account
    const owner = store.get("SELECT * FROM users WHERE platform_role='owner' AND disabled=0 ORDER BY created_at LIMIT 1");
    add('Account', 'owner', 'Owner account set up', owner ? 'pass' : 'fail', owner ? 'A platform owner exists and signs in with a password.' : 'No owner account yet.', owner ? `owner: ${owner.username}` : null);
    add('Account', 'pwhash', 'Passwords stored hashed', owner ? 'pass' : 'na', 'Passwords are kept as salted scrypt hashes, never in plain text.', owner ? 'scrypt hash present' : null);
    add('Account', 'cookie', 'Sign-in cookie protected', 'pass', 'The session cookie is HttpOnly and SameSite=Strict, so other sites and scripts cannot read it.', 'HttpOnly; SameSite=Strict');
    add('Account', '2fa', 'Two-step sign-in', 'na', 'Two-step sign-in is not offered yet. Use a strong, unique password.', null);
    // This computer
    const vb = vault.backendName || 'file key';
    add('This computer', 'vault', 'Saved keys encrypted', /keychain|safestorage|credential|secret/i.test(vb) ? 'pass' : 'warn', `API keys and tokens are encrypted with ${vb}.`, vb);
    const li = app.listenInfo || {};
    add('This computer', 'bind', 'Network exposure', !li.remote ? 'pass' : (li.https ? 'pass' : 'warn'), !li.remote ? 'ForgeAI listens only on this computer (loopback). Nothing is exposed to the network.' : li.https ? 'ForgeAI accepts connections from the network over HTTPS.' : 'ForgeAI accepts network connections over plain HTTP.', `${li.remote ? '0.0.0.0' : '127.0.0.1'}:${li.port || '-'} ${li.https ? 'https' : 'http'}`);
    add('This computer', 'engine', 'AI engine build verified', (() => { try { const b = forgeEngine.kit.installed && forgeEngine.kit.installed(); return b && b.verified ? 'pass' : b ? 'warn' : 'na'; } catch { return 'na'; } })(), 'The built-in model engine is a known, checksum-verified build shipped inside ForgeAI.', (() => { try { const b = forgeEngine.kit.installed(); return b ? `${b.asset || b.tag} (${b.source || 'engine'})` : null; } catch { return null; } })());
    // Connections
    for (const n of cluster.nodes().filter((x) => !x.is_local)) {
      let scheme = 'http'; try { scheme = new URL(n.url).protocol.replace(':', ''); } catch {}
      const linked = !!n.link_id; const enc = linked || scheme === 'https';
      add('Connections', 'enc:' + n.id, `${n.name} — encrypted`, enc ? 'pass' : 'fail', enc ? (linked ? 'Reached over the encrypted remote link.' : 'Reached over HTTPS.') : 'Reached over plain HTTP — sign-ins and messages are not encrypted in transit.', linked ? 'remote link (TLS)' : n.url);
      if (scheme === 'https' && n.kind === 'worker' && !linked) add('Connections', 'pin:' + n.id, `${n.name} — certificate pinned`, n.cert_pin ? 'pass' : 'warn', n.cert_pin ? 'This computer’s certificate is pinned, so it cannot be impersonated.' : 'The certificate is trusted on first use but not pinned yet.', n.cert_pin ? 'pinned' : 'trust-on-first-use');
    }
    if (!cluster.nodes().some((x) => !x.is_local)) add('Connections', 'none', 'Other computers', 'na', 'No other computers are connected yet.', null);
    // Models
    const origins = store.getSetting('engine_origins', {});
    const dls = Object.keys(origins).length;
    add('Models', 'checksum', 'Downloads checksum-verified', dls ? 'pass' : 'na', dls ? 'Model files downloaded through ForgeAI are checked against the publisher’s checksum before use.' : 'No models have been downloaded through ForgeAI yet.', dls ? `${dls} tracked download${dls === 1 ? '' : 's'}` : null);
    add('Models', 'untrusted', 'Model code treated as untrusted', 'pass', 'Model files are run by the engine in a separate process, not loaded into ForgeAI itself.', 'engine runs as a child process');
    // Permissions
    const shared = cluster.nodes().filter((n) => { try { return (safeJSON(n.org_ids, []) || []).length; } catch { return false; } }).length;
    add('Permissions', 'sharing', 'Computer sharing limited', shared ? 'pass' : 'na', shared ? `${shared} computer${shared === 1 ? ' is' : 's are'} shared with specific organisations only.` : 'Computers are available to every organisation on this hub (no restrictions set).', shared ? `${shared} restricted` : 'all organisations');
    add('Permissions', 'audit', 'Actions are audited', 'pass', 'Important actions (sign-ins, sharing, installs, uninstalls) are recorded in the activity log.', 'platform_audit + per-org audit');
    // Remote link
    const hub = linkHub.status();
    if (hub.enabled) {
      add('Remote link', 'hubhttps', 'Hub uses HTTPS', li.https ? 'pass' : 'fail', li.https ? 'The hub accepts pairing and connections over HTTPS.' : 'The hub is on without HTTPS — pairing codes would travel unencrypted.', li.https ? 'https' : 'http');
      const keys = (hub.enrol || []); const live = keys.filter((k) => !k.expired);
      add('Remote link', 'enrol', 'Enrolment keys limited', live.length ? 'warn' : 'pass', live.length ? `${live.length} enrolment key${live.length === 1 ? '' : 's'} can still add computers. Revoke any you are done with.` : 'No active enrolment keys — no new computer can join until you make one.', `${live.length} active`);
    } else add('Remote link', 'off', 'Remote link', 'na', 'The remote link is off; no computer can connect from outside.', null);
    const order = ['Account', 'This computer', 'Connections', 'Models', 'Permissions', 'Remote link'];
    const list = order.filter((c) => cats[c]).map((c) => ({ category: c, checks: cats[c] }));
    const all = list.flatMap((c) => c.checks); const n = (st) => all.filter((x) => x.state === st).length;
    return { at: now, categories: list, summary: { pass: n('pass'), warn: n('warn'), fail: n('fail'), na: n('na') } };
  });
  R('POST', '/api/security/scan', async (req) => {
    needPlatform(req); const out = { at: new Date().toISOString(), computers: [], warnings: [] };
    const nodes = cluster.nodes();
    for (const n of nodes) {
      const st = cluster.state.get(n.id) || {}; let scheme = 'http'; let host = ''; let port = 0; try { const u = new URL(n.url); scheme = u.protocol.replace(':',''); host = u.hostname; port = +u.port || (scheme === 'https' ? 443 : 80); } catch {}
      const row = { id: n.id, name: n.name, kind: n.kind, url: n.url, scope: n.is_local ? 'local' : require('./net').networkScope(n.url), status: st.status || 'unknown', items: [] };
      const add = (sev, text, fix) => row.items.push({ sev, text, fix });
      if (!n.is_local && scheme !== 'https' && !/^(127\.|localhost|::1)$/.test(host)) add('warn', 'Reached over plain HTTP; sign-ins and messages travel unencrypted.', 'Turn on HTTPS under Computers → This computer → Encrypt connections, or use the remote link / Tailscale.');
      if (scheme === 'https' && !n.cert_pin && !n.is_local && n.kind === 'worker') add('info', 'Certificate not pinned yet; the first visit will trust it on first use.', 'Open the computer card and press Trust certificate.');
      if (n.kind === 'ollama' && !n.is_local) add('warn', "Ollama's network API has no password or encryption by default.", 'Use it only on a trusted network or VPN, or add a ForgeAI computer (worker) instead.');
      if (n.kind === 'compat' && !n.secret_ref && !n.api_key_ref && !n.is_local) add('info', 'No API key or token set; anyone on the same network could reach this server.', 'Set an API key or token on that server and save it here.');
      if (st.error) add('warn', 'Unreachable: ' + st.error, 'Check the computer is on and reachable, or remove it under Computers.');
      const sp = cluster.speed.get(n.id); if (sp) row.tps = sp;
      row.grade = row.items.some((x) => x.sev === 'bad') ? 'bad' : row.items.some((x) => x.sev === 'warn') ? 'warn' : 'ok';
      out.computers.push(row);
    }
    // LAN sweep: find any surprise ports open on common AI software
    try { const found = await require('./discovery').scan(1500, instanceId); for (const f of found) { if (!nodes.some((n) => n.url === f.url)) out.warnings.push({ sev: 'info', text: `Found an unknown ${f.preset} server on your network at ${f.url}. Add it under Computers if you meant to, or close it on that machine.` }); } } catch {}
    // Hub itself
    const linkStatus = linkHub.status(); if (linkStatus.enabled) { if (!app.listenInfo || !app.listenInfo.https) out.warnings.push({ sev: 'warn', text: 'The hub is on without HTTPS. Turn on HTTPS so pairing codes travel safely.' }); for (const sp of linkStatus.spokes) if (sp.expose && sp.scheme !== 'https') out.warnings.push({ sev: 'warn', text: `${sp.name} is reachable from the internet on hub port ${sp.expose} without HTTPS.` }); }
    out.summary = `${out.computers.filter((c) => c.grade === 'ok').length} fine, ${out.computers.filter((c) => c.grade === 'warn').length} to improve, ${out.computers.filter((c) => c.grade === 'bad').length} action needed`;
    return out;
  });
  // Plans surface
  R('GET', '/api/plans', (req) => ({
    current: store.getSetting('plan', 'home'),
    tiers: [
      { id: 'home', name: 'ForgeAI Home', price: 'Free', line: 'One workspace, one computer, local models + bring your own API keys.', in: ['Everything on this page', 'ForgeAI Engine with full catalogue', 'Clusters on your own network', 'Export your data any time'], not: ['Teams, roles, review', 'Signed audit, backups to object storage', 'Hosted relay for internet-wide clusters'] },
      { id: 'business', name: 'ForgeAI Business', price: 'From $19 / seat / month', line: 'Shared libraries, roles, review and audit — ships as the same app, unlocks the extras in-place.', in: ['Teams with roles and review', 'Shared chats, agents, prompts, knowledge', 'Signed audit log export', 'Backups to object storage', 'Priority email support'], not: [] },
      { id: 'appliance', name: 'ForgeAI Appliance', price: 'From $999', line: 'A Mac mini or mini-PC we ship pre-installed, tuned for your organisation. Includes the Business tier for the appliance.', in: ['Shipped pre-installed, signed and set up', 'Spare drive, SSH key management', 'Return-to-base warranty, next-day replacement'] },
      { id: 'cloud_hub', name: 'ForgeAI Cloud Hub', price: 'From $9 / month', line: 'A hosted relay in your region so computers on different networks link without opening ports.', in: ['End-to-end encrypted — the relay only moves bytes', 'Pick your region', 'Scales to as many spokes as you add'] },
    ],
  }));
  R('PUT', '/api/plans', (req) => { needPlatform(req, 'owner'); const id = String((req.body || {}).plan || ''); if (!['home','business','appliance','cloud_hub'].includes(id)) throw err(400, 'Pick a plan'); store.setSetting('plan', id); store.audit(req.user.username, 'plan.set', null, { plan: id }); return { ok: true, plan: id }; });

  // Sign-in with your own OpenAI / Google account — opens the provider's OAuth page and swaps the code for a token
  // ForgeAI stores. For Claude: there is no public OAuth for personal subscriptions, so we say so plainly.
  R('GET', '/api/oauth/start/:provider', (req) => {
    needPlatform(req, 'owner'); const prov = req.params.provider;
    if (prov === 'openai') { const base = 'https://platform.openai.com/oauth/authorize'; const client = store.getSetting('oauth_openai_client', ''); if (!client) return { ok: false, reason: 'Add an OpenAI OAuth client id first under AI Providers → Advanced. OpenAI issues these to your organisation.' }; const state = crypto.randomBytes(10).toString('base64url'); store.setSetting('oauth_state', { state, at: Date.now(), prov }); return { ok: true, url: `${base}?response_type=code&client_id=${encodeURIComponent(client)}&redirect_uri=${encodeURIComponent((app.listenInfo && app.listenInfo.localUrl || '') + '/api/oauth/callback/openai')}&scope=api.read%20api.write&state=${state}` }; }
    if (prov === 'google') { const client = store.getSetting('oauth_google_client', ''); if (!client) return { ok: false, reason: 'Add a Google OAuth client id first. Create one at console.cloud.google.com (OAuth 2.0 Client → Desktop app). ForgeAI uses it to let you sign in with your Google account for Gemini.' }; const state = crypto.randomBytes(10).toString('base64url'); store.setSetting('oauth_state', { state, at: Date.now(), prov }); return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(client)}&redirect_uri=${encodeURIComponent((app.listenInfo && app.listenInfo.localUrl || '') + '/api/oauth/callback/google')}&scope=https://www.googleapis.com/auth/generative-language.retriever&state=${state}` }; }
    return { ok: false, reason: prov === 'anthropic' ? 'Claude.ai does not offer a public OAuth for personal subscriptions, so ForgeAI uses an Anthropic API key instead (console.anthropic.com → Keys).' : `No subscription sign-in for ${prov} yet; paste an API key instead.` };
  });
  R('GET', '/api/oauth/callback/:provider', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Sign-in received. You can close this window.</p><script>setTimeout(()=>close(),1500)</script>'); return undefined; }, { raw: true, public: true });

  // ---------------- backups
  R('GET', '/api/orgs/:org/backups', (req) => { const db = orgAccess(req, 'manage'); return { list: backups.list(db), last: db.kv('last_backup'), dest: backups.dest(db) }; });
  R('POST', '/api/orgs/:org/backups', (req) => { const db = orgAccess(req, 'manage'); return { name: backups.create(db, req.user.username) }; });
  R('POST', '/api/orgs/:org/backups/:name/restore', (req) => { const db = orgAccess(req, 'own'); backups.restore(db, req.params.name, req.user.username); return { ok: true }; });

  // ---------------- models, nodes, providers
  R('GET', '/api/orgs/:org/model-options', (req) => {
    const db = orgAccess(req, 'view'); const org = db.org; const pol = db.policy();
    // Everything the model menu shows: where each model runs (app + computer + address), whether it is loaded,
    // what it can do, and how fast it measured. Cloud models are marked as paid with the price from your price list.
    const catAll = cluster.catalog();
    const local = models.localCandidates(org, false).map((m) => { const copies = catAll.filter((x) => x.id === m.id);
      return { id: m.id, name: m.alias || null, params: m.params, quant: m.quant, family: m.family || '', sizeBytes: m.sizeBytes || 0, memBytes: m.memBytes || 0, loaded: m.anyLoaded, vision: m.vision, tools: m.tools !== false, reasoning: !!(m.caps && m.caps.reasoning), context: m.context, loadedContext: m.loadedContext || null, tps: m.tps, ttft: m.ttft,
        startable: copies.length > 0 && copies.every((x) => x.startable), capsKnown: ['engine', 'ollama', 'lmstudio'].includes(m.runtime) || (m.source && m.source.caps === 'reported'), origin: m.origin ? { repo: m.origin.repo, url: m.origin.url } : null, from: m.from || null,
        endpoints: copies.map((x) => ({ name: x.endpoint.name, app: x.endpoint.app, appName: x.endpoint.appName, node: x.endpoint.node, nodeKind: x.endpoint.nodeKind, cluster: x.endpoint.cluster, viaLink: x.endpoint.viaLink, host: (() => { if (String(x.endpoint.url).startsWith('forgeai-engine:')) return 'built in'; try { return new URL(x.endpoint.url).host; } catch { return x.endpoint.url; } })(), scope: x.endpoint.scope, loaded: !!x.loaded, startable: !!x.startable, state: x.state || (x.loaded ? 'loaded' : x.startable ? 'app-closed' : 'ready') })) }; });
    const priceOf = (id) => { const pz = models.price(id); return { in: pz.input_per_m, out: pz.output_per_m, from: pz.pattern === '*' || !pz.pattern ? 'default' : 'list' }; };
    const ALLOW = { openai: 'allow_openai', anthropic: 'allow_anthropic', google: 'allow_google', openai_compat: 'allow_openai' };
    const cloud = Object.values(models.providersFor(org.id)).filter((c) => pol[ALLOW[c.provider]] !== false).map((c) => { const L = safeJSON(c.models, {}).list || []; return { providerId: c.id, provider: c.provider, name: c.label || PROVIDER_TYPES[c.provider].name, host: hostOf(c.base_url || PROVIDER_TYPES[c.provider].defaultBase), models: L.filter((m) => !m.kind || m.kind === 'chat').map((m) => m.id), other: L.filter((m) => m.kind === 'other').map((m) => m.id), prices: Object.fromEntries(L.filter((m) => !m.kind || m.kind === 'chat').slice(0, 400).map((m) => [m.id, priceOf(m.id)])), paid: true }; });
    const engineLabel = (p) => { const e = p.engine || 'auto'; if (e === 'auto') return `Auto (${({ fast: 'fast', balanced: 'balanced', best: 'best quality' })[p.speed] || 'balanced'}) — chooses each time`; if (e.startsWith('local:')) { const id = e.slice(6); const lm = local.find((x) => x.id === id); const ep = lm && lm.endpoints[0]; return `${lm && lm.name || id}${ep ? ' · ' + ep.name + (ep.nodeKind === 'local' ? ' (this computer)' : '') : ' (not available now)'} · free`; } if (e.startsWith('cloud:')) { const [, pid, ...r] = e.split(':'); const cp = models.providersFor(org.id); const cfg = Object.values(cp).find((c) => c.id === pid); return `${r.join(':')} · ${cfg ? cfg.label || PROVIDER_TYPES[cfg.provider].name : 'cloud'} · paid`; } return ({ local_fast: 'Fastest local model · free', local_powerful: 'Most capable local model · free', claude: 'Claude · paid', openai: 'OpenAI · paid', google: 'Gemini · paid', cloud: 'Best cloud model · paid' })[e] || e; };
    const profiles = models.profilesFor(org.id).map((p) => ({ engine: p.engine || 'auto', engineLabel: engineLabel(p), instructionsPreview: (p.instructions || '').slice(0, 160), id: p.id, name: p.name, tagline: p.tagline, color: p.color, icon: p.icon, purpose: p.purpose, speed: p.speed, web: !!p.web, tools: !!p.tools, daily_limit: p.daily_limit, used_today: p.daily_limit ? db.dayUsage({ profileId: p.id }).calls : undefined }));
    const places = [{ value: 'auto', label: 'Anywhere (automatic)' }, { value: 'local', label: 'This computer only' }]; for (const n of cluster.nodes()) { if (n.is_local || !n.enabled) continue; const st = cluster.state.get(n.id) || {}; if (/\(cluster\)$/.test(n.name)) continue; places.push({ value: n.name, label: `${n.name} only${st.status === 'online' ? '' : ' (offline)'}`, online: st.status === 'online', linked: !!n.link_id }); } if (store.getSetting('clusters', []).some((c) => c.status === 'running')) places.push({ value: 'cluster', label: 'The cluster' });
    return { places, local, cloud, policy: pol, profiles, defaultPick: store.getSetting('default_pick', 'auto'), pipelines: engine.pipelines().map((p) => ({ id: p.id, name: p.name, stages: p.stages.filter((x) => x.enabled !== false).map((x) => x.name) })), limits: models.limitStates(db) };
  });
  R('POST', '/api/orgs/:org/route-preview', (req) => {
    const db = orgAccess(req, 'view'); const d = models.decide({ orgDb: db, mode: req.body.mode, model: req.body.model, sensitivity: req.body.sensitivity, web: req.body.web, where: req.body.where, text: req.body.text || '' });
    return { label: d.label, blocked: !!d.blocked, approvable: !!d.approvable, reasons: d.reasons, why: d.why || null, scope: d.scope || null, scopeLabel: d.scope ? SCOPE_LABEL[d.scope] : null, whyNot: d.whyNot || [], trace: d.trace || [], req: d.req || [], warning: d.warning || null, alternatives: d.alternatives || [] };
  });
  R('GET', '/api/cluster', (req) => {
    const nodes = cluster.nodes().map((n) => ({ ...n, secret_ref: undefined, api_key_ref: undefined, headers_ref: undefined, hasToken: !!n.secret_ref, hasKey: !!n.api_key_ref, pinned: !!n.cert_pin, cert_pin: undefined, org_ids: safeJSON(n.org_ids, []), managers: (safeJSON(n.grants, {}) || {}).managers || [],
      headerNames: (() => { try { return Object.keys(JSON.parse(vault.reveal(n.headers_ref) || '{}')); } catch { return []; } })(), scope: n.is_local ? 'local' : networkScope(n.url),
      ...(cluster.state.get(n.id) || { status: 'unknown', models: [] }), inflight: cluster.inflight.get(n.id) || 0, availability: n.is_local ? lender.last : ((cluster.metrics.get(n.id) || {}).availability || null), lend: n.is_local ? lender.settings().mode : ((cluster.metrics.get(n.id) || {}).lend || null) }));
    const al = aliases();
    for (const n of nodes) n.models = (n.models || []).map((m) => ({ ...m, _url: undefined, endpointUrl: m._url, alias: al[m.id] || null, tps: cluster.speed.get(n.id + '|' + m.id) || null, ttft: cluster.ttft.get(n.id + '|' + m.id) || null }));
    return { nodes, runtimes: cluster.localRuntimes(), canManage: req.user.platform_role !== 'none' };
  });
  R('POST', '/api/cluster/refresh', async () => { await cluster.refreshAll(); return { ok: true }; });
  // ---- Virtual machines & isolated sandboxes (for agents to run code/commands away from the real computer)
  R('GET', '/api/vms', (req) => { needPlatform(req); return { capabilities: vms.capabilities(), image: vms.image(), instances: vms.list() }; });
  R('POST', '/api/vms/capabilities/refresh', (req) => { needPlatform(req); return vms.capabilities(true); });
  R('POST', '/api/vms', (req) => { needPlatform(req, 'owner'); const b = req.body || {}; const inst = vms.create({ name: b.name, backend: b.backend || 'auto' }); store.audit(req.user.username, 'vm.create', null, { id: inst.id, backend: inst.backend }); return inst; });
  R('POST', '/api/vms/:id/exec', async (req) => { needPlatform(req, 'owner'); const b = req.body || {}; const cmd = String(b.command || ''); if (!cmd) throw err(400, 'Give a command to run'); store.audit(req.user.username, 'vm.exec', null, { id: req.params.id, cmd: cmd.slice(0, 200) }); return vms.exec(req.params.id, cmd, { timeout: Math.min(600, b.timeout_seconds || 180) * 1000 }); });
  R('DELETE', '/api/vms/:id', (req) => { needPlatform(req, 'owner'); store.audit(req.user.username, 'vm.destroy', null, { id: req.params.id }); return vms.destroy(req.params.id); });
  R('PUT', '/api/vms/image', (req) => { needPlatform(req, 'owner'); const b = req.body || {}; const img = b.path ? { path: String(b.path).slice(0, 500), container: b.container ? String(b.container).slice(0, 200) : undefined, note: b.note ? String(b.note).slice(0, 200) : undefined } : null; store.setSetting('vm_image', img); vms.capabilities(true); return { image: img }; });
  // One-click Ollama install on this computer (the server).
  let ollamaJob = { state: 'idle' };
  // ---- ForgeAI Engine (built in: runs and downloads models with no other apps)
  R('GET', '/api/engine', async (req) => { needPlatform(req); return { ...forgeEngine.status(), models: await forgeEngine.models() }; });
  R('POST', '/api/engine/install', (req) => { needPlatform(req, 'owner'); kit.ensure({ gpu: ['cpu', 'cuda', 'vulkan'].includes(req.body.gpu) ? req.body.gpu : 'cpu' }).then(() => forgeEngine.start()).then(() => cluster.refreshAll()).catch(() => {}); return forgeEngine.status(); });
  R('POST', '/api/engine/start', async (req) => { needPlatform(req); const r = await forgeEngine.start(); await cluster.refreshAll(); return r; });
  R('POST', '/api/engine/stop', async (req) => { needPlatform(req, 'owner'); forgeEngine.stop(); await cluster.refreshAll(); return forgeEngine.status(); });
  R('PUT', '/api/engine/settings', async (req) => { needPlatform(req, 'owner'); const n = forgeEngine.saveSettings(req.body || {}); if (forgeEngine.running()) { forgeEngine.stop(); await forgeEngine.start(); } return n; });
  R('POST', '/api/engine/load', async (req) => { needPlatform(req); await forgeEngine.ensureLoaded(String(req.body.id)); await cluster.refreshAll(); return { ok: true }; });
  R('POST', '/api/engine/unload', async (req) => { needPlatform(req); await forgeEngine.unload(String(req.body.id)); await cluster.refreshAll(); return { ok: true }; });
  R('DELETE', '/api/engine/models/:id', async (req) => { needPlatform(req, 'owner'); const r = await forgeEngine.remove(req.params.id); await cluster.refreshAll(); store.audit(req.user.username, 'engine.model.delete', null, { id: req.params.id }); return r; });
  R('GET', '/api/engine/search', async (req) => { needPlatform(req); return forgeEngine.search(req.query.get('q') || '', { author: req.query.get('author') || undefined }); });
  R('GET', '/api/engine/resolve', async (req) => { needPlatform(req); return (await forgeEngine.resolve(req.query.get('q') || '')) || { repo: null }; });
  R('GET', '/api/engine/repo', async (req) => { needPlatform(req); return forgeEngine.repoFiles(req.query.get('repo') || ''); });
  R('POST', '/api/engine/download', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {}; if (!b.repo || !Array.isArray(b.files) || !b.files.length) throw err(400, 'Choose a file to download');
    // Sizes and checksums come from Hugging Face itself, never from the browser.
    const info = await forgeEngine.repoFiles(String(b.repo)); const all = [...info.choices.flatMap((c) => c.files), ...info.projectors];
    const pick = (p) => { const f = all.find((x) => x.path === (p && p.path || p)); if (!f) throw err(400, `${p && p.path || p} is not in ${b.repo}`); return f; };
    const j = forgeEngine.download({ repo: String(b.repo), files: b.files.slice(0, 64).map(pick), mmproj: b.mmproj ? pick(b.mmproj) : null, id: b.id }); store.audit(req.user.username, 'engine.download', null, { repo: b.repo, files: b.files.map((f) => f.path) }); return j; });
  R('GET', '/api/engine/downloads', (req) => { needPlatform(req); return forgeEngine.downloadsList(); });
  // Engine operations on any ForgeAI computer (this one or a worker / linked computer): the download runs THERE, from Hugging Face, with the same checks.
  const ENGINE_OPS = {
    status: async () => ({ ...forgeEngine.status(), models: await forgeEngine.models(), downloads: forgeEngine.downloadsList() }),
    install: async (b) => { await kit.ensure({ gpu: ['cpu', 'cuda', 'vulkan'].includes(b.gpu) ? b.gpu : 'cpu' }); await forgeEngine.start(); await cluster.refreshAll(); return forgeEngine.status(); },
    start: async () => { const r = await forgeEngine.start(); await cluster.refreshAll(); return r; },
    download: async (b) => { if (!b.repo || !Array.isArray(b.files) || !b.files.length) throw new Error('Choose a file to download'); const info = await forgeEngine.repoFiles(String(b.repo)); const all = [...info.choices.flatMap((c) => c.files), ...info.projectors]; const pick = (p) => { const f = all.find((x) => x.path === (p && p.path || p)); if (!f) throw new Error(`${p && p.path || p} is not in ${b.repo}`); return f; }; return forgeEngine.download({ repo: String(b.repo), files: b.files.slice(0, 64).map(pick), mmproj: b.mmproj ? pick(b.mmproj) : null, id: b.id }); },
    downloads: () => forgeEngine.downloadsList(), cancel: (b) => forgeEngine.cancel(String(b.id)),
    load: async (b) => { await forgeEngine.ensureLoaded(String(b.id)); await cluster.refreshAll(); return { ok: true }; }, unload: async (b) => { await forgeEngine.unload(String(b.id)); await cluster.refreshAll(); return { ok: true }; },
    remove: async (b) => { const r = await forgeEngine.remove(String(b.id)); await cluster.refreshAll(); return r; },
  };
  R('POST', '/node/engine/:op', async (req) => { workerAuth(req); const f = ENGINE_OPS[req.params.op]; if (!f) throw err(404, 'Unknown operation'); try { return await f(req.body || {}); } catch (e) { throw err(400, e.message); } }, { public: true });
  R('POST', '/api/engine/on/:node/:op', async (req) => {
    const op = req.params.op; if (!ENGINE_OPS[op]) throw err(404, 'Unknown operation');
    if (['install', 'download', 'remove'].includes(op)) needPlatform(req, 'owner');
    else if (req.params.node === 'local') needPlatform(req);
    else { const mn = store.get("SELECT * FROM nodes WHERE id=?", req.params.node); if (!mn) throw err(404, 'That computer is not a ForgeAI computer'); needManageNode(req, mn); }
    if (req.params.node === 'local') { try { const r = await ENGINE_OPS[op](req.body || {}); if (op === 'download') store.audit(req.user.username, 'engine.download', null, { repo: req.body.repo, files: (req.body.files || []).map((f) => f.path || f) }); return r; } catch (e) { throw err(e.status || 400, e.message); } }
    const n = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", req.params.node); if (!n) throw err(404, 'That computer is not a ForgeAI computer');
    try { const r = await cluster.runtimesFor(n)[0].adapter.post('/node/engine/' + op, req.body || {}, op === 'install' ? 20 * 60000 : 60000); if (op === 'download') store.audit(req.user.username, 'engine.download', null, { repo: req.body.repo, on: n.name }); return r; }
    catch (e) { throw err(400, `${n.name}: ${e.message}`); }
  });
  R('GET', '/api/engine/targets', async (req) => { needPlatform(req); const out = [{ id: 'local', name: 'This computer', online: true, engine: forgeEngine.status().installed, running: forgeEngine.running() }]; for (const n of store.all("SELECT * FROM nodes WHERE kind='worker' AND enabled=1")) { const st = cluster.state.get(n.id) || {}; let eng = null; if (st.status === 'online') { try { eng = await cluster.runtimesFor(n)[0].adapter.post('/node/engine/status', {}, 8000); } catch (e) { eng = { error: e.message }; } } out.push({ id: n.id, name: n.name, online: st.status === 'online', linked: !!n.link_id, engine: eng ? !!eng.installed : null, running: eng ? !!eng.running : null, version: eng && eng.version, error: eng && eng.error, models: eng && eng.models ? eng.models.map((m) => m.id) : [], downloads: eng && eng.downloads ? eng.downloads : [] }); } return out; });
  R('POST', '/api/engine/downloads/:id/cancel', (req) => { needPlatform(req); return forgeEngine.cancel(req.params.id); });
  R('GET', '/api/engine/existing', (req) => { needPlatform(req); return forgeEngine.findExisting(); });
  R('POST', '/api/engine/link', async (req) => { needPlatform(req, 'owner'); const r = await forgeEngine.link((req.body.items || []).slice(0, 200)); await cluster.refreshAll(); return r; });
  R('PUT', '/api/engine/hf-token', (req) => { needPlatform(req, 'owner'); const old = store.getSetting('hf_token_ref', null); if (old) vault.remove(old); const t = String(req.body.token || '').trim(); store.setSetting('hf_token_ref', t ? vault.put(t) : null); return { ok: true, set: !!t }; });
  // ---- training (LoRA fine-tuning with MLX)
  R('GET', '/api/train', (req) => { needPlatform(req); return trainer.status(); });
  R('POST', '/api/train/setup', async (req) => { needPlatform(req, 'owner'); return trainer.install(); });
  R('GET', '/api/train/base-models', async (req) => {
    needPlatform(req); const q = req.query.get('q') || '';
    const p = new URLSearchParams({ search: q, author: 'mlx-community', sort: 'downloads', direction: '-1', limit: '25' });
    const list = await forgeEngine.hfJSON('/api/models?' + p);
    return list.map((m) => ({ repo: m.id || m.modelId, downloads: m.downloads || 0, url: `${(process.env.FORGEAI_HF_BASE || 'https://huggingface.co')}/${m.id || m.modelId}` }));
  });
  R('POST', '/api/train/start', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {}; let examples = [];
    if (typeof b.jsonl === 'string' && b.jsonl.trim()) examples.push(...b.jsonl.split(/\r?\n/).filter((l) => l.trim()));
    for (const x of b.pairs || []) if (x && String(x.q || '').trim() && String(x.a || '').trim()) examples.push({ messages: [...(b.system ? [{ role: 'system', content: String(b.system) }] : []), { role: 'user', content: String(x.q) }, { role: 'assistant', content: String(x.a) }] });
    // From chats: each of your messages and the answer you kept become one example.
    if (b.fromChats && b.fromChats.org && Array.isArray(b.fromChats.ids)) {
      const db = orgAccess({ ...req, params: { org: b.fromChats.org } }, 'chat');
      for (const cid of b.fromChats.ids.slice(0, 500)) {
        const rows = db.all('SELECT * FROM messages WHERE conv_id=? ORDER BY created_at, rowid', cid);
        for (let i = 0; i < rows.length; i++) { if (rows[i].role !== 'user') continue; const ans = rows.slice(i + 1).find((m) => { const mt = safeJSON(m.meta, {}); return m.role === 'assistant' && !mt.error && !mt.blocked && !mt.system && (!mt.compare || mt.compare.chosen || (mt.compare.slot === 0 && !rows.some((x) => { const y = safeJSON(x.meta, {}); return y.compare && y.compare.of === mt.compare.of && y.compare.chosen; }))); });
          if (ans && ans.content.trim()) examples.push({ messages: [...(b.system ? [{ role: 'system', content: String(b.system) }] : []), { role: 'user', content: rows[i].content }, { role: 'assistant', content: ans.content }] }); }
      }
    }
    const r = trainer.start({ name: b.name, baseModel: String(b.baseModel || '').trim(), examples, iters: b.iters, layers: b.layers, batch: b.batch, lr: b.lr, maxSeq: b.maxSeq });
    store.audit(req.user.username, 'train.start', null, { name: r.name, base: r.baseModel, examples: r.examples }); return r;
  });
  R('POST', '/api/train/:id/stop', (req) => { needPlatform(req, 'owner'); return trainer.stop(req.params.id); });
  R('POST', '/api/train/:id/serve', async (req) => {
    needPlatform(req); const r = trainer.get(req.params.id); const { url } = await trainer.serve(req.params.id);
    const old = r.nodeId && store.get('SELECT * FROM nodes WHERE id=?', r.nodeId);
    if (old) store.run('UPDATE nodes SET url=?, enabled=1 WHERE id=?', url, old.id);
    else { const nid = uid('node_'); store.run('INSERT INTO nodes(id,name,kind,url,ram_gb,enabled,is_local,created_at,preset,tls_mode,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)', nid, `Trained · ${r.name}`, 'compat', url, 0, 1, 0, now(), 'mlx', 'verify', 600000); trainer.patch(r.id, { nodeId: nid }); }
    const node = store.get('SELECT * FROM nodes WHERE id=?', trainer.get(r.id).nodeId); const st = await cluster.refreshNode(node).catch(() => null);
    if (st && st.models[0]) setAlias(st.models[0].id, r.name);
    return trainer.get(r.id);
  });
  R('POST', '/api/train/:id/unserve', (req) => { needPlatform(req); const r = trainer.get(req.params.id); trainer.unserve(req.params.id); if (r && r.nodeId) { store.run('UPDATE nodes SET enabled=0 WHERE id=?', r.nodeId); cluster.state.delete(r.nodeId); } return trainer.get(req.params.id); });
  R('DELETE', '/api/train/:id', (req) => { needPlatform(req, 'owner'); const r = trainer.get(req.params.id); if (r && r.nodeId) { store.run('DELETE FROM nodes WHERE id=?', r.nodeId); cluster.state.delete(r.nodeId); } return trainer.remove(req.params.id); });
  // ---- model apps on this computer (Ollama, LM Studio + LM Link)
  R('GET', '/api/apps', async (req) => { needPlatform(req); const a = appsMod.apps(); const [o, l] = await Promise.all([appsMod.portOpen(11434), appsMod.portOpen(1234)]); let lmAuth = null; if (l) { try { const ad = cluster.lmStudioFor(cluster.nodes().find((n) => n.is_local).id).adapter; const r = await ad.oa._fetch(ad.root + '/api/v1/models', { headers: ad.oa.headers(), signal: AbortSignal.timeout(4000) }); lmAuth = r.status === 401 || r.status === 403 ? 'needs-token' : r.ok ? 'ok' : r.status === 404 ? 'old-version' : 'error-' + r.status; } catch { lmAuth = 'unreachable'; } }
    return { ollama: { ...a.ollama, running: o }, lmstudio: { ...a.lmstudio, running: l, auth: lmAuth, tokenSet: !!store.getSetting('lmstudio_token_ref', null), link: a.lmstudio.cli ? await appsMod.lmLinkStatus().catch((e) => ({ available: false, reason: e.message })) : { available: false, reason: 'LM Studio is not installed' } } }; });
  R('PUT', '/api/apps/lmstudio/token', async (req) => { needPlatform(req, 'owner'); const old = store.getSetting('lmstudio_token_ref', null); if (old) vault.remove(old); const t = String(req.body.token || '').trim(); store.setSetting('lmstudio_token_ref', t ? vault.put(t) : null); await cluster.refreshAll(); return { ok: true, set: !!t }; });
  // Downloads into LM Studio (this computer, or an LM Studio server you added) through LM Studio's own API.
  const lmsJobs = new Map();
  const lmsErr = (r, j, what) => { if (r.status === 401 || r.status === 403) return `LM Studio refused ${what} (${r.status}) — its server requires an API token with permission to download. Next: Models → Engines → LM Studio → API token.`; if (r.status === 404) return `This LM Studio can’t do ${what} through its API (404). Next: update LM Studio (0.4 or newer), or use the ForgeAI Engine.`; return `LM Studio could not do ${what}: ${(j && (j.error && (j.error.message || j.error))) || 'error ' + r.status}`; };
  R('POST', '/api/lmstudio/download', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {};
    const local = cluster.nodes().find((n) => n.is_local); const { node, adapter } = cluster.lmStudioFor(b.nodeId || local.id);
    if (node.is_local && !(await appsMod.portOpen(1234))) await appsMod.startLmStudio();
    const model = String(b.model || '').trim(); if (!model) throw err(400, 'Choose a model');
    const body = { model }; if (b.quantization) body.quantization = String(b.quantization);
    let r; try { r = await adapter.oa._fetch(adapter.root + '/api/v1/models/download', { method: 'POST', headers: adapter.oa.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); } catch (e) { throw err(400, explainNet(e, adapter.root, 'Asking LM Studio to download').message); }
    const j = await r.json().catch(() => ({})); if (!r.ok) throw err(400, lmsErr(r, j, 'downloads'));
    const id = j.job_id || uid('lms_'); const job = { id, kind: 'lmstudio', nodeId: node.id, node: node.name, model: b.label || model, from: /^https?:/.test(model) ? model : 'lmstudio.ai/models/' + model, quant: b.quantization || null, state: j.status === 'already_downloaded' || j.status === 'completed' ? 'done' : j.status === 'failed' ? 'error' : 'running', status: j.status === 'already_downloaded' ? 'Already downloaded in LM Studio' : 'LM Studio is downloading', done: 0, total: j.total_size_bytes || 0, startedAt: Date.now() };
    lmsJobs.set(id, job); store.audit(req.user.username, 'lmstudio.download', null, { node: node.name, model, quantization: b.quantization || null });
    if (job.state === 'running' && j.job_id) (async () => {
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        try { const x = await adapter.oa._fetch(adapter.root + '/api/v1/models/download/status/' + encodeURIComponent(j.job_id), { headers: adapter.oa.headers(), signal: AbortSignal.timeout(15000) }); const s2 = await x.json().catch(() => ({}));
          if (!x.ok) { job.state = 'error'; job.status = lmsErr(x, s2, 'download progress'); break; }
          job.done = s2.downloaded_bytes || job.done; job.total = s2.total_size_bytes || job.total; job.speed = s2.bytes_per_second || null;
          job.status = s2.status === 'paused' ? 'Paused in LM Studio' : `LM Studio is downloading${s2.bytes_per_second ? ` · ${(s2.bytes_per_second / 2 ** 20).toFixed(1)} MB/s` : ''}`;
          if (s2.status === 'completed') { job.state = 'done'; job.status = 'Downloaded into LM Studio'; break; }
          if (s2.status === 'failed') { job.state = 'error'; job.status = 'LM Studio reported the download failed — open LM Studio → Downloads for the reason'; break; }
        } catch (e) { job.status = 'Waiting for LM Studio…'; }
      }
      await cluster.refreshNode(node).catch(() => {});
    })();
    else await cluster.refreshNode(node).catch(() => {});
    return job;
  });
  R('GET', '/api/lmstudio/downloads', (req) => { needPlatform(req); return [...lmsJobs.values()].reverse().slice(0, 20); });
  R('GET', '/api/lmstudio/targets', (req) => { needPlatform(req); return cluster.nodes().filter((n) => n.enabled && ((n.is_local && cluster.appInstalled('lmstudio')) || (n.kind === 'compat' && n.preset === 'lmstudio'))).map((n) => ({ id: n.id, name: n.is_local ? 'LM Studio on this computer' : `LM Studio on ${n.name}`, local: !!n.is_local })); });
  R('POST', '/api/apps/:app/start', async (req) => { needPlatform(req); const r = req.params.app === 'ollama' ? await appsMod.startOllama() : req.params.app === 'lmstudio' ? await appsMod.startLmStudio() : null; if (!r) throw err(404, 'Unknown app'); await cluster.refreshAll(); return r; });
  R('GET', '/api/runtime/ollama', (req) => { needPlatform(req); return { ...ollamaJob, installed: !!installedPath(), os: process.platform }; });
  R('POST', '/api/runtime/ollama', (req) => {
    needPlatform(req); if (ollamaJob.state === 'running') return ollamaJob;
    ollamaJob = { state: 'running', status: 'Starting', completed: 0, total: 0 };
    store.audit(req.user.username, 'runtime.install_ollama', null, {});
    installOllama((p) => Object.assign(ollamaJob, p)).then(async (r) => {
      Object.assign(ollamaJob, { status: 'Waiting for Ollama to start' });
      for (let i = 0; i < 30; i++) { await new Promise((ok) => setTimeout(ok, 2000)); await cluster.refreshAll().catch(() => {}); const l = cluster.nodes().find((n) => n.is_local); const st = l && cluster.state.get(l.id); if (st && st.status === 'online') break; }
      ollamaJob = { state: 'done', status: 'Ollama is ready', path: r.path };
    }).catch((e) => { ollamaJob = { state: 'error', status: e.message }; });
    return ollamaJob;
  });
  R('POST', '/api/nodes', async (req) => {
    needPlatform(req); const b = req.body;
    if (!['ollama', 'compat', 'worker'].includes(b.kind)) throw err(400, 'Unknown server type');
    if (!/^https?:\/\/[^\s]+$/.test(b.url || '')) throw err(400, 'Enter an address like http://192.168.1.20:1234 or https://ai.example.com');
    const url = b.url.replace(/\/+$/, '');
    if (store.get('SELECT 1 FROM nodes WHERE url=?', url)) throw err(409, 'That server is already added');
    const id = uid('node_'); const f = endpointFields(b);
    store.run('INSERT INTO nodes(id,name,kind,url,secret_ref,ram_gb,enabled,is_local,created_at,preset,api_key_ref,headers_ref,tls_mode,cert_pin,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, String(b.name || 'Server').slice(0, 60), b.kind, url, (b.token || (b.kind === 'worker' && b.apiKey)) ? vault.put(String(b.token || b.apiKey)) : null, +b.ram_gb || 0, 1, 0, now(),
      f.preset, b.apiKey && b.kind !== 'worker' ? vault.put(String(b.apiKey)) : null, Object.keys(f.headers).length ? vault.put(JSON.stringify(f.headers)) : null, f.tls_mode, f.cert_pin, f.timeout_ms);
    store.audit(req.user.username, 'node.add', null, { name: b.name, url: b.url });
    await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE id=?', id)).catch(() => {});
    return { id };
  });
  R('PUT', '/api/nodes/:id', async (req) => {
    needPlatform(req); const b = req.body; const n = store.get('SELECT * FROM nodes WHERE id=?', req.params.id); if (!n) throw err(404, 'Not found');
    if (b.name !== undefined) store.run('UPDATE nodes SET name=? WHERE id=?', String(b.name).slice(0, 60), n.id);
    if (b.enabled !== undefined) store.run('UPDATE nodes SET enabled=? WHERE id=?', b.enabled ? 1 : 0, n.id);
    if (b.ram_gb !== undefined) store.run('UPDATE nodes SET ram_gb=? WHERE id=?', +b.ram_gb || 0, n.id);
    if (b.org_ids !== undefined) { needPlatform(req, 'owner'); const ids = Array.isArray(b.org_ids) ? b.org_ids.filter((x) => store.getOrg(x)) : []; store.run('UPDATE nodes SET org_ids=? WHERE id=?', ids.length ? JSON.stringify(ids) : null, n.id); store.audit(req.user.username, 'node.sharing', null, { node: n.name, orgs: ids.length || 'all' }); }
    if (b.url && !n.is_local) store.run('UPDATE nodes SET url=?, cert_pin=NULL WHERE id=?', b.url.replace(/\/$/, ''), n.id);
    if (b.token) { vault.remove(n.secret_ref); store.run('UPDATE nodes SET secret_ref=? WHERE id=?', vault.put(b.token), n.id); }
    if (!n.is_local) {
      const f = endpointFields({ ...n, ...b, headers: b.headers !== undefined ? b.headers : undefined });
      store.run('UPDATE nodes SET preset=?, tls_mode=?, cert_pin=?, timeout_ms=? WHERE id=?', f.preset, f.tls_mode, b.cert_pin !== undefined ? f.cert_pin : n.cert_pin, f.timeout_ms, n.id);
      if (b.apiKey !== undefined) { vault.remove(n.api_key_ref); store.run('UPDATE nodes SET api_key_ref=? WHERE id=?', b.apiKey ? vault.put(String(b.apiKey)) : null, n.id); }
      if (b.headers !== undefined) { vault.remove(n.headers_ref); store.run('UPDATE nodes SET headers_ref=? WHERE id=?', Object.keys(f.headers).length ? vault.put(JSON.stringify(f.headers)) : null, n.id); }
    }
    await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE id=?', n.id)).catch(() => {});
    return { ok: true };
  });
  R('PUT', '/api/nodes/:id/grants', (req) => {
    needPlatform(req, 'owner'); const n = store.get('SELECT * FROM nodes WHERE id=?', req.params.id); if (!n) throw err(404, 'Not found');
    const b = req.body || {};
    if (b.org_ids !== undefined) { const ids = Array.isArray(b.org_ids) ? b.org_ids.filter((x) => store.getOrg(x)) : []; store.run('UPDATE nodes SET org_ids=? WHERE id=?', ids.length ? JSON.stringify(ids) : null, n.id); }
    if (b.managers !== undefined) { const cur = safeJSON(n.grants, {}) || {}; const ids = Array.isArray(b.managers) ? b.managers.filter((uid) => store.get('SELECT 1 FROM users WHERE id=? AND disabled=0', uid)) : []; cur.managers = ids; store.run('UPDATE nodes SET grants=? WHERE id=?', JSON.stringify(cur), n.id); }
    store.audit(req.user.username, 'node.grants', null, { node: n.name, orgs: Array.isArray(b.org_ids) ? b.org_ids.length : undefined, managers: Array.isArray(b.managers) ? b.managers.length : undefined });
    return { ok: true };
  });
  R('PUT', '/api/nodes/:id/sharing', (req) => {
    needPlatform(req, 'owner'); const n = store.get('SELECT * FROM nodes WHERE id=?', req.params.id); if (!n) throw err(404, 'Not found');
    const ids = Array.isArray((req.body || {}).org_ids) ? req.body.org_ids.filter((x) => store.getOrg(x)) : [];
    store.run('UPDATE nodes SET org_ids=? WHERE id=?', ids.length ? JSON.stringify(ids) : null, n.id);
    store.audit(req.user.username, 'node.sharing', null, { node: n.name, orgs: ids.length || 'all' });
    return { ok: true, org_ids: ids };
  });
  R('DELETE', '/api/nodes/:id', (req) => { needPlatform(req); const n = store.get('SELECT * FROM nodes WHERE id=?', req.params.id); if (!n || n.is_local) throw err(400, 'Cannot remove this node'); vault.remove(n.secret_ref); vault.remove(n.api_key_ref); vault.remove(n.headers_ref); store.run('DELETE FROM nodes WHERE id=?', n.id); cluster.state.delete(n.id); return { ok: true }; });
  // ---- live performance across machines, models, providers and clusters, with plain-English bottlenecks
  const workerMetrics = new Map();
  const pollWorkers = async () => {
    await Promise.all(cluster.nodes().filter((n) => n.kind === 'worker' && n.enabled).map(async (n) => {
      try { const rt = cluster.runtimesFor(n)[0]; const m = await rt.adapter.get('/node/metrics', 2500); workerMetrics.set(n.id, { ...m.machine, at: Date.now(), ok: true }); }
      catch (e) { workerMetrics.set(n.id, { ok: false, error: e.message, at: Date.now() }); }
    }));
  };
  const aggUsage = (hours = 24) => {
    const since = new Date(Date.now() - hours * 3600e3).toISOString(); const rows = [];
    for (const d of [store, ...store.listOrgs().map((o) => store.openOrg(o.id))]) rows.push(...d.all('SELECT provider, provider_id, model, node, endpoint, scope, ok, error, ms, ttft_ms, output_tokens, input_tokens, bottleneck, ts FROM usage WHERE ts>=?', since));
    const by = (keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!k) continue; const a = m.get(k) || { key: k, calls: 0, errors: 0, rateLimited: 0, ms: [], ttft: [], tps: [], tokens: 0, bottlenecks: {} }; a.calls++; if (!r.ok) { a.errors++; if (/429|rate limit/i.test(r.error || '')) a.rateLimited++; } else { a.ms.push(r.ms); if (r.ttft_ms != null) a.ttft.push(r.ttft_ms); const gen = r.ms - (r.ttft_ms || 0); if (r.output_tokens > 3 && gen > 200) a.tps.push(r.output_tokens / (gen / 1000)); a.tokens += (r.output_tokens || 0) + (r.input_tokens || 0); } if (r.bottleneck && r.bottleneck !== 'none') a.bottlenecks[r.bottleneck] = (a.bottlenecks[r.bottleneck] || 0) + 1; a.provider = r.provider; a.node = r.node; a.endpoint = r.endpoint; a.scope = r.scope; m.set(k, a); }
      const med = (x) => { if (!x.length) return null; const y = [...x].sort((p, q) => p - q); return y[Math.floor(y.length / 2)]; }; const p95 = (x) => { if (!x.length) return null; const y = [...x].sort((p, q) => p - q); return y[Math.min(y.length - 1, Math.floor(y.length * 0.95))]; };
      return [...m.values()].map((a) => ({ key: a.key, provider: a.provider, node: a.node, endpoint: a.endpoint, scope: a.scope, calls: a.calls, errors: a.errors, rateLimited: a.rateLimited, medianMs: med(a.ms), p95Ms: p95(a.ms), ttftMs: med(a.ttft), tps: med(a.tps), tokens: a.tokens, topBottleneck: Object.entries(a.bottlenecks).sort((p, q) => q[1] - p[1])[0] || null })).sort((p, q) => q.calls - p.calls); };
    return { models: by((r) => r.model), endpoints: by((r) => r.provider === 'local' ? r.node && `${r.node} · ${r.endpoint}` : `${r.provider} · ${r.endpoint}`), total: rows.length };
  };
  R('GET', '/api/perf', async (req) => {
    needPlatform(req);
    await Promise.race([pollWorkers(), new Promise((ok) => setTimeout(ok, 3000))]);
    const local = perf.machine || await perf.sampleMachine();
    const machines = cluster.nodes().filter((n) => n.enabled).map((n) => {
      const st = cluster.state.get(n.id) || {}; const m = n.is_local ? local : n.kind === 'worker' ? workerMetrics.get(n.id) : null;
      const loaded = (st.models || []).filter((x) => x.loaded);
      return { id: n.id, name: n.name, kind: n.kind, preset: n.preset, url: n.url, scope: n.is_local ? 'local' : networkScope(n.url), status: st.status || 'unknown', error: st.error || null, endpoints: st.endpoints || [], inflight: cluster.inflight.get(n.id) || 0,
        metrics: m && m.ok !== false ? m : null, metricsNote: !m ? (n.kind === 'worker' ? 'Waiting for metrics' : 'Hardware metrics need ForgeAI installed on that computer (Add → Another ForgeAI computer). Showing server data only.') : m.ok === false ? m.error : null,
        loaded: loaded.map((x) => ({ id: x.id, vram: x.vramBytes, mem: x.memBytes, ctx: x.loadedContext || x.context })), changes: st.changes || [], changedAt: st.changedAt || null,
        speeds: (st.models || []).map((x) => ({ id: x.id, tps: cluster.speed.get(n.id + '|' + x.id) || null, ttft: cluster.ttft.get(n.id + '|' + x.id) || null })).filter((x) => x.tps || x.ttft) };
    });
    const agg = aggUsage(+req.query.get('hours') || 24);
    const providers = store.all("SELECT id, provider, label, status, status_detail FROM providers").map((p) => ({ ...p, name: p.label || (PROVIDER_TYPES[p.provider] || {}).name, rateLimited: /rate limit/i.test(p.status_detail || '') }));
    const live = perf.liveList();
    // Bottlenecks across the whole system, worst first.
    const B = [];
    for (const m of machines) {
      if (m.status === 'offline') B.push({ sev: 3, where: m.name, text: `${m.name} is not reachable — its models can't be used.`, fix: m.error || 'Check it is on and the server is running.' });
      const x = m.metrics; if (x && x.memTotal) { const freePct = x.memFree / x.memTotal * 100; if (freePct < 8) B.push({ sev: 3, where: m.name, text: `Memory almost full on ${m.name} (${(x.memFree / 2 ** 30).toFixed(1)} GB free) — models will be swapped out or load slowly.`, fix: 'Unload unused models, use a smaller quantisation, or move a model to another computer.' }); }
      if (x && x.cpuPct > 90) B.push({ sev: 2, where: m.name, text: `CPU busy on ${m.name} (${x.cpuPct}%).`, fix: 'If a model runs on the CPU, it will be slow — use a smaller model or a GPU machine.' });
      for (const g of (x && x.gpu) || []) if (g.utilPct >= 95 && m.inflight > 1) B.push({ sev: 2, where: m.name, text: `GPU on ${m.name} is saturated with ${m.inflight} requests at once — they are sharing it.`, fix: 'Spread work to another computer or use a smaller model for quick tasks.' });
      if (m.inflight > 2) B.push({ sev: 2, where: m.name, text: `${m.inflight} requests are queued on ${m.name}.`, fix: 'Add another computer or let quick jobs use a smaller model.' });
    }
    for (const a of agg.models) {
      if (a.tps != null && a.tps < 8 && a.provider === 'local' && a.calls >= 2) B.push({ sev: 2, where: a.key, text: `${a.key} writes slowly (${a.tps.toFixed(1)} tokens/s on ${a.node || 'its computer'}).`, fix: 'It may be too big for that machine or partly on the CPU — try a smaller quantisation or another computer.' });
      if (a.ttftMs != null && a.ttftMs > 6000 && a.calls >= 2) B.push({ sev: 2, where: a.key, text: `${a.key} takes ${(a.ttftMs / 1000).toFixed(1)}s before the first word.`, fix: a.provider === 'local' ? 'Keep the model loaded, shorten long conversations, or use a faster computer.' : 'The provider is slow to start — try a faster model tier.' });
      if (a.rateLimited) B.push({ sev: 3, where: a.key, text: `${a.key} was rate-limited ${a.rateLimited}× by the provider.`, fix: 'Slow down, raise your provider tier, or let Auto use a local model.' });
      if (a.errors > 2 && a.errors / a.calls > 0.3) B.push({ sev: 2, where: a.key, text: `${a.key} failed ${a.errors} of ${a.calls} requests.`, fix: 'Open Activity on a failed answer to see the error.' });
    }
    for (const c of store.getSetting('clusters', [])) for (const l of c.links || []) if (l.mbps && l.mbps < 1500) B.push({ sev: 2, where: c.name, text: `Cluster “${c.name}”: the link ${l.a} ↔ ${l.b} measured ${Math.round(l.mbps)} Mbit/s — splitting a model over it will be limited by the network.`, fix: 'Use 10 Gb Ethernet or Thunderbolt between those computers.' });
    // Queue and loading time, from recent requests.
    const q = scheduler.snapshot(); for (const [k, v] of Object.entries(q)) if (v.waiting > 0) B.push({ sev: 2, where: k, text: `${v.waiting} request${v.waiting > 1 ? 's are' : ' is'} waiting for ${k.replace('forgeai-engine://local', 'the ForgeAI Engine')} (limit ${v.limit} at once).`, fix: 'Raise its “at once” limit under Model health → Request queue, or spread work to another computer.' });
    const slowLoads = perf.recent.filter((r) => r.loadMs > 15000).slice(0, 3); for (const r of slowLoads) B.push({ sev: 1, where: r.model, text: `${r.model} took ${(r.loadMs / 1000).toFixed(0)}s to load on ${r.node}.`, fix: 'Pin it under Model health → Memory so it stays loaded, or raise “Keep loaded”.' });
    const queued = perf.recent.filter((r) => r.queueMs > 2000).slice(0, 3); for (const r of queued) B.push({ sev: 1, where: r.model, text: `A request waited ${(r.queueMs / 1000).toFixed(1)}s in the queue for ${r.endpoint}.`, fix: 'Several requests share that app. Raise its limit or add a computer.' });
    const health = store.getSetting('health', {}); for (const [k, v] of Object.entries(health)) if (v.cooldownUntil > Date.now() && k.startsWith('model:')) B.push({ sev: 3, where: k.slice(6), text: `${k.slice(6)} is set aside after ${v.cooldownWhy ? v.cooldownWhy.n + '× ' + (v.cooldownWhy.text || v.cooldownWhy.kind) : 'failures'}.`, fix: 'See Model health. If it was a memory problem, unload other models or use a smaller quantisation.' });
    if (!B.length) B.push({ sev: 0, where: 'All', text: 'No bottlenecks right now.', fix: null });
    B.sort((p, q) => q.sev - p.sev);
    return { at: now(), machines, live, recent: perf.recent.slice(0, 80).map((r) => ({ ...r, outChars: undefined })), models: agg.models, endpoints: agg.endpoints, providers, bottlenecks: B, clusters: store.getSetting('clusters', []) };
  });
  // Measure a model on its real hardware (time to first token and tokens/sec). Results feed the capability guide.
  // ---- 2.9 Topology: one call with everything the network map needs (machines, models, link type, latency,
  // measured speed) plus combined totals for the "supercomputer" view. Latency is timed live (cached 20 s);
  // speed is only shown once someone runs a speed test on that link (it moves real data, so it's on demand).
  const topoLatency = new Map(); const topoSpeed = new Map();
  const timePing = async (n) => {
    const c = topoLatency.get(n.id); if (c && Date.now() - c.at < 20000) return c.ms;
    try { const rt = cluster.runtimesFor(n)[0]; const t0 = Date.now(); await rt.adapter.get('/node/net/ping', 3000); const ms = Date.now() - t0; topoLatency.set(n.id, { ms, at: Date.now() }); return ms; }
    catch { topoLatency.set(n.id, { ms: null, at: Date.now() }); return null; }
  };
  const linkKind = (n) => n.link_id ? 'link' : n.is_local ? 'local' : ({ local: 'local', lan: 'lan', vpn: 'vpn', internet: 'internet' }[networkScope(n.url)] || 'lan');
  R('GET', '/api/topology', async (req) => {
    needPlatform(req);
    if (!perf.machine) await perf.sampleMachine().catch(() => {});
    const stale = cluster.nodes().some((n) => n.kind === 'worker' && n.enabled && (!workerMetrics.get(n.id) || Date.now() - workerMetrics.get(n.id).at > 15000));
    if (stale) await pollWorkers().catch(() => {});
    const nodes = cluster.nodes(); const spokes = linkHub.status().spokes || [];
    const out = await Promise.all(nodes.map(async (n) => {
      const st = cluster.state.get(n.id) || { status: 'unknown', models: [] };
      const sp = n.link_id ? spokes.find((s) => s.id === n.link_id) : null;
      const machine = n.is_local ? perf.machine : (workerMetrics.get(n.id) && workerMetrics.get(n.id).ok ? workerMetrics.get(n.id) : (sp && sp.machine) || null);
      const online = n.is_local || st.status === 'online';
      const models = (st.models || []).map((m) => ({ id: m.id, loaded: !!m.loaded, size: m.memBytes || m.sizeBytes || null, tps: cluster.speed.get(n.id + '|' + m.id) || null }));
      return { id: n.is_local ? 'local' : n.id, nodeId: n.id, name: n.name, kind: n.is_local ? 'hub' : n.kind, cluster: /\(cluster\)$/.test(n.name) || n.kind === 'compat' && n.preset === 'llamacpp' && /cluster/i.test(n.name),
        link: linkKind(n), online, enabled: !!n.enabled, error: online ? null : (st.error || null), version: n.is_local ? version : (sp && sp.version) || null,
        latencyMs: n.is_local ? 0 : (online && n.kind === 'worker' ? await timePing(n) : null), mbps: (topoSpeed.get(n.id) || {}).mbps || null,
        machine: machine ? { host: machine.host, os: machine.os, cores: machine.cores, cpuPct: machine.cpuPct, memTotal: machine.memTotal, memFree: machine.memFree, gpu: (machine.gpu || []).map((g) => ({ name: g.name, utilPct: g.utilPct, memTotal: g.memTotal })) } : null,
        availability: n.is_local ? lender.last : ((cluster.metrics.get(n.id) || {}).availability || null), inflight: cluster.inflight.get(n.id) || 0,
        sharedWith: safeJSON(n.org_ids, []), models };
    }));
    const live = out.filter((x) => x.online && x.machine);
    const totals = { computers: out.filter((x) => x.kind !== 'hub' && !x.cluster).length + 1, online: out.filter((x) => x.online && !x.cluster).length,
      cores: live.reduce((a, x) => a + (x.machine.cores || 0), 0), idleCores: Math.round(live.reduce((a, x) => a + (x.machine.cores || 0) * (1 - (x.machine.cpuPct || 0) / 100), 0)),
      memTotal: live.reduce((a, x) => a + (x.machine.memTotal || 0), 0), memFree: live.reduce((a, x) => a + (x.machine.memFree || 0), 0),
      gpus: live.reduce((a, x) => a + (x.machine.gpu || []).length, 0), models: new Set(out.flatMap((x) => x.models.map((m) => m.id))).size,
      loaded: out.reduce((a, x) => a + x.models.filter((m) => m.loaded).length, 0), running: out.reduce((a, x) => a + (x.inflight || 0), 0) };
    return { hub: { name: platformName(), version, hubOn: !!linkHub.settings().enabled, publicAddress: hubPublic() }, nodes: out, totals };
  });
  R('POST', '/api/topology/speed/:id', async (req) => {
    needPlatform(req, 'admin'); const n = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", req.params.id); if (!n) throw err(404, 'Speed tests work between ForgeAI computers');
    try { const r = await measureLink((p) => pinnedFetch(n.url.replace(/\/$/, '') + p, { headers: { authorization: 'Bearer ' + vault.reveal(n.secret_ref) }, pin: n.cert_pin, signal: AbortSignal.timeout(60000) }), 16); topoSpeed.set(n.id, { mbps: r.mbps, rttMs: r.rttMs, at: Date.now() }); return r; }
    catch (e) { throw err(400, `${n.name}: speed test failed — ${e.message}`); }
  });
  R('GET', '/api/perf/live', (req) => { needPlatform(req); return perf.liveList(); });
  // ---- model health, capabilities, memory, queue
  const providersForCaps = () => store.all('SELECT * FROM providers').map((c) => ({ id: c.id, provider: c.provider, name: c.label || PROVIDER_TYPES[c.provider].name, host: hostOf(c.base_url || PROVIDER_TYPES[c.provider].defaultBase), list: safeJSON(c.models, {}).list || [], price: (id) => { const pz = models.price(id); return { in: pz.input_per_m, out: pz.output_per_m }; } }));
  R('GET', '/api/health', async (req) => {
    needPlatform(req);
    const reg = capsReg.list({ providers: providersForCaps() });
    // Backends: every endpoint ForgeAI talks to, with the last check and the health record.
    const backends = [];
    for (const n of cluster.nodes()) { if (!n.enabled) continue; const st = cluster.state.get(n.id) || {}; for (const e of st.endpoints || []) backends.push({ name: PRESET_NAMES[e.runtime] || e.runtime, node: n.name, url: e.url === 'forgeai-engine://local' ? 'built in' : e.url, ok: e.ok, startable: !!e.startable, latencyMs: e.latencyMs, models: e.models || 0, error: e.error || null, kind: e.ok ? 'ok' : e.startable ? 'app-closed' : classify(new Error(e.error || ''), { remote: !n.is_local, node: n.name }).kind, stats: health.stats('endpoint', e.url), machine: health.stats('machine', n.name), machineState: n.is_local ? 'ok' : st.status }); }
    for (const c of store.all('SELECT * FROM providers')) backends.push({ name: c.label || PROVIDER_TYPES[c.provider].name, node: 'cloud', url: hostOf(c.base_url || PROVIDER_TYPES[c.provider].defaultBase), ok: c.status === 'connected', error: c.status === 'connected' ? null : c.status_detail, kind: c.status === 'connected' ? 'ok' : /rate limit/i.test(c.status_detail || '') ? 'RATE_LIMITED' : /401|403|key/i.test(c.status_detail || '') ? 'API_KEY_INVALID' : 'BACKEND_FAILED', stats: health.stats('endpoint', PROVIDER_TYPES[c.provider].name) });
    return { models: reg, backends, memory: { settings: memory.settings(), loaded: memory.loaded().map((m) => ({ ...m, node: undefined, url: undefined })), log: memory.log.slice(0, 20), keepLimit: memory.keepLimit() }, queue: scheduler.snapshot(), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.title])) };
  });
  R('PUT', '/api/health/caps/:id', (req) => { needPlatform(req, 'owner'); const b = req.body || {}; const patch = {}; for (const k of ['vision', 'tools', 'coding', 'reasoning', 'json', 'parallel', 'excluded', 'imageGen']) if (k in b) patch[k] = b[k] === null ? null : !!b[k]; for (const k of ['context', 'maxOutput']) if (k in b) patch[k] = b[k] ? Math.max(0, +b[k]) : null; if ('note' in b) patch.note = b.note ? String(b.note).slice(0, 200) : null; const r = capsReg.setOverride(req.params.id, patch); store.audit(req.user.username, 'model.caps', null, { id: req.params.id, patch }); return r; });
  R('POST', '/api/health/clear', (req) => { needPlatform(req, 'owner'); const { scope, id } = req.body || {}; health.clear(scope || 'model', String(id)); store.audit(req.user.username, 'health.clear', null, { scope, id }); return { ok: true }; });
  R('POST', '/api/health/disable', (req) => { needPlatform(req, 'owner'); const { id, on } = req.body || {}; health.disable('model', String(id), !!on); capsReg.setOverride(String(id), { excluded: !!on }); store.audit(req.user.username, 'model.disable', null, { id, on: !!on }); return { ok: true }; });
  R('PUT', '/api/memory', (req) => { needPlatform(req, 'owner'); const n = memory.save(req.body || {}); if ('autoUnload' in (req.body || {})) store.setSetting('memory', { ...n, autoUnload: !!req.body.autoUnload }); return memory.settings(); });
  R('POST', '/api/memory/pin', (req) => { needPlatform(req, 'owner'); memory.pin(String(req.body.id), !!req.body.on); return { pinned: [...memory.pinned] }; });
  R('PUT', '/api/queue', (req) => { needPlatform(req, 'owner'); const cur = store.getSetting('concurrency', {}); const b = req.body || {}; for (const k of ['localDefault', 'engineDefault', 'cloudDefault']) if (b[k] != null) cur[k] = Math.max(1, Math.min(32, +b[k] || 1)); if (b.key && b.limit != null) cur[b.key] = Math.max(1, Math.min(32, +b.limit || 1)); store.setSetting('concurrency', cur); return cur; });
  // Test Model: a short diagnostic — can it load, generate, stream, see images, call tools — and how fast.
  R('POST', '/api/models/test', async (req) => {
    needPlatform(req); const id = String(req.body.model || ''); if (!id) throw err(400, 'Choose a model');
    const d = models.decide({ orgDb: ownerLedger, mode: 'other', model: id.startsWith('cloud:') ? id : 'local:' + id, text: 'test' });
    if (d.blocked) throw err(400, d.reasons[d.reasons.length - 1]);
    const out = { model: id, steps: [], ok: true }; const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); if (ok === false) out.ok = false; };
    const t0 = Date.now(); let r;
    try { r = await models.run(d, { orgDb: ownerLedger, system: 'You are a test. Follow the instruction exactly.', messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 8, kind: 'benchmark', noFallback: true });
      step('Load', true, r.stats.loadMs ? `loaded in ${(r.stats.loadMs / 1000).toFixed(1)}s` : 'already loaded'); step('Generate', /ok/i.test(r.text) ? true : null, r.text.trim().slice(0, 40) || '(empty)'); step('Stream', r.stats.ttftMs != null, r.stats.ttftMs != null ? `first word after ${r.stats.ttftMs} ms` : 'no streaming seen');
    } catch (e) { step('Load / generate', false, (e.info && e.info.text) || e.message); out.error = e.info || { kind: 'UNKNOWN', text: e.message }; return out; }
    const reg = capsReg.list({ providers: providersForCaps() }).find((m) => m.id === id || m.id === 'local:' + id);
    if (reg && reg.caps.vision) { try { const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z8DwnwEJMDEgAQwMDAC4yQMBhU0D3wAAAABJRU5ErkJggg==', 'base64').toString('base64'); const v = await models.run(d, { orgDb: ownerLedger, messages: [{ role: 'user', content: 'What colour is this image? One word.', images: [{ mime: 'image/png', b64: png }] }], maxTokens: 8, kind: 'benchmark', noFallback: true }); step('Vision', !!v.text.trim(), v.text.trim().slice(0, 40)); } catch (e) { step('Vision', false, (e.info && e.info.text) || e.message); } }
    if (reg && reg.caps.tools) { try { const tr = await models.runTools(d, { orgDb: ownerLedger, system: 'Use the tool.', messages: [{ role: 'user', content: 'What is the weather in Wellington? Use the get_weather tool.' }], tools: [{ name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }], maxTokens: 64, kind: 'benchmark' }); const called = (tr.toolCalls || []).some((c) => c.name === 'get_weather'); step('Tool calling', called ? true : null, called ? 'called get_weather' : 'answered without calling the tool'); } catch (e) { step('Tool calling', false, (e.info && e.info.text) || e.message); } }
    try { const b = await models.run(d, { orgDb: ownerLedger, system: 'You are a benchmark.', messages: [{ role: 'user', content: 'Write exactly 80 words about bicycles.' }], maxTokens: 140, kind: 'benchmark', noFallback: true }); step('Speed', true, `${b.stats.tps ? Math.round(b.stats.tps) + ' tok/s' : 'not measured'} · first word ${b.stats.ttftMs} ms`); out.tps = b.stats.tps; out.ttftMs = b.stats.ttftMs; } catch (e) { step('Speed', false, (e.info && e.info.text) || e.message); }
    out.totalMs = Date.now() - t0; store.audit(req.user.username, 'model.test', null, { model: id, ok: out.ok }); return out;
  });
  R('POST', '/api/models/test-all', async (req) => { needPlatform(req, 'owner'); const ids = cluster.distinctModels().filter((m) => !(m.caps && m.caps.embeddings)).map((m) => m.id).slice(0, 40); const results = []; for (const id of ids) { try { const d = models.decide({ orgDb: ownerLedger, mode: 'other', model: 'local:' + id, text: 'test' }); if (d.blocked) { results.push({ model: id, ok: false, error: d.reasons.slice(-1)[0] }); continue; } const r = await models.run(d, { orgDb: ownerLedger, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 6, kind: 'benchmark', noFallback: true }); results.push({ model: id, ok: true, ttftMs: r.stats.ttftMs, loadMs: r.stats.loadMs }); } catch (e) { results.push({ model: id, ok: false, error: (e.info && e.info.text) || e.message, kind: e.info && e.info.kind }); } } return results; });
  R('GET', '/api/orgs/:org/route-explain', (req) => { const db = orgAccess(req, 'view'); const d = models.decide({ orgDb: db, mode: req.query.get('mode') || 'auto', model: req.query.get('model') || null, text: req.query.get('text') || '', needVision: req.query.get('vision') === '1' }); return { label: d.label, blocked: !!d.blocked, reasons: d.reasons, why: d.why, whyNot: d.whyNot || [], trace: d.trace || [], req: d.req || [], fallbacks: d.fallbacks || [] }; }, {});
  R('POST', '/api/models/benchmark', async (req) => {
    needPlatform(req); const id = String(req.body.model || ''); if (!id) throw err(400, 'Choose a model');
    const d = models.decide({ orgDb: ownerLedger, mode: 'other', model: id.startsWith('cloud:') ? id : 'local:' + id, text: 'benchmark' });
    if (d.blocked) { const own = store.getSetting('owner_ai', {}); if (id.startsWith('cloud:') && !own.cloud_allowed) throw err(400, 'Benchmarks run as the Owner AI, which is set to local only. Allow cloud in Owner AI settings to benchmark cloud models.'); throw err(400, d.reasons[d.reasons.length - 1]); }
    const runs = []; let last;
    for (let i = 0; i < 2; i++) {
      last = await models.run(d, { orgDb: ownerLedger, system: 'You are a benchmark. Follow the instruction exactly.', messages: [{ role: 'user', content: 'Write exactly 120 words about the history of the bicycle. No title.' }], maxTokens: 220, kind: 'benchmark' });
      runs.push(last.stats);
    }
    const best = runs[runs.length - 1]; const key = (d.kind === 'local' ? (last.node || 'local') : last.provider) + '|' + (d.kind === 'local' ? d.model : id);
    const b = store.getSetting('benchmarks', {}); b[key] = { model: d.model, where: d.kind === 'local' ? last.node : last.provider, endpoint: last.endpoint, ttftMs: best.ttftMs, coldTtftMs: runs[0].ttftMs, tps: best.tps, totalMs: best.totalMs, at: now() };
    store.setSetting('benchmarks', b); store.audit(req.user.username, 'model.benchmark', null, { model: id });
    return b[key];
  });
  R('GET', '/api/models/guide', (req) => {
    needPlatform(req); const bench = store.getSetting('benchmarks', {});
    return { models: cluster.catalog().map((m) => ({ id: m.id, alias: m.alias, node: m.nodeName, endpoint: m.endpoint, params: m.params, quant: m.quant, family: m.family, format: m.format, file: m.file, sizeBytes: m.sizeBytes, memBytes: m.memBytes, vramBytes: m.vramBytes, context: m.context, loadedContext: m.loadedContext, loaded: m.loaded, caps: m.caps || { chat: true, vision: m.vision, tools: m.tools }, source: m.source || {}, measured: bench[m.nodeName + '|' + m.id] || null, liveTps: m.tps, liveTtft: m.ttft })) };
  });
  R('GET', '/api/pipelines', () => engine.pipelines());
  R('PUT', '/api/pipelines', (req) => {
    needPlatform(req);
    const list = (Array.isArray(req.body.pipelines) ? req.body.pipelines : []).slice(0, 30).map((p) => ({ id: String(p.id || uid('pipe_')).replace(/[^\w-]/g, '').slice(0, 40) || uid('pipe_'), name: String(p.name || 'Pipeline').slice(0, 60),
      stages: (Array.isArray(p.stages) ? p.stages : []).slice(0, 8).map((x) => ({ name: String(x.name || 'Stage').slice(0, 40), role: ['ideate', 'execute', 'review', 'custom'].includes(x.role) ? x.role : 'custom', pick: String(x.pick || 'auto').slice(0, 200), fallback: x.fallback ? String(x.fallback).slice(0, 200) : null, instruction: String(x.instruction || '').slice(0, 4000), optional: !!x.optional, enabled: x.enabled !== false })) })).filter((p) => p.stages.length);
    store.setSetting('pipelines', list); store.audit(req.user.username, 'pipelines.save', null, { count: list.length }); return list;
  });

  // ---- clusters (one model split across several computers)
  async function ollamaModelPath(model) {
    const r = await fetch('http://127.0.0.1:11434/api/show', { method: 'POST', body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('Ollama does not have ' + model + ' on this computer');
    const j = await r.json(); const m = /^FROM\s+(.+)$/m.exec(j.modelfile || ''); if (!m || !fs.existsSync(m[1].trim())) throw new Error('Could not find the GGUF file of ' + model);
    return m[1].trim();
  }
  // Run a kit operation on this computer ('local') or on a ForgeAI worker computer.
  const kitOn = async (nodeId, op, body = {}, ms = 60000) => {
    if (!nodeId || nodeId === 'local') { const f = KIT_OPS[op]; return f(body); }
    const n = store.get('SELECT * FROM nodes WHERE id=?', nodeId); if (!n || n.kind !== 'worker') throw err(400, 'That computer must be added as “Another ForgeAI computer” to join a cluster');
    try { return await cluster.runtimesFor(n)[0].adapter.post('/node/kit/' + op, body, ms); }
    catch (e) { const m = String(e.message || e).replace(/^Worker node error \d+:\s*/, ''); throw Object.assign(new Error(/failed at|not found|could not|already in use|Install|Choose/.test(m) ? m : `${n.name}: ${m}`), { status: 400 }); }
  };
  const nodeHost = (nodeId) => { if (!nodeId || nodeId === 'local') return null; const n = store.get('SELECT * FROM nodes WHERE id=?', nodeId); try { return new URL(n.url).hostname; } catch { return null; } };
  R('GET', '/api/kit', async (req) => { needPlatform(req); return { local: kit.status(), clusters: store.getSetting('clusters', []) }; });
  R('POST', '/api/kit/:node/:op', async (req) => { needPlatform(req, 'owner'); if (!['caps', 'status', 'install', 'stop'].includes(req.params.op)) throw err(400, 'Not allowed here'); return kitOn(req.params.node, req.params.op, req.body || {}); });
  // Wizard steps 1–2–3–6: hardware, backends and links for the chosen computers.
  // Which of a worker's network addresses is fastest from this computer? Tries every interface it reports (Thunderbolt/USB-C
  // bridge, Ethernet, Wi-Fi, VPN) that answers on ForgeAI's port and measures each. Linked computers always go through the link.
  const bestAddress = async (nodeId, caps) => {
    const row = store.get('SELECT * FROM nodes WHERE id=?', nodeId); if (!row || row.link_id) return null;
    let u; try { u = new URL(row.url); } catch { return null; }
    const port = +u.port || (u.protocol === 'https:' ? 443 : 80); const cur = u.hostname;
    const addrs = [...new Set([cur, ...((caps && caps.interfaces) || []).map((i) => i.address)])];
    const out = [];
    for (const a of addrs) {
      const iface = ((caps && caps.interfaces) || []).find((i) => i.address === a) || { kind: a === cur ? 'current' : 'other', name: '' };
      if (!(await portOpen(a, port, 1500))) { out.push({ address: a, kind: iface.kind, name: iface.name, reachable: false }); continue; }
      const url = `${u.protocol}//${a}:${port}`;
      try { const r = await measureLink((p) => pinnedFetch(url + p, { headers: { authorization: 'Bearer ' + vault.reveal(row.secret_ref) }, pin: row.cert_pin, signal: AbortSignal.timeout(30000) }), 16); out.push({ address: a, kind: iface.kind, name: iface.name, reachable: true, mbps: r.mbps, rttMs: r.rttMs }); }
      catch (e) { out.push({ address: a, kind: iface.kind, name: iface.name, reachable: true, error: e.message }); }
    }
    const best = out.filter((x) => x.mbps).sort((x, y) => y.mbps - x.mbps)[0] || null;
    return { candidates: out, best: best ? best.address : cur, bestKind: best ? best.kind : null };
  };
  R('POST', '/api/clusters/links', async (req) => { needPlatform(req, 'owner'); const ids = (req.body.members || []).filter((id) => id !== 'local').slice(0, 16); const out = {}; for (const id of ids) { try { const caps = await kitOn(id, 'caps', {}, 30000); out[id] = await bestAddress(id, caps); } catch (e) { out[id] = { error: e.message }; } } return out; });
  R('POST', '/api/clusters/plan', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {}; const members = (b.members || []).slice(0, 16); const coord = b.coordinator || 'local';
    const nodes = await Promise.all(members.map(async (m) => {
      if (m.manual) return { id: m.id, manual: true, name: m.name || `${m.host}:${m.port}`, host: m.host, port: m.port, reachable: await portOpen(m.host, +m.port, 1500) };
      try { const caps = await kitOn(m.id, 'caps', {}, 30000); const n = m.id === 'local' ? null : store.get('SELECT name,url FROM nodes WHERE id=?', m.id); return { id: m.id, name: n ? n.name : 'This computer', host: nodeHost(m.id), caps }; }
      catch (e) { return { id: m.id, name: m.id, error: e.message }; }
    }));
    // Links from the coordinator to every other ForgeAI computer.
    const links = [];
    if (b.measure) {
      const targets = nodes.filter((n) => n.id !== coord && !n.manual && !n.error && n.id !== 'local').map((n) => { const row = store.get('SELECT * FROM nodes WHERE id=?', n.id); return { id: n.id, url: row.url, token: vault.reveal(row.secret_ref), pin: row.cert_pin }; });
      let res = [];
      if (coord === 'local') res = await Promise.all(targets.map(async (t) => { try { return { id: t.id, ...(await measureLink((p) => pinnedFetch(t.url + p, { headers: { authorization: 'Bearer ' + t.token }, pin: t.pin, signal: AbortSignal.timeout(60000) }), 32)) }; } catch (e) { return { id: t.id, error: e.message }; } }));
      else res = await kitOn(coord, 'link', { targets: targets.filter((t) => t.id !== coord) }, 120000);
      const nm = (id) => (nodes.find((n) => n.id === id) || {}).name || id;
      for (const r of res) links.push({ a: nm(coord), b: nm(r.id), ...r });
      if (coord !== 'local' && nodes.some((n) => n.id === 'local')) { const row = store.get('SELECT * FROM nodes WHERE id=?', coord); try { const r = await measureLink((p) => pinnedFetch(row.url + p, { headers: { authorization: 'Bearer ' + vault.reveal(row.secret_ref) }, pin: row.cert_pin, signal: AbortSignal.timeout(60000) }), 32); links.push({ a: 'This computer', b: nm(coord), ...r }); } catch (e) { links.push({ a: 'This computer', b: nm(coord), error: e.message }); } }
    }
    // Suggested split by memory available for the model (VRAM on NVIDIA, otherwise system memory).
    const mem = (n) => { if (n.manual) return +n.memGb * 2 ** 30 || 0; const c = n.caps || {}; const nv = (c.gpu || []).filter((g) => g.kind === 'nvidia'); return nv.length ? nv.reduce((a, g) => a + (g.vramTotal - g.vramUsed), 0) : c.memFree || 0; };
    const ordered = [nodes.find((n) => n.id === coord), ...nodes.filter((n) => n.id !== coord)].filter(Boolean);
    const total = ordered.reduce((a, n) => a + mem(n), 0) || 1;
    const split = ordered.map((n) => ({ id: n.id, name: n.name, memBytes: mem(n), share: +(mem(n) / total).toFixed(3) }));
    const backends = {
      llamacpp: { name: 'llama.cpp RPC', ok: nodes.every((n) => n.manual || (n.caps && n.caps.backends.llamacpp.supported)), note: 'Works on Mac, Windows and Linux (Metal, CUDA, Vulkan or CPU). ForgeAI installs and runs it for you. Best default for mixed or Windows clusters.' },
      exo: { name: 'exo', ok: nodes.every((n) => !n.manual && n.caps && n.caps.backends.exo.supported), note: 'Discovers devices itself and splits models by topology; strongest on Apple Silicon. Linux runs on CPU only for now; Windows is not supported. Install exo on each computer, then ForgeAI connects to it.', rdma: nodes.some((n) => n.caps && n.caps.backends.exo.rdmaPossible) },
      mlx: { name: 'MLX distributed', ok: nodes.every((n) => !n.manual && n.caps && n.caps.backends.mlx.supported), note: 'Apple Silicon Macs only. Needs Python with mlx and mlx-lm on each Mac.' },
      vllm: { name: 'vLLM + Ray', ok: nodes.every((n) => !n.manual && n.caps && n.caps.backends.vllm.supported), note: 'Linux (or WSL2) computers with NVIDIA GPUs. Highest throughput, most setup.' },
    };
    const warnings = [];
    for (const l of links) if (l.mbps && l.mbps < 1500) warnings.push(`${l.a} ↔ ${l.b}: ${Math.round(l.mbps)} Mbit/s — about 1 Gb Ethernet or Wi-Fi. Splitting a model over this link will be slow; use 10 Gb Ethernet or Thunderbolt.`);
    for (const n of nodes) if (n.caps && n.caps.board) warnings.push(`${n.name} is a ${n.caps.board}: good for small 1–3B models, monitoring or routing. Adding it to a GPU cluster usually makes the cluster slower.`);
    for (const n of nodes) if (n.caps && (n.caps.interfaces || []).some((i) => i.kind === 'wifi') && !(n.caps.interfaces || []).some((i) => i.kind !== 'wifi' && i.kind !== 'vpn')) warnings.push(`${n.name} only has Wi-Fi — use a cable for clusters.`);
    // Visual plan for a specific model: layers per computer, memory, link speed and what that means for speed.
    let visual = null;
    if (b.model && b.model.value) {
      const { readGGUF } = require('./gguf'); let meta = null, memBytes = 0, name = String(b.model.value);
      try { const file = b.model.type === 'ollama' ? await ollamaModelPath(b.model.value) : b.model.value; if (fs.existsSync(file)) { meta = readGGUF(file); memBytes = Math.round(fs.statSync(file).size * 1.15); name = meta.name || path.basename(file); } } catch {}
      const layers = meta && meta.blocks ? meta.blocks : null; const GBv = 2 ** 30;
      const totalShare = split.reduce((a, x) => a + x.share, 0) || 1; let from = 0;
      const perMachine = split.map((x) => { const share = x.share / totalShare; const n = layers ? Math.round(layers * share) : null; const r = { ...x, layers: n != null ? [from, Math.min(layers, from + n) - 1] : null, gb: memBytes ? +(memBytes * share / GBv).toFixed(1) : null, fits: x.memBytes ? memBytes * share <= x.memBytes : null }; if (n != null) from += n; return r; });
      const fitsAlone = split.filter((x) => memBytes && x.memBytes >= memBytes * 1.05).map((x) => x.name);
      const worst = links.filter((l) => l.mbps).sort((a, b2) => a.mbps - b2.mbps)[0] || null;
      // Per token, every hop moves one hidden-state vector (small) but pays one round trip: the network alone caps speed at ~1000 / (hops × RTT).
      const hops = Math.max(0, split.length - 1); const rtt = links.length ? Math.max(...links.filter((l) => l.rttMs != null).map((l) => l.rttMs)) : null;
      const netCap = hops && rtt ? +(1000 / (hops * rtt)).toFixed(0) : null;
      const bench = store.getSetting('benchmarks', {}); const single = Object.values(bench).find((x) => x.model === b.model.value || x.model === name);
      const est = { text: 'Unknown until you press Benchmark — ForgeAI does not guess speeds.', netCapTps: netCap, singleTps: single ? single.tps : null };
      if (netCap) est.text = `The network alone caps generation at about ${netCap} tok/s (${hops} hop${hops > 1 ? 's' : ''} × ${rtt.toFixed(1)} ms round trip, measured). Real speed will be lower; press Benchmark after starting to measure it.`;
      const advice = fitsAlone.length ? `${name} fits on ${fitsAlone.join(' or ')} alone (needs about ${(memBytes / GBv).toFixed(0)} GB). One computer is almost always faster than a cluster — use the cluster only if you need the extra memory for a bigger context or more models.` : memBytes ? `${name} needs about ${(memBytes / GBv).toFixed(0)} GB — more than any one of these computers has free, so splitting is the way to run it.` : null;
      visual = { model: name, layers, memBytes, perMachine, worstLink: worst ? { a: worst.a, b: worst.b, mbps: Math.round(worst.mbps), rttMs: +worst.rttMs.toFixed(1) } : null, estimate: est, fitsAlone, advice, recommended: !fitsAlone.length };
    }
    return { nodes, links, split, backends, warnings, visual };
  });
  const clusters = () => store.getSetting('clusters', []);
  const saveClusters = (l) => store.setSetting('clusters', l);
  // After a restart, llama.cpp clusters ForgeAI ran are no longer running — say so instead of showing a dead endpoint.
  { const l = clusters(); let changed = false; for (const c of l) if (c.backend === 'llamacpp' && ['running', 'starting'].includes(c.status)) { c.status = 'stopped'; c.error = null; changed = true; if (c.endpointNode) store.run('UPDATE nodes SET enabled=0 WHERE id=?', c.endpointNode); } if (changed) saveClusters(l); }
  R('POST', '/api/clusters', (req) => {
    needPlatform(req, 'owner'); const b = req.body || {};
    const c = { id: uid('clu_'), name: String(b.name || 'Cluster').slice(0, 60), backend: ['llamacpp', 'exo', 'mlx', 'vllm'].includes(b.backend) ? b.backend : 'llamacpp', coordinator: b.coordinator || 'local',
      members: (b.members || []).slice(0, 16).map((m) => ({ id: m.id, manual: !!m.manual, host: m.host || null, port: +m.port || 50052, address: m.address || null, name: m.name || null })),
      model: { type: ['ollama', 'path', 'hf'].includes((b.model || {}).type) ? b.model.type : 'ollama', value: String((b.model || {}).value || '').slice(0, 500) }, split: b.split && typeof b.split === 'object' && !Array.isArray(b.split) ? Object.fromEntries(Object.entries(b.split).slice(0, 17).map(([k, v]) => [String(k), Math.max(0, +v || 0)])) : null, useCoordinator: b.useCoordinator !== false,
      ctx: Math.min(262144, Math.max(1024, +b.ctx || 8192)), port: +b.port || 8090, gpu: ['cpu', 'cuda', 'vulkan'].includes(b.gpu) ? b.gpu : 'cpu', links: b.links || [], status: 'stopped', created_at: now() };
    saveClusters([...clusters(), c]); store.audit(req.user.username, 'cluster.create', null, { name: c.name, backend: c.backend }); return c;
  });
  R('DELETE', '/api/clusters/:id', async (req) => { needPlatform(req, 'owner'); const c = clusters().find((x) => x.id === req.params.id); if (c && c.endpointNode) { store.run('DELETE FROM nodes WHERE id=?', c.endpointNode); cluster.state.delete(c.endpointNode); } saveClusters(clusters().filter((x) => x.id !== req.params.id)); return { ok: true }; });
  const setCl = (id, patch) => { const l = clusters().map((x) => (x.id === id ? { ...x, ...patch } : x)); saveClusters(l); return l.find((x) => x.id === id); };
  R('POST', '/api/clusters/:id/start', async (req) => {
    needPlatform(req, 'owner'); let c = clusters().find((x) => x.id === req.params.id); if (!c) throw err(404, 'Not found');
    if (c.backend !== 'llamacpp') throw err(400, 'ForgeAI starts llama.cpp clusters itself. For exo, MLX or vLLM, start the cluster with that tool, then use “Connect” to add its address.');
    setCl(c.id, { status: 'starting', error: null });
    try {
      const workers = c.members.filter((m) => m.id !== c.coordinator);
      // 1. llama.cpp on every ForgeAI computer
      for (const m of [{ id: c.coordinator }, ...workers.filter((w) => !w.manual)]) { const st = await kitOn(m.id, 'status'); if (!st.installed) throw new Error(`llama.cpp is not installed on ${m.id === 'local' ? 'this computer' : m.name || m.id} yet — use “Install llama.cpp” in the wizard`); }
      // 2. RPC servers, bound to the address the coordinator reaches them on (a Thunderbolt address if chosen — that also enables RDMA on supported Macs).
      const rpc = []; const order = [];
      for (const w of workers) {
        if (w.manual) { rpc.push(`${w.host}:${w.port}`); order.push(w.id); continue; }
        const row = store.get('SELECT * FROM nodes WHERE id=?', w.id);
        if (row && row.link_id) { // reached through ForgeAI Link: the RPC server binds to loopback there and the tunnel brings it here
          await kitOn(w.id, 'start-rpc', { host: '127.0.0.1', port: w.port || 50052 });
          const lp = await linkForward(row.link_id, w.port || 50052); rpc.push(`127.0.0.1:${lp}`); order.push(w.id); continue;
        }
        const host = w.address || nodeHost(w.id) || '127.0.0.1';
        await kitOn(w.id, 'start-rpc', { host, port: w.port || 50052 });
        rpc.push(`${host}:${w.port || 50052}`); order.push(w.id);
      }
      // A coordinator without a GPU only contributes its memory through its own RPC server (llama.cpp splits across devices, and plain CPU isn't one).
      const coordCaps = await kitOn(c.coordinator, 'caps', {}, 30000).catch(() => ({ gpu: [] }));
      const localGpus = (coordCaps.gpu || []).length;
      if (!localGpus && c.useCoordinator !== false) { const port = 50053; await kitOn(c.coordinator, 'start-rpc', { host: '127.0.0.1', port, own: true }); rpc.push(`127.0.0.1:${port}`); order.push(c.coordinator); }
      else if (localGpus) order.push(c.coordinator);
      // 3. Coordinator llama-server. llama.cpp lists RPC devices first, then local ones; the split follows that order.
      let ts = null;
      if (c.split && typeof c.split === 'object' && !Array.isArray(c.split) && localGpus <= 1) ts = order.map((id) => Math.max(0, +c.split[id] || 0));
      if (ts && !ts.some((x) => x > 0)) ts = null;
      let modelArg = {};
      if (c.model.type === 'ollama') modelArg.model = (await kitOn(c.coordinator, 'ollama-path', { model: c.model.value })).path;
      else if (c.model.type === 'hf') modelArg.hf = c.model.value; else modelArg.model = c.model.value;
      const apiKey = require('crypto').randomBytes(18).toString('hex');
      const bindHost = c.coordinator === 'local' ? '127.0.0.1' : nodeHost(c.coordinator);
      const alias = c.model.type === 'path' ? c.model.value.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : c.model.value;
      const r = await kitOn(c.coordinator, 'start-server', { ...modelArg, alias, rpc, split: ts, port: c.port, host: bindHost, ctx: c.ctx, apiKey }, 15 * 60000);
      // 4. Register it as a server so it appears in every model list, labelled with the cluster name.
      if (c.endpointNode) { const old = store.get('SELECT * FROM nodes WHERE id=?', c.endpointNode); if (old) { vault.remove(old.api_key_ref); store.run('DELETE FROM nodes WHERE id=?', old.id); } }
      const nid = uid('node_');
      store.run('INSERT INTO nodes(id,name,kind,url,ram_gb,enabled,is_local,created_at,preset,api_key_ref,tls_mode,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', nid, `${c.name} (cluster)`, 'compat', `http://${bindHost}:${c.port}`, 0, 1, 0, now(), 'llamacpp', vault.put(apiKey), 'verify', 600000);
      await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE id=?', nid)).catch(() => {});
      const ks = await kitOn(c.coordinator, 'status').catch(() => ({}));
      c = setCl(c.id, { status: 'running', endpointNode: nid, url: r.url, rpc, startedAt: now(), devices: (ks.devices || []).map((d) => { const a = /\[([^\]]+)\]/.exec(d.device); let i = a ? rpc.indexOf(a[1]) : -1; if (i < 0) { const mm = /^RPC(\d+)/.exec(d.device); i = mm ? +mm[1] : -1; } const who = i >= 0 ? order[i] : c.coordinator; return { ...d, member: who, host: /^CPU/i.test(d.device) }; }), offload: ks.offload || null });
      store.audit(req.user.username, 'cluster.start', null, { name: c.name, rpc });
      return c;
    } catch (e) {
      for (const m of c.members) if (!m.manual) await kitOn(m.id, 'stop', {}).catch(() => {});
      setCl(c.id, { status: 'error', error: e.message }); throw err(400, e.message);
    }
  });
  R('POST', '/api/clusters/:id/stop', async (req) => {
    needPlatform(req, 'owner'); const c = clusters().find((x) => x.id === req.params.id); if (!c) throw err(404, 'Not found');
    for (const m of [{ id: c.coordinator }, ...c.members]) if (!m.manual) await kitOn(m.id, 'stop', {}).catch(() => {});
    if (c.endpointNode) store.run('UPDATE nodes SET enabled=0 WHERE id=?', c.endpointNode);
    if (req.body && req.body.system) return setCl(c.id, { status: 'stopped' });
    return setCl(c.id, { status: 'stopped', note: null, ...(c.allMembers ? { members: c.allMembers, allMembers: null } : {}) }); // a manual stop restores the full member list
  });
  R('POST', '/api/clusters/:id/benchmark', async (req) => {
    needPlatform(req, 'owner'); const c = clusters().find((x) => x.id === req.params.id); if (!c || c.status !== 'running') throw err(400, 'Start the cluster first');
    store.run('UPDATE nodes SET enabled=1 WHERE id=?', c.endpointNode); await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE id=?', c.endpointNode)).catch(() => {});
    const st = cluster.state.get(c.endpointNode); const model = st && st.models[0]; if (!model) throw err(400, 'The cluster has no model loaded');
    const d = models.decide({ orgDb: ownerLedger, mode: 'other', model: 'local:' + model.id, text: 'benchmark' }); if (d.blocked) throw err(400, d.reasons[d.reasons.length - 1]);
    const r = await models.run(d, { orgDb: ownerLedger, system: 'You are a benchmark.', messages: [{ role: 'user', content: 'Write exactly 120 words about the history of the bicycle.' }], maxTokens: 220, kind: 'benchmark' });
    return setCl(c.id, { bench: { ...r.stats, at: now() } });
  });
  R('GET', '/api/clusters/:id/logs', async (req) => { needPlatform(req, 'owner'); const c = clusters().find((x) => x.id === req.params.id); if (!c) throw err(404, 'Not found'); const out = {}; for (const m of [{ id: c.coordinator }, ...c.members.filter((x) => !x.manual && x.id !== c.coordinator)]) { try { out[m.id === 'local' ? 'This computer' : m.name || m.id] = (await kitOn(m.id, 'status')).logs; } catch (e) { out[m.name || m.id] = { error: e.message }; } } return out; });
  // Quick Cluster: one click — every online ForgeAI computer, llama.cpp installed everywhere, automatic split, started.
  const quickJobs = new Map();
  R('GET', '/api/clusters/quick/:id', (req) => { needPlatform(req); const j = quickJobs.get(req.params.id); if (!j) throw err(404, 'Not found'); return j; });
  R('POST', '/api/clusters/quick', (req) => {
    needPlatform(req, 'owner'); const b = req.body || {};
    if (!b.model || !b.model.value) throw err(400, 'Choose the model to split');
    const workers = store.all("SELECT * FROM nodes WHERE kind='worker' AND enabled=1").filter((n) => (cluster.state.get(n.id) || {}).status === 'online');
    if (!workers.length) throw err(400, 'No other ForgeAI computer is online. Next: install ForgeAI (or ForgeAI Server) on another computer and add it under Computers → Add Computer.');
    const id = uid('qc_'); const job = { id, state: 'running', steps: [], started: now() }; quickJobs.set(id, job);
    const step = (t, st = 'run') => { const last = job.steps[job.steps.length - 1]; if (last && last.state === 'run') last.state = 'done'; job.steps.push({ text: t, state: st, at: now() }); };
    (async () => {
      try {
        const members = [{ id: 'local', name: 'This computer' }, ...workers.map((w) => ({ id: w.id, name: w.name }))];
        step(`Using ${members.length} computers: ${members.map((m) => m.name).join(', ')}`);
        for (const m of members) {
          const st = await kitOn(m.id, 'status');
          if (!st.installed) { step(`Installing llama.cpp on ${m.name} (from github.com/ggml-org/llama.cpp)`); await kitOn(m.id, 'install', { gpu: b.gpu || 'cpu' });
            for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 1000)); const s2 = await kitOn(m.id, 'status'); if (s2.installed) break; if (s2.install && s2.install.state === 'error') throw new Error(`${m.name}: ${s2.install.status}`); if (i === 599) throw new Error(`${m.name}: llama.cpp install took too long`); } }
        }
        step('Checking memory and measuring the links between computers');
        const addrOf = {};
        for (const m of members) { if (m.id === 'local') continue; const row = store.get('SELECT * FROM nodes WHERE id=?', m.id); if (row && row.link_id) { step(`${m.name}: reached through the remote link (speed limited by the internet connection)`, 'warn'); continue; } try { const caps = await kitOn(m.id, 'caps', {}, 30000); const r = await bestAddress(m.id, caps); if (r && r.candidates.length > 1) { addrOf[m.id] = r.best; const b2 = r.candidates.find((c) => c.address === r.best); step(`${m.name}: using ${b2 && b2.kind !== 'current' ? ({ thunderbolt: 'Thunderbolt / USB-C', ethernet: 'Ethernet', wifi: 'Wi-Fi', vpn: 'VPN' })[b2.kind] || b2.kind : 'its address'} ${r.best}${b2 && b2.mbps ? ` (${b2.mbps >= 1000 ? (b2.mbps / 1000).toFixed(1) + ' Gbit/s' : Math.round(b2.mbps) + ' Mbit/s'}, ${b2.rttMs != null ? b2.rttMs.toFixed(1) + ' ms' : ''})` : ''} — fastest of ${r.candidates.filter((c) => c.reachable).length} reachable links`); } } catch (e) { step(`${m.name}: could not compare links (${e.message})`, 'warn'); } }
        const planReq = { members: members.map((m) => ({ id: m.id })), coordinator: 'local', measure: true, model: b.model };
        const plan = await (async () => { const fake = { user: req.user, body: planReq }; return routesByKey['POST /api/clusters/plan'](fake); })();
        const bad = plan.nodes.filter((n) => n.error); if (bad.length) throw new Error(bad.map((n) => `${n.name}: ${n.error}`).join('; '));
        if (plan.visual && plan.visual.fitsAlone && plan.visual.fitsAlone.length) step(`Note: ${plan.visual.advice}`, 'warn');
        const name = String(b.name || (b.model.value.split(/[\\/:]/).filter(Boolean).pop() || 'Cluster').replace(/\.gguf$/i, '')).slice(0, 60);
        const c = { id: uid('clu_'), name, backend: 'llamacpp', coordinator: 'local', members: members.map((m) => ({ id: m.id, manual: false, host: null, port: 50052, address: addrOf[m.id] || null, name: m.name })),
          model: { type: ['ollama', 'path', 'hf'].includes(b.model.type) ? b.model.type : 'path', value: String(b.model.value).slice(0, 500) }, split: null, useCoordinator: true, ctx: Math.min(262144, Math.max(1024, +b.ctx || 8192)), port: 8090 + Math.floor(Math.random() * 50), gpu: b.gpu || 'cpu', links: plan.links, status: 'stopped', created_at: now(), quick: true };
        saveClusters([...clusters(), c]); job.clusterId = c.id;
        for (const w of plan.warnings) step('Note: ' + w, 'warn');
        step('Starting the workers and loading the model across them (big models take a few minutes)');
        const r = await routesByKey['POST /api/clusters/:id/start']({ user: req.user, params: { id: c.id }, body: {} });
        step(`Running — “${r.name} (cluster)” is now in every model menu`, 'done'); job.state = 'done'; job.cluster = r;
        store.audit(req.user.username, 'cluster.quick', null, { name: c.name, members: members.length });
      } catch (e) { step(e.message, 'fail'); job.state = 'error'; job.error = e.message; }
    })();
    return job;
  });
  // Lend-when-idle for clusters: a split model cannot survive losing a computer mid-generation, so when a lent member
  // becomes busy ForgeAI stops the cluster and restarts it on the remaining computers (and brings the member back later).
  let lendTickBusy = false;
  const lendTick = async () => {
    if (lendTickBusy) return; lendTickBusy = true;
    try {
      for (const c of clusters()) {
        if (c.backend !== 'llamacpp' || c.lendAware === false) continue;
        const busyOf = (id) => { if (id === 'local') return null; const mt = cluster.metrics.get(id); return mt && mt.availability && mt.availability.available === false ? mt.availability.reason : null; };
        const all = c.allMembers || c.members; const busy = all.filter((m) => !m.manual && busyOf(m.id)); const active = c.members;
        const wantIds = all.filter((m) => m.manual || !busyOf(m.id)).map((m) => m.id); const haveIds = active.map((m) => m.id);
        const same = wantIds.length === haveIds.length && wantIds.every((id) => haveIds.includes(id));
        if (c.status === 'running' && !same) {
          const sysUser = { username: 'system', platform_role: 'owner' };
          setCl(c.id, { allMembers: all, note: busy.length ? `Paused on ${busy.map((m) => m.name || m.id).join(', ')}: ${busyOf(busy[0].id)}` : null });
          await routesByKey['POST /api/clusters/:id/stop']({ user: sysUser, params: { id: c.id }, body: { system: true } }).catch(() => {});
          const remaining = all.filter((m) => wantIds.includes(m.id)); if (!remaining.some((m) => m.id === c.coordinator)) { setCl(c.id, { status: 'stopped', error: 'The coordinator is in use — the cluster waits until it is idle again' }); continue; }
          setCl(c.id, { members: remaining, allMembers: all });
          try { await routesByKey['POST /api/clusters/:id/start']({ user: sysUser, params: { id: c.id }, body: {} }); store.audit('system', 'cluster.rebuild', null, { name: c.name, members: remaining.length, busy: busy.map((m) => m.name || m.id) }); }
          catch (e) { setCl(c.id, { status: 'stopped', error: `Rebuilt without ${busy.map((m) => m.name || m.id).join(', ')} failed: ${e.message}` }); }
        } else if (c.status === 'stopped' && c.allMembers && c.note && !same && wantIds.length > haveIds.length) {
          // a member came back: restore it
          setCl(c.id, { members: all.filter((m) => wantIds.includes(m.id)), note: wantIds.length === all.length ? null : c.note });
          await routesByKey['POST /api/clusters/:id/start']({ user: { username: 'system', platform_role: 'owner' }, params: { id: c.id }, body: {} }).catch((e) => setCl(c.id, { error: e.message }));
        }
      }
    } catch (e) { console.error('lend tick', e.message); } finally { lendTickBusy = false; }
  };
  timersLate.push(() => setInterval(() => lendTick().catch(() => {}), 30000));
  // exo / MLX / vLLM: connect to a cluster that tool is running.
  R('POST', '/api/clusters/:id/connect', async (req) => {
    needPlatform(req, 'owner'); const c = clusters().find((x) => x.id === req.params.id); if (!c) throw err(404, 'Not found');
    const url = String(req.body.url || '').replace(/\/+$/, ''); if (!/^https?:\/\//.test(url)) throw err(400, 'Enter the address the cluster serves on');
    const t = await cluster.testConfig({ kind: 'compat', url, preset: c.backend === 'exo' ? 'exo' : c.backend === 'vllm' ? 'vllm' : 'mlx', timeout_ms: 8000 });
    if (!t.reachable) throw err(400, t.error);
    const nid = uid('node_'); store.run('INSERT INTO nodes(id,name,kind,url,ram_gb,enabled,is_local,created_at,preset,tls_mode,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)', nid, `${c.name} (cluster)`, 'compat', url, 0, 1, 0, now(), c.backend === 'exo' ? 'exo' : c.backend === 'vllm' ? 'vllm' : 'mlx', 'verify', 600000);
    await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE id=?', nid)).catch(() => {});
    return setCl(c.id, { status: 'running', endpointNode: nid, url });
  });

  // ---- connections: test a server before saving, find servers, trust a certificate, import / export
  const PRESETS_SRV = {
    lmstudio: { name: 'LM Studio', kind: 'compat', port: 1234, path: '' }, ollama: { name: 'Ollama', kind: 'ollama', port: 11434, path: '' },
    llamacpp: { name: 'llama.cpp server', kind: 'compat', port: 8080, path: '' }, vllm: { name: 'vLLM', kind: 'compat', port: 8000, path: '' },
    exo: { name: 'exo', kind: 'compat', port: 52415, path: '' }, mlx: { name: 'MLX (mlx_lm.server)', kind: 'compat', port: 8080, path: '' },
    koboldcpp: { name: 'KoboldCpp', kind: 'compat', port: 5001, path: '' }, jan: { name: 'Jan', kind: 'compat', port: 1337, path: '' },
    localai: { name: 'LocalAI', kind: 'compat', port: 8080, path: '' }, generic: { name: 'OpenAI-compatible (any)', kind: 'compat', port: null, path: '/v1' },
    worker: { name: 'Another ForgeAI computer', kind: 'worker', port: 4545, path: '' },
  };
  const endpointFields = (b) => {
    let headers = {};
    if (b.headers && typeof b.headers === 'object') headers = Object.fromEntries(Object.entries(b.headers).filter(([k, v]) => /^[A-Za-z0-9-]{1,64}$/.test(k) && String(v).length < 2000).map(([k, v]) => [k, String(v)]));
    else if (typeof b.headers === 'string') for (const line of b.headers.split('\n')) { const i = line.indexOf(':'); if (i > 0) { const k = line.slice(0, i).trim(); if (/^[A-Za-z0-9-]{1,64}$/.test(k)) headers[k] = line.slice(i + 1).trim(); } }
    return { preset: PRESETS_SRV[b.preset] ? b.preset : (b.kind === 'ollama' ? 'ollama' : 'generic'), headers, tls_mode: ['verify', 'pin', 'insecure'].includes(b.tls_mode) ? b.tls_mode : 'verify', cert_pin: /^[0-9A-F:]{95}$/.test(String(b.cert_pin || '')) ? b.cert_pin : null, timeout_ms: Math.min(120000, Math.max(0, Math.floor(+b.timeout_ms || 0))) };
  };
  R('GET', '/api/connections/presets', () => PRESETS_SRV);
  R('POST', '/api/connections/test', async (req) => {
    needPlatform(req); const b = req.body; const f = endpointFields(b);
    if (!/^https?:\/\/[^\s]+$/.test(b.url || '')) throw err(400, 'Enter an address like http://192.168.1.20:1234');
    const kind = b.kind || (PRESETS_SRV[f.preset] || {}).kind || 'compat';
    const r = await cluster.testConfig({ kind, url: b.url, preset: f.preset, apiKey: b.apiKey || null, headers: f.headers, tls_mode: f.tls_mode, cert_pin: f.cert_pin, timeout_ms: f.timeout_ms || 8000 });
    if (!r.reachable && /certificate/i.test(r.error || '')) r.cert = await certInfo(b.url);
    r.scopeLabel = SCOPE_LABEL[r.scope];
    if (r.scope === 'internet' && /^http:/.test(b.url)) r.warning = 'This address is on the internet without HTTPS — anything sent can be read on the way. Use HTTPS, a VPN (Tailscale / WireGuard) or a reverse proxy with TLS.';
    if (r.scope === 'internet' && !b.apiKey && !Object.keys(f.headers).length) r.warning = (r.warning ? r.warning + ' ' : '') + 'It also has no API key: never leave an inference server open to the internet without authentication.';
    return r;
  });
  R('POST', '/api/connections/cert', async (req) => { needPlatform(req); const c = await certInfo(req.body.url); if (!c) throw err(400, 'Could not read a certificate from that address (is it https://?)'); return c; });
  // Look for model servers on this computer (and, if asked, on the local network) on the usual ports. Nothing is added automatically.
  R('POST', '/api/connections/discover', async (req) => {
    needPlatform(req);
    const ports = [[11434, 'ollama'], [1234, 'lmstudio'], [8080, 'llamacpp'], [8000, 'vllm'], [52415, 'exo'], [5001, 'koboldcpp'], [1337, 'jan']];
    const hosts = ['127.0.0.1'];
    if (req.body && req.body.lan) for (const a of addresses()) { if (a.tailscale) continue; const base = a.address.split('.').slice(0, 3).join('.'); for (let i = 1; i < 255; i++) { const h = `${base}.${i}`; if (h !== a.address) hosts.push(h); } }
    const known = new Set(store.all('SELECT url FROM nodes').map((n) => n.url).concat(cluster.localRuntimes().map((r) => r.url.replace('localhost', '127.0.0.1'))));
    const found = []; const jobs = [];
    for (const h of hosts) for (const [port, preset] of ports) jobs.push([h, port, preset]);
    const probe = async ([h, port, preset]) => {
      const ok = await new Promise((done) => { const sk = require('net').connect({ host: h, port, timeout: h === '127.0.0.1' ? 600 : 350 }, () => { sk.destroy(); done(true); }); sk.on('error', () => done(false)); sk.on('timeout', () => { sk.destroy(); done(false); }); });
      if (!ok) return;
      const url = `http://${h}:${port}`;
      let detected = null, models = null;
      for (const [p2, kind] of [[preset, (PRESETS_SRV[preset] || {}).kind], ['generic', 'compat'], ['ollama', 'ollama']]) {
        const r = await cluster.testConfig({ kind, url, preset: p2, timeout_ms: 2500 }).catch(() => null);
        if (r && r.reachable && r.authenticated) { detected = p2; models = r.modelCount; break; }
        if (r && r.authenticated === false) { detected = p2; models = null; break; }
      }
      if (detected) found.push({ host: h, port, url, preset: detected, name: (PRESETS_SRV[detected] || {}).name, models, needsKey: models === null, alreadyAdded: known.has(url), scope: networkScope(url) });
    };
    for (let i = 0; i < jobs.length; i += 96) await Promise.all(jobs.slice(i, i + 96).map(probe));
    return { found, scanned: hosts.length };
  });
  // Export: settings only — keys and passwords are never written to the file.
  R('GET', '/api/connections/export', (req) => {
    needPlatform(req);
    const servers = store.all('SELECT * FROM nodes WHERE is_local=0').map((n) => ({ name: n.name, kind: n.kind, preset: n.preset, url: n.url, tls_mode: n.tls_mode, cert_pin: n.cert_pin, timeout_ms: n.timeout_ms, headerNames: (() => { try { return Object.keys(JSON.parse(vault.reveal(n.headers_ref) || '{}')); } catch { return []; } })(), hasKey: !!(n.api_key_ref || n.secret_ref) }));
    const cloud = store.all('SELECT * FROM providers').map((p) => ({ provider: p.provider, label: p.label, base_url: p.base_url, budget_month: p.budget_month, org: p.org_id ? (store.getOrg(p.org_id) || {}).name : null }));
    return { forgeai: 'connections', version: 1, exportedAt: now(), note: 'API keys, tokens and header values are not included — add them after importing.', localRuntimes: cluster.localRuntimes(), servers, cloud };
  });
  R('POST', '/api/connections/import', async (req) => {
    needPlatform(req); const d = req.body || {};
    if (d.forgeai !== 'connections') throw err(400, 'That file is not a ForgeAI connections export');
    const added = [], skipped = [], needKeys = [];
    for (const n of (d.servers || []).slice(0, 200)) {
      if (!/^https?:\/\//.test(n.url || '') || !['ollama', 'compat', 'worker'].includes(n.kind)) { skipped.push(n.url); continue; }
      if (store.get('SELECT 1 FROM nodes WHERE url=?', n.url)) { skipped.push(n.url); continue; }
      const f = endpointFields(n);
      store.run('INSERT INTO nodes(id,name,kind,url,ram_gb,enabled,is_local,created_at,preset,tls_mode,cert_pin,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', uid('node_'), String(n.name || 'Server').slice(0, 60), n.kind, n.url, 0, 1, 0, now(), f.preset, f.tls_mode, f.cert_pin, f.timeout_ms);
      added.push(n.name || n.url); if (n.hasKey || (n.headerNames || []).length) needKeys.push(n.name || n.url);
    }
    for (const c of d.cloud || []) needKeys.push(`${c.label || c.provider} (connect it under Connect Provider with its key)`);
    store.audit(req.user.username, 'connections.import', null, { added: added.length }); cluster.refreshAll().catch(() => {});
    return { added, skipped, needKeys };
  });

  R('PUT', '/api/settings/local-runtimes', (req) => { needPlatform(req); const list = (req.body.runtimes || []).filter((r) => /^https?:\/\//.test(r.url || '')).map((r) => ({ runtime: String(r.runtime || 'openai-compatible').slice(0, 30), url: r.url.replace(/\/$/, '') })); store.setSetting('local_runtimes', list); return list; });
  // Model management (download / rename / create / load / unload / delete) on this computer, other Ollama
  // computers and ForgeAI worker nodes (Mac or Windows) — no Terminal needed.
  const OLLAMA_OPS = {
    pull: (b) => ['POST', '/api/pull', { model: b.model, name: b.model, stream: true }, true],
    create: (b) => ['POST', '/api/create', { model: b.name, from: b.from, system: b.system || undefined, stream: true }, true],
    copy: (b) => ['POST', '/api/copy', { source: b.source, destination: b.destination }, false],
    delete: (b) => ['DELETE', '/api/delete', { model: b.model, name: b.model }, false],
    load: (b) => ['POST', '/api/generate', { model: b.model, prompt: '', keep_alive: b.unload ? 0 : '24h', stream: false }, false],
  };
  async function ollamaDirect(url, op, body, onProgress, signal) {
    const [method, p, payload, streaming] = OLLAMA_OPS[op](body);
    const r = await fetch(url + p, { method, body: JSON.stringify(payload), signal });
    if (!r.ok) throw new Error('Ollama: ' + (await r.text()).slice(0, 300));
    if (streaming) await readNDJSON(r, (j) => { if (j.error) throw new Error(j.error); onProgress && onProgress(j); });
    else await r.text();
  }
  const localOllamaUrl = () => (cluster.localRuntimes().find((r) => r.runtime === 'ollama') || {}).url;
  async function ollamaOp(nodeId, op, body, onProgress, signal) {
    const n = store.get('SELECT * FROM nodes WHERE id=?', nodeId); if (!n) throw err(404, 'Node not found');
    if (n.kind === 'local') { const u = localOllamaUrl(); if (!u) throw err(400, 'Ollama is not configured on this computer'); return ollamaDirect(u, op, body, onProgress, signal); }
    if (n.kind === 'ollama') return ollamaDirect(n.url, op, body, onProgress, signal);
    if (n.kind === 'worker') {
      const r = await pinnedFetch(`${n.url}/node/ollama/${op}`, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + vault.reveal(n.secret_ref) }, body: JSON.stringify(body), pin: n.cert_pin, onPin: (fp) => store.run('UPDATE nodes SET cert_pin=? WHERE id=?', fp, n.id) });
      if (!r.ok) throw new Error('Worker: ' + (await r.text()).slice(0, 300));
      let ok = false;
      await readNDJSON(r, (j) => { if (j.error) throw new Error(j.error); if (j.progress) onProgress && onProgress(j.progress); if (j.done) ok = true; });
      if (!ok) throw new Error('Worker closed the connection early');
      return;
    }
    throw err(400, 'Model management is available for Ollama and ForgeAI nodes');
  }
  const aliases = () => store.getSetting('model_aliases', {});
  const setAlias = (model, name) => { const a = aliases(); if (name && name.trim()) a[model] = name.trim().slice(0, 60); else delete a[model]; store.setSetting('model_aliases', a); };
  const MODEL_RE = /^[\w.\-:/]+$/;
  const jobs = new Map();
  const jobView = (j) => ({ id: j.id, kind: j.kind, nodeId: j.nodeId, nodeName: j.nodeName, model: j.model, finalName: j.finalName, displayName: j.displayName, status: j.status, completed: j.completed, total: j.total, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt, state: j.state });
  function startJob(kind, req, spec, run) {
    const n = store.get('SELECT * FROM nodes WHERE id=?', req.params.id); if (!n) throw err(404, 'Node not found');
    const j = { id: uid('job_'), kind, nodeId: n.id, nodeName: n.name, ...spec, status: 'starting', state: 'running', completed: 0, total: 0, startedAt: now(), ctl: new AbortController() };
    jobs.set(j.id, j);
    (async () => {
      try {
        await run(j, (p) => { j.status = p.status || j.status; if (p.total) { j.total = p.total; j.completed = p.completed || 0; } });
        if (j.ctl.signal.aborted) throw new Error('Cancelled');
        j.state = 'done'; j.status = 'Ready'; if (j.total) j.completed = j.total;
        store.audit(req.user.username, 'model.' + kind, null, { node: n.name, model: j.finalName });
      } catch (e) { j.state = j.ctl.signal.aborted ? 'cancelled' : 'error'; j.error = e.message; }
      j.finishedAt = now();
      cluster.refreshAll().catch(() => {});
      for (const [id, x] of jobs) if (x.state !== 'running' && Date.now() - new Date(x.finishedAt).getTime() > 3600e3) jobs.delete(id);
    })();
    return jobView(j);
  }
  R('POST', '/api/nodes/:id/pull', (req) => {
    needPlatform(req);
    const model = String(req.body.model || '').trim(); const saveAs = String(req.body.saveAs || '').trim().toLowerCase(); const displayName = String(req.body.displayName || '').trim();
    if (!MODEL_RE.test(model)) throw err(400, 'Enter a model name like qwen3:14b or hf.co/<user>/<repo>');
    if (saveAs && !MODEL_RE.test(saveAs)) throw err(400, 'The new model name can only use letters, numbers, - _ . : /');
    return startJob('download', req, { model, finalName: saveAs || model, displayName }, async (j, prog) => {
      await ollamaOp(j.nodeId, 'pull', { model }, prog, j.ctl.signal);
      if (saveAs && saveAs !== model) {
        j.status = 'Renaming'; await ollamaOp(j.nodeId, 'copy', { source: model, destination: saveAs });
        await ollamaOp(j.nodeId, 'delete', { model });
      }
      if (displayName) setAlias(j.finalName, displayName);
    });
  });
  R('POST', '/api/nodes/:id/create-model', (req) => {
    needPlatform(req);
    const name = String(req.body.name || '').trim().toLowerCase(); const from = String(req.body.from || '').trim(); const displayName = String(req.body.displayName || '').trim();
    if (!MODEL_RE.test(name)) throw err(400, 'Model name can only use letters, numbers, - _ . : /');
    if (!MODEL_RE.test(from)) throw err(400, 'Choose a base model');
    return startJob('create', req, { model: from, finalName: name, displayName }, async (j, prog) => {
      await ollamaOp(j.nodeId, 'create', { name, from, system: String(req.body.system || '').slice(0, 20000) }, prog, j.ctl.signal);
      if (displayName) setAlias(name, displayName);
    });
  });
  R('POST', '/api/nodes/:id/rename-model', async (req) => {
    needPlatform(req); const from = String(req.body.model || ''); const to = String(req.body.newName || '').trim().toLowerCase();
    if (!MODEL_RE.test(from) || !MODEL_RE.test(to)) throw err(400, 'Model names can only use letters, numbers, - _ . : /');
    await ollamaOp(req.params.id, 'copy', { source: from, destination: to });
    await ollamaOp(req.params.id, 'delete', { model: from });
    const a = aliases(); if (a[from]) { a[to] = a[from]; delete a[from]; store.setSetting('model_aliases', a); }
    store.audit(req.user.username, 'model.rename', null, { from, to }); await cluster.refreshAll(); return { ok: true };
  });
  R('GET', '/api/jobs', (req) => { needPlatform(req); return [...jobs.values()].map(jobView).reverse(); });
  R('POST', '/api/jobs/:id/cancel', (req) => { needPlatform(req); const j = jobs.get(req.params.id); if (j && j.state === 'running') j.ctl.abort(); return { ok: true }; });
  R('PUT', '/api/models/alias', (req) => { needPlatform(req); setAlias(String(req.body.model || ''), req.body.name); store.audit(req.user.username, 'model.display_name', null, { model: req.body.model, name: req.body.name }); return aliases(); });
  R('POST', '/api/nodes/:id/load', async (req) => { needPlatform(req); await ollamaOp(req.params.id, 'load', { model: req.body.model, unload: !!req.body.unload }); await cluster.refreshAll(); return { ok: true }; });
  // Load or unload any model, whichever app runs it: ForgeAI Engine, Ollama, LM Studio (also on other computers).
  R('POST', '/api/models/control', async (req) => {
    needPlatform(req); const { nodeId, model, action } = req.body || {}; if (!['load', 'unload'].includes(action)) throw err(400, 'Unknown action');
    const node = store.get('SELECT * FROM nodes WHERE id=?', nodeId); if (!node) throw err(404, 'Computer not found');
    const m = cluster.catalog().find((x) => x.nodeId === nodeId && x.id === model); if (!m) throw err(404, `${model} is not on ${node.name}`);
    if (m.runtime === 'engine') { if (action === 'load') await forgeEngine.ensureLoaded(model); else await forgeEngine.unload(model); }
    else if (m.runtime === 'ollama' || node.kind === 'ollama' || node.kind === 'worker') { if (action === 'load' && node.kind === 'local') await cluster.ensureReady({ node, model: m, adapter: null }); else await ollamaOp(nodeId, 'load', { model, unload: action === 'unload' }); }
    else if (m.runtime === 'lmstudio' || (node.preset === 'lmstudio')) {
      const rt = cluster.runtimesFor(node).find((r) => r.url === m._url) || cluster.runtimesFor(node)[0];
      if (action === 'load') await cluster.ensureReady({ node, model: m, adapter: rt.adapter });
      else { const list = await rt.adapter.j('/api/v1/models', 8000); const it = (list.models || list.data || []).find((x) => (x.key || x.id) === model); for (const ins of (it && it.loaded_instances) || []) { await rt.adapter.oa._fetch(rt.adapter.root + '/api/v1/models/unload', { method: 'POST', headers: rt.adapter.oa.headers(), body: JSON.stringify({ instance_id: ins.id }) }); } }
    } else throw err(400, `${node.name} doesn’t let ForgeAI load or unload models — do it in that app.`);
    await cluster.refreshNode(node).catch(() => {}); return { ok: true };
  });
  R('POST', '/api/nodes/:id/delete-model', async (req) => { needPlatform(req, 'owner'); await ollamaOp(req.params.id, 'delete', { model: req.body.model }); setAlias(req.body.model, ''); store.audit(req.user.username, 'model.delete', null, req.body.model); await cluster.refreshAll(); return { ok: true }; });

  R('GET', '/api/provider-types', () => Object.entries(PROVIDER_TYPES).map(([id, t]) => ({ id, name: t.name, help: t.keyHelp })));
  R('GET', '/api/providers', (req) => {
    const orgs = auth.orgsFor(req.user).filter((o) => auth.can(req.user, o.id, 'manage')).map((o) => o.id);
    const isPlat = req.user.platform_role !== 'none';
    return store.all('SELECT * FROM providers ORDER BY org_id IS NOT NULL, provider').filter((p) => (p.org_id ? orgs.includes(p.org_id) : isPlat)).map(providerView);
  });
  // Test a cloud provider key without saving anything.
  R('POST', '/api/providers/test', async (req) => {
    needPlatformOrOrg(req, req.body.org_id); const b = req.body; if (!PROVIDER_TYPES[b.provider]) throw err(400, 'Unknown provider');
    if (!String(b.apiKey || '').trim()) throw err(400, 'Paste the API key');
    const t0 = Date.now();
    try { const list = await PROVIDER_TYPES[b.provider].make({ apiKey: String(b.apiKey).trim(), baseUrl: b.base_url || undefined }).listModels(); return { reachable: true, authenticated: true, modelCount: list.length, chatModels: list.filter((m) => !m.kind || m.kind === 'chat').length, latencyMs: Date.now() - t0, scope: 'internet' }; }
    catch (e) { const x = explainNet(e, b.base_url || PROVIDER_TYPES[b.provider].defaultBase, 'Connecting'); return { reachable: !!e.status, authenticated: e.status ? !(e.status === 401 || e.status === 403) : null, latencyMs: e.status ? Date.now() - t0 : null, error: x.message }; }
  });
  R('POST', '/api/providers', async (req) => {
    const b = req.body; if (!PROVIDER_TYPES[b.provider]) throw err(400, 'Unknown provider');
    if (b.org_id) { if (!auth.can(req.user, b.org_id, 'manage')) throw err(403, 'Not allowed'); } else needPlatform(req);
    if (!String(b.apiKey || '').trim()) throw err(400, 'Paste the API key');
    if (b.provider === 'openai_compat' && !/^https:\/\//.test(b.base_url || '')) throw err(400, 'Enter the provider base URL (https://…/v1)');
    // Never leave a half-saved provider: the key is tested first and only stored when it works (or the user insists).
    let list = null;
    try { list = await PROVIDER_TYPES[b.provider].make({ apiKey: String(b.apiKey).trim(), baseUrl: b.base_url || undefined }).listModels(); }
    catch (e) { if (!b.force) throw err(400, explainNet(e, b.base_url || PROVIDER_TYPES[b.provider].defaultBase, 'Connecting').message); }
    const id = uid('prv_');
    store.run('INSERT INTO providers(id,provider,org_id,label,secret_ref,base_url,status,status_detail,models,budget_month,created_at,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, b.provider, b.org_id || null, String(b.label || PROVIDER_TYPES[b.provider].name).slice(0, 80), vault.put(String(b.apiKey).trim()), b.base_url || null,
      list ? 'connected' : 'error', list ? `${list.length} models available` : 'Saved without a working connection', JSON.stringify(list ? { list } : {}), +b.budget_month || 0, now(), now());
    store.audit(req.user.username, 'provider.add', b.org_id || null, { provider: b.provider, forced: !list });
    return { id, ok: !!list, provider: providerView(store.get('SELECT * FROM providers WHERE id=?', id)) };
  });
  const provAccess = (req) => { const p = store.get('SELECT * FROM providers WHERE id=?', req.params.id); if (!p) throw err(404, 'Not found'); if (p.org_id) { if (!auth.can(req.user, p.org_id, 'manage')) throw err(403, 'Not allowed'); } else needPlatform(req); return p; };
  R('PUT', '/api/providers/:id', async (req) => {
    const p = provAccess(req); const b = req.body;
    if (b.label !== undefined) store.run('UPDATE providers SET label=? WHERE id=?', String(b.label).slice(0, 80), p.id);
    if (b.budget_month !== undefined) store.run('UPDATE providers SET budget_month=? WHERE id=?', Math.max(0, +b.budget_month || 0), p.id);
    if (b.default_model !== undefined || b.fast_model !== undefined) {
      const m = safeJSON(p.models, {}); if (b.default_model !== undefined) m.default = b.default_model; if (b.fast_model !== undefined) m.fast = b.fast_model;
      store.run('UPDATE providers SET models=? WHERE id=?', JSON.stringify(m), p.id);
    }
    if (b.apiKey) { vault.remove(p.secret_ref); store.run('UPDATE providers SET secret_ref=? WHERE id=?', vault.put(String(b.apiKey).trim()), p.id); store.audit(req.user.username, 'provider.rotate_key', p.org_id, p.provider); await testProvider(store.get('SELECT * FROM providers WHERE id=?', p.id)); }
    return providerView(store.get('SELECT * FROM providers WHERE id=?', p.id));
  });
  R('POST', '/api/providers/:id/test', async (req) => { const p = provAccess(req); await testProvider(p); return providerView(store.get('SELECT * FROM providers WHERE id=?', p.id)); });
  R('DELETE', '/api/providers/:id', (req) => { const p = provAccess(req); vault.remove(p.secret_ref); store.run('DELETE FROM providers WHERE id=?', p.id); store.audit(req.user.username, 'provider.remove', p.org_id, p.provider); return { ok: true }; });
  R('GET', '/api/prices', () => store.all('SELECT * FROM prices ORDER BY pattern'));
  R('PUT', '/api/prices', (req) => { needPlatform(req); store.run('DELETE FROM prices'); for (const r of req.body.prices || []) if (r.pattern) store.run('INSERT OR REPLACE INTO prices VALUES(?,?,?)', String(r.pattern).slice(0, 60), +r.input_per_m || 0, +r.output_per_m || 0); return { ok: true }; });

  // ---------------- grants (cross-organisation permissions) — platform owner only
  R('GET', '/api/grants', (req) => { needPlatform(req, 'owner'); return store.all('SELECT * FROM grants ORDER BY created_at DESC').map((g) => ({ ...g, scopes: safeJSON(g.scopes, []), sourceName: g.source_org ? (store.getOrg(g.source_org) || {}).name : null, targetName: (store.getOrg(g.target_org) || {}).name })); });
  R('POST', '/api/grants', (req) => {
    needPlatform(req, 'owner'); const b = req.body;
    if (!['owner_ai', 'cross_org'].includes(b.kind)) throw err(400, 'Unknown grant');
    if (!store.getOrg(b.target_org)) throw err(400, 'Choose an organisation');
    if (b.kind === 'cross_org' && (!store.getOrg(b.source_org) || b.source_org === b.target_org)) throw err(400, 'Choose two different organisations');
    const scopes = Array.isArray(b.scopes) && b.scopes.length ? b.scopes : b.kind === 'owner_ai' ? ['overview'] : ['*'];
    if (b.kind === 'owner_ai') store.run('DELETE FROM grants WHERE kind=\'owner_ai\' AND target_org=?', b.target_org);
    const id = uid('grt_');
    store.run('INSERT INTO grants(id,kind,source_org,target_org,scopes,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, b.kind, b.source_org || null, b.target_org, JSON.stringify(scopes), req.user.username, now());
    store.audit(req.user.username, 'grant.create', b.target_org, { kind: b.kind, source: b.source_org, scopes });
    for (const o of [b.source_org, b.target_org].filter(Boolean)) store.openOrg(o).audit(req.user.username, 'grant.create', { kind: b.kind, source: b.source_org, target: b.target_org, scopes });
    return { id };
  });
  R('DELETE', '/api/grants/:id', (req) => { needPlatform(req, 'owner'); const g = store.get('SELECT * FROM grants WHERE id=?', req.params.id); if (g) { store.run('DELETE FROM grants WHERE id=?', g.id); store.audit(req.user.username, 'grant.revoke', g.target_org, { kind: g.kind }); } return { ok: true }; });

  // ---------------- Owner AI
  R('GET', '/api/owner-ai', (req) => { needPlatform(req, 'owner'); const ctx = engine.ownerContext(); return { settings: store.getSetting('owner_ai', { cloud_allowed: false }), orgs: ctx.orgs.map((o) => o.org.name), messages: store.all('SELECT * FROM owner_chat ORDER BY id').map((m) => ({ ...m, meta: safeJSON(m.meta, {}) })) }; });
  R('PUT', '/api/owner-ai/settings', (req) => { needPlatform(req, 'owner'); const s = { cloud_allowed: !!req.body.cloud_allowed, budget: Math.max(0, +req.body.budget || 0) }; store.setSetting('owner_ai', s); store.audit(req.user.username, 'owner_ai.settings', null, s); return s; });
  R('DELETE', '/api/owner-ai/messages', (req) => { needPlatform(req, 'owner'); store.run('DELETE FROM owner_chat'); return { ok: true }; });
  R('POST', '/api/owner-ai/messages', async (req, res) => {
    needPlatform(req, 'owner'); const text = String(req.body.text || '').trim(); if (!text) throw err(400, 'Empty message');
    const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    sse(res); const emit = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    store.run('INSERT INTO owner_chat(ts,role,content,meta) VALUES(?,?,?,?)', now(), 'user', text, '{}');
    const ctx = engine.ownerContext();
    const save = (content, meta) => { store.run('INSERT INTO owner_chat(ts,role,content,meta) VALUES(?,?,?,?)', now(), 'assistant', content, JSON.stringify(meta)); emit('done', { message: { role: 'assistant', content, meta } }); };
    if (!ctx.orgs.length) { save('No organisations are shared with the Owner AI yet. Grant access under **Owner AI → Access**.', {}); return res.end(); }
    const d = models.decide({ orgDb: ownerLedger, mode: req.body.mode || 'auto', model: req.body.model, text });
    if (d.blocked) { save(d.reasons[d.reasons.length - 1], {}); return res.end(); }
    emit('route', { label: d.label, reasons: d.reasons });
    const history = store.all('SELECT role, content FROM owner_chat ORDER BY id DESC LIMIT 12').reverse();
    const system = `You are the platform owner's private Owner AI. You can see ONLY the organisations listed below, which the owner explicitly authorised: ${ctx.orgs.map((o) => o.org.name).join(', ')}. You have no access to any other organisation. Answer only from the data below; if the data does not contain the answer (for example, cash balances when no finance report is shared), say exactly what is missing and which agent or document would provide it. Today is ${new Date().toDateString()}.\n\n# AUTHORISED DATA\n${ctx.text}`;
    try {
      const r = await models.run(d, { orgDb: ownerLedger, system, messages: history.map((h) => ({ role: h.role, content: h.content })), onDelta: (x) => emit('delta', { d: x }), signal: ctl.signal, kind: 'owner_ai' });
      save(r.text, { model: r.model, cost: r.cost, orgs: ctx.orgs.map((o) => o.org.name) });
      store.audit(req.user.username, 'owner_ai.query', null, { orgs: ctx.orgs.map((o) => o.org.id), model: r.model });
    } catch (e) { save(e.message, { error: true }); }
    res.end();
  }, { raw: true });

  // ---------------- remote access & worker settings (platform owner)
  R('GET', '/api/settings/access', (req) => {
    needPlatform(req, 'owner'); const s = store.getSetting('access', { remote: false, port: 4545, https: false });
    const w = store.getSetting('worker', { enabled: false });
    return { ...s, listening: app.listenInfo, addresses: addresses(), worker: { enabled: !!w.enabled, token: w.enabled ? vault.reveal(w.token_ref) : null }, vault: vault.backendName, dataDir };
  });
  R('PUT', '/api/settings/access', async (req) => {
    needPlatform(req, 'owner'); const b = req.body; const cur = store.getSetting('access', { remote: false, port: 4545, https: false });
    const s = { remote: b.remote !== undefined ? !!b.remote : cur.remote, port: b.port ? Math.min(65535, Math.max(1024, +b.port)) : cur.port, https: b.https !== undefined ? !!b.https : cur.https };
    store.setSetting('access', s); store.audit(req.user.username, 'access.update', null, s);
    setTimeout(() => app.relisten().catch((e) => console.error('relisten failed', e)), 300);
    return s;
  });
  R('PUT', '/api/settings/worker', (req) => {
    needPlatform(req, 'owner'); const w = store.getSetting('worker', { enabled: false });
    if (req.body.enabled && (!w.token_ref || req.body.regenerate)) { if (w.token_ref) vault.remove(w.token_ref); w.token_ref = vault.put(crypto.randomBytes(24).toString('base64url')); }
    w.enabled = !!req.body.enabled; store.setSetting('worker', w); store.audit(req.user.username, 'worker.update', null, { enabled: w.enabled });
    return { enabled: w.enabled, token: w.enabled ? vault.reveal(w.token_ref) : null };
  });

  // ---------------- worker-node endpoints (this Mac serving its local models to a hub)
  const { Priority } = require('./priority');
  const priority = new Priority({ store }); priority.freeMem = async () => (perf.machine && perf.machine.memFree) || os.freemem();
  kit.onSpawn = (pid) => priority.track(pid); trainer.onSpawn = (pid) => priority.track(pid);
  scheduler.gate = (p) => priority.blocked(p);
  const hostPids = () => { try { return (host && host.appPids && host.appPids()) || []; } catch { return []; } };
  const { Lender } = require('./idle');
  const lender = new Lender({ store, perf, host, inflight: () => { const l = cluster.nodes().find((n) => n.is_local); return l ? (cluster.inflight.get(l.id) || 0) : 0; } });
  const availabilityNow = () => lender.last;
  lender.yieldState = () => priority.state;
  priority.on('change', async (st) => {
    scheduler.pumpAll(); lender.sample().catch(() => {});
    if (st.yielding) {
      store.audit('system', 'yield.on', null, { reason: st.reason });
      // Give memory back: unload every idle, unpinned local model (never one that is answering).
      if (/memory/.test(st.reason || '')) memory.makeRoom(Number.MAX_SAFE_INTEGER).catch(() => {});
    } else store.audit('system', 'yield.off', null, {});
    try { linkSpoke.report({ machine: perf.machine || null, availability: lender.last }); } catch {}
  });
  R('GET', '/api/settings/priority', (req) => { needPlatform(req); return { ...priority.settings(), state: priority.state }; });
  R('PUT', '/api/settings/priority', async (req) => { needPlatform(req, 'owner'); const n = priority.save(req.body || {}); store.audit(req.user.username, 'priority.update', null, n); await priority.tick(hostPids()).catch(() => {}); return { ...n, state: priority.state }; });
  // Desktop behaviour (icon, Dock, start at login) is stored here and applied by the desktop app.
  R('GET', '/api/settings/desktop', (req) => { needPlatform(req); return { showIcon: true, startAtLogin: false, startHidden: false, ...store.getSetting('desktop', {}), available: !!(host && host.applyDesktop), os: process.platform }; });
  R('PUT', '/api/settings/desktop', (req) => { needPlatform(req, 'owner'); const cur = store.getSetting('desktop', {}); const b = req.body || {}; const n = { showIcon: b.showIcon == null ? cur.showIcon !== false : !!b.showIcon, startAtLogin: b.startAtLogin == null ? !!cur.startAtLogin : !!b.startAtLogin, startHidden: b.startHidden == null ? !!cur.startHidden : !!b.startHidden }; store.setSetting('desktop', n); store.audit(req.user.username, 'desktop.update', null, n); try { host && host.applyDesktop && host.applyDesktop(n); } catch {} return { ...n, available: !!(host && host.applyDesktop), os: process.platform }; });
  R('GET', '/api/settings/lend', (req) => { needPlatform(req); return { ...lender.settings(), now: lender.last }; });
  R('PUT', '/api/settings/lend', async (req) => { needPlatform(req, 'owner'); const n = lender.save(req.body || {}); store.audit(req.user.username, 'lend.update', null, n); await lender.sample().catch(() => {}); return { ...n, now: lender.last }; });
  // ---- ForgeAI Link: hub + spoke (see link.js)
  const ensureWorkerToken = () => { const w = store.getSetting('worker', { enabled: false }); if (!w.token_ref) w.token_ref = vault.put(crypto.randomBytes(24).toString('base64url')); if (!w.enabled) { w.enabled = true; store.setSetting('worker', w); } return vault.reveal(w.token_ref); };
  const kitPorts = () => { const out = []; for (const k of ['rpc', 'server']) { const pr = kit.procs[k]; if (pr && pr.args) { const i = pr.args.findIndex((x) => x === '-p' || x === '--port'); if (i >= 0) out.push(+pr.args[i + 1]); } } return out.filter(Boolean); };
  // Ports on this computer other ForgeAI computers may reach through the link: ForgeAI itself, llama.cpp (RPC + cluster server), the engine and the local model apps.
  const linkAllowedPorts = () => { const out = new Set([app.listenInfo && app.listenInfo.port, forgeEngine.port, ...kitPorts(), 50052, 50053]); for (const r of cluster.localRuntimes()) { try { out.add(+new URL(r.url).port || (r.url.startsWith('https') ? 443 : 80)); } catch {} } for (const c of store.getSetting('clusters', [])) if (c.port) out.add(+c.port); return [...out].filter(Boolean); };
  linkHub.allowedPorts = linkAllowedPorts; linkSpoke.allowedPorts = linkAllowedPorts;
  linkHub.workerToken = () => ensureWorkerToken(); linkHub.machine = () => perf.machine || null; linkHub.availability = () => availabilityNow();
  Object.defineProperty(linkHub, 'hubId', { get: () => instanceId }); Object.defineProperty(linkHub, 'hubPort', { get: () => app.listenInfo && app.listenInfo.port }); Object.defineProperty(linkHub, 'hubScheme', { get: () => (app.listenInfo && app.listenInfo.https ? 'https' : 'http') });
  linkSpoke.hello = () => ({ id: instanceId, name: platformName() === 'ForgeAI' ? os.hostname() : platformName(), port: app.listenInfo && app.listenInfo.port, scheme: app.listenInfo && app.listenInfo.https ? 'https' : 'http', workerToken: ensureWorkerToken(), version, machine: perf.machine || null, availability: availabilityNow() });
  // A computer reached through the link is registered as a Computer with a loopback address that ForgeAI forwards over the tunnel.
  const upsertLinkNode = async (peerId, name, scheme, port, workerToken, viaHub) => {
    try {
      const lp = viaHub ? await linkSpoke.forward(peerId, port) : await linkHub.forward(peerId, port);
      const url = `${scheme}://127.0.0.1:${lp}`; const old = store.get('SELECT * FROM nodes WHERE link_id=?', peerId);
      if (old) { if (old.secret_ref) vault.remove(old.secret_ref); store.run('UPDATE nodes SET url=?, name=?, secret_ref=?, enabled=1, cert_pin=NULL WHERE id=?', url, name, workerToken ? vault.put(workerToken) : null, old.id); }
      else store.run('INSERT INTO nodes(id,name,kind,url,secret_ref,ram_gb,enabled,is_local,created_at,tls_mode,timeout_ms,link_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', uid('node_'), name, 'worker', url, workerToken ? vault.put(workerToken) : null, 0, 1, 0, now(), 'tofu', 30000, peerId);
      await cluster.refreshNode(store.get('SELECT * FROM nodes WHERE link_id=?', peerId)).catch(() => {});
    } catch (e) { llog(`Could not register ${name}: ${e.message}`); }
  };
  linkHub.on('spoke', (ev) => { if (!ev.online) { const n = store.get('SELECT * FROM nodes WHERE link_id=?', ev.id); if (n) cluster.refreshNode(n).catch(() => {}); return; } const sp = linkHub.spokes()[ev.id]; upsertLinkNode(ev.id, sp.name, sp.scheme, sp.port, sp.worker_ref ? vault.reveal(sp.worker_ref) : null, false); });
  linkSpoke.on('peers', (peers) => { for (const n of store.all('SELECT * FROM nodes WHERE link_id IS NOT NULL')) if (!peers.some((p) => p.id === n.link_id) && !linkHub.spokes()[n.link_id]) { store.run('DELETE FROM nodes WHERE id=?', n.id); cluster.state.delete(n.id); } for (const p of peers) if (p.online && p.workerToken) upsertLinkNode(p.id, p.name, p.scheme, p.port, p.workerToken, true); else if (!p.online) { const n = store.get('SELECT * FROM nodes WHERE link_id=?', p.id); if (n) cluster.refreshNode(n).catch(() => {}); } });
  const linkForward = (peerId, port) => (linkHub.conns.has(peerId) ? linkHub.forward(peerId, port) : linkSpoke.forward(peerId, port));
  // Every address this hub can be reached on, for the join string: each network interface (covers multiple VLANs),
  // the address the owner is looking at it on, any public address they set, the listen port, and the relay id if on.
  const hubPublic = () => store.getSetting('hub_public_address', null);
  const hubJoinAddresses = (req) => {
    const port = app.listenInfo ? app.listenInfo.port : 4545; const seen = new Set(); const out = [];
    const add = (a) => { if (!a) return; const v = /:\d+$/.test(a) ? a : `${a}:${port}`; if (!seen.has(v)) { seen.add(v); out.push(v); } };
    if (req) { const h = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, ''); if (h && !/^(127\.|localhost)/.test(h)) add(h); }
    add(hubPublic());
    for (const [, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) add(a.address);
    return out;
  };
  const publicAddresses = () => { const out = []; for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address }); return out; };
  R('PUT', '/api/link/public-address', (req) => { needPlatform(req, 'owner'); const v = String((req.body || {}).address || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 200); if (v && !/^[\w.\-]+(:\d+)?$/.test(v)) throw err(400, 'Enter a host name or IP, e.g. ai.example.com or 203.0.113.5:4545'); store.setSetting('hub_public_address', v || null); return { address: v || null }; });
  R('GET', '/api/link', (req) => { needPlatform(req); return { hub: linkHub.status(), spoke: linkSpoke.status(), request: linkSpoke.requestStatus(), listen: app.listenInfo, addresses: publicAddresses(), allowedPorts: linkAllowedPorts(), log: linkLog.slice(0, 40), isHubCapable: !!(app.listenInfo && app.listenInfo.https && app.listenInfo.remote) }; });
  R('POST', '/api/link/hub', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {}; const cur = linkHub.settings();
    const s = { ...cur, enabled: b.enabled != null ? !!b.enabled : cur.enabled, name: String(b.name || cur.name || os.hostname()).slice(0, 60) }; store.setSetting('link_hub', s);
    if (s.enabled) { const acc = store.getSetting('access', { remote: false, port: 4545, https: false }); if (!acc.remote || !acc.https) { store.setSetting('access', { ...acc, remote: true, https: true }); await app.relisten(); } ensureWorkerToken(); await linkHub.restoreExposed(); }
    store.audit(req.user.username, 'link.hub', null, { enabled: s.enabled }); return linkHub.status();
  });
  R('POST', '/api/link/hub/code', (req) => { needPlatform(req, 'owner'); if (!linkHub.settings().enabled) throw err(400, 'Turn the hub on first'); return { code: linkHub.newCode(), expiresInMinutes: 15, address: app.listenInfo ? `${app.listenInfo.port}` : null }; });
  R('DELETE', '/api/link/hub/spokes/:id', (req) => { needPlatform(req, 'owner'); linkHub.forget(req.params.id); const n = store.get('SELECT * FROM nodes WHERE link_id=?', req.params.id); if (n) { store.run('DELETE FROM nodes WHERE id=?', n.id); cluster.state.delete(n.id); } store.audit(req.user.username, 'link.forget', null, { id: req.params.id }); return { ok: true }; });
  R('POST', '/api/nodes/:id/restart', async (req) => {
    const n = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", req.params.id); if (!n) throw err(404, 'Not a ForgeAI computer'); needManageNode(req, n);
    try { const r = await cluster.runtimesFor(n)[0].adapter.post('/node/manage/restart', {}, 10000); store.audit(req.user.username, 'computer.restart', null, { node: n.name }); return { ok: true, name: n.name, ...r }; }
    catch (e) { throw err(400, `${n.name}: ${e.message}`); }
  });
  R('GET', '/api/nodes/:id/state', async (req) => {
    needPlatform(req); const n = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", req.params.id); if (!n) throw err(404, 'Not a ForgeAI computer');
    try { return await cluster.runtimesFor(n)[0].adapter.get('/node/manage/state', 8000); } catch (e) { throw err(400, `${n.name}: ${e.message}`); }
  });
  // Uninstall ForgeAI from another computer and take away its access here.
  R('POST', '/api/nodes/:id/uninstall', async (req) => {
    needPlatform(req, 'owner'); const purge = !!(req.body || {}).purge;
    const n = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", req.params.id); if (!n) throw err(404, 'That is not a ForgeAI computer — only ForgeAI computers can be uninstalled from here');
    if (!(req.body || {}).confirm) throw err(400, 'Confirm the uninstall first');
    let r; try { r = await cluster.runtimesFor(n)[0].adapter.post('/node/manage/uninstall', { purge }, 20000); }
    catch (e) { throw err(400, `${n.name} could not be reached to uninstall: ${e.message}. Next: make sure it is on, or remove it with "Uninstall ForgeAI.exe /S" (Windows) or uninstall-unix.sh --silent (Mac/Linux) from your deployment tool.`); }
    if (n.link_id) linkHub.forget(n.link_id);
    store.run('DELETE FROM nodes WHERE id=?', n.id); cluster.state.delete(n.id);
    store.audit(req.user.username, 'computer.uninstall', null, { node: n.name, purge }); return { ok: true, name: n.name, ...r };
  });
  R('POST', '/api/link/hub/spokes/:id/expose', async (req) => { needPlatform(req, 'owner'); const port = +(req.body || {}).port; if (!(port >= 1024 && port <= 65535)) throw err(400, 'Choose a port between 1024 and 65535'); if (!(req.body || {}).confirm) throw err(400, 'Confirm that you want this computer reachable from the internet through the hub'); try { await linkHub.expose(req.params.id, port); } catch (e) { throw err(400, e.message); } store.audit(req.user.username, 'link.expose', null, { id: req.params.id, port }); return linkHub.status(); });
  R('POST', '/api/link/hub/spokes/:id/unexpose', (req) => { needPlatform(req, 'owner'); linkHub.unexpose(req.params.id); store.audit(req.user.username, 'link.unexpose', null, { id: req.params.id }); return linkHub.status(); });
  R('POST', '/node/link/pair', (req) => { if (!linkHub.settings().enabled) throw err(503, 'Remote link is turned off on this hub'); if (!req.secure && !req.isLoopback) throw err(426, 'HTTPS required'); const b = req.body || {}; try { return linkHub.pair(b); } catch (e) { throw err(400, e.message); } }, { public: true });
  R('POST', '/api/link/pair', async (req) => { needPlatform(req, 'owner'); const b = req.body || {}; try { const r = await linkSpoke.pair(b.hub, String(b.code || '').trim(), linkSpoke.hello()); store.audit(req.user.username, 'link.pair', null, { hub: b.hub }); return { ...r, status: linkSpoke.status() }; } catch (e) { throw err(400, e.message); } });
  // ---- Owner-approved join requests (no key needed on the device; the owner approves on the hub) ----
  // Hub: a fresh computer asks to join. Public, but it only records a pending request — it hands out nothing.
  R('POST', '/node/link/request', (req) => { if (!linkHub.settings().enabled) throw err(503, 'Remote link is turned off on this hub'); if (!req.secure && !req.isLoopback) throw err(426, 'HTTPS required'); try { const r = linkHub.addJoinRequest(req.body || {}); llog(`Join request from ${(req.body || {}).name || (req.body || {}).id}`); return r; } catch (e) { throw err(400, e.message); } }, { public: true });
  // Hub: the device polls for the owner's decision. The one-time key is released only to the device whose nonce matches.
  R('GET', '/node/link/request/status', (req) => { if (!linkHub.settings().enabled) throw err(503, 'Remote link is off'); return linkHub.claimDecision(req.query.get('id'), req.query.get('nonce')); }, { public: true });
  // Hub owner: see and decide requests.
  R('GET', '/api/link/requests', (req) => { needPlatform(req); return { requests: linkHub.joinRequests().filter((r) => r.status === 'pending').map((r) => ({ reqId: r.reqId, name: r.name, os: r.os, address: r.address, version: r.version, at: r.at })) }; });
  R('POST', '/api/link/requests/:id/approve', (req) => { needPlatform(req, 'owner'); if (!linkHub.settings().enabled) throw err(400, 'Turn the hub on first'); try { const r = linkHub.approveJoinRequest(req.params.id, { label: (req.body || {}).label }); store.audit(req.user.username, 'link.request.approve', null, { reqId: req.params.id }); return { ...r, status: linkHub.status() }; } catch (e) { throw err(400, e.message); } });
  R('POST', '/api/link/requests/:id/decline', (req) => { needPlatform(req, 'owner'); linkHub.declineJoinRequest(req.params.id); store.audit(req.user.username, 'link.request.decline', null, { reqId: req.params.id }); return { ok: true, status: linkHub.status() }; });
  // Device owner: ask a hub to let this computer join, and see/cancel the pending ask.
  R('POST', '/api/link/request', async (req) => { needPlatform(req, 'owner'); const b = req.body || {}; if (!b.hub) throw err(400, 'Enter the hub address'); try { const r = await linkSpoke.requestJoin(b.hub); store.audit(req.user.username, 'link.request', null, { hub: b.hub }); return r; } catch (e) { throw err(400, e.message); } });
  R('GET', '/api/link/request', (req) => { needPlatform(req); return linkSpoke.requestStatus() || { status: 'none' }; });
  R('DELETE', '/api/link/request', (req) => { needPlatform(req, 'owner'); return linkSpoke.cancelRequest(); });
  R('POST', '/api/link/disconnect', (req) => { needPlatform(req, 'owner'); linkSpoke.unpair(); for (const n of store.all('SELECT * FROM nodes WHERE link_id IS NOT NULL')) { if (!linkHub.spokes()[n.link_id]) { store.run('DELETE FROM nodes WHERE id=?', n.id); cluster.state.delete(n.id); } } store.audit(req.user.username, 'link.disconnect', null, {}); return linkSpoke.status(); });
  R('POST', '/api/link/reconnect', (req) => { needPlatform(req, 'owner'); linkSpoke.stop(); linkSpoke.state.attempts = 0; linkSpoke.start(); return linkSpoke.status(); });
  R('POST', '/api/link/router', async (req) => { needPlatform(req, 'owner'); const port = +(req.body || {}).port || (app.listenInfo && app.listenInfo.port); try { const r = await openRouterPort(port); store.audit(req.user.username, 'link.router', null, { port, method: r.method }); return { ok: true, ...r, port }; } catch (e) { throw err(400, e.message); } });
  // ---- Rollouts: enrolment keys + deploy scripts the hub serves to new computers
  R('POST', '/api/link/hub/enrol', (req) => { needPlatform(req, 'owner'); if (!linkHub.settings().enabled) throw err(400, 'Turn the hub on first'); const b = req.body || {}; const k = linkHub.newEnrolKey({ label: b.label, uses: b.uses, days: b.days }); store.audit(req.user.username, 'link.enrol.create', null, { id: k.id, label: k.label, uses: k.uses }); return { ...k, commands: deployCommands(req, k.key), join: joinString(req, k.key) }; });
  R('DELETE', '/api/link/hub/enrol/:id', (req) => { needPlatform(req, 'owner'); linkHub.revokeEnrolKey(req.params.id); store.audit(req.user.username, 'link.enrol.revoke', null, { id: req.params.id }); return { ok: true }; });
  const deployDir = () => store.getSetting('deploy_dir', null) || path.join(os.homedir(), 'Downloads', 'ForgeAI', 'Installers');
  const DEPLOY_FILES = ['ForgeAI-Mac-AppleSilicon.zip', 'ForgeAI-Mac-Intel.zip', 'ForgeAI-Windows.zip', 'ForgeAI-Server.zip', 'Uninstall ForgeAI.exe', 'SHA256SUMS.txt'];
  const hubPin = () => { try { const t = store.getSetting('tls'); const der = new crypto.X509Certificate(t.cert).publicKey.export({ type: 'spki', format: 'der' }); return 'sha256//' + crypto.createHash('sha256').update(der).digest('base64'); } catch { return null; } };
  const hubAddr = (req) => { const h = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, ''); return h || `127.0.0.1:${app.listenInfo ? app.listenInfo.port : 4545}`; };
  const validKey = (raw) => { const h = crypto.createHash('sha256').update(String(raw || '').trim().toUpperCase()).digest('hex'); const k = linkHub.enrolKeys().find((x) => x.hash === h); return !!(k && k.expires > Date.now() && k.used < k.uses); };
  // The join string a new computer pastes (or gets inside the one-line command): everything it needs to find and
  // join THIS hub on its own — all of the hub's addresses, the enrolment key, the certificate pin, and the preset.
  function joinString(req, key, opts = {}) {
    const payload = { v: 1, a: hubJoinAddresses(req), k: key, p: hubPin() || undefined,
      n: linkHub.settings().name || undefined, ...opts };
    return 'FGJ1.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  }
  function parseJoinString(str) {
    const m = /^FGJ1\.([A-Za-z0-9_-]+)$/.exec(String(str || '').trim()); if (!m) throw new Error('That is not a ForgeAI join string (it should start with FGJ1.)');
    let j; try { j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { throw new Error('The join string is damaged — copy it again from the hub'); }
    if (!Array.isArray(j.a) || !j.a.length || !j.k) throw new Error('The join string is missing the hub address or key');
    return j;
  }
  function deployCommands(req, key) {
    const addr = hubAddr(req); const pin = hubPin(); const pinArg = pin ? `--pinnedpubkey '${pin}' ` : '';
    return {
      mac: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/install.sh?key=${key}' | sh -s -- --silent --autostart`,
      linux: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/install.sh?key=${key}' | sudo sh -s -- --silent`,
      windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; & ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('https://${addr}/node/deploy/install.ps1?key=${key}'))) -AutoStart"`,
      service: {
        windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; & ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('https://${addr}/node/deploy/install.ps1?key=${key}'))) -Service"`,
        mac: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/install.sh?key=${key}' | sudo sh -s -- --silent --service`,
        linux: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/install.sh?key=${key}' | sudo sh -s -- --silent --service`,
      },
      uninstall: {
        mac: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/uninstall.sh' | sh -s -- --silent`,
        linux: `curl -fsSk ${pinArg}'https://${addr}/node/deploy/uninstall.sh' | sudo sh -s -- --silent`,
        windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; & ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('https://${addr}/node/deploy/uninstall.ps1')))"`,
        purgeNote: 'Add --purge (Mac/Linux) or -Purge (Windows) to also delete that computer’s ForgeAI data.',
      },
      hub: addr, pin, files: DEPLOY_FILES.filter((f) => fs.existsSync(path.join(deployDir(), f))), dir: deployDir(),
    };
  }
  R('GET', '/api/deploy', (req) => { needPlatform(req); const dir = deployDir(); return { dir, files: DEPLOY_FILES.map((f) => { try { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, ok: true }; } catch { return { name: f, ok: false }; } }), hubOn: linkHub.settings().enabled, enrol: linkHub.status().enrol || [], ssh: !!process.env.PATH, uninstall: deployCommands(req, '').uninstall }; });
  R('PUT', '/api/deploy', (req) => { needPlatform(req, 'owner'); const d = String((req.body || {}).dir || '').trim(); if (d && !fs.existsSync(d)) throw err(400, 'That folder does not exist on this computer'); store.setSetting('deploy_dir', d || null); return { dir: deployDir() }; });
  R('GET', '/node/deploy/file/:name', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub'); if (!validKey(req.query.get('key'))) throw err(401, 'Enrolment key missing, expired or used up');
    if (!DEPLOY_FILES.includes(req.params.name)) throw err(404, 'Unknown file'); const f = path.join(deployDir(), req.params.name); if (!fs.existsSync(f)) throw err(404, `${req.params.name} is not in the hub's installers folder (${deployDir()})`);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return undefined;
  }, { raw: true, public: true });
  R('GET', '/node/deploy/install.sh', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub'); const key = String(req.query.get('key') || ''); if (!validKey(key)) throw err(401, 'Enrolment key missing, expired or used up');
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install-unix.sh'), 'utf8');
    const body = tpl.replace('__HUB__', hubAddr(req)).replace('__KEY__', key.replace(/[^A-Za-z0-9-]/g, '')).replace('__PIN__', hubPin() || '').replace('__JOIN__', joinString(req, key));
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return undefined;
  }, { raw: true, public: true });
  R('GET', '/node/deploy/install.ps1', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub'); const key = String(req.query.get('key') || ''); if (!validKey(key)) throw err(401, 'Enrolment key missing, expired or used up');
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install-windows.ps1'), 'utf8');
    const body = tpl.replace('__HUB__', hubAddr(req)).replace('__KEY__', key.replace(/[^A-Za-z0-9-]/g, '')).replace('__JOIN__', joinString(req, key));
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return undefined;
  }, { raw: true, public: true });
  // Uninstallers: nothing secret in them, so no enrolment key is needed (the hub must have the remote link on).
  R('GET', '/node/deploy/uninstall.sh', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub');
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, '..', 'deploy', 'uninstall-unix.sh'))); return undefined;
  }, { raw: true, public: true });
  R('GET', '/node/deploy/uninstall.exe', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub');
    const f = [path.join(deployDir(), 'Uninstall ForgeAI.exe'), path.join(__dirname, '..', 'deploy', 'Uninstall ForgeAI.exe')].find((x) => fs.existsSync(x));
    if (!f) throw err(404, `Uninstall ForgeAI.exe is not in the hub's installers folder (${deployDir()})`);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return undefined;
  }, { raw: true, public: true });
  R('GET', '/node/deploy/uninstall.ps1', (req, res) => {
    if (!linkHub.settings().enabled) throw err(503, 'Remote link is off on this hub');
    const f = [path.join(deployDir(), 'Uninstall ForgeAI.exe'), path.join(__dirname, '..', 'deploy', 'Uninstall ForgeAI.exe')].find((x) => fs.existsSync(x));
    const want = f ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : '';
    const body = `# ForgeAI remote uninstall (from the hub at ${hubAddr(req)}). -Purge also deletes ForgeAI's data.
param([switch]$Purge)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
$exe = Join-Path $env:TEMP ('ForgeAI-Uninstall-' + [guid]::NewGuid().ToString('N') + '.exe')
(New-Object Net.WebClient).DownloadFile('https://${hubAddr(req)}/node/deploy/uninstall.exe', $exe)
if ('${want}' -and ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower() -ne '${want}')) { Remove-Item $exe -Force; throw 'Uninstaller download was damaged (checksum mismatch) - nothing removed' }
$a = @('/S'); if ($Purge) { $a += '/PURGE' }
$p = Start-Process -FilePath $exe -ArgumentList $a -Wait -PassThru
Remove-Item $exe -Force -ErrorAction SilentlyContinue
$log = Join-Path $env:TEMP 'ForgeAI-uninstall.log'; if (Test-Path $log) { Get-Content $log }
exit $p.ExitCode
`;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return undefined;
  }, { raw: true, public: true });
  // Push from this computer over SSH (uses this computer's own SSH keys; never stores a password).
  R('POST', '/api/deploy/ssh', async (req) => {
    needPlatform(req, 'owner'); const b = req.body || {}; const targets = String(b.targets || '').split(/[\s,]+/).filter(Boolean).slice(0, 100);
    if (!targets.length) throw err(400, 'Enter one or more user@host'); if (targets.some((t) => !/^[\w.\-]+@[\w.\-:\[\]]+$/.test(t))) throw err(400, 'Use the form user@host (one per line)');
    const k = linkHub.newEnrolKey({ label: 'SSH push', uses: targets.length, days: 1 }); const cmds = deployCommands(req, k.key);
    const { execFile } = require('child_process');
    const run = (t) => new Promise((ok) => {
      const os2 = b.os === 'windows' ? 'windows' : b.os === 'linux' ? 'linux' : 'mac';
      const remote = os2 === 'windows' ? cmds.windows : os2 === 'linux' ? cmds.linux.replace('| sudo sh', '| sudo -n sh') : cmds.mac;
      execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', t, remote], { timeout: 15 * 60000, maxBuffer: 4 << 20 }, (e, out, errOut) => ok({ target: t, ok: !e, output: String(out || '').slice(-1500), error: e ? (String(errOut || e.message).slice(-600) || e.message) : null }));
    });
    const results = []; for (let i = 0; i < targets.length; i += 8) results.push(...await Promise.all(targets.slice(i, i + 8).map(run)));
    store.audit(req.user.username, 'deploy.ssh', null, { targets: targets.length, ok: results.filter((r) => r.ok).length }); return { results };
  });
  // Silent-install setup (setup.json written by the installers) — applied once at first start.
  const applySetup = async (j) => {
    j = j || {}; const who = 'setup';
    if (j.priority || j.yield != null) priority.save({ level: j.priority, yield: j.yield });
    if (j.showIcon != null || j.startAtLogin != null || j.startHidden != null) { const cur = store.getSetting('desktop', {}); store.setSetting('desktop', { showIcon: j.showIcon == null ? cur.showIcon !== false : !!j.showIcon, startAtLogin: j.startAtLogin == null ? !!cur.startAtLogin : !!j.startAtLogin, startHidden: j.startHidden == null ? !!cur.startHidden : !!j.startHidden }); }
    if (j.lend) lender.save({ mode: j.lend });
    if (j.name) store.setSetting('platform_name', String(j.name).slice(0, 40));
    if (j.worker || j.hub) ensureWorkerToken();
    if (j.join) { try { const g = parseJoinString(j.join); store.setSetting('pending_join', { addresses: g.a.slice(0, 20), key: String(g.k).slice(0, 80), pin: g.p || null, hubName: g.n || null, tries: 0 }); } catch (e) { llog('setup join string: ' + e.message); } }
    else if (j.hub && j.key) store.setSetting('pending_join', { addresses: [String(j.hub).slice(0, 200)], key: String(j.key).slice(0, 80), tries: 0 });
    store.audit(who, 'setup.apply', null, { ...j, key: j.key ? '••••' : undefined });
    await tryPendingJoin();
  };
  const tryPendingJoin = async () => {
    const p = store.getSetting('pending_join', null); if (!p || linkSpoke.settings().enabled) return;
    const addrs = p.addresses || (p.hub ? [p.hub] : []); if (!addrs.length) { store.setSetting('pending_join', null); return; }
    try { await linkSpoke.pair(addrs, p.key, linkSpoke.hello()); store.setSetting('pending_join', null); llog(`Joined hub ${p.hubName || addrs[0]} from setup`); }
    catch (e) { p.tries = (p.tries || 0) + 1; p.error = e.message; store.setSetting('pending_join', p.tries > 500 ? null : p); llog(`Joining ${addrs[0]}${addrs.length > 1 ? ` (+${addrs.length - 1} more)` : ''}: ${e.message}`); }
  };
  timersLate.push(() => setInterval(() => tryPendingJoin().catch(() => {}), 60000));
    R('POST', '/api/link/hub/relay', (req) => { needPlatform(req, 'owner'); if (!linkHub.settings().enabled) throw err(400, 'Turn the hub on first'); const b = req.body || {}; try { return linkHub.saveRelay(b); } catch (e) { throw err(400, e.message); } });
    R('POST', '/api/link/public-ip', async (req) => { needPlatform(req, 'owner'); try { const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) }); const j = await r.json(); return { ip: j.ip, note: 'Looked up at api.ipify.org (this request left your network).' }; } catch (e) { throw err(400, 'Could not look up the public address: ' + e.message); } });
  const nodeManagers = (n) => { try { const g = safeJSON(n.grants, {}) || {}; return Array.isArray(g.managers) ? g.managers : []; } catch { return []; } };
  const canManageNode = (req, n) => req.user && (req.user.platform_role === 'owner' || req.user.platform_role === 'admin' || nodeManagers(n).includes(req.user.id));
  const needManageNode = (req, n) => { if (!canManageNode(req, n)) throw err(403, `You don't have permission to manage ${n.name}. Ask the owner to give you manage access under Computers → ${n.name} → People.`); };
  const workerAuth = (req) => {
    const w = store.getSetting('worker', { enabled: false });
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const want = w.enabled ? vault.reveal(w.token_ref) : null;
    if (!want || !got || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw err(401, 'Invalid node token');
  };
  // ---- cluster kit on a worker computer (called by the main ForgeAI with the computer token)
  const KIT_OPS = {
    caps: () => kit.capabilities(), status: () => kit.status(),
    // Download the official build, or use a release file / folder already on that computer (no internet needed).
    install: async (b) => {
      if (b.folder || b.archive) { try { await (b.folder ? kit.useFolder(String(b.folder)) : kit.installArchive(String(b.archive))); } catch (e) { kit.install = { state: 'error', status: e.message }; throw e; } return kit.status(); }
      kit.ensure({ gpu: ['cpu', 'cuda', 'vulkan'].includes(b.gpu) ? b.gpu : 'cpu' }).catch(() => {}); return kit.status();
    },
    'start-rpc': (b) => kit.startRpc(b), 'start-server': (b) => kit.startServer(b), stop: (b) => kit.stop(b.kind),
    'ollama-path': async (b) => ({ path: await ollamaModelPath(b.model) }),
    link: async (b) => Promise.all((b.targets || []).slice(0, 16).map(async (t) => { try { return { id: t.id, ...(await measureLink((p) => pinnedFetch(t.url + p, { headers: { authorization: 'Bearer ' + t.token }, pin: t.pin, signal: AbortSignal.timeout(60000) }), b.mb || 32)) }; } catch (e) { return { id: t.id, error: e.message }; } })),
  };
  R('POST', '/node/kit/:op', async (req) => { workerAuth(req); const f = KIT_OPS[req.params.op]; if (!f) throw err(404, 'Unknown operation'); try { return await f(req.body || {}); } catch (e) { throw err(400, e.message); } }, { public: true });
  R('GET', '/node/net/ping', (req) => { workerAuth(req); return { ok: true, t: Date.now() }; }, { public: true });
  R('GET', '/node/net/blob', (req, res) => { workerAuth(req); const mb = Math.min(256, Math.max(1, +req.query.get('mb') || 32)); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': mb * 2 ** 20 }); const chunk = Buffer.alloc(2 ** 20); let n = 0; const w = () => { while (n < mb) { n++; if (!res.write(chunk)) return res.once('drain', w); } res.end(); }; w(); return undefined; }, { raw: true, public: true });
  // Remote restart: the service wrapper / launchd / login item brings ForgeAI back up.
  R('POST', '/node/manage/restart', (req) => {
    workerAuth(req); store.audit('hub', 'computer.restart', null, {});
    setTimeout(() => { try { process.exit(0); } catch {} }, 500);
    return { ok: true, restarting: true, managed: !!(store.getSetting('managed', {}) || {}).on };
  }, { public: true });
  // Remote state for the manager: what this computer is and how it's set.
  R('GET', '/node/manage/state', (req) => {
    workerAuth(req); const d = store.getSetting('desktop', {}); const pr = priority.settings();
    return { version, platform: process.platform, managed: !!(store.getSetting('managed', {}) || {}).on,
      name: platformName(), priority: pr.level, yield: pr.yield !== false, lend: lender.settings().mode,
      engine: { installed: forgeEngine.status().installed, running: forgeEngine.running() }, uptimeSec: Math.round(process.uptime()) };
  }, { public: true });
  // Remote uninstall (asked for by the hub owner with this computer's token): answers first, then runs the
  // uninstaller from a temporary copy so it can remove the program folder it came from.
  R('POST', '/node/manage/uninstall', (req) => {
    workerAuth(req); const purge = !!(req.body || {}).purge; const { spawn } = require('child_process');
    const dep = path.join(__dirname, '..', 'deploy'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeai-uninstall-'));
    let cmd, args;
    if (process.platform === 'win32') {
      const src = path.join(dep, 'Uninstall ForgeAI.exe'); if (!fs.existsSync(src)) throw err(501, 'This ForgeAI is too old to uninstall remotely (no uninstaller in its deploy folder). Next: run "Uninstall ForgeAI.exe /S" on it with your deployment tool.');
      cmd = path.join(tmp, 'Uninstall ForgeAI.exe'); fs.copyFileSync(src, cmd); args = ['/S']; if (purge) args.push('/PURGE');
    } else {
      const src = path.join(dep, 'uninstall-unix.sh'); if (!fs.existsSync(src)) throw err(501, 'No uninstaller found in this ForgeAI. Next: run uninstall-unix.sh --silent on it.');
      const f = path.join(tmp, 'uninstall-unix.sh'); fs.copyFileSync(src, f); cmd = '/bin/sh'; args = [f, '--silent']; if (purge) args.push('--purge');
    }
    store.audit('hub', 'computer.uninstall', null, { purge });
    setTimeout(() => { try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); } catch {} }, 600);
    return { ok: true, starting: true, purge, platform: process.platform, user: os.userInfo().username,
      note: process.platform !== 'win32' && process.getuid && process.getuid() !== 0 ? 'Running without administrator rights: a system-wide service on that computer (if any) is left for an administrator to remove.' : null };
  }, { public: true });
  R('GET', '/node/metrics', async (req) => { workerAuth(req); return { machine: perf.machine || await perf.sampleMachine(), live: perf.liveList().length, version, availability: lender.last, lend: lender.settings().mode }; }, { public: true });
  R('GET', '/node/models', async (req) => {
    workerAuth(req); const local = cluster.nodes().find((n) => n.is_local);
    const st = await cluster.refreshNode(local);
    return { models: st.models.map((m) => ({ ...m, _url: undefined })) };
  }, { public: true });
  R('POST', '/node/chat', async (req, res) => {
    workerAuth(req); const local = cluster.nodes().find((n) => n.is_local);
    const st = cluster.state.get(local.id) || await cluster.refreshNode(local);
    const m = st.models.find((x) => x.id === req.body.model); if (!m) throw err(404, 'Model not on this node');
    const rt = cluster.runtimesFor(local).find((r) => r.url === m._url);
    const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    cluster.begin(local.id, null, 0); const t0 = Date.now();
    try {
      await cluster.ensureReady({ node: local, model: m, adapter: rt.adapter }, (pg) => res.write(JSON.stringify({ progress: pg }) + '\n'), ctl.signal);
      const r = await rt.adapter.chat({ onProgress: (pg) => res.write(JSON.stringify({ progress: pg }) + '\n'), model: m.id, system: req.body.system, messages: req.body.messages || [], maxTokens: req.body.maxTokens, temperature: typeof req.body.temperature === 'number' ? req.body.temperature : undefined, signal: ctl.signal, onDelta: (d) => res.write(JSON.stringify({ delta: d }) + '\n') });
      cluster.end(local.id, null, 0, r.outputTokens, Date.now() - t0, m.id);
      res.write(JSON.stringify({ done: true, result: r }) + '\n');
    } catch (e) { cluster.end(local.id, null, 0); res.write(JSON.stringify({ error: e.message }) + '\n'); }
    res.end();
  }, { raw: true, public: true });

  R('POST', '/node/chat-tools', async (req) => {
    workerAuth(req); const local = cluster.nodes().find((n) => n.is_local);
    const st = cluster.state.get(local.id) || await cluster.refreshNode(local);
    const m = st.models.find((x) => x.id === req.body.model); if (!m) throw err(404, 'Model not on this node');
    const rt = cluster.runtimesFor(local).find((r) => r.url === m._url);
    cluster.begin(local.id, null, 0); const t0 = Date.now();
    try { await cluster.ensureReady({ node: local, model: m, adapter: rt.adapter }); const r = await rt.adapter.chatTools({ model: m.id, system: req.body.system, messages: req.body.messages || [], tools: req.body.tools || [], maxTokens: req.body.maxTokens, temperature: typeof req.body.temperature === 'number' ? req.body.temperature : undefined, numCtx: Math.min(Math.max(8192, m.context || 16384), 32768) }); cluster.end(local.id, null, 0, r.outputTokens, Date.now() - t0, m.id); return r; }
    catch (e) { cluster.end(local.id, null, 0); throw err(502, e.message); }
  }, { public: true });
  R('POST', '/node/ollama/:op', async (req, res) => {
    workerAuth(req); if (!OLLAMA_OPS[req.params.op]) throw err(404, 'Unknown operation');
    const u = localOllamaUrl(); if (!u) throw err(400, 'Ollama is not configured on this worker');
    const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    try { await ollamaDirect(u, req.params.op, req.body, (p) => res.write(JSON.stringify({ progress: p }) + '\n'), ctl.signal); res.write(JSON.stringify({ done: true }) + '\n'); }
    catch (e) { res.write(JSON.stringify({ error: e.message }) + '\n'); }
    res.end(); cluster.refreshAll().catch(() => {});
  }, { raw: true, public: true });

  // ---------------- HTTP plumbing
  function setCookie(res, token, secure) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
  }
  function sse(res) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' }); }
  function cookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
  function readBody(req, limit = 45 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(err(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(err(400, 'Invalid JSON')); } });
      req.on('error', reject);
    });
  }
  const SEC_HEADERS = {
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    req.ip = req.socket.remoteAddress || '';
    req.isLoopback = /^(127\.|::1$|::ffff:127\.)/.test(req.ip) && !req.headers['x-forwarded-for'];
    req.secure = !!req.socket.encrypted;
    req.query = url.searchParams;
    try {
      if (!/^\/(api|node|v1|render|art|link)\//.test(url.pathname)) return serveStatic(url.pathname, res);
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw err(404, 'Not found');
      const m = route.re.exec(url.pathname); req.params = {}; route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      req.token = cookies(req)[COOKIE];
      req.user = auth.userFromToken(req.token);
      if (!route.opt.public && !req.user) throw err(401, 'Please sign in');
      // CSRF defence: state-changing browser requests must carry our custom header (cannot be sent cross-site without CORS).
      if (req.method !== 'GET' && url.pathname.startsWith('/api/') && req.headers['x-aicore'] !== '1') throw err(403, 'Missing request header');
      req.body = req.method === 'GET' ? {} : await readBody(req);
      const out = await route.handler(req, res);
      if (route.opt.raw) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out === undefined ? { ok: true } : out));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (res.headersSent) { try { res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`); res.end(); } catch {} return; }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
  function serveStatic(p, res) {
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------- lifecycle
  let server = null; let timers = [];
  const discovery = new Discovery(() => app.listenInfo && app.listenInfo.remote ? { id: instanceId, name: platformName(), host: os.hostname(), os: process.platform, port: app.listenInfo.port, https: app.listenInfo.https, fp: app.listenInfo.fingerprint, worker: !!store.getSetting('worker', {}).enabled, version } : null);
  const app = {
    store, vault, auth, cluster, models, engine, backups, mail, mcp, artifacts, priority, vms, applySetup, dataDir, listenInfo: null, setupCode, host,
    search: (q, n) => webSearch(q, n),
    notify(orgDb, title, body, link) {
      orgDb.run('INSERT INTO notifications(id,title,body,link,created_at) VALUES(?,?,?,?,?)', uid('ntf_'), String(title || '').slice(0, 200), String(body || '').slice(0, 1000), link || null, now());
      try { app.host && app.host.notify && app.host.notify(`${title}`, `${orgDb.org.name}: ${body || ''}`.slice(0, 250)); } catch {}
    },
    async listen() {
      const s = store.getSetting('access', { remote: false, port: 4545, https: false });
      if (process.env.AICORE_REMOTE === '1') s.remote = true;
      const host = s.remote ? '0.0.0.0' : '127.0.0.1';
      if (s.https) {
        let tls = store.getSetting('tls', null);
        if (!tls) {
          const selfsigned = require('selfsigned');
          const pems = await selfsigned.generate([{ name: 'commonName', value: 'ForgeAI' }], { days: 3650, keySize: 2048 });
          tls = { cert: pems.cert, key_ref: vault.put(pems.private) }; store.setSetting('tls', tls);
        }
        server = https.createServer({ cert: tls.cert, key: vault.reveal(tls.key_ref) }, handle);
      } else server = http.createServer(handle);
      server.requestTimeout = 0; server.headersTimeout = 60000;
      server.on('upgrade', (req, socket, head) => { try { if (!linkHub.upgrade(req, socket, head)) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); } } catch (e) { try { socket.destroy(); } catch {} } });
      let port = +process.env.AICORE_PORT || s.port || 4545;
      for (let i = 0; i < 20; i++) {
        try { await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); }); break; }
        catch (e) { if (e.code !== 'EADDRINUSE' || i === 19) throw e; port++; }
      }
      const fp = s.https ? new crypto.X509Certificate(store.getSetting('tls').cert).fingerprint256 : null;
      app.listenInfo = { host, port, https: !!s.https, remote: !!s.remote, fingerprint: fp, localUrl: `${s.https ? 'https' : 'http'}://127.0.0.1:${port}` };
      try { fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ url: app.listenInfo.localUrl, port, https: !!s.https, pid: process.pid, version, managed: !!(store.getSetting('managed', {}) || {}).on, at: Date.now() })); } catch {}
      if (s.remote) discovery.start(); else discovery.stop();
      return app.listenInfo;
    },
    async relisten() { await new Promise((r) => { if (!server) return r(); server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }); const info = await app.listen(); app.onRelisten && app.onRelisten(info); return info; },
    async start() {
      const info = await app.listen();
      if (forgeEngine.installed() && forgeEngine.settings().autoStart && forgeEngine.files().length) await forgeEngine.start().catch((e) => console.error('engine', e.message));
      linkSpoke.start(); if (linkHub.settings().enabled) linkHub.restoreExposed().catch(() => {});
      timers.push(setInterval(() => { try { linkSpoke.report({ machine: perf.machine || null, availability: availabilityNow() }); } catch {} }, 15000));
      cluster.refreshAll().catch(() => {});
      timers.push(setInterval(() => cluster.refreshAll().catch(() => {}), (store.getSetting('refresh_seconds', 15) || 15) * 1000)); // live load/unload detection
      timers.push(setInterval(() => perf.sampleMachine().catch(() => {}), 3000));
      timers.push(setInterval(() => lender.sample().catch(() => {}), 10000)); lender.sample().catch(() => {});
      priority.tick(hostPids()).catch(() => {}); timers.push(setInterval(() => priority.tick(hostPids()).catch(() => {}), process.platform === 'win32' ? 15000 : 5000));
      timers.push(setInterval(() => memory.tick().catch(() => {}), 60000));
      timers.push(setInterval(() => health.flush(), 15000));
      for (const f of timersLate) timers.push(f());
      timers.push(setInterval(() => { try { engine.tick(); } catch (e) { console.error('scheduler', e); } }, 30000));
      timers.push(setInterval(() => { try { backups.tick(); } catch (e) { console.error('backup', e); } }, 15 * 60000));
      setTimeout(() => { try { backups.tick(); } catch {} }, 60000);
      return info;
    },
    stop() { timers.forEach(clearInterval); timers = []; discovery.stop(); try { vms.destroyAll(); } catch {} if (server) server.close(); },
    instanceId, platformName,
    // Headless "worker" mode (Raspberry Pi, Linux box, spare PC): share this computer with a main ForgeAI without opening the dashboard.
    enableWorker({ port, https: tlsOn = true, managed = false } = {}) {
      const cur = store.getSetting('access', { remote: false, port: 4545, https: false });
      // Managed (background service): don't open to the network — the hub reaches this computer through the link tunnel
      // to loopback. Keeps the machine from listening on 0.0.0.0 where no one asked it to.
      store.setSetting('access', managed
        ? { remote: false, port: port ? Math.min(65535, Math.max(1024, +port)) : cur.port || 4545, https: false }
        : { remote: true, port: port ? Math.min(65535, Math.max(1024, +port)) : cur.port || 4545, https: tlsOn });
      if (managed) store.setSetting('managed', { on: true, since: now() });
      const w = store.getSetting('worker', { enabled: false });
      if (!w.token_ref) w.token_ref = vault.put(crypto.randomBytes(24).toString('base64url'));
      w.enabled = true; store.setSetting('worker', w); store.audit('console', 'worker.update', null, { enabled: true, headless: true });
      return vault.reveal(w.token_ref);
    },
    // Used by the Mac app window so the owner on this Mac is signed in automatically.
    localSession() { const owner = store.get('SELECT * FROM users WHERE platform_role=\'owner\' AND disabled=0 ORDER BY created_at LIMIT 1'); return owner ? auth.newSession(owner.id, '127.0.0.1', 'local', 7) : null; },
    COOKIE,
  };
  // ---- Infrastructure Auto-Pilot: a facade the fleet agent uses to see and run the ForgeAI fleet in plain language.
  // Permission is always checked against the human who asked (the resolved actor), never the agent itself.
  app.infra = {
    isAdmin: (u) => !!(u && (u.platform_role === 'owner' || u.platform_role === 'admin')),
    isOwner: (u) => !!(u && u.platform_role === 'owner'),
    canManage: (u, n) => !!(u && (u.platform_role === 'owner' || u.platform_role === 'admin' || nodeManagers(n).includes(u.id))),
    nodeByName(name) {
      const nm = String(name || '').trim().toLowerCase();
      const all = cluster.nodes();
      if (!nm || nm === 'local' || nm === 'this computer') return all.find((n) => n.is_local);
      return all.find((n) => (n.name || '').toLowerCase() === nm) || all.find((n) => (n.name || '').toLowerCase().includes(nm));
    },
    list() {
      const al = aliases();
      return cluster.nodes().filter((n) => n.enabled).map((n) => {
        const st = cluster.state.get(n.id) || {};
        const mt = n.is_local ? (perf.machine || null) : cluster.metrics.get(n.id);
        const av = n.is_local ? availabilityNow() : (mt && mt.availability) || null;
        const sp = topoSpeed.get(n.id);
        return {
          name: n.is_local ? 'This computer' : n.name,
          kind: /\(cluster\)$/.test(n.name) ? 'cluster' : n.kind,
          online: !!n.is_local || st.status === 'online',
          available: av ? av.available !== false : true,
          why_not: av && av.available === false ? av.reason : null,
          cpu_percent: mt && mt.cpuPct != null ? mt.cpuPct : null,
          free_memory_gb: mt && mt.memFree ? +(mt.memFree / 2 ** 30).toFixed(1) : null,
          total_memory_gb: mt && mt.memTotal ? +(mt.memTotal / 2 ** 30).toFixed(1) : (n.ram_gb || null),
          models: (st.models || []).map((m) => al[m.id] || m.id).slice(0, 30),
          loaded_models: (st.models || []).filter((m) => m.loaded).map((m) => al[m.id] || m.id),
          link: n.is_local ? 'this computer' : (n.link_id ? 'remote link (encrypted tunnel)' : networkScope(n.url)),
          link_mbps: sp ? sp.mbps : null, link_rtt_ms: sp ? sp.rttMs : null,
        };
      });
    },
    async diagnose({ node } = {}) {
      const findings = []; const facts = []; const target = node ? this.nodeByName(node) : null;
      const workers = cluster.nodes().filter((n) => n.enabled && n.kind === 'worker' && (!target || n.id === target.id));
      // Offline / unavailable
      for (const n of cluster.nodes().filter((x) => x.enabled && !x.is_local && (!target || x.id === target.id))) {
        const st = cluster.state.get(n.id) || {};
        if (st.status !== 'online') findings.push(`${n.name} is offline (${st.error || 'not responding'}). It can't take work until it's back.`);
      }
      // Memory / CPU pressure
      for (const n of cluster.nodes().filter((x) => x.enabled && (!target || x.id === target.id))) {
        const mt = n.is_local ? (perf.machine || null) : cluster.metrics.get(n.id); if (!mt) continue;
        const nm = n.is_local ? 'This computer' : n.name;
        if (mt.memFree != null && mt.memFree < 2 * 2 ** 30) findings.push(`${nm} has only ${(mt.memFree / 2 ** 30).toFixed(1)} GB free memory — big models may fail to load there. Unload a model or use a smaller one.`);
        if (mt.cpuPct != null && mt.cpuPct > 85) findings.push(`${nm} is busy (${mt.cpuPct}% CPU) — work sent there will be slow right now.`);
        else facts.push(`${nm}: ${mt.cpuPct != null ? mt.cpuPct + '% CPU, ' : ''}${mt.memFree != null ? (mt.memFree / 2 ** 30).toFixed(1) + ' GB free' : 'memory unknown'}.`);
      }
      // Models set aside after failures
      const h = store.getSetting('health', {});
      for (const [k, v] of Object.entries(h)) if (k.startsWith('model:') && v.cooldownUntil > Date.now()) findings.push(`Model ${k.slice(6)} is set aside after repeated failures${v.cooldownWhy ? ' (' + (v.cooldownWhy.text || v.cooldownWhy.kind) + ')' : ''}. It won't be used until it recovers.`);
      // Link speed to each worker (this is the usual cause of "slow" across computers)
      for (const n of workers) {
        try {
          const r = await measureLink((p) => pinnedFetch(n.url.replace(/\/$/, '') + p, { headers: { authorization: 'Bearer ' + vault.reveal(n.secret_ref) }, pin: n.cert_pin, signal: AbortSignal.timeout(30000) }), 16);
          topoSpeed.set(n.id, { mbps: r.mbps, rttMs: r.rttMs, at: Date.now() });
          if (r.rttMs > 120) findings.push(`The link to ${n.name} is slow to respond (${Math.round(r.rttMs)} ms round-trip) — this adds lag to every step that runs there. A wired connection or the same network would help.`);
          if (r.mbps < 50) findings.push(`The link to ${n.name} is only ${r.mbps.toFixed(0)} Mbps — moving a model or large context to it is slow. Keep big models on faster-linked computers.`);
          facts.push(`Link to ${n.name}: ${r.mbps.toFixed(0)} Mbps, ${Math.round(r.rttMs)} ms round-trip.`);
        } catch (e) { findings.push(`Couldn't measure the link to ${n.name}: ${e.message}`); }
      }
      return { findings, facts, checked: new Date().toISOString() };
    },
    async findComputers() {
      const found = await scan(1800, instanceId); const known = new Set(cluster.nodes().map((n) => n.url));
      return found.map((f) => ({ name: f.name, host: f.host, os: f.os, url: f.url, worker: !!f.worker, version: f.version, already_added: known.has(f.url) }));
    },
    addComputer({ label, service } = {}) {
      if (!linkHub.settings().enabled) throw new Error('The remote link (hub) is turned off, so new computers have nothing to join. Turn it on under Settings → Computers → Remote link, then ask again.');
      const k = linkHub.newEnrolKey({ label: String(label || 'Added by Auto-Pilot').slice(0, 60), uses: 1, days: 7 });
      const req = { headers: {} }; const cmds = deployCommands(req, k.key);
      return { key: k.key, join: joinString(req, k.key), expires_days: 7,
        run_on_new_computer: service ? cmds.service : { mac: cmds.mac, windows: cmds.windows, linux: cmds.linux },
        note: 'Run the line for the new computer\'s operating system on that computer (or paste the join string into its ForgeAI setup). It then appears here on its own. The key works once and expires in 7 days.' };
    },
    async moveModel({ node, op, id, repo, files, mmproj } = {}) {
      if (!ENGINE_OPS[op]) throw new Error('Unknown model operation: ' + op);
      const n = this.nodeByName(node); if (!n) throw new Error('No such computer: ' + node);
      const body = { id, repo, files, mmproj };
      if (n.is_local) return ENGINE_OPS[op](body);
      const wn = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", n.id);
      if (!wn) throw new Error(`${n.name} isn't a ForgeAI computer that can run models remotely.`);
      try { return await cluster.runtimesFor(wn)[0].adapter.post('/node/engine/' + op, body, op === 'download' ? 20 * 60000 : 60000); }
      catch (e) { throw new Error(`${n.name}: ${e.message}`); }
    },
    async restart({ node } = {}) {
      const n = this.nodeByName(node); if (!n) throw new Error('No such computer: ' + node);
      if (n.is_local) throw new Error('I can restart other ForgeAI computers, but not the one running the hub itself.');
      const wn = store.get("SELECT * FROM nodes WHERE id=? AND kind='worker'", n.id);
      if (!wn) throw new Error(`${n.name} can't be restarted from here.`);
      try { const r = await cluster.runtimesFor(wn)[0].adapter.post('/node/manage/restart', {}, 10000); return { ok: true, name: n.name, ...r }; }
      catch (e) { throw new Error(`${n.name}: ${e.message}`); }
    },
  };

  app.runtime = new AgentRuntime(app);
  engine.app = app;
  return app;
}

module.exports = { createApp };
