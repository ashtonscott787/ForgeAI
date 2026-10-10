'use strict';
// ForgeAI agent runtime: a model + tools loop with a step log, file scopes and human approval for risky actions.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { uid, now } = require('./db');
const { safeJSON, estTokens } = require('./router');
const { FileScope } = require('./sandbox');
const { createDocument, makeChartSvg, readXlsx } = require('./docs');
const { extractText, isImage, imageMime } = require('./files');

const PAY_RE = /\b(buy( now)?|purchase|pay( now)?|place (your )?order|check ?out|confirm (and pay|order|payment|purchase)|complete (order|purchase)|subscribe|donate|book now|add payment|make payment)\b/i;
const ACT_RE = /\b(send|post|publish|share|tweet|reply|comment|submit|delete|remove|transfer|follow|unfollow|invite|upload|confirm|accept|decline|sign ?up|register|apply)\b/i;
const CAPABILITIES = {
  files: 'Read, search and organise files in allowed folders',
  documents: 'Create Word, PowerPoint, Excel, PDF, web pages and charts',
  code: 'Run JavaScript calculations and data analysis (safe sandbox)',
  web: 'Search the web and read pages',
  browser: 'Use a web browser with its own logins (websites, webmail, social media, shopping)',
  email: 'Read and send email from assigned mailboxes',
  shell: 'Run commands and programs on this computer (build apps, run tools)',
  sandbox: 'Run commands inside a throwaway, isolated virtual machine/sandbox — safe for untrusted or risky commands, kept away from the real computer',
  schedule: 'Schedule tasks and reminders, send notifications',
  memory: 'Remember facts for this organisation',
  agents: 'Ask other agents for help',
  infra: 'Run the ForgeAI computers in plain language: see them, find and add more, move models between them, diagnose slowness and restart them (every change needs the person’s own permission)',
};
const DEFAULT_ASSISTANT_TOOLS = ['files', 'documents', 'code', 'web', 'schedule', 'memory', 'agents', 'infra'];

function clip(s, n = 20000) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters]` : s; }
function htmlToText(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function whenToDate(when) {
  if (!when) return new Date(Date.now() + 60000);
  const m = /^in\s+(\d+)\s*(minute|min|hour|hr|day)s?$/i.exec(String(when).trim());
  if (m) return new Date(Date.now() + (+m[1]) * ({ minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 864e5 }[m[2].toLowerCase()]));
  const d = new Date(when); if (isNaN(d)) throw new Error('Could not understand the time. Use an ISO date like 2026-10-01T08:00 or "in 2 hours".'); return d;
}
function nextFor(repeat, from) {
  const r = repeat || {}; const d = new Date(from);
  if (r.type === 'hourly') return new Date(d.getTime() + 3600e3);
  if (r.type === 'daily') return new Date(d.getTime() + 864e5);
  if (r.type === 'weekly') return new Date(d.getTime() + 7 * 864e5);
  if (r.type === 'weekdays') { do { d.setDate(d.getDate() + 1); } while ([0, 6].includes(d.getDay())); return d; }
  return null;
}

// Runs JavaScript in an isolated worker with no file, network or process access.
function runJs(code, inputs, ms = 20000) {
  return new Promise((resolve) => {
    const src = `const { parentPort, workerData } = require('worker_threads'); const vm = require('vm');
      const out = []; const fmt = (a) => a.map((x) => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x, null, 2); } catch { return String(x); } })()).join(' ');
      const sandbox = { console: { log: (...a) => out.push(fmt(a)), error: (...a) => out.push('ERROR: ' + fmt(a)), table: (x) => out.push(fmt([x])) }, files: workerData.inputs, Math, JSON, Date, Number, String, Array, Object, Intl, Map, Set, RegExp, parseFloat, parseInt, isNaN };
      try { const r = vm.runInNewContext(workerData.code, sandbox, { timeout: ${ms} }); Promise.resolve(r).then((v) => parentPort.postMessage({ out, result: v === undefined ? undefined : fmt([v]) })).catch((e) => parentPort.postMessage({ out, error: String(e && e.stack || e) })); }
      catch (e) { parentPort.postMessage({ out, error: String(e && e.message || e) }); }`;
    const w = new Worker(src, { eval: true, workerData: { code, inputs }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const t = setTimeout(() => { w.terminate(); resolve({ error: 'Timed out' }); }, ms + 2000);
    w.on('message', (m) => { clearTimeout(t); w.terminate(); resolve(m); });
    w.on('error', (e) => { clearTimeout(t); resolve({ error: e.message }); });
  });
}

class AgentRuntime {
  constructor(app) { this.app = app; this.controllers = new Map(); this.steer = new Map(); }
  get store() { return this.app.store; }

  // ---------- profile & context
  assistantProfile(orgDb) {
    const s = orgDb.kv('assistant') || {};
    return { id: null, name: this.app.platformName(), title: 'Assistant', instructions: s.instructions || '', tools: s.tools || DEFAULT_ASSISTANT_TOOLS, folders: s.folders || [], mailboxes: s.mailboxes || [], mcp: s.mcp || [], autonomy: s.autonomy || 'ask_risky', confirm_payments: 1, max_steps: s.max_steps || 25, model_mode: 'auto', sensitivity: 'normal' };
  }
  profileFor(orgDb, agentId) {
    if (!agentId) return this.assistantProfile(orgDb);
    const a = orgDb.get('SELECT * FROM agents WHERE id=?', agentId); if (!a) throw new Error('Agent not found');
    return { ...a, tools: safeJSON(a.tools, ['files', 'documents', 'code', 'web', 'memory', 'agents']), folders: safeJSON(a.folders, []), mailboxes: safeJSON(a.mailboxes, []), mcp: safeJSON(a.mcp, []), autonomy: a.autonomy || 'ask_risky', max_steps: a.max_steps || 30 };
  }
  workspaceDir(orgDb, profile) { const d = path.join(orgDb.dir, 'workspaces', profile.id || 'assistant'); fs.mkdirSync(d, { recursive: true }); return d; }
  scope(orgDb, profile) {
    const roots = [{ id: 'workspace', name: 'Workspace', path: this.workspaceDir(orgDb, profile), mode: 'readwrite' }];
    const grants = this.store.all('SELECT * FROM folders WHERE org_id=?', orgDb.id);
    for (const f of profile.folders || []) {
      const g = grants.find((x) => x.id === (f.id || f)); if (!g || !fs.existsSync(g.path)) continue;
      const mode = g.mode === 'readwrite' && (f.mode || 'readwrite') === 'readwrite' ? 'readwrite' : 'read';
      roots.push({ id: g.id, name: g.name, path: g.path, mode });
    }
    return new FileScope(roots);
  }
  mailboxesFor(orgDb, profile) { const ids = profile.mailboxes || []; return ids.length ? orgDb.all('SELECT * FROM mailboxes').filter((m) => ids.includes(m.id)) : []; }
  mcpFor(orgDb, profile) { const ids = profile.mcp || []; return this.app.mcp.list(orgDb.id).filter((s) => ids.includes(s.id) && s.enabled); }

  // ---------- tools
  toolset(ctx) {
    const T = []; const caps = new Set(ctx.profile.tools || []); const A = this.app;
    const add = (cap, name, description, properties, required, run, risk) => { if (cap && !caps.has(cap)) return; T.push({ name, description, parameters: { type: 'object', properties, required: required || [] }, run, risk }); };
    const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
    // Approval is only asked for actions that are actually permitted; forbidden ones fail straight away.
    const inWs = (p, write) => { try { return ctx.scope.resolve(p, !!write).root.id === 'workspace'; } catch { return true; } };
    const fileOut = (abs, display) => ({ path: display, abs, name: path.basename(abs) });

    // files
    add('files', 'list_files', 'List files and folders. Use a folder name from your allowed folders, e.g. "Workspace" or "Workspace/reports".', { path: S }, [], async (a) => {
      const r = ctx.scope.resolve(a.path || 'Workspace', false);
      if (!fs.existsSync(r.abs)) return { content: 'Folder does not exist: ' + r.display };
      const items = fs.readdirSync(r.abs, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).slice(0, 300).map((e) => { let size = 0; try { size = e.isFile() ? fs.statSync(path.join(r.abs, e.name)).size : 0; } catch {} return `${e.isDirectory() ? '[folder]' : `[${size} bytes]`} ${r.display}/${e.name}`; });
      return { content: items.join('\n') || '(empty folder)' };
    });
    add('files', 'read_file', 'Read a file: text, PDF, Word, Excel, CSV, code, or an image (returned as an image).', { path: S, max_chars: N }, ['path'], async (a) => {
      const r = ctx.scope.resolve(a.path, false); const buf = fs.readFileSync(r.abs); const name = path.basename(r.abs);
      if (isImage('', name)) return { content: `Image ${r.display} (${buf.length} bytes)`, images: [{ mime: imageMime('', name), b64: buf.toString('base64') }] };
      const text = /\.xlsx$/i.test(name) ? await readXlsx(buf) : await extractText(buf, name, '');
      return { content: text === null ? `Cannot read ${name} as text (${buf.length} bytes).` : clip(text, a.max_chars || 30000) };
    });
    add('files', 'search_files', 'Find files by name or content inside allowed folders.', { query: S, path: S }, ['query'], async (a) => {
      const r = ctx.scope.resolve(a.path || 'Workspace', false); const q = String(a.query).toLowerCase(); const hits = []; let seen = 0;
      const walk = (dir, depth) => { if (depth > 6 || hits.length > 60 || seen > 4000) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; const f = path.join(dir, e.name); seen++;
        if (e.isDirectory()) walk(f, depth + 1); else { const rel = r.display + '/' + path.relative(r.abs, f).split(path.sep).join('/'); if (e.name.toLowerCase().includes(q)) hits.push(rel + '  (name)'); else if (/\.(txt|md|csv|json|html?|js|ts|py|css|xml|log)$/i.test(e.name) && fs.statSync(f).size < 2e6) { const t = fs.readFileSync(f, 'utf8'); const i = t.toLowerCase().indexOf(q); if (i >= 0) hits.push(`${rel}: …${t.slice(Math.max(0, i - 60), i + 80).replace(/\s+/g, ' ')}…`); } } } };
      if (fs.existsSync(r.abs)) walk(r.abs, 0);
      return { content: hits.join('\n') || 'No matches.' };
    });
    add('files', 'write_file', 'Create or overwrite a text file (code, notes, CSV, HTML…). Saves to your workspace unless a writable folder is given.', { path: S, content: S }, ['path', 'content'], async (a) => {
      const r = ctx.scope.resolve(a.path, true); fs.mkdirSync(path.dirname(r.abs), { recursive: true }); fs.writeFileSync(r.abs, String(a.content ?? ''));
      return { content: `Saved ${r.display}`, files: [fileOut(r.abs, r.display)] };
    }, (a) => (!inWs(a.path, true) ? `write to ${a.path}` : null));
    add('files', 'copy_file', 'Copy or move a file between allowed folders.', { from: S, to: S, move: B }, ['from', 'to'], async (a) => {
      const s = ctx.scope.resolve(a.from, !!a.move), d = ctx.scope.resolve(a.to, true); fs.mkdirSync(path.dirname(d.abs), { recursive: true });
      if (a.move) fs.renameSync(s.abs, d.abs); else fs.copyFileSync(s.abs, d.abs); return { content: `${a.move ? 'Moved' : 'Copied'} to ${d.display}`, files: [fileOut(d.abs, d.display)] };
    }, (a) => (!inWs(a.to, true) || (a.move && !inWs(a.from, true)) ? `${a.move ? 'move' : 'copy'} ${a.from} → ${a.to}` : null));
    add('files', 'delete_file', 'Delete a file.', { path: S }, ['path'], async (a) => { const r = ctx.scope.resolve(a.path, true); fs.rmSync(r.abs, { force: true }); return { content: 'Deleted ' + r.display }; }, (a) => { try { ctx.scope.resolve(a.path, true); return `delete ${a.path}`; } catch { return null; } });

    // documents
    add('documents', 'create_document', 'Create a file people can keep and share. format: docx (Word), pdf, pptx (PowerPoint: use slides), xlsx (Excel: use sheets, formulas start with =), html (web page), md, csv, txt. content is Markdown for docx/pdf/html/md.',
      { format: { type: 'string', enum: ['docx', 'pdf', 'pptx', 'xlsx', 'html', 'md', 'csv', 'txt'] }, filename: S, title: S, content: S, folder: S,
        slides: { type: 'array', items: { type: 'object', properties: { title: S, bullets: { type: 'array', items: S }, notes: S, table: { type: 'array', items: { type: 'array', items: S } } } } },
        sheets: { type: 'array', items: { type: 'object', properties: { name: S, rows: { type: 'array', items: { type: 'array', items: {} } } } } }, html: S }, ['format'], async (a) => {
        const dir = ctx.scope.resolve(a.folder || 'Workspace', true);
        const f = await createDocument(a, dir.abs, A.host);
        const disp = dir.display + '/' + f.name;
        return { content: `Created ${disp} (${f.size} bytes).`, files: [fileOut(f.abs, disp)] };
      }, (a) => (a.folder && !inWs(a.folder, true) ? `save a file into ${a.folder}` : null));
    add('documents', 'create_artifact', 'Make an interactive web page the user can open in their browser (and share, if permitted). Returns the URL. Use for mini-apps, dashboards, forms, or an interactive chart. The page is sandboxed and loads only its own code; include everything inline. The page gets a small window.forge object: forge.id, forge.send(toArtifactId, data), forge.broadcast(channel, data), forge.onMessage(fn), forge.save(key, value), forge.load(key).',
      { title: S, html: S, visibility: { type: 'string', enum: ['private', 'org', 'public'] }, bus: { type: 'boolean' } }, ['html'], async (a) => {
        if (!A.artifacts) return { content: 'Artifacts are not available right now.' };
        const art = A.artifacts.create(orgDb, { title: a.title || 'Artifact', html: String(a.html || ''), visibility: a.visibility || 'org', bus: a.bus !== false, author: ctx.actor, conv_id: ctx.convId });
        const base = (A.listenInfo && A.listenInfo.localUrl) || '';
        return { content: `Made the artifact “${art.title}”. Open it at ${base}/art/${art.id}${art.share_token ? ` (public share link: ${base}/art/s/${art.share_token})` : ''}.`, files: [], artifact: { id: art.id, title: art.title, url: `/art/${art.id}`, shareUrl: art.share_token ? `/art/s/${art.share_token}` : null, visibility: art.visibility } };
      });
    add('documents', 'create_chart', 'Make a chart image (bar, line or pie) and save it. It is shown to the user.', { type: { type: 'string', enum: ['bar', 'line', 'pie'] }, title: S, labels: { type: 'array', items: S }, series: { type: 'array', items: { type: 'object', properties: { name: S, values: { type: 'array', items: N } } } }, filename: S }, ['labels', 'series'], async (a) => {
      const dir = ctx.scope.resolve('Workspace', true); const base = String(a.filename || a.title || 'Chart').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.svg$/i, '');
      let name = base + '.svg', n = 2; while (fs.existsSync(path.join(dir.abs, name))) name = `${base} (${n++}).svg`;
      fs.writeFileSync(path.join(dir.abs, name), makeChartSvg(a)); return { content: `Chart saved as Workspace/${name}`, files: [fileOut(path.join(dir.abs, name), 'Workspace/' + name)] };
    });
    add('documents', 'convert_file', 'Convert a file to another format (e.g. PDF→Word, Word→PDF, Excel→CSV, CSV→Excel, any→Markdown/HTML).', { path: S, to: { type: 'string', enum: ['docx', 'pdf', 'html', 'md', 'txt', 'xlsx', 'csv'] } }, ['path', 'to'], async (a) => {
      const r = ctx.scope.resolve(a.path, false); const buf = fs.readFileSync(r.abs); const base = path.basename(r.abs).replace(/\.[^.]+$/, '');
      const dir = ctx.scope.resolve('Workspace', true);
      let args;
      if (['xlsx', 'csv'].includes(a.to)) {
        const rows = /\.xlsx$/i.test(r.abs) ? (await readXlsx(buf)).split('\n').filter((l) => !l.startsWith('# Sheet')).map((l) => l.split('\t')) : buf.toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
        args = { format: a.to, filename: base, sheets: [{ name: base.slice(0, 31), rows }] };
      } else {
        const text = /\.xlsx$/i.test(r.abs) ? await readXlsx(buf) : await extractText(buf, path.basename(r.abs), '');
        if (text === null) throw new Error('Cannot read that file type');
        args = { format: a.to, filename: base, content: text };
      }
      const f = await createDocument(args, dir.abs, A.host); return { content: `Converted to Workspace/${f.name}`, files: [fileOut(f.abs, 'Workspace/' + f.name)] };
    });

    // code
    add('code', 'run_javascript', 'Run JavaScript for calculations and data analysis in a safe sandbox (no internet, no disk). Use console.log to print. Put file paths in input_files to get their text in the `files` object, keyed by path.', { code: S, input_files: { type: 'array', items: S } }, ['code'], async (a) => {
      const inputs = {};
      for (const p of a.input_files || []) { const r = ctx.scope.resolve(p, false); const buf = fs.readFileSync(r.abs); inputs[p] = /\.xlsx$/i.test(p) ? await readXlsx(buf) : (await extractText(buf, path.basename(r.abs), '')) ?? buf.toString('utf8'); }
      const r = await runJs(String(a.code), inputs);
      return { content: clip([r.out && r.out.length ? r.out.join('\n') : '', r.result !== undefined && !(r.out && r.out.length) ? 'Result: ' + r.result : '', r.error ? 'Error: ' + r.error : ''].filter(Boolean).join('\n') || '(no output)', 15000) };
    });

    // shell (full computer access)
    add('shell', 'run_command', `Run a command on this computer (${process.platform === 'win32' ? 'Windows PowerShell' : 'macOS/Linux shell'}). Starts in your workspace. Use it to build apps, run npm/python/git/docker/supabase, etc. Up to 10 minutes.`, { command: S, folder: S, timeout_seconds: N }, ['command'], async (a, sig) => {
      const cwd = ctx.scope.resolve(a.folder || 'Workspace', false).abs;
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
      const argv = isWin ? ['-NoProfile', '-Command', a.command] : ['-lc', a.command];
      return new Promise((resolve) => {
        execFile(shell, argv, { cwd, timeout: Math.min(600, a.timeout_seconds || 180) * 1000, maxBuffer: 20 * 1024 * 1024, signal: sig, env: { ...process.env, FORGEAI_WORKSPACE: ctx.scope.workspace.real } }, (err, stdout, stderr) => {
          resolve({ content: clip(`${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}${err ? `\n[exit: ${err.code ?? err.signal ?? err.message}]` : '\n[exit: 0]'}`, 20000) });
        });
      });
    }, (a) => `run a command: ${String(a.command).slice(0, 300)}`);

    // sandbox (throwaway isolated machine — safe for untrusted/risky commands)
    if (caps.has('sandbox') && A.vms) {
      add(null, 'sandbox_run', 'Run a command inside a throwaway, isolated machine that is kept away from the real computer — use this for anything untrusted or risky (running code you downloaded, testing an unknown script). The machine and its files are deleted when this task ends. State is kept between calls within this task. It starts empty and has no network.', { command: S, timeout_seconds: N }, ['command'], async (a, sig) => {
        if (!ctx._sandbox) { const inst = A.vms.create({ name: `task ${String(ctx.taskId).slice(0, 10)}`, backend: 'auto' }); ctx._sandbox = inst.id; if (ctx.emit) ctx.emit({ type: 'progress', note: `Isolated sandbox ready (${inst.isolation})` }); }
        const r = await A.vms.exec(ctx._sandbox, String(a.command), { timeout: Math.min(600, a.timeout_seconds || 120) * 1000, signal: sig });
        return { content: clip(`${r.stdout || ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}\n[exit: ${r.code}]`, 20000) };
      });
      add(null, 'sandbox_info', 'Show what kind of isolation the sandbox uses on this computer (full virtual machine, container, namespace or confined process) and why.', {}, [], async () => {
        const c = A.vms.capabilities(); return { content: `${c.summary}\n\n` + c.backends.map((b) => `- ${b.tech}: ${b.available ? 'available' : 'not available'} — ${b.reason}`).join('\n') };
      });
    }

    // web
    add('web', 'web_search', 'Search the web. Returns titles, links and snippets. Then use fetch_url to read the best pages and cite them.', { query: S, count: N }, ['query'], async (a) => ({ content: await A.search(a.query, Math.min(10, a.count || 6)) }));
    add('web', 'fetch_url', 'Read a web page or online PDF as text.', { url: S }, ['url'], async (a, sig) => {
      if (!/^https?:\/\//.test(a.url || '')) throw new Error('URL must start with http(s)://');
      const res = await fetch(a.url, { headers: { 'user-agent': 'Mozilla/5.0 (ForgeAI research assistant)' }, redirect: 'follow', signal: sig || AbortSignal.timeout(20000) });
      const type = res.headers.get('content-type') || ''; const buf = Buffer.from(await res.arrayBuffer());
      if (/pdf/.test(type) || /\.pdf($|\?)/i.test(a.url)) return { content: clip(await extractText(buf, 'page.pdf', 'application/pdf'), 25000) };
      const html = buf.toString('utf8'); const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
      return { content: `Status ${res.status} · ${title.trim()}\n${res.url}\n\n` + clip(/html/.test(type) ? htmlToText(html) : html, 25000) };
    });

    // browser (desktop app)
    if (caps.has('browser') && A.host && A.host.browser) {
      const br = () => A.host.browser(ctx.browserKey);
      const actRisk = async (a, verb) => {
        let label = ''; try { label = await br().describe(a.ref); } catch {}
        const page = await br().info().catch(() => ({}));
        const hay = `${label} ${a.text || ''}`;
        if (PAY_RE.test(label)) return { reason: `${verb} “${label.slice(0, 80)}” on ${page.host || 'a website'} — this may spend money`, payment: true };
        if (ACT_RE.test(label) || (verb === 'type' && a.submit)) return `${verb} “${(label || hay).slice(0, 80)}” on ${page.host || 'a website'}`;
        return null;
      };
      add(null, 'browser_open', 'Open a website in your own browser (it keeps your logins).', { url: S }, ['url'], async (a) => ({ content: await br().open(a.url) }));
      add(null, 'browser_read', 'Read the current page: text plus a numbered list of links, buttons and fields you can use.', {}, [], async () => ({ content: await br().read() }));
      add(null, 'browser_click', 'Click an element by its number from browser_read.', { ref: N }, ['ref'], async (a) => ({ content: await br().click(a.ref) }), (a) => actRisk(a, 'click'));
      add(null, 'browser_type', 'Type into a field by its number. Set submit to press Enter afterwards.', { ref: N, text: S, submit: B }, ['ref', 'text'], async (a) => ({ content: await br().type(a.ref, a.text, a.submit) }), (a) => actRisk(a, 'type'));
      add(null, 'browser_press', 'Press a key (Enter, Tab, Escape, ArrowDown, PageDown…).', { key: S }, ['key'], async (a) => ({ content: await br().press(a.key) }));
      add(null, 'browser_scroll', 'Scroll the page up or down.', { direction: { type: 'string', enum: ['up', 'down'] } }, ['direction'], async (a) => ({ content: await br().scroll(a.direction) }));
      add(null, 'browser_back', 'Go back to the previous page.', {}, [], async () => ({ content: await br().back() }));
      add(null, 'browser_screenshot', 'See the page as an image (use when the page layout matters).', {}, [], async () => { const img = await br().screenshot(); return { content: 'Screenshot of the current page.', images: [img] }; });
      add(null, 'browser_download', 'Save the current page as a PDF in your workspace.', { filename: S }, [], async (a) => {
        const dir = ctx.scope.resolve('Workspace', true); const name = String(a.filename || 'Page').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '') + '.pdf';
        fs.writeFileSync(path.join(dir.abs, name), await br().pdf()); return { content: 'Saved Workspace/' + name, files: [fileOut(path.join(dir.abs, name), 'Workspace/' + name)] };
      });
    }

    // email
    if (caps.has('email') && ctx.mailboxes.length) {
      const pick = (id) => { const m = !id ? ctx.mailboxes[0] : ctx.mailboxes.find((x) => x.id === id || x.email.toLowerCase() === String(id).toLowerCase() || (x.name || '').toLowerCase() === String(id).toLowerCase()); if (!m) throw new Error('Mailbox not assigned to this agent: ' + id); return m; };
      const mbList = ctx.mailboxes.map((m) => m.email).join(', ');
      add(null, 'email_list', `List emails. Mailboxes: ${mbList}.`, { mailbox: S, folder: S, unread_only: B, limit: N, query: S }, [], async (a) => {
        const rows = await A.mail.list(pick(a.mailbox), { folder: a.folder || 'INBOX', unreadOnly: !!a.unread_only, limit: a.limit || 20, query: a.query || '' });
        return { content: rows.map((r) => `#${r.uid} ${r.unread ? '[unread] ' : ''}${new Date(r.date).toISOString().slice(0, 16).replace('T', ' ')} · ${r.from} · ${r.subject}`).join('\n') || 'No emails.' };
      });
      add(null, 'email_read', 'Open an email by its number (#uid). Attachments are saved to your workspace.', { mailbox: S, uid: N, folder: S }, ['uid'], async (a) => {
        const m = await A.mail.read(pick(a.mailbox), a.uid, a.folder || 'INBOX'); const files = [];
        if (m.attachments.length) { const dir = ctx.scope.resolve('Workspace', true); const sub = path.join(dir.abs, 'Email attachments'); fs.mkdirSync(sub, { recursive: true });
          for (const at of m.attachments.slice(0, 10)) { const nm = String(at.filename || 'attachment').replace(/[\\/:*?"<>|]+/g, '-'); fs.writeFileSync(path.join(sub, nm), at.content); files.push(fileOut(path.join(sub, nm), 'Workspace/Email attachments/' + nm)); } }
        return { content: `From: ${m.from}\nTo: ${m.to}${m.cc ? '\nCc: ' + m.cc : ''}\nDate: ${m.date}\nSubject: ${m.subject}\n${files.length ? 'Attachments saved: ' + files.map((f) => f.path).join(', ') + '\n' : ''}\n${m.text}`, files };
      });
      add(null, 'email_send', 'Send a new email. Attachments are file paths from allowed folders.', { mailbox: S, to: S, cc: S, subject: S, body: S, attachments: { type: 'array', items: S } }, ['to', 'subject', 'body'], async (a) => {
        const atts = (a.attachments || []).map((p) => { const r = ctx.scope.resolve(p, false); return { filename: path.basename(r.abs), path: r.abs }; });
        const mb = pick(a.mailbox); const r = await A.mail.send(mb, { to: a.to, cc: a.cc, subject: a.subject, text: a.body + (mb.signature ? '\n\n' + mb.signature : ''), attachments: atts }); return { content: `Sent to ${(r.accepted || []).join(', ') || a.to}.` };
      }, (a) => `send an email to ${a.to} — “${String(a.subject || '').slice(0, 80)}”`);
      add(null, 'email_reply', 'Reply to an email by its number.', { mailbox: S, uid: N, body: S, reply_all: B }, ['uid', 'body'], async (a) => {
        const mb = pick(a.mailbox); const m = await A.mail.read(mb, a.uid);
        const to = a.reply_all ? [m.from, m.cc].filter(Boolean).join(', ') : m.from;
        await A.mail.send(mb, { to, subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), text: `${a.body}${mb.signature ? '\n\n' + mb.signature : ''}\n\nOn ${m.date}, ${m.from} wrote:\n${String(m.text).split('\n').map((l) => '> ' + l).join('\n').slice(0, 20000)}`, inReplyTo: m.messageId, references: m.references || m.messageId });
        return { content: 'Reply sent to ' + to };
      }, (a) => `reply to email #${a.uid}`);
      add(null, 'email_move', 'Move an email to another folder (e.g. Archive, Trash).', { mailbox: S, uid: N, to_folder: S }, ['uid', 'to_folder'], async (a) => { await A.mail.move(pick(a.mailbox), a.uid, a.to_folder); return { content: 'Moved to ' + a.to_folder }; }, (a) => (/trash|delete|bin/i.test(a.to_folder) ? `move email #${a.uid} to ${a.to_folder}` : null));
    }

    // scheduling & notifications
    add('schedule', 'schedule_task', 'Schedule work or a reminder for later. repeat: once, hourly, daily, weekdays, weekly. The result is posted to the user and notified.', { title: S, instruction: S, when: S, repeat: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly'] } }, ['title', 'instruction', 'when'], async (a) => {
      const at = whenToDate(a.when); const id = uid('job_');
      ctx.orgDb.run('INSERT INTO jobs(id,title,instruction,agent_id,repeat,next_run,enabled,conv_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, a.title, a.instruction, ctx.profile.id || null, JSON.stringify({ type: a.repeat || 'once' }), at.toISOString(), 1, ctx.convId || null, ctx.actor, now());
      return { content: `Scheduled “${a.title}” for ${at.toLocaleString()}${a.repeat && a.repeat !== 'once' ? ', repeating ' + a.repeat : ''} (id ${id}).` };
    });
    add('schedule', 'list_scheduled', 'List scheduled tasks and reminders.', {}, [], async () => ({ content: ctx.orgDb.all('SELECT * FROM jobs WHERE enabled=1 ORDER BY next_run').map((j) => `${j.id} · ${j.title} · next ${j.next_run} · ${safeJSON(j.repeat, {}).type}`).join('\n') || 'Nothing scheduled.' }));
    add('schedule', 'cancel_scheduled', 'Cancel a scheduled task by id.', { id: S }, ['id'], async (a) => { ctx.orgDb.run('UPDATE jobs SET enabled=0 WHERE id=?', a.id); return { content: 'Cancelled ' + a.id }; });
    add('schedule', 'notify_user', 'Send the user a notification.', { title: S, message: S }, ['message'], async (a) => { A.notify(ctx.orgDb, a.title || ctx.profile.name, a.message, ctx.link); return { content: 'Notified.' }; });

    add('memory', 'remember', 'Save a lasting fact for this organisation (everyone’s chats and agents will know it).', { fact: S }, ['fact'], async (a) => { ctx.orgDb.run('INSERT INTO memory(id,content,source,created_at) VALUES(?,?,?,?)', uid('mem_'), String(a.fact).slice(0, 2000), ctx.profile.name, now()); return { content: 'Remembered.' }; });

    // Infrastructure Auto-Pilot: run the ForgeAI fleet in plain language. Every change is checked against the person who asked.
    if (caps.has('infra') && A.infra) {
      const infra = A.infra;
      // The human who set this task running — used only for permission. Agents never get more power than the person behind them.
      const actor = (() => { try { return A.store.get('SELECT * FROM users WHERE lower(username)=lower(?)', String(ctx.actor || '')); } catch { return null; } })();
      const denyMsg = (what) => `You don't have permission to ${what}. Ask a ForgeAI administrator${what.includes('restart') || what.includes('load') ? ', or the owner of that computer,' : ''} to do it or to give you access.`;
      add('infra', 'infra_status', 'See every ForgeAI computer and cluster: whether it is online and free, its spare memory and CPU, which models it holds and has loaded, and how fast its link is. Use this before moving models or diagnosing problems.', {}, [], async () => {
        const list = infra.list(); return { content: list.length ? JSON.stringify(list, null, 1) : 'No ForgeAI computers are set up yet.' };
      });
      add('infra', 'infra_diagnose', 'Work out why things are slow or failing across the computers: checks for offline computers, low memory, busy CPUs, models set aside after failures, and slow links (it measures link speed live). Give a computer name to focus on one, or leave empty for all.', { computer: S }, [], async (a) => {
        const r = await infra.diagnose({ node: a.computer || null });
        return { content: (r.findings.length ? 'Problems found:\n- ' + r.findings.join('\n- ') : 'No problems found — everything looks healthy.') + (r.facts.length ? '\n\nReadings:\n- ' + r.facts.join('\n- ') : '') };
      });
      add('infra', 'infra_find_computers', 'Look on the local network for other ForgeAI computers that are running but not added yet. Returns what it finds; it does not add anything.', {}, [], async () => {
        if (!infra.isAdmin(actor)) return { content: denyMsg('scan the network for computers') };
        const found = await infra.findComputers();
        return { content: found.length ? JSON.stringify(found, null, 1) : 'No other ForgeAI computers answered on this network. They may be on a different network — add those with a join string (infra_add_computer).' };
      });
      add('infra', 'infra_add_computer', 'Get what a NEW computer needs to join this hub: a one-time join string and the single command to run on that computer (Mac, Windows or Linux). Set background to true for a hidden background-service install. This does not reach out to any computer — it hands you the join details to use on the new one.', { label: S, background: B }, [], async (a) => {
        if (!infra.isOwner(actor)) return { content: denyMsg('add a computer to the fleet (owner only)') };
        try { const r = infra.addComputer({ label: a.label, service: !!a.background });
          return { content: `A computer can join with this join string:\n\n${r.join}\n\nOr run this on the new computer:\n• Mac: ${r.run_on_new_computer.mac}\n• Windows: ${r.run_on_new_computer.windows}\n• Linux: ${r.run_on_new_computer.linux}\n\n${r.note}` }; }
        catch (e) { return { content: e.message }; }
      });
      add('infra', 'infra_model', 'Move a model on a computer: op = "load" (make it ready), "unload" (free memory), "download" (fetch from Hugging Face onto that computer — give repo and files), "remove" (delete it), or "status". Loading/unloading needs manage access to that computer; downloading, removing and installing need to be the owner.', { computer: S, op: { type: 'string', enum: ['load', 'unload', 'download', 'remove', 'status'] }, model_id: S, repo: S, files: { type: 'array', items: S } }, ['computer', 'op'], async (a) => {
        const n = infra.nodeByName(a.computer); if (!n) return { content: 'No such computer: ' + a.computer + '. Use infra_status to see the names.' };
        if (['download', 'remove'].includes(a.op) && !infra.isOwner(actor)) return { content: denyMsg(`${a.op} a model on ${a.computer} (owner only)`) };
        if (['load', 'unload'].includes(a.op) && !infra.canManage(actor, n)) return { content: denyMsg(`load or unload models on ${a.computer}`) };
        if (a.op === 'status' && !infra.canManage(actor, n) && !infra.isAdmin(actor)) return { content: denyMsg(`see model details on ${a.computer}`) };
        try { const r = await infra.moveModel({ node: a.computer, op: a.op, id: a.model_id, repo: a.repo, files: a.files }); return { content: `Done (${a.op} on ${n.is_local ? 'this computer' : n.name}): ${JSON.stringify(r).slice(0, 1500)}` }; }
        catch (e) { return { content: 'Could not ' + a.op + ': ' + e.message }; }
      }, (a) => (['download', 'remove'].includes(a.op) ? `${a.op} model ${a.model_id || a.repo || ''} on ${a.computer}` : null));
      add('infra', 'infra_restart', 'Restart the ForgeAI service on another computer (not the hub itself). Needs manage access to that computer.', { computer: S }, ['computer'], async (a) => {
        const n = infra.nodeByName(a.computer); if (!n) return { content: 'No such computer: ' + a.computer };
        if (!infra.canManage(actor, n)) return { content: denyMsg(`restart ${a.computer}`) };
        try { const r = await infra.restart({ node: a.computer }); return { content: `Restarted ${r.name}.` }; }
        catch (e) { return { content: e.message }; }
      }, (a) => `restart ForgeAI on ${a.computer}`);
    }

    if (caps.has('agents')) {
      const cols = ctx.profile.id ? A.engine.colleaguesFor(ctx.orgDb, ctx.profile) : ctx.orgDb.all('SELECT id,name,description FROM agents WHERE enabled=1').map((x) => ({ ...x, orgId: ctx.orgDb.id, orgName: ctx.orgDb.org.name }));
    // Choose where this work runs — any ForgeAI computer, this computer, or a cluster — and switch mid-task.
    add(null, 'list_computers', 'List the computers and clusters this work can run on: whether each is online, free to use (computers can be lent only when idle, and step back when their owner needs them), free memory, and which models it has. Use before use_computer.', {}, [], async () => {
      const C = A.cluster; const out = [];
      for (const n of C.nodes()) { if (!n.enabled) continue; const st = C.state.get(n.id) || {}; const mt = n.is_local ? (A.models.perf && A.models.perf.machine) : C.metrics.get(n.id); const av = n.is_local ? (A.priority && A.priority.state.yielding ? { available: false, reason: A.priority.state.reason } : { available: true }) : (mt && mt.availability) || null;
        out.push({ name: n.is_local ? 'This computer' : n.name, where: n.is_local ? 'local' : n.name, kind: /\(cluster\)$/.test(n.name) ? 'cluster' : n.kind, online: !!n.is_local || st.status === 'online', available: av ? av.available !== false : true, why_not: av && av.available === false ? av.reason : null, free_memory_gb: mt && mt.memFree ? +(mt.memFree / 2 ** 30).toFixed(1) : null, models: (st.models || []).map((m) => m.id).slice(0, 20) }); }
      return { content: JSON.stringify({ current: (ctx.st && ctx.st.where) || 'auto', places: out }, null, 1) };
    });
    add(null, 'use_computer', 'Move this task to run on a different computer or cluster from now on (where = "auto", "local", "cluster" or a computer name from list_computers). Say why. The conversation so far is kept.', { where: S, reason: S }, ['where'], async (a) => {
      const where = String(a.where || 'auto'); const d = A.models.decide({ orgDb: ctx.orgDb, mode: 'auto', text: (ctx.st.messages.find((m) => m.role === 'user') || {}).content || '', needTools: true, where: where === 'auto' ? null : where });
      if (d.blocked) return { content: `Could not move to ${where}: ${d.reasons[d.reasons.length - 1]}${(d.whyNot || []).length ? ' Why the models there were not used: ' + d.whyNot.slice(0, 4).map((w) => typeof w === 'string' ? w : `${w.name}: ${w.why}`).join('; ') : ''}. Still running on ${ctx.st.decision.label}.` };
      ctx.st.decision = d; ctx.st.where = where === 'auto' ? null : where;
      if (ctx.emit) ctx.emit({ type: 'route', label: d.label, reasons: [...d.reasons, `Moved by the agent${a.reason ? ': ' + a.reason : ''}`] });
      return { content: `Now running on ${d.label}${a.reason ? ' (' + a.reason + ')' : ''}.` };
    });
      if (cols.length && ctx.depth < 2) add(null, 'ask_agent', 'Give a task to another agent and get its answer. Agents: ' + cols.map((c) => `${c.name}${c.orgName !== ctx.orgDb.org.name ? ' (' + c.orgName + ')' : ''}: ${c.description || ''}`).join('; '), { agent: S, request: S }, ['agent', 'request'], async (a, sig) => {
        const c = cols.find((x) => x.name.toLowerCase() === String(a.agent).toLowerCase()) || cols.find((x) => x.name.toLowerCase().includes(String(a.agent).toLowerCase().replace(/\s+agent$/, '')));
        if (!c) return { content: 'No such agent: ' + a.agent };
        const tdb = c.orgId === ctx.orgDb.id ? ctx.orgDb : A.store.openOrg(c.orgId);
        const t = A.engine.createTask(tdb, { agentId: c.id, title: `From ${ctx.profile.name}: ${String(a.request).slice(0, 60)}`, input: a.request, createdBy: ctx.profile.name, parentTask: ctx.taskId });
        const r = await this.run(tdb, t.id, { depth: ctx.depth + 1, signal: sig });
        return { content: r.paused ? `${c.name} is waiting for a human approval; its answer will come later.` : r.text || '(no answer)' };
      });

      // Split one job into independent pieces and run them at the same time on different computers, then gather the results.
      if (ctx.depth < 1) add(null, 'distribute', 'Split independent pieces of work and run them in parallel, each on its own computer, then collect every result. Use this when a job has several parts that do not depend on each other (e.g. summarise ten documents, research five topics, process many files) — it is much faster than doing them one after another. Each piece runs as a fresh helper with the same tools and folders as you; they do not share a conversation, so make every piece self-contained. Leave "where" empty to let ForgeAI spread the pieces across the free computers it finds; set it to a computer name from list_computers to pin a piece.', {
        tasks: { type: 'array', items: { type: 'object', properties: { request: S, where: S }, required: ['request'] }, description: 'The independent pieces. Each: {request: a full self-contained instruction, where?: a computer name or "auto"}.' },
      }, ['tasks'], async (a, sig) => {
        const list = Array.isArray(a.tasks) ? a.tasks.filter((t) => t && t.request).slice(0, 12) : [];
        if (list.length < 2) return { content: 'distribute needs at least two independent pieces. For a single piece just do it yourself, or use use_computer to move the whole task.' };
        // Find the computers we may spread work onto: online, available (idle-lending aware), excluding ones that are explicitly unavailable.
        const C = A.cluster; const pool = [];
        for (const n of C.nodes()) { if (!n.enabled) continue; const st = C.state.get(n.id) || {}; const online = !!n.is_local || st.status === 'online'; if (!online) continue;
          const av = n.is_local ? (A.priority && A.priority.state.yielding ? false : true) : (() => { const mt = C.metrics.get(n.id); return !(mt && mt.availability && mt.availability.available === false); })();
          if (!av) continue; pool.push(n.is_local ? 'local' : n.name); }
        if (!pool.length) pool.push('local');
        // Assign a computer to each piece: honour an explicit "where", else round-robin across the free pool.
        let rr = 0; const assigned = list.map((t) => { const w = t.where && t.where !== 'auto' ? t.where : pool[rr++ % pool.length]; return { request: String(t.request), where: w }; });
        const started = assigned.map((t) => t.where).join(', ');
        if (ctx.emit) ctx.emit({ type: 'progress', note: `Distributing ${list.length} pieces across: ${started}` });
        const results = await Promise.all(assigned.map(async (t, i) => {
          const sub = A.engine.createTask(ctx.orgDb, { agentId: ctx.profile.id || null, title: `Piece ${i + 1}: ${t.request.slice(0, 50)}`, input: t.request, createdBy: `${ctx.profile.name} (distribute)`, parentTask: ctx.taskId });
          try { const r = await this.run(ctx.orgDb, sub.id, { depth: ctx.depth + 1, signal: sig, place: t.where }); return { i, where: t.where, request: t.request, ok: !r.paused, text: r.paused ? '(this piece paused for a human approval; it could not finish on its own)' : (r.text || '(no answer)'), ran_on: (r.node || r.endpoint || t.where) }; }
          catch (e) { return { i, where: t.where, request: t.request, ok: false, text: 'Failed: ' + (e && e.message || e) }; }
        }));
        const done = results.filter((r) => r.ok).length;
        const body = results.map((r) => `### Piece ${r.i + 1} — ran on ${r.ran_on || r.where}\nTask: ${r.request}\n\n${r.text}`).join('\n\n');
        return { content: `${done} of ${results.length} pieces finished. Combine these into one answer for the user:\n\n${body}` };
      });
    }

    // connectors (MCP)
    for (const srv of ctx.mcp) {
      const slug = A.mcp.slug(srv);
      for (const t of A.mcp.tools(srv.id)) {
        const nm = (slug + '__' + t.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const ro = t.annotations && (t.annotations.readOnlyHint === true);
        T.push({ name: nm, description: `[${srv.name}] ${t.description || t.name}`.slice(0, 1000), parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
          run: async (a, sig) => A.mcp.call(srv.id, t.name, a, sig), risk: ro ? null : () => `use ${srv.name}: ${t.title || t.name}` });
      }
    }
    return T;
  }

  systemPrompt(ctx, tools) {
    const org = ctx.orgDb.org; const p = ctx.profile;
    const mem = ctx.orgDb.all('SELECT content FROM memory ORDER BY created_at DESC LIMIT 40').map((m) => '- ' + m.content);
    const names = new Set(tools.map((t) => t.name));
    const parts = [
      p.id ? `You are ${p.name}${p.title ? ', ' + p.title : ''}, an AI agent working for ${org.name}.` : `You are ${p.name}, the AI assistant for ${org.name}.`,
      `Current date and time: ${new Date().toString()}. Computer: ${os.platform() === 'darwin' ? 'Mac' : os.platform() === 'win32' ? 'Windows PC' : os.platform()}.`,
      'Be accurate, practical and concise. You can answer and explain, give advice, brainstorm, research, write in any tone, work with files, analyse data, code and take actions with your tools. Use tools whenever they help; never pretend to have done something you did not do. If a tool fails, try another approach or explain what is needed.',
      `You only have access to ${org.name}'s information. Never reveal passwords or keys.`,
    ];
    if (p.description) parts.push('Your role: ' + p.description);
    if (p.instructions) parts.push('Instructions from your owner:\n' + p.instructions);
    if (ctx.project && ctx.project.instructions) parts.push('Project instructions:\n' + ctx.project.instructions);
    if (mem.length) parts.push('Things to remember about ' + org.name + ':\n' + mem.join('\n'));
    if (names.has('list_files') || names.has('create_document')) parts.push('Folders you may use:\n' + ctx.scope.describe() + '\nRefer to files as "Folder/path/file.ext". Deliverables (documents, decks, spreadsheets, PDFs, pages) must be saved with create_document so the user can open and download them.');
    if (names.has('web_search')) parts.push('For research: search, read the best sources with fetch_url, then answer with a short "Sources" list of the links you used.');
    if (ctx.mailboxes.length && names.has('email_list')) parts.push('Your email addresses: ' + ctx.mailboxes.map((m) => `${m.name ? m.name + ' ' : ''}<${m.email}>`).join(', '));
    if (names.has('browser_open')) parts.push('Your browser keeps its own logins. Work step by step: open, read, then click/type using element numbers. If a site needs a login, a CAPTCHA or a code you do not have, stop and ask the user to sign in to your browser (ForgeAI → your agent → Browser). Never try to get around security checks.');
    if (names.has('distribute')) parts.push('When a job has several independent pieces (e.g. summarise many documents, research several topics, process many files), use distribute to run them at the same time on different computers and then combine the results — it is far faster than one at a time. Keep each piece self-contained.');
    if (names.has('infra_status')) parts.push('You are also the Infrastructure Auto-Pilot for this ForgeAI fleet. To answer questions or act on the computers, start with infra_status (and infra_diagnose when something is slow or failing), then use infra_find_computers, infra_add_computer, infra_model and infra_restart. Any change checks the permission of the person who asked; if it is refused, tell them plainly and say who can do it. Explain what you changed in plain language.');
    parts.push('Formatting: use Markdown. For a chart the user should see inline, reply with a ```chart code block containing JSON {"type":"bar|line|pie","title":"","labels":[],"series":[{"name":"","values":[]}]}. For diagrams use a ```mermaid code block. For an interactive mini web page use a ```html code block (self-contained).');
    if (p.autonomy !== 'full') parts.push('Some actions (sending, posting, buying, deleting, running commands, changing files outside your workspace) wait for a human approval automatically — just call the tool normally.');
    return parts.join('\n\n');
  }

  async needsApproval(ctx, tool, args) {
    if (!tool.risk) return ctx.profile.autonomy === 'ask_all' && !/^(list_|read_|search_|browser_read|browser_screenshot|browser_scroll|web_search|fetch_url|email_list|email_read|list_scheduled|run_javascript|remember)/.test(tool.name) ? { reason: `use ${tool.name}` } : null;
    let r = await tool.risk(args, ctx); if (!r) return null;
    if (typeof r === 'string') r = { reason: r };
    if (r.payment && ctx.profile.confirm_payments !== 0) return r;
    if (ctx.profile.autonomy === 'full') return null;
    return r;
  }

  // ---------- the loop
  async run(orgDb, taskId, { onEvent, signal, depth = 0, resume, place } = {}) {
    const task = orgDb.get('SELECT * FROM tasks WHERE id=?', taskId);
    const profile = this.profileFor(orgDb, task.agent_id);
    const ctl = new AbortController(); this.controllers.set(taskId, ctl);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    const ctx = { app: this.app, orgDb, profile, taskId, depth, convId: task.conv_id, actor: task.created_by, browserKey: `${orgDb.id}:${profile.id || 'assistant'}`,
      scope: this.scope(orgDb, profile), mailboxes: this.mailboxesFor(orgDb, profile), mcp: this.mcpFor(orgDb, profile), link: task.conv_id ? `#/chat/${task.conv_id}` : profile.id ? `#/agent/${profile.id}` : '#/tasks' };
    if (task.conv_id) { const c = orgDb.get('SELECT project_id FROM conversations WHERE id=?', task.conv_id); if (c && c.project_id) ctx.project = orgDb.get('SELECT * FROM projects WHERE id=?', c.project_id); }
    const tools = this.toolset(ctx);
    const emit = (e) => { try { onEvent && onEvent(e); } catch {} };
    const step = (kind, tool, args, content, files) => {
      const r = orgDb.run('INSERT INTO steps(task_id,kind,tool,args,content,files,created_at) VALUES(?,?,?,?,?,?,?)', taskId, kind, tool || null, args ? JSON.stringify(args).slice(0, 20000) : null, content == null ? null : String(content).slice(0, 20000), files ? JSON.stringify(files.map((f) => ({ path: f.path, name: f.name }))) : null, now());
      const s = { id: Number(r.lastInsertRowid), kind, tool, args, content: content == null ? null : String(content).slice(0, 4000), files: files ? files.map((f) => ({ path: f.path, name: f.name })) : null };
      emit({ type: 'step', step: s }); return s;
    };
    const setCur = (txt) => orgDb.run('UPDATE tasks SET current=? WHERE id=?', txt, taskId);
    let st = resume ? safeJSON(task.state, null) : null;
    const allFiles = [];
    try {
      if (!st) {
        if (profile.id && task.kind !== 'chat') {
          const ag = orgDb.get('SELECT runs_per_day, budget_month FROM agents WHERE id=?', profile.id) || {};
          if (ag.runs_per_day > 0) { const d0 = new Date(); d0.setHours(0, 0, 0, 0); const n = orgDb.get("SELECT COUNT(*) c FROM tasks WHERE agent_id=? AND started_at>=? AND id<>?", profile.id, d0.toISOString(), taskId).c; if (n >= ag.runs_per_day) throw new Error(`${profile.name} has reached its limit of ${ag.runs_per_day} tasks today (agent settings → Limits).`); }
          if (ag.budget_month > 0 && orgDb.agentMonthSpend(profile.id) >= ag.budget_month) throw new Error(`${profile.name} has used its $${ag.budget_month} monthly budget (agent settings → Limits).`);
        }
        const agentPick = String(profile.model_mode || 'auto');
        // A distributed sub-task carries an explicit `place` (which computer to run on); otherwise fall back to the chat route / agent's home computer.
        const wantWhere = place != null ? (place === 'auto' ? null : place) : (task.kind === 'chat' ? safeJSON(task.route, {}).where : (profile.place || null));
        const decision = this.app.models.decide({ orgDb, mode: task.kind === 'chat' ? (task.route ? safeJSON(task.route, {}).mode : 'auto') : /^(profile|local|cloud):/.test(agentPick) ? 'other' : agentPick, model: task.kind === 'chat' ? safeJSON(task.route, {}).model : /^(profile|local|cloud):/.test(agentPick) ? agentPick : null, sensitivity: task.kind === 'chat' ? safeJSON(task.route, {}).sensitivity : profile.sensitivity, web: false, text: task.input, needTools: true, needVision: !!(task.kind === 'chat' && safeJSON(task.route, {}).vision), where: wantWhere });
        if (decision.blocked) throw new Error(decision.reasons[decision.reasons.length - 1]);
        const history = task.kind === 'chat' ? safeJSON(task.route, {}).history || [] : [];
        st = { where: wantWhere || null, decision, messages: [...history, { role: 'user', content: task.input, images: task.kind === 'chat' ? safeJSON(task.route, {}).images || [] : [] }], steps: 0, pending: [] };
        orgDb.run('UPDATE tasks SET status=?, started_at=? WHERE id=?', 'running', now(), taskId);
        emit({ type: 'route', label: decision.label, reasons: decision.reasons });
      } else {
        orgDb.run('UPDATE tasks SET status=? WHERE id=?', 'running', taskId);
        // Apply the human decision to the call that was waiting.
        const [call, ...rest] = st.pending; const approved = resume.approve;
        if (call) {
          if (approved) { st.pending = rest; await this.exec(ctx, tools, call, st, step, allFiles, ctl.signal, setCur); }
          else { st.pending = rest; st.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: `The user declined this action${resume.note ? ': ' + resume.note : ''}. Do not try it again; continue without it or explain.` }); step('declined', call.name, call.args, 'Declined by ' + resume.by); }
        }
      }
      ctx.st = st; ctx.emit = emit;
      const system = this.systemPrompt(ctx, tools);
      const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      for (;;) {
        // Remaining calls from the same model turn.
        while (st.pending.length) {
          const call = st.pending[0]; const tool = tools.find((t) => t.name === call.name);
          const need = tool ? await this.needsApproval(ctx, tool, call.args) : null;
          if (need) return this.pause(ctx, st, call, need, step, emit);
          st.pending.shift();
          await this.exec(ctx, tools, call, st, step, allFiles, ctl.signal, setCur);
        }
        if (ctl.signal.aborted) throw new Error('Stopped');
        if (st.steps >= (profile.max_steps || 30)) { st.messages.push({ role: 'user', content: 'Step limit reached. Give your best final answer now without tools.' }); }
        // Notes the user typed while this was running are added before the next model turn.
        const notes = this.steer.get(taskId) || []; this.steer.delete(taskId);
        for (const n of notes) { st.messages.push({ role: 'user', content: `Added by the user while you were working: ${n}` }); step('note', null, null, n); }
        setCur('Thinking…');
        const msgs = this.compact(st.messages, st.decision.kind === 'local' ? 14000 : 90000);
        let thinking = '';
        const r = await this.app.models.runTools(st.decision, { orgDb, system, messages: msgs, tools: st.steps >= (profile.max_steps || 30) ? [] : toolDefs, signal: ctl.signal, agentId: profile.id, kind: task.kind === 'chat' ? 'chat' : 'agent', onThinking: (t) => { thinking += t; }, onProgress: (pg) => emit({ type: 'progress', ...pg }), onFallback: (f) => { emit({ type: 'fallback', ...f }); step('note', null, null, `${f.from} failed (${f.reason}). Continuing with ${f.to}.`); }, text: (msgs[msgs.length - 1] || {}).content || '', needVision: !!(msgs[msgs.length - 1] && msgs[msgs.length - 1].images && msgs[msgs.length - 1].images.length) });
        if (thinking.trim()) { emit({ type: 'thinking', text: thinking }); }
        emit({ type: 'stats', model: r.model, endpoint: r.endpointLabel, scope: r.scope, stats: r.stats, step: st.steps + 1 });
        st.steps++;
        st.model = r.model; st.endpoint = r.endpointLabel; st.scope = r.scope;
        const calls = r.toolCalls || [];
        st.messages.push({ role: 'assistant', content: r.text || '', toolCalls: calls, raw: r.raw });
        if (!calls.length && (this.steer.get(taskId) || []).length) continue; // the user added something while it was answering — take it into account
        if (!calls.length) {
          const text = r.text || '(no answer)';
          orgDb.run('UPDATE tasks SET status=?, output=?, finished_at=?, model_used=?, state=NULL, current=NULL WHERE id=?', profile.requires_approval ? 'awaiting_approval' : 'done', text, now(), `${r.model}${r.node ? ' @ ' + r.node : ''}`, taskId);
          if (profile.id) orgDb.run('UPDATE agents SET last_run=? WHERE id=?', now(), profile.id);
          if (profile.requires_approval) this.app.engine.createApproval(orgDb, { kind: 'agent_output', title: `${profile.name}: ${task.title}`, detail: text.slice(0, 2000), requestedBy: profile.name, payload: { type: 'agent_output', taskId } });
          const files = this.taskFiles(orgDb, taskId);
          emit({ type: 'final', text, files, model: r.model, node: r.node });
          this.controllers.delete(taskId); this.cleanupSandbox(ctx);
          return { text, files, model: r.model, node: r.node, endpoint: r.endpointLabel, scope: r.scope, stats: r.stats, stop: r.stop };
        }
        if (r.text) step('thought', null, null, r.text);
        st.pending = calls.map((c) => ({ id: c.id || uid('call_'), name: c.name, args: c.args || {} }));
        st.messages[st.messages.length - 1].toolCalls = st.pending;
      }
    } catch (e) {
      this.controllers.delete(taskId); this.cleanupSandbox(ctx);
      const msg = ctl.signal.aborted ? 'Stopped by user' : e.message;
      orgDb.run('UPDATE tasks SET status=?, error=?, finished_at=?, state=NULL, current=NULL WHERE id=?', 'failed', msg, now(), taskId);
      step('error', null, null, msg);
      emit({ type: 'error', message: msg });
      return { error: msg };
    }
  }
  cleanupSandbox(ctx) { if (ctx && ctx._sandbox && this.app.vms) { try { this.app.vms.destroy(ctx._sandbox); } catch {} ctx._sandbox = null; } }
  describeCall(c) { const a = c.args || {}; return ({ browser_open: `Opening ${a.url}`, browser_read: 'Reading the page', browser_click: `Clicking #${a.ref}`, browser_type: 'Typing', web_search: `Searching “${a.query}”`, fetch_url: `Reading ${a.url}`, create_document: `Creating ${a.filename || a.title || 'a document'}.${a.format}`, read_file: `Reading ${a.path}`, email_list: 'Checking email', email_read: 'Reading an email', email_send: `Emailing ${a.to}`, run_command: 'Running a command', run_javascript: 'Calculating' }[c.name]) || `Using ${c.name.replace(/__/, ': ').replace(/_/g, ' ')}`; }
  async exec(ctx, tools, call, st, step, allFiles, signal, setCur) {
    const tool = tools.find((t) => t.name === call.name);
    setCur(this.describeCall(call));
    step('call', call.name, call.args, this.describeCall(call));
    let res;
    try {
      if (!tool) throw new Error('Unknown tool ' + call.name);
      res = await tool.run(call.args || {}, signal);
    } catch (e) { res = { content: 'Error: ' + e.message }; }
    const files = res.files || [];
    allFiles.push(...files);
    step('result', call.name, null, String(res.content || '').slice(0, 4000), files);
    st.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: clip(res.content, 24000), images: res.images });
  }
  pause(ctx, st, call, need, step, emit) {
    const { orgDb, profile, taskId } = ctx;
    const title = `${profile.name} wants to ${need.reason}`;
    const ap = this.app.engine.createApproval(orgDb, { kind: need.payment ? 'payment' : 'action', title: title.slice(0, 300), detail: '```json\n' + JSON.stringify(call.args, null, 2).slice(0, 3000) + '\n```', requestedBy: profile.name, payload: { type: 'action', taskId, tool: call.name } });
    // Stored images are dropped from the saved state to keep it small.
    const slim = { ...st, messages: st.messages.map((m) => (m.images && m.images.length ? { ...m, images: [] } : m)) };
    orgDb.run('UPDATE tasks SET status=?, state=?, current=? WHERE id=?', 'awaiting_approval', JSON.stringify(slim), 'Waiting for approval: ' + need.reason, taskId);
    step('approval', call.name, call.args, title);
    this.app.notify(orgDb, 'Approval needed', title, '#/approvals');
    emit({ type: 'approval', approvalId: ap.id, title, payment: !!need.payment });
    this.controllers.delete(taskId); this.cleanupSandbox(ctx);
    return { paused: true, approvalId: ap.id, title };
  }
  compact(messages, budget) {
    let total = messages.reduce((a, m) => a + estTokens(m.content) + (m.images ? m.images.length * 1000 : 0), 0);
    if (total <= budget) return messages;
    const out = messages.map((m) => ({ ...m }));
    for (let i = 0; i < out.length - 4 && total > budget; i++) {
      const m = out[i];
      if (m.role === 'tool' && String(m.content).length > 600) { total -= estTokens(m.content) - 150; m.content = String(m.content).slice(0, 500) + '\n…[shortened to save space]'; }
      if (m.images && m.images.length) { total -= m.images.length * 1000; m.images = []; }
    }
    return out;
  }
  taskFiles(orgDb, taskId) {
    const out = []; const seen = new Set();
    for (const s of orgDb.all('SELECT files FROM steps WHERE task_id=? AND files IS NOT NULL', taskId)) for (const f of safeJSON(s.files, [])) if (!seen.has(f.path)) { seen.add(f.path); out.push(f); }
    return out;
  }
  stop(taskId) { const c = this.controllers.get(taskId); if (c) c.abort(); return !!c; }
}

module.exports = { AgentRuntime, CAPABILITIES, DEFAULT_ASSISTANT_TOOLS, nextFor, whenToDate, htmlToText, PAY_RE };
