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
  const handlers = {
    health: () => ({ runtime_available: Boolean(cfg.local), runtime_id: "test", models_dir: "/tmp", app_version: "0.5.2" }),
    installed_models: () => (cfg.local ? [{ file_name: "tiny-test.gguf", bytes: 2 * 2 ** 30 }] : []),
    ensure_engine: ({ modelFile }) => ({ running: true, port: cfg.enginePort || 0, model_file: modelFile, base_url: cfg.engineBase }),
    detect_hardware: () => ({ schema: 1, id: 1, name: "Test Mac", os: "macOS", backend: "metal", trust: "selfhost", ram_bytes: 16 * 2 ** 30, vram_bytes: 0, unified_memory: true, usable_model_bytes: 8 * 2 ** 30, runtimes: [], links: [], load: 0, online: true }),
    catalogue: () => ({ schema: 1, generated_at: "2026-01-01", models: [] }),
    cpu_label: () => "Test CPU",
    link_readiness: () => ({ tailscale: "unavailable" }),
    reminders_list: () => [],
    memory_list: () => [],
    connectors_list: () => [],
    skills_list: () => [],
    get_settings: () => ({ theme: "dark", selected_model: cfg.selected || null, context_size: 4096, gpu_layers: 0 }),
    memory_for_prompt: () => [],
    skills_for_prompt: () => [],
    engine_status: () => ({ running: false, port: 0, model_file: null, base_url: "" }),
    read_files: () => [],
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
