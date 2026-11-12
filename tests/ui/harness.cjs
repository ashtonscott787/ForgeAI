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
const BRIDGE = `(() => {
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
      : { running: true, port: cfg.enginePort || 0, model_file: modelFile, base_url: cfg.engineBase }),
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
    detect_hardware: () => ({ schema: 1, id: 1, name: "Test Mac", os: "macOS", backend: "metal", trust: "selfhost", ram_bytes: 16 * 2 ** 30, vram_bytes: 0, unified_memory: true, usable_model_bytes: (cfg.usableGb || 8) * 2 ** 30, runtimes: [], links: [], load: 0, online: true }),
    catalogue: () => ({ schema: 1, generated_at: "2026-01-01", models: [] }),
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
    memory_for_prompt: () => [],
    skills_for_prompt: () => [],
    engine_status: () => ({ running: false, port: 0, model_file: null, base_url: "" }),
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
