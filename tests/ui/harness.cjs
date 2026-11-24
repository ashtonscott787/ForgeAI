// UI test harness: serves the production build and installs a stand-in for the
// Electron bridge (window.forge). The stand-in replaces ONLY the process boundary;
// the React app, its state, and its streaming logic run exactly as shipped.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "..", "dist");
const preview = require("../../electron/preview.cjs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };

function serve() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__preview-register") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      return req.on("end", () => {
        try {
          const p = preview.register(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: p.id, url: "/__preview/" + p.id }));
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
    if (req.method === "POST" && req.url.startsWith("/__preview-forget/")) {
      preview.forget(req.url.split("/").pop());
      res.writeHead(204);
      return res.end();
    }
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // Generated pages are served with their real policy (electron/preview.cjs), from this origin.
    const pv = /^\/__preview\/([0-9a-f]{32})$/.exec(urlPath);
    if (pv) {
      const r = preview.respond(`${preview.SCHEME}://${pv[1]}/`);
      res.writeHead(r.status, r.headers);
      return res.end(r.body);
    }
    const file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    if (path.basename(file) === "index.html") {
      // Electron allows generated pages from the forge-preview scheme. This stand-in serves them from
      // this origin instead, so the one substitution is that the frame source also allows 'self'.
      // Every other directive in the shipped policy is served unchanged.
      const html = fs.readFileSync(file, "utf8").replace("frame-src forge-preview:", "frame-src forge-preview: 'self'");
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Runs in the page before the app starts. */
// String.raw, not a plain template literal.
//
// This string is injected into the page as JavaScript source. Written as an
// ordinary template literal, every backslash in it was consumed once by this
// file before the browser ever saw it: \s in a regular expression became a
// bare s, \n inside a string became a real newline and broke the parse, and
// the symptom was always the same — every scenario in a suite failing at once
// with "Invalid or unexpected token". It cost four separate debugging
// sessions. String.raw hands the browser exactly what is written here.
const BRIDGE = String.raw`(() => {
  const listeners = {};
  const calls = [];
  const pending = {};
  const providers = [
    { provider: "anthropic", saved: false, verified_at: null, models: [], manual: [], last_error: null, last_error_at: null },
    { provider: "openai", saved: false, verified_at: null, models: [], manual: [], last_error: null, last_error_at: null },
  ];
  const cfg = window.__cfg || {};
  const find = (p) => providers.find((x) => x.provider === p);
  const state = {};
  const handlers = {
    health: () => ({ runtime_available: Boolean(cfg.local), runtime_id: "test", models_dir: "/tmp", app_version: "0.5.2" }),
    installed_models: () => (cfg.local ? [{ file_name: "tiny-test.gguf", bytes: 2 * 2 ** 30 }] : []),
    // A stalled start: the engine never becomes ready until Stop stops it, as in the app.
    ensure_engine: ({ modelFile }) => (cfg.stallEngine
      ? new Promise((resolve, reject) => { window.__engineStop = () => reject(new Error("The AI engine was stopped while it was starting.")); })
      : { running: true, port: cfg.enginePort || 0, model_file: modelFile, base_url: cfg.engineBase, api_key: "test-engine-key" }),
    default_browser_status: () => ({ is_default: false, platform: "darwin" }),
    share_status: () => ({ enabled: false, running: false, urls: [], port: 11435, token: null, mesh_enabled: false, mesh_address: null, error: null }),
    share_set: (a) => ({ enabled: Boolean(a.enabled), running: Boolean(a.enabled), urls: a.enabled ? ["http://127.0.0.1:11435"] : [], port: 11435, token: a.enabled ? "test-token" : null, mesh_enabled: Boolean(a.mesh), mesh_address: null, error: null }),
    knowledge_list: () => (cfg.packs || []),
    site_parse: ({ text }) => {
      // The real parser is in the main process and is unit-tested; this
      // stand-in splits on fences, with no escapes, because this whole file is
      // injected as a template literal and would eat them.
      const files = {};
      // A literal backtick would close the template this file is injected as.
      const FENCE = String.fromCharCode(96, 96, 96);
      const parts = String(text).split(FENCE);
      let page = 0;
      for (let i = 1; i < parts.length; i += 2) {
        const chunk = parts[i];
        const nl = chunk.indexOf(String.fromCharCode(10));
        if (nl < 0) continue;
        const head = chunk.slice(0, nl).trim();
        const body = chunk.slice(nl + 1);
        const sp = head.indexOf(" ");
        const lang = (sp < 0 ? head : head.slice(0, sp)).toLowerCase();
        const info = sp < 0 ? "" : head.slice(sp + 1).trim();
        if (lang !== "html" && lang !== "css") continue;
        let name = info;
        if (!name) name = lang === "css" ? "styles.css" : page === 0 ? "index.html" : "page-" + (page + 1) + ".html";
        if (lang === "html") page++;
        files[name] = body;
      }
      const names = Object.keys(files);
      const pages = names.filter((n) => n.endsWith(".html"));
      const broken = [];
      for (const n of pages) {
        let rest = files[n];
        while (true) {
          const at = rest.indexOf('href="');
          if (at < 0) break;
          rest = rest.slice(at + 6);
          const q = rest.indexOf('"');
          if (q < 0) break;
          const t = rest.slice(0, q);
          rest = rest.slice(q + 1);
          const external = t.indexOf(":") >= 0 || t.charAt(0) === "#" || t.slice(0, 2) === "//";
          if (!external && names.indexOf(t) < 0) broken.push({ from: n, href: t, target: t });
        }
      }
      return {
        files,
        report: { ok: !broken.length, pages: pages.length, files: names.length, broken, orphans: [], hasIndex: names.indexOf("index.html") >= 0 },
        summary: broken.length
          ? pages.length + " pages. " + broken.length + " broken link(s): " + broken[0].from + " to " + broken[0].href
          : pages.length + " pages, every internal link resolves.",
      };
    },
    site_preview: ({ files }) => ({ url: "about:blank#", served: Object.keys(files || {}), report: { ok: true, pages: 1, files: 1, broken: [], orphans: [], hasIndex: true }, summary: "" }),
    site_export: () => ({ ok: true, path: "/tmp/website.zip", bytes: 2048, files: 3 }),
    save_document: ({ kind }) => ({ ok: true, path: "/tmp/Report." + kind, bytes: 4096 }),
    agent_tools: () => ([
      { id: "web_search", label: "Search the web", changes: false },
      { id: "read_files", label: "Read files in a folder you choose", changes: false },
      { id: "create_reminder", label: "Create a reminder", changes: true },
      { id: "write_file", label: "Write or change a file", changes: true },
    ]),
    agent_list: () => (state.agents || (state.agents = [])),
    mail_status: () => ({ configured: Boolean(cfg.mailReady), host: cfg.mailReady ? "smtp.example.com" : "", port: 587, secure: false, user: "", from: cfg.mailReady ? "you@example.com" : "", has_password: Boolean(cfg.mailReady), provider: "other", imap_host: cfg.mailReady ? "imap.example.com" : "", imap_port: 993, can_read: Boolean(cfg.mailReady) }),
    mail_save: () => ({ ok: true }),
    // What the machine was judged to be. The point of the tests is that the
    // measurements are shown and the verdict can be overridden.
    tiers: () => ({
      tiers: [
        { id: "tiny", label: "Tiny", says: "Small memory and no graphics card. Everything is sized to leave the machine usable.", max_model_bytes: 1.6 * 1024 ** 3, context: 4096, parallel: 1, flash_attention: false, kv_type: "q8_0", gpu_layers: 0 },
        { id: "small", label: "Small", says: "Enough for a small model with room to work.", max_model_bytes: 3.5 * 1024 ** 3, context: 8192, parallel: 1, flash_attention: true, kv_type: "q8_0", gpu_layers: 999 },
        { id: "medium", label: "Medium", says: "A 7-8B model fits comfortably, with a long conversation.", max_model_bytes: 7 * 1024 ** 3, context: 16384, parallel: 1, flash_attention: true, kv_type: "f16", gpu_layers: 999 },
        { id: "large", label: "Large", says: "Room for a large model and a long context at full precision.", max_model_bytes: 24 * 1024 ** 3, context: 32768, parallel: 1, flash_attention: true, kv_type: "f16", gpu_layers: 999 },
      ],
      machine: handlers.detect_hardware(),
    }),
    set_tier: ({ tier }) => { state.tier = tier; return handlers.detect_hardware(); },
    speed_get: () => (state.speed
      ? { valid: true, tok_s: state.speed, describe: "about 24 words a second" }
      : { valid: false, describe: "not measured yet" }),
    speed_measure: () => { state.speed = 32; return { ok: true, valid: true, tok_s: 32, describe: "about 24 words a second" }; },
    partial_downloads: () => state.partials || (state.partials = cfg.partials || []),
    discard_partial: ({ part }) => {
      state.partials = (state.partials || []).filter((p) => p.part !== part);
      return { ok: true };
    },
    // The shell. Nothing is ever really spawned in a test; what is checked
    // is that a command is only run by a press, and that the refusals hold.
    shell_status: () => state.shell || (state.shell = { open: false, cwd: "/Users/you", platform: "darwin" }),
    shell_open: ({ cwd }) => {
      const st = handlers.shell_status();
      st.open = true;
      if (cwd) st.cwd = cwd;
      return { ok: true, ...st };
    },
    shell_close: () => {
      const st = handlers.shell_status();
      st.open = false;
      return { ok: true, ...st };
    },
    shell_check: ({ command }) => {
      const bad = /rm\s+-[a-z]*r[a-z]*\s+(\/|~)|mkfs|\bsudo\b/i.test(String(command || ""));
      return { allowed: !bad, why: bad ? "Forge AI will not run that: it deletes a whole tree from the top of the disk or your home folder. Use a real terminal if you mean it." : null };
    },
    shell_run: ({ command }) => {
      const c = handlers.shell_check({ command });
      if (!c.allowed) return { ok: false, refused: true, why: c.why };
      const st = handlers.shell_status();
      if (!st.open) return { ok: false, why: "The shell is not open." };
      state.ran = (state.ran || []).concat(String(command));
      return { ok: true, code: 0, output: "ran: " + command, ...st };
    },
    shell_ran: () => state.ran || [],
    shell_interrupt: () => ({ ok: true }),
    shell_pick_folder: () => ({ ok: true, cwd: "/Users/you/Projects" }),
    // More than one computer. The worker never runs in a test; what is
    // checked is that the interface refuses the dangerous choices and says
    // which machines are actually in use.
    cluster_status: () => state.cluster || (state.cluster = {
      available: cfg.noWorker ? false : true,
      enabled: false,
      peers: [],
      using: [],
      engine_running: false,
      worker: { running: false, host: "127.0.0.1", port: 50052, log: [] },
      addresses: [{ name: "en0", address: "192.168.1.42", private: true }],
    }),
    cluster_set: (a) => {
      const c = handlers.cluster_status();
      if (a && Array.isArray(a.peers)) {
        const bad = a.peers.find((t) => !/^[A-Za-z0-9._-]+(:\d+)?$/.test(String(t).trim()));
        // No template literals in here: this whole block lives inside a
        // String.raw template, and a backtick ends it.
        if (bad) return { ok: false, why: '"' + bad + '" is not an address.' };
        c.peers = a.peers.map((t) => {
          const [h, p] = String(t).trim().split(":");
          return { host: h, port: Number(p) || 50052, label: h + ":" + (Number(p) || 50052), ok: null };
        });
      }
      if (a && a.enabled !== undefined) c.enabled = Boolean(a.enabled);
      return { ok: true, ...c };
    },
    cluster_check: () => {
      const c = handlers.cluster_status();
      c.peers = c.peers.map((p, i) => (i === 0 ? { ...p, ok: true, ms: 7 } : { ...p, ok: false, why: "nothing is listening on that port" }));
      return c;
    },
    worker_set: (a) => {
      const c = handlers.cluster_status();
      if (a && a.enabled && a.host === "0.0.0.0" && !a.allowPublic) {
        return { ok: false, why: "Listening on every interface would offer this machine to any network it joins, and the worker has no password of any kind." };
      }
      c.worker = { running: Boolean(a && a.enabled), host: (a && a.host) || c.worker.host, port: (a && a.port) || c.worker.port, log: a && a.enabled ? ["worker listening"] : [] };
      return { ok: true, ...c };
    },
    // Making a model from one already installed.
    workshop_status: () => state.shop || (state.shop = {
      formats: [
        { id: "Q4_K_M", label: "Q4_K_M", note: "The usual choice. About half the size of Q8 and hard to tell apart in use." },
        { id: "Q6_K", label: "Q6_K", note: "Close to indistinguishable from Q8, and smaller." },
      ],
      can_shrink: true,
      can_combine: true,
      job: null,
    }),
    workshop_suggest: ({ source, format }) => String(source).replace(/\.gguf$/i, "").replace(/[-.]Q\d[A-Z0-9_]*$/i, "") + "-" + format + ".gguf",
    workshop_shrink: ({ name }) => {
      const st = handlers.workshop_status();
      st.job = { kind: "shrink", out: name, started: Date.now(), log: ["quantizing…"] };
      return { ok: true, ...st };
    },
    workshop_combine: ({ adapter, name }) => {
      const st = handlers.workshop_status();
      if (!/\.gguf$/i.test(String(adapter))) return { ok: false, why: "The adapter has to be a .gguf file." };
      st.job = { kind: "combine", out: name, started: Date.now(), log: ["merging…"] };
      return { ok: true, ...st };
    },
    workshop_stop: () => {
      const st = handlers.workshop_status();
      st.job = null;
      return { ok: true, ...st };
    },
    system_status: () => ({
      at: Date.now(), worst: "failed", headline: "1 not working",
      counts: { connected: 4, failed: 1, off: 2, not_set_up: 2 },
      rows: [
        { group: "This computer", name: "Inference engine", detail: "gemma-2-2b-it-Q4_K_M.gguf", state: "connected", ms: 2, note: "" },
        { group: "This computer", name: "Models", detail: "3 installed", state: "connected", ms: null, note: "" },
        { group: "This computer", name: "Knowledge", detail: "2 packs", state: "connected", ms: null, note: "" },
        { group: "This computer", name: "Agents", detail: "1 saved", state: "connected", ms: null, note: "" },
        { group: "Private mesh", name: "Tailscale", detail: "100.88.1.4", state: "connected", ms: null, note: "This machine has a mesh address." },
        { group: "Private mesh", name: "Shared to the mesh", detail: "off", state: "off", ms: null, note: "" },
        { group: "Sharing", name: "Local endpoint", detail: "off", state: "off", ms: null, note: "" },
        { group: "Email", name: "Incoming (IMAP)", detail: "imap.example.com", state: "failed", ms: 2585, note: "ECONNREFUSED" },
        { group: "Email", name: "Outgoing (SMTP)", detail: "not set up", state: "not_set_up", ms: null, note: "Settings, Email." },
        { group: "Search", name: "wikipedia", detail: "ready", state: "connected", ms: null, note: "" },
      ],
    }),
    security_audit: () => ({
      at: Date.now(), worst: "high", headline: "2 things worth looking at",
      counts: { high: 1, low: 1 },
      scope: "This looks at how Forge AI is set up and what it exposes. It is not an antivirus, and it does not scan your operating system or your network.",
      findings: [
        { id: "share-no-token", severity: "high", area: "Sharing", title: "The shared endpoint has no access token", found: "Sharing is on and no token is set.", fix: "Open Settings, Sharing, and press New token." },
        { id: "share-mesh", severity: "low", area: "Sharing", title: "Your models are reachable from your private mesh", found: "Bound to 100.88.1.4.", fix: "This is what the setting is for." },
      ],
    }),
    contacts_list: () => {
      if (!state.people) state.people = [
        { id: "c1", email: "dana@supplier.example", seen: 4, last_seen: Date.now(),
          known: { email: "dana@supplier.example", name: "Dana Patel", organisation: "Patel Logistics", notes: ["Prefers email to phone"] },
          pending: [
            { id: "f1", field: "role", value: "Operations Manager", state: "suggested", times: 3, source: "their email", last_source: 'their email Order 1042', at: Date.now() },
            { id: "f2", field: "phone", value: "+64 21 555 0199", state: "suggested", times: 1, source: "their signature", at: Date.now() },
          ], facts: [] },
        { id: "c2", email: "jo@client.example", seen: 1, last_seen: Date.now() - 86400000,
          known: { email: "jo@client.example", notes: [] }, pending: [], facts: [] },
      ];
      return state.people;
    },
    contacts_decide: ({ email, fact_id, state: st }) => {
      const p = (state.people || []).find((x) => x.email === email);
      if (p) p.pending = p.pending.filter((f) => f.id !== fact_id);
      return { id: fact_id, state: st };
    },
    contacts_forget: ({ email }) => { state.people = (state.people || []).filter((x) => x.email !== email); return { forgotten: true }; },
    contacts_scan: () => (cfg.mailReady ? { ok: true, read: 40, people: 2 } : { ok: false, error: "No incoming mail account is set up, so there is nobody to learn about." }),
    contacts_state: () => ({ id: "new", state: "confirmed" }),
    mail_providers: () => ({
      gmail: { label: "Gmail", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 587, secure: false }, note: "Needs an app password.", works: true },
      microsoft: { label: "Outlook / Microsoft 365", imap: { host: "outlook.office365.com", port: 993 }, smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false }, note: "Microsoft has switched off password sign-in for mail apps.", works: false },
      other: { label: "Something else", imap: { host: "", port: 993 }, smtp: { host: "", port: 587, secure: false }, note: "Your provider's help pages will give the servers.", works: true },
    }),
    mail_detect: ({ address }) => {
      const at = String(address || "");
      if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(at)) return { ok: false, why: "That does not look like an email address." };
      if (/@gmail\.com$/i.test(at)) return { ok: true, provider: "gmail", domain: "gmail.com", how: "the address itself" };
      if (/@school\.example$/i.test(at)) return { ok: true, provider: "gmail", domain: "school.example", how: "where this domain delivers its mail" };
      if (/@corp\.example$/i.test(at)) return { ok: true, provider: "microsoft", domain: "corp.example", how: "where this domain delivers its mail" };
      return { ok: true, provider: "", domain: at.split("@")[1], how: "" };
    },
    mail_check: () => ({ ok: true, mailboxes: ["INBOX", "Sent"] }),
    mail_inbox: () => (cfg.mailReady ? { ok: true, total: 2, messages: [
      { uid: 102, seq: 2, unread: true, from: "Dana Patel <dana@supplier.example>", to: "you@example.com", subject: "Order 1042 delayed", date: "Thu, 20 Nov 2026 09:14:00" },
      { uid: 101, seq: 1, unread: false, from: "Jo Lee <jo@client.example>", to: "you@example.com", subject: "Thanks", date: "Wed, 19 Nov 2026 16:02:00" },
    ] } : { ok: false, error: "No incoming mail server is set up.", messages: [], total: 0 }),
    mail_read: ({ uid }) => ({ ok: true, uid, from: "Dana Patel <dana@supplier.example>", subject: "Order 1042 delayed", date: "Thu, 20 Nov 2026 09:14:00", text: "The pallets are held at customs. New date is 3 December." }),
    mail_send: (a) => (a && a.approved === true
      ? { ok: true, recipients: 1, response: "250 OK queued" }
      : { ok: false, error: "A message is only sent when you approve it." }),
    agent_activity: () => ({
      events: cfg.agentEvents === 0 ? 0 : 7,
      agents: cfg.agentEvents === 0 ? [] : [
        { id: "a1", name: "Bea", icon: "\u{1F4E7}", tools: ["web_search", "read_email"], packs: ["p1"],
          runs: 2, calls: 5, failures: 1, waiting: 1, last_at: Date.now(), last_kind: "failed", used: { web_search: 3, read_email: 2 } },
        { id: "a2", name: "Finn", icon: "\u{1F4CA}", tools: ["web_search", "read_files"], packs: ["p1"],
          runs: 1, calls: 2, failures: 0, waiting: 0, last_at: Date.now(), last_kind: "finished", used: { web_search: 2 } },
        { id: "a3", name: "Solo", icon: "\u{1F916}", tools: ["create_reminder"], packs: [],
          runs: 0, calls: 0, failures: 0, waiting: 0, last_at: null, last_kind: null, used: {} },
      ],
      links: cfg.agentEvents === 0 ? [] : [
        { a: "a1", b: "a2", tools: ["web_search"], packs: ["p1"], why: "shared permissions" },
      ],
      recent: cfg.agentEvents === 0 ? [] : [
        { at: Date.now() - 4000, agent_id: "a1", agent_name: "Bea", kind: "started", tool: null, input: "check the supplier", ok: null, detail: "" },
        { at: Date.now() - 3000, agent_id: "a1", agent_name: "Bea", kind: "tool", tool: "web_search", input: "steel", ok: true, detail: "2 results" },
        { at: Date.now() - 2000, agent_id: "a1", agent_name: "Bea", kind: "tool", tool: "read_email", input: "", ok: false, detail: "no account set up" },
      ],
    }),
    agent_activity_clear: () => ({ cleared: true }),
    connect_plan: ({ app }) => ({
      ok: true,
      file: app === "chatgpt" ? "/Users/you/Library/Application Support/ChatGPT/mcp_config.json"
                              : "/Users/you/Library/Application Support/Claude/claude_desktop_config.json",
      existed: true,
      others: ["filesystem"],
      already: Boolean(cfg.connected),
      same: Boolean(cfg.connected),
      command: "claude mcp add forge-ai --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Forge AI.app/Contents/MacOS/Forge AI /x/mcp-server.cjs",
    }),
    connect_apply: () => ({ ok: true, changed: true, note: "Added." }),
    connect_remove: () => ({ ok: true, changed: true, note: "Removed." }),
    mcp_list: () => cfg.mcpServers || [],
    mcp_save: ({ servers }) => servers,
    mcp_inspect: ({ command }) =>
      String(command).includes("broken")
        ? { ok: false, name: command, tools: [], description: "", error: "spawn ENOENT" }
        : {
            ok: true,
            name: "Notes",
            tools: [{ name: "search_notes" }, { name: "delete_note" }],
            // Built with fromCharCode because this whole bridge is injected as
            // a template literal: a backslash escape written here is eaten
            // before the browser ever sees it, and the script fails to parse.
            description: [
              "Notes 1.0 - 2 tools.",
              "- search_notes - Find a note.",
              "- delete_note - Remove a note.",
              "Of these, one appears to change something: delete_note. Treat that as a guess from the wording, not a guarantee.",
            ].join(String.fromCharCode(10)),
          },
    agent_event: () => ({ ok: true }),
    agent_icons: () => ["\u{1F916}", "\u{1F4E7}", "\u{1F50D}", "\u{1F4C1}"],
    agent_duplicate: ({ id }) => {
      state.agents = state.agents || [];
      const src = state.agents.find((a) => a.id === id);
      if (!src) throw new Error("no such agent");
      const copy = Object.assign({}, src, { id: "a" + (state.agents.length + 1) + "c", name: src.name + " copy" });
      state.agents.push(copy);
      return copy;
    },
    agent_save: ({ agent }) => {
      state.agents = state.agents || [];
      const saved = Object.assign({}, agent, { id: agent.id || "a" + (state.agents.length + 1) });
      const at = state.agents.findIndex((x) => x.id === saved.id);
      if (at >= 0) state.agents[at] = saved; else state.agents.push(saved);
      return saved;
    },
    agent_delete: ({ id }) => { state.agents = (state.agents || []).filter((a) => a.id !== id); return { deleted: true }; },
    agent_advice: ({ usable_bytes }) => (usable_bytes / (1024 * 1024 * 1024) < 6
      ? { ok: false, text: "This machine has about 5.0 GB usable. Agent loops need a 7B-class model; expect this to be unreliable here." }
      : { ok: true, warn: false, text: "This machine has enough memory." }),
    knowledge_context: ({ query }) => {
      const packs = cfg.packs || [];
      const hit = packs.find((p) => (p.documents || []).some((d) => String(query).toLowerCase().includes((d.name || "").toLowerCase().split(".")[0])));
      return hit ? { text: 'From the document ' + hit.documents[0].name + ' - stub passage', packs: [hit.name] } : { text: "", packs: [] };
    },
    stop_engine: () => { calls.push({ cmd: "stop_engine", args: {} }); if (window.__engineStop) window.__engineStop(); return null; },
    detect_hardware: () => {
      const detected = cfg.tier || "small";
      const tier = state.tier || detected;
      const shapes = { tiny: 4096, small: 8192, medium: 16384, large: 32768 };
      return {
        schema: 1, id: 1, name: "Test Mac", os: "macOS", backend: "metal", trust: "selfhost",
        ram_bytes: 16 * 2 ** 30,
        free_bytes: (cfg.freeGb || 9) * 2 ** 30,
        vram_bytes: cfg.vramGb ? cfg.vramGb * 2 ** 30 : 0,
        vram_known: Boolean(cfg.vramGb),
        gpu_name: cfg.gpuName || "Apple M3",
        gpu_kind: cfg.gpuKind || "apple",
        accelerated: cfg.accelerated !== false,
        cores: 8, performance_cores: 4,
        tier, tier_label: tier.charAt(0).toUpperCase() + tier.slice(1),
        tier_says: "Enough for a small model with room to work.",
        tier_detected: detected,
        tier_is_override: Boolean(state.tier) && state.tier !== detected,
        tier_settings: { id: tier, label: tier, says: "", max_model_bytes: 3.5 * 2 ** 30, context: shapes[tier], parallel: 1, flash_attention: true, kv_type: tier === "tiny" || tier === "small" ? "q8_0" : "f16", gpu_layers: 999 },
        unified_memory: true,
        usable_model_bytes: (cfg.usableGb || 8) * 2 ** 30,
        runtimes: [], links: [], load: 0, online: true,
      };
    },
    catalogue: () => ({ schema: 1, generated_at: "2026-01-01", models: cfg.catalogue || [] }),
    cpu_label: () => "Test CPU",
    link_readiness: () => ({ tailscale: "unavailable" }),
    // A stateful stand-in for the reminder commands (the real module is in electron/reminders.cjs).
    reminders_list: () => window.__reminders || [],
    reminder_create: ({ text, when }) => { const r = { id: "r" + Math.random().toString(36).slice(2, 7), text, at: Date.now() + 3600e3, repeat: null, state: "pending", late: false, last_fired: null, when }; window.__reminders = [...(window.__reminders || []), r]; return r; },
    reminder_update: (patch) => { const list = window.__reminders || []; const r = list.find((x) => x.id === patch.id); if (!r) throw new Error("that reminder no longer exists"); Object.assign(r, patch); return r; },
    reminder_delete: ({ id }) => { window.__reminders = (window.__reminders || []).filter((x) => x.id !== id); return null; },
    parse_when: ({ text }) => (/nonsense/.test(text) ? { error: "I could not work out that time." } : { at: Date.now() + 3600e3, repeat: null, text }),
    memory_list: () => [],
    connectors_list: () => [],
    skills_list: () => [],
    get_settings: () => {
      if (!state.settings) state.settings = { theme: "dark", selected_model: cfg.selected || null, context_size: 4096, gpu_layers: 0, search_provider: cfg.searchProvider || "wikipedia", searxng_instance: "" };
      return state.settings;
    },
    // Settings persist here as they do in the app, so a control that reads back
    // what it wrote behaves the same way in a test as it does for a person.
    set_settings: (a) => { state.settings = Object.assign({}, state.settings, a && a.settings ? a.settings : a); return state.settings; },
    memory_for_prompt: () => cfg.memories || [],
    skills_for_prompt: () => cfg.skills || [],
    engine_status: () => ({ running: false, port: 0, model_file: null, base_url: "", api_key: "" }),
    read_files: () => [],
    // Keyless search is tested in the main process (tests/open-web.test.cjs). The stand-in returns a
    // fixed answer shaped like the real one, so the view can be exercised here.
    web_search: ({ query }) => {
      // cfg.searchFails lets a scenario exercise the failure path, which must
      // never look like an empty success.
      if (cfg.searchFails) return { ok: false, provider: "brave", query, results: [], found: 0, error: "Brave refused the key. Check it in Settings.", kind: "auth" };
      if (cfg.searchEmpty) return { ok: true, provider: "brave", label: "Brave Search", query, results: [], found: 0, note: "Brave Search returned no results for that search.", context: "", fetched_at: 0 };
      return {
        ok: true, provider: "brave", label: "Brave Search", query, fetched_at: 0, found: 2,
        results: [
          { title: "Forge AI", url: "https://en.wikipedia.org/wiki/Forge_AI", snippet: "A desktop app.", source: "en.wikipedia.org", provider: "brave" },
          { title: "Steel prices", url: "https://example.com/steel", snippet: "Prices rose.", source: "example.com", provider: "brave" },
        ],
        context: "Brave Search results",
      };
    },
    search_providers: () => ({
      providers: [
        { id: "wikipedia", label: "Wikipedia", keyless: true, needs: null, ready: true },
        { id: "searxng", label: "SearXNG", keyless: true, needs: "instance", ready: false },
        { id: "brave", label: "Brave Search", keyless: false, needs: "key", ready: Boolean(cfg.braveKey) },
        { id: "tavily", label: "Tavily", keyless: false, needs: "key", ready: false },
      ],
      chosen: (state.settings && state.settings.search_provider) || cfg.searchProvider || "wikipedia",
      instance: (state.settings && state.settings.searxng_instance) || "",
    }),
    search_key_save: ({ key }) => (String(key).length > 8
      ? { ok: true, detail: "Working: the test search returned 2 result(s)." }
      : { ok: false, error: "Brave refused the key. Check it in Settings." }),
    save_screenshot: ({ dataUrl }) => (dataUrl.startsWith("data:image/png;base64,") ? "/tmp/forge-shot.png" : null),
    // Stand-in for the forge-preview scheme, which only Electron serves.
    // The page cannot call Node modules, so registration goes to the harness server, which stores
    // the page with the real electron/preview.cjs module.
    preview_register: ({ html }) => fetch("/__preview-register", { method: "POST", headers: { "content-type": "text/plain" }, body: html }).then((r) => r.json()),
    preview_forget: ({ id }) => fetch("/__preview-forget/" + id, { method: "POST" }).then(() => null),
    memory_for_prompt_unused: () => [],
    provider_status: () => providers,
    provider_key_save: ({ provider, key }) => {
      if (!key || key.length < 10) throw new Error("That does not look like an API key.");
      const p = find(provider); p.saved = true; p.verified_at = null; p.models = []; p.last_error = null;
      return providers;
    },
    provider_test: ({ provider }) => {
      const p = find(provider);
      if (cfg.testError) { p.verified_at = null; p.last_error = cfg.testError; throw new Error(cfg.testError); }
      p.verified_at = Date.now();
      p.models = provider === "anthropic"
        ? [{ id: "claude-test-a", label: "Claude Test A" }, { id: "claude-test-b", label: "Claude Test B" }]
        : [{ id: "gpt-test", label: "gpt-test" }];
      p.last_error = null;
      return providers;
    },
    provider_disconnect: ({ provider }) => { const p = find(provider); p.verified_at = null; p.models = []; return providers; },
    provider_remove: ({ provider }) => { const p = find(provider); p.saved = false; p.verified_at = null; p.models = []; return providers; },
    provider_manual_add: ({ provider, id }) => { find(provider).manual.push(id); return providers; },
    provider_manual_remove: ({ provider, id }) => { const p = find(provider); p.manual = p.manual.filter((m) => m !== id); return providers; },
    provider_stream: (args) => new Promise((resolve, reject) => { pending[args.requestId] = { resolve, reject, args }; }),
    provider_cancel: ({ requestId }) => {
      const p = pending[requestId];
      if (p) { delete pending[requestId]; p.resolve({ tokens: 0, stopReason: "cancelled", usage: { input: null, output: null }, cancelled: true }); }
      return { cancelled: Boolean(p) };
    },
  };
  window.__calls = calls;
  window.__pending = pending;
  window.__emit = (event, payload) => (listeners[event] || []).forEach((cb) => cb(payload));
  window.__finish = (requestId, result) => {
    const p = pending[requestId];
    if (p) { delete pending[requestId]; p.resolve(result); }
  };
  window.__fail = (requestId, message) => {
    const p = pending[requestId];
    if (p) { delete pending[requestId]; p.reject(new Error(message)); }
  };
  window.forge = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      // Startup is instant here, which leaves nothing to look at. A scenario
      // can slow it or break it to exercise the starting screen.
      const BOOT = ["get_settings", "engine_status", "health", "detect_hardware", "catalogue", "installed_models"];
      if (cfg.bootFails && cmd === "detect_hardware") throw new Error("deliberate boot failure");
      if (cfg.slowBoot && BOOT.indexOf(cmd) >= 0) {
        await new Promise((r) => setTimeout(r, Math.round(cfg.slowBoot / 3)));
      }
      const fn = handlers[cmd];
      if (!fn) return null;
      // IPC copies values across the boundary; so does the stand-in.
      const out = fn(args || {});
      const copy = (v) => JSON.parse(JSON.stringify(v ?? null));
      return out && typeof out.then === "function" ? out.then(copy) : copy(out);
    },
    on: (event, cb) => { (listeners[event] = listeners[event] || []).push(cb); return () => {}; },
    pathForFile: () => "",
  };
})();`;

module.exports = { serve, BRIDGE };
