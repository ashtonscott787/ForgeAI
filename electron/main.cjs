// Forge AI desktop shell (Electron). Mirrors the Tauri command surface so the
// same React frontend runs unchanged. Inference is the bundled llama.cpp
// `llama-server`, bound to 127.0.0.1 on a free port.
const { app, BrowserWindow, ipcMain, screen, shell, session, dialog, protocol, net: electronNet } = require("electron");
const preview = require("./preview.cjs");

// Generated pages load from this scheme, with their own policy. Must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: preview.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { readAttachment, selectRelevant } = require("./extract.cjs");
const updater = require("./updater.cjs");
const { downloadModel } = require("./transfer.cjs");
const reminders = require("./reminders.cjs");
const memory = require("./memory.cjs");
const skills = require("./skills.cjs");
const { isTrustedSender } = require("./trust.cjs");
const providers = require("./providers.cjs");
const { openEngineLog } = require("./engine-log.cjs");
const openWeb = require("./open-web.cjs");
// Keyless lookups leave through Electron's network stack, so they follow the system proxy.
openWeb.useTransport((url, { timeoutMs, maxBytes, userAgent }) => new Promise((resolve, reject) => {
  const req = electronNet.request({ method: "GET", url, redirect: "error" });
  req.setHeader("User-Agent", userAgent);
  req.setHeader("Accept", "application/json");
  const timer = setTimeout(() => { req.abort(); reject(new openWeb.WebError("The source did not answer in time.", "timeout")); }, timeoutMs);
  req.on("response", (res) => {
    let body = "";
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { clearTimeout(timer); req.abort(); reject(new openWeb.WebError("The source sent too much data.", "limit")); return; }
      body += chunk.toString("utf8");
    });
    res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
    res.on("error", () => { clearTimeout(timer); reject(new openWeb.WebError("The connection to the source was lost.", "network")); });
  });
  req.on("error", (e) => {
    clearTimeout(timer);
    reject(new openWeb.WebError(/redirect/i.test(e.message) ? "The source redirected the request, which Forge AI refuses." : `Could not reach the source: ${e.message}`, /redirect/i.test(e.message) ? "redirect" : "network"));
  });
  req.end();
}));
const providerState = require("./provider-state.cjs");
const connectors = require("./connectors.cjs");
const secrets = require("./secrets.cjs");
const research = require("./research.cjs");
const { parseWhen } = require("./when.cjs");

const RUNTIME_ID = "llamacpp-b12180";
const IDLE_UNLOAD_MS = 20 * 60 * 1000;
const GiB = 1024 ** 3;
const root = () => path.join(app.getPath("userData"));
const modelsDir = () => { const d = path.join(root(), "models"); fs.mkdirSync(d, { recursive: true }); return d; };
const settingsFile = () => path.join(root(), "settings.json");
const engineDir = () => app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(__dirname, "..", "engine-dev");
const serverBin = () => path.join(engineDir(), process.platform === "win32" ? "llama-server.exe" : "llama-server");

// ── settings ────────────────────────────────────────────────
/**
 * macOS runs a quarantined app from a read-only copy ("app translocation")
 * until it is moved to Applications. Nothing can write next to the bundle in
 * that state, so updating is impossible and the only honest answer is to say
 * so and tell the person what to do.
 */
const translocated = () => process.platform === "darwin" && process.execPath.includes("/AppTranslocation/");

const DEFAULTS = {
  theme: "system",
  context_size: 8192,
  gpu_layers: 999,
  threads: null,
  selected_model: null,
  experimental_cluster: false,
  // How the weights are run: "gpu" offloads everything it can, "cpu" keeps
  // them off the GPU entirely, "split" offloads a chosen number of layers.
  run_mode: "gpu",
  split_layers: 20,
  // Memory-mapped weights stay on disk and page in; loading them into RAM is
  // faster per token but needs the whole model resident.
  load_into_memory: false,
  /** Ceiling on how much of this machine's memory models may use, in bytes. */
  memory_budget_bytes: null,
};
function loadSettings() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { return { ...DEFAULTS }; } }
function saveSettings(s) { const t = settingsFile() + ".tmp"; fs.writeFileSync(t, JSON.stringify(s, null, 2)); fs.renameSync(t, settingsFile()); }
let settings;

// ── hardware ────────────────────────────────────────────────
function usableBytes(ram, vram, unified) {
  const pool = unified || vram === 0 ? ram : vram;
  const headroom = unified || vram === 0 ? 0.75 : 0.92;
  return Math.max(0, Math.min(Math.floor(pool * headroom), pool - 3 * GiB));
}
function hardware() {
  const ram = os.totalmem();
  const mac = process.platform === "darwin";
  const metal = mac && process.arch === "arm64";
  // The Windows build ships the CPU engine, so report CPU honestly even if a GPU exists.
  const backend = metal ? "metal" : "cpu";
  return {
    schema: 1, id: 1, name: os.hostname(), os: process.platform === "win32" ? "windows" : process.platform,
    backend, trust: "selfhost", ram_bytes: ram, vram_bytes: 0, unified_memory: mac,
    usable_model_bytes: Math.min(
      usableBytes(ram, 0, mac),
      Number(settings?.memory_budget_bytes) > 0 ? Number(settings.memory_budget_bytes) : Infinity,
    ),
    memory_budget_bytes: Number(settings?.memory_budget_bytes) || null, runtimes: [RUNTIME_ID], links: [], load: 0, online: true,
  };
}
const cpuLabel = () => `${os.cpus()[0]?.model?.trim() ?? "CPU"} · ${os.cpus().length} threads`;

// ── models ──────────────────────────────────────────────────
const safeName = (n) => { if (!n || n !== path.basename(n) || !n.endsWith(".gguf")) throw new Error("invalid model file name"); return n; };
// A vision model is a language model plus a projector file named "mmproj-<model file>".
// Projectors are never listed as models of their own.
const projectorName = (modelFile) => "mmproj-" + modelFile;
const isProjector = (f) => f.startsWith("mmproj-");
function installed() {
  return fs.readdirSync(modelsDir()).filter((f) => f.endsWith(".gguf") && !isProjector(f))
    .map((f) => ({
      file_name: f,
      bytes: fs.statSync(path.join(modelsDir(), f)).size,
      vision: fs.existsSync(path.join(modelsDir(), projectorName(f))),
    }));
}
function get(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "ForgeAI/0.1", ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 10) {
        res.resume(); resolve(get(new URL(res.headers.location, url).toString(), headers, redirects + 1)); return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

// ── Hugging Face resolution ─────────────────────────────────
// Catalogue entries name a repository, not a file. The exact GGUF file name is
// read from the repository at download time, so a renamed upload does not turn
// into a dead link inside the app.
const { resolveArtifact, resolveProjector } = require("./hf.cjs");
const { missingEngineLibraries } = require("./engine-check.cjs");

async function searchHub({ query, sort, author, limit }) {
  const q = String(query || "").trim();
  const params = new URLSearchParams();
  if (q) params.set("search", q);
  if (author) params.set("author", String(author));
  params.set("filter", "gguf");
  params.set("sort", ["downloads", "likes", "lastModified", "trendingScore"].includes(sort) ? sort : "downloads");
  params.set("direction", "-1");
  params.set("limit", String(Math.min(Number(limit) || 30, 60)));
  const list = await getJSON(`https://huggingface.co/api/models?${params.toString()}`);
  return (Array.isArray(list) ? list : []).map((r) => {
    const id = r.modelId || r.id || "";
    const tags = Array.isArray(r.tags) ? r.tags : [];
    return {
      repo: id,
      author: id.split("/")[0] || "",
      downloads: r.downloads || 0,
      likes: r.likes || 0,
      updated: r.lastModified || "",
      license: (tags.find((t) => t.startsWith("license:")) || "").slice(8),
      tags: tags.filter((t) => !t.includes(":")).slice(0, 8),
    };
  });
}

/** Every GGUF in a repository, so the user picks the exact file and size. */
async function listRepoFiles({ repo }) {
  const clean = String(repo || "").trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error("expected a repository in the form owner/name");
  const tree = await getJSON(`https://huggingface.co/api/models/${clean}/tree/main?recursive=1`);
  const files = (Array.isArray(tree) ? tree : [])
    .filter((f) => f.type === "file" && /\.gguf$/i.test(f.path))
    .map((f) => ({
      path: f.path,
      file_name: f.path.split("/").pop(),
      bytes: size(f),
      sha256: f.lfs && typeof f.lfs.oid === "string" && f.lfs.oid.length === 64 ? f.lfs.oid : "",
      quant: (f.path.match(/(IQ\d[\w]*|Q\d[_\w]*|BF16|F16|F32)/i) || ["GGUF"])[0].toUpperCase(),
      split: /-\d{5}-of-\d{5}\./.test(f.path),
      url: `https://huggingface.co/${clean}/resolve/main/${encodeURI(f.path)}?download=true`,
    }))
    .sort((a, b) => a.bytes - b.bytes);
  if (!files.length) throw new Error(`no GGUF files in ${clean} — that repository may hold the original weights rather than a GGUF conversion`);
  return { repo: clean, files };
}

// ── engine ──────────────────────────────────────────────────
let engine = { proc: null, port: 0, model_file: null };
const status = () => ({ running: !!engine.proc, port: engine.port, model_file: engine.model_file, base_url: engine.proc ? `http://127.0.0.1:${engine.port}` : "" });
const freePort = () => new Promise((r, j) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); s.on("error", j); });
function stopEngine() { if (engine.proc) { try { engine.proc.kill(); } catch {} } engine = { proc: null, port: 0, model_file: null }; }
const logFile = () => path.join(root(), "engine.log");
const logTail = (lines = 12) => {
  try {
    return fs.readFileSync(logFile(), "utf8").split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "(the engine wrote nothing to its log)";
  }
};
let idleTimer = null;
function touchEngine() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (engine.proc) stopEngine(); }, IDLE_UNLOAD_MS);
}
async function ensureEngine({ modelFile }) {
  if (engine.proc && engine.model_file === modelFile) { touchEngine(); return status(); }
  return startEngine({ modelFile });
}
let win = null;
async function startEngine({ modelFile }) {
  stopEngine();
  // Launched from the translocated copy, the app's files sit in a read-only temporary location.
  // Say so at once, rather than starting an engine that cannot load and waiting for it to fail.
  if (translocated()) throw new Error("Forge AI is running from a temporary copy, so the AI engine cannot start. Quit Forge AI, drag it into your Applications folder, and open it from there.");
  // The engine must be able to load before it is started. A build missing a library names it here.
  const missingLibs = missingEngineLibraries(engineDir());
  if (missingLibs.length) {
    const names = [...new Set(missingLibs.map((m) => m.name.split("/").pop()))];
    throw new Error(`The AI engine cannot load: ${names.slice(0, 4).join(", ")}${names.length > 4 ? " and more" : ""} ${names.length === 1 ? "is" : "are"} missing from this copy of Forge AI. Download the latest version from the Forge AI releases page, or reinstall.`);
  }
  const model = path.join(modelsDir(), safeName(modelFile));
  if (!fs.existsSync(model)) throw new Error("model file not found — download it first");
  if (!fs.existsSync(serverBin())) throw new Error("The AI engine is missing from this copy of Forge AI.");
  try {
    fs.accessSync(serverBin(), fs.constants.X_OK);
  } catch {
    throw new Error("The AI engine is not marked executable. Re-download Forge AI, or move it to your Applications folder and open it again.");
  }
  const size = fs.statSync(model).size;
  if (size < 1024 * 1024) throw new Error("That model file is far too small to be a model — the download was probably cut short. Delete it and download it again.");
  const port = await freePort();
  const layers =
    settings.run_mode === "cpu" ? 0 : settings.run_mode === "split" ? Math.max(0, Number(settings.split_layers) || 0) : Number(settings.gpu_layers) || 999;
  const args = [
    "--model", model,
    "--ctx-size", String(settings.context_size),
    "--port", String(port),
    "--host", "127.0.0.1",
    "--n-gpu-layers", String(layers),
  ];
  if (settings.threads) args.push("--threads", String(settings.threads));
  // A vision model's projector sits beside it; the engine reads images only with it.
  const projector = path.join(modelsDir(), projectorName(safeName(modelFile)));
  if (fs.existsSync(projector)) args.push("--mmproj", projector);
  // --no-mmap reads the whole file into RAM instead of paging it from disk.
  if (settings.load_into_memory) args.push("--no-mmap");
  const log = openEngineLog(logFile());
  const proc = spawn(serverBin(), args, { cwd: engineDir(), windowsHide: true, env: { ...process.env, PATH: engineDir() + path.delimiter + process.env.PATH } });
  // Both output streams feed one guarded log. The log is closed exactly once, on
  // close, and any later chunk is dropped rather than written to an ended stream.
  proc.stdout.on("data", (c) => log.write(c));
  proc.stderr.on("data", (c) => log.write(c));
  proc.once("close", () => log.close());
  let exited = null;
  proc.on("exit", (code) => { exited = code; if (engine.proc === proc) engine = { proc: null, port: 0, model_file: null }; });
  proc.on("error", (e) => { exited = String(e); });
  engine = { proc, port, model_file: modelFile };
  const started = Date.now();
  const deadline = started + 600_000; // a large model on a busy disk is slow
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`the AI engine stopped while loading (${exited}).\n${logTail()}`);
    }
    try {
      const ok = await new Promise((r) => http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); r(res.statusCode === 200); }).on("error", () => r(false)));
      if (ok) { touchEngine(); return status(); }
    } catch {
      /* not listening yet */
    }
    try {
      win?.webContents.send("engine://loading", { seconds: Math.round((Date.now() - started) / 1000), tail: logTail(2) });
    } catch {
      /* the window may be gone */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  stopEngine();
  throw new Error(`the AI engine did not become ready within 10 minutes.\n${logTail()}`);
}

// ── IPC ─────────────────────────────────────────────────────
function register(win) {
  const h = (name, fn) => ipcMain.handle("forge:" + name, async (e, a) => {
    // Every command comes from the app page itself, or it is refused.
    if (!isTrustedSender(e, path.join(__dirname, "..", "dist", "index.html"))) throw new Error("refused: this message did not come from the Forge AI window");
    try { return await fn(a || {}); } catch (e) { throw new Error(e?.message || String(e)); }
  });
  h("preview_register", ({ html }) => preview.register(html));
  h("preview_forget", ({ id }) => { preview.forget(id); return null; });
  h("health", () => ({ runtime_available: fs.existsSync(serverBin()), runtime_id: RUNTIME_ID, models_dir: modelsDir(), app_version: app.getVersion() }));
  h("detect_hardware", hardware);
  h("cpu_label", cpuLabel);
  h("get_settings", () => settings);
  h("set_settings", ({ settings: s }) => { settings = { ...DEFAULTS, ...s }; saveSettings(settings); });
  h("catalogue", () => JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue.json"), "utf8")));
  h("installed_models", installed);
  h("download_model", (a) => downloadModel(win, { dir: modelsDir(), ...a }));
  h("delete_model", ({ fileName }) => { const p = path.join(modelsDir(), safeName(fileName)); if (engine.model_file === fileName) stopEngine(); fs.rmSync(p, { force: true }); fs.rmSync(p + ".part", { force: true }); });
  h("start_engine", startEngine);
  h("ensure_engine", ensureEngine);
  h("resolve_artifact", resolveArtifact);
  h("resolve_projector", resolveProjector);
  h("search_hub", (a) => searchHub(a || {}));
  h("list_repo_files", (a) => listRepoFiles(a || {}));
  // ── attachments ───────────────────────────────────────────
  h("pick_files", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Documents and code", extensions: ["pdf","docx","pptx","xlsx","txt","md","csv","tsv","json","html","css","js","ts","tsx","py","rs","go","java","c","cpp","sh","sql","xml","yml","yaml","log"] },
        { name: "Images", extensions: ["png","jpg","jpeg","webp","gif"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (canceled) return [];
    return Promise.all(filePaths.map(readAttachment));
  });
  h("read_files", ({ paths }) => Promise.all((Array.isArray(paths) ? paths : []).map(readAttachment)));
  h("build_context", ({ files, question, budget }) => {
    const list = Array.isArray(files) ? files : [];
    const cap = Math.max(2000, Number(budget) || 24000);
    const share = Math.floor(cap / Math.max(1, list.length));
    const parts = [];
    const report = [];
    for (const f of list) {
      const { text, trimmed } = selectRelevant(String(f.text || ""), String(question || ""), share);
      parts.push(`<<<FILE: ${f.name}${trimmed ? " (most relevant extracts)" : ""}>>>\n${text}\n<<<END ${f.name}>>>`);
      report.push({ name: f.name, trimmed, chars: text.length });
    }
    return { context: parts.join("\n\n"), report };
  });

  // ── reminders ─────────────────────────────────────────────
  h("parse_when", ({ text }) => parseWhen(text));
  h("reminders_list", () => reminders.list());
  h("reminder_create", ({ text, when, at, repeat }) => {
    if (Number.isFinite(at)) return reminders.create({ text, at, repeat: repeat ?? null });
    const parsed = parseWhen(when ?? text);
    if ("error" in parsed) throw new Error(parsed.error);
    return reminders.create({ text, at: parsed.at, repeat: parsed.repeat });
  });
  h("reminder_update", (patch) => reminders.update(patch || {}));
  h("reminder_delete", ({ id }) => reminders.remove(id));
  h("reminder_snooze", ({ id, minutes }) => reminders.snooze(id, minutes));

  // ── cloud providers ───────────────────────────────────────
  // Keys live only in the keychain and never go back to the renderer. Saved
  // (has a key), verified (last authenticated test passed) and failed are kept
  // as separate facts in provider-state.cjs.
  const PROVIDERS = providerState.PROVIDERS;
  const providerName = (p) => { if (!PROVIDERS.includes(p)) throw new Error("unknown provider"); return p; };
  const keyName = (p) => "provider:" + providerName(p);
  const providerStatus = () => {
    const snap = providerState.snapshot();
    return PROVIDERS.map((p) => ({ provider: p, saved: Boolean(secrets.get(keyName(p))), ...snap[p] }));
  };
  h("provider_status", () => providerStatus());
  h("provider_key_save", ({ provider, key }) => {
    const k = String(key || "").trim();
    if (k.length < 10 || k.length > 300 || /\s/.test(k)) throw new Error("That does not look like an API key. Paste the whole key, with no spaces.");
    secrets.set(keyName(provider), k);
    providerState.disconnect(providerName(provider));
    return providerStatus();
  });
  h("provider_test", async ({ provider }) => {
    const p = providerName(provider);
    const key = secrets.get(keyName(p));
    if (!key) throw new Error("No key is saved for this provider yet.");
    try {
      const { models } = await providers.listModels(p, { apiKey: key });
      providerState.markVerified(p, models);
      return providerStatus();
    } catch (e) {
      const msg = providers.redact(e.message, key);
      providerState.markFailed(p, msg);
      throw new Error(msg);
    }
  });
  h("provider_disconnect", ({ provider }) => { providerState.disconnect(providerName(provider)); return providerStatus(); });
  h("provider_remove", ({ provider }) => {
    const p = providerName(provider);
    secrets.set(keyName(p), "");
    providerState.forget(p);
    return providerStatus();
  });
  h("provider_manual_add", ({ provider, id }) => { providerState.addManual(providerName(provider), id); return providerStatus(); });
  h("provider_manual_remove", ({ provider, id }) => { providerState.removeManual(providerName(provider), String(id)); return providerStatus(); });

  const providerRuns = new Map();
  h("provider_stream", async ({ requestId, provider, model, system, messages }) => {
    const p = providerName(provider);
    if (!/^[\w-]{1,64}$/.test(String(requestId || ""))) throw new Error("invalid request id");
    if (providerRuns.has(requestId)) throw new Error("that request is already running");
    const row = providerState.get(p);
    const key = secrets.get(keyName(p));
    if (!key) throw new Error("No key is saved for this provider.");
    // The model must come from this connection's own list, so a renderer cannot name arbitrary models.
    const listed = row.models.some((m) => m.id === model) || row.manual.includes(model);
    if (!listed) throw new Error("That model is not on this connection's list. Test the connection, or add the model name in Settings.");
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 500) throw new Error("invalid messages");
    const clean = messages.map((m) => {
      if (!["user", "assistant"].includes(m?.role) || typeof m.content !== "string") throw new Error("invalid message");
      return { role: m.role, content: m.content.slice(0, 200_000) };
    });
    const ac = new AbortController();
    providerRuns.set(requestId, ac);
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    try {
      const result = await providers.stream(p, {
        apiKey: key, model,
        system: typeof system === "string" ? system.slice(0, 20_000) : undefined,
        messages: clean, signal: ac.signal,
        onToken: (text) => { if (!ac.signal.aborted) wc?.send("provider://token", { requestId, text }); },
      });
      return { ...result, cancelled: false };
    } catch (e) {
      if (e.kind === "cancelled") return { tokens: 0, stopReason: "cancelled", usage: { input: null, output: null }, cancelled: true };
      throw new Error(providers.redact(e.message, key));
    } finally {
      providerRuns.delete(requestId);
    }
  });
  h("provider_cancel", ({ requestId }) => { const ac = providerRuns.get(requestId); if (ac) ac.abort(); return { cancelled: Boolean(ac) }; });

  // ── skills ────────────────────────────────────────────────
  h("skills_list", () => skills.list());
  h("skills_add", (s) => skills.add(s || {}));
  h("skills_update", (s) => skills.update(s || {}));
  h("skills_delete", ({ id }) => skills.remove(id));
  h("skills_for_prompt", () => skills.forPrompt());
  h("skills_export", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), "forge-ai-skills.json"),
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, JSON.stringify(skills.exportAll(), null, 2));
    return filePath;
  });
  h("skills_import", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (canceled || !filePaths[0]) return null;
    const stat = fs.statSync(filePaths[0]);
    if (stat.size > 2 * 1024 * 1024) throw new Error("That file is too large to be a skills file.");
    return skills.importAll(JSON.parse(fs.readFileSync(filePaths[0], "utf8")));
  });

  // ── connectors ────────────────────────────────────────────
  // The token is written to the keychain and never sent back to the renderer.
  h("connectors_list", () => connectors.list());
  h("connectors_add", (c) => connectors.add(c || {}));
  h("connectors_update", (c) => connectors.update(c || {}));
  h("connectors_delete", ({ id }) => connectors.remove(id));
  h("connectors_call", ({ id, path: p, method, body }) => connectors.call(id, { path: p, method, body }));

  // ── memory ────────────────────────────────────────────────
  h("memory_list", () => memory.list());
  h("memory_add", (m) => memory.add(m || {}));
  h("memory_update", (m) => memory.update(m || {}));
  h("memory_delete", ({ id }) => memory.remove(id));
  h("memory_for_prompt", ({ project } = {}) => memory.forPrompt({ project }));
  h("default_browser_status", () => defaultBrowserStatus());
  h("default_browser_request", () => {
    // Asked for by the person's own button press. The operating system may show its own prompt.
    for (const p of WEB_PROTOCOLS) app.setAsDefaultProtocolClient(p);
    return defaultBrowserStatus();
  });
  h("default_browser_settings", () => {
    // Windows has a settings page for this. macOS and Linux do not expose a reliable link to it.
    if (process.platform !== "win32") return { opened: false };
    shell.openExternal("ms-settings:defaultapps");
    return { opened: true };
  });
  // Saves a PNG from the built-in browser to a place the person chooses.
  h("save_screenshot", async ({ dataUrl }) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) throw new Error("That is not a PNG image.");
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 25 * 1024 * 1024) throw new Error("That screenshot is too large to save.");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("pictures"), "forge-screenshot.png"),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, buf);
    return filePath;
  });
  h("memory_export", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), "forge-ai-memory.json"),
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, JSON.stringify(memory.exportAll(), null, 2));
    return filePath;
  });
  h("memory_import", async ({ replace } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Memory export", extensions: ["json"] }],
    });
    if (canceled || !filePaths[0]) return null;
    return memory.importAll(JSON.parse(fs.readFileSync(filePaths[0], "utf8")), { replace });
  });

  // ── integrations ──────────────────────────────────────────
  h("secret_status", () => ({ available: secrets.available(), providers: secrets.status() }));
  h("secret_clear", ({ provider }) => secrets.set(provider, ""));
  /** Saves a key only after a real call to that provider accepts it. */
  h("secret_connect", async ({ provider, key }) => {
    const value = String(key || "").trim();
    if (!value) throw new Error("paste a key first");
    const result = await research.verify(provider, value);
    secrets.set(provider, value);
    secrets.markVerified(provider, true, result.detail);
    return { connected: true, detail: result.detail };
  });

  // ── web research ──────────────────────────────────────────
  h("research_run", async ({ query, provider }) => {
    const want = provider && provider !== "auto" ? provider : null;
    const px = secrets.get("perplexity");
    const fc = secrets.get("firecrawl");
    const chosen = want ?? (px ? "perplexity" : fc ? "firecrawl" : null);
    // No key saved: answer from open sources instead of failing, and say so in the result.
    if (!chosen) return openWeb.wikipediaSearch(query);
    const key = chosen === "perplexity" ? px : fc;
    if (!key) throw new Error(`${chosen} is not connected.`);
    return chosen === "perplexity"
      ? research.perplexity({ key, query })
      : research.firecrawlSearch({ key, query });
  });
  // Keyless lookups: Wikipedia's public API. No key, and every result carries its source URL.
  h("web_search", ({ query }) => openWeb.wikipediaSearch(query));
  h("web_article", ({ title }) => openWeb.wikipediaSummary(title));
  h("research_scrape", ({ url }) => {
    const key = secrets.get("firecrawl");
    if (!key) throw new Error("Reading a page needs a Firecrawl key, added in Settings → Integrations.");
    if (!/^https?:\/\//.test(String(url))) throw new Error("that is not a web address");
    return research.firecrawlScrape({ key, url });
  });

  // ── updates ───────────────────────────────────────────────
  h("check_update", async (a) => {
    const info = await updater.checkForUpdate(a || {});
    if (translocated()) {
      return {
        ...info,
        installable: false,
        reason:
          "macOS is running Forge AI from a temporary read-only copy, which happens until the app is moved out of Downloads. Drag Forge AI into your Applications folder, open it from there, and updates will install themselves.",
      };
    }
    return info;
  });
  h("download_update", async ({ info }) => {
    const r = await updater.fetchUpdate(info, (p) => win.webContents.send("update://progress", p));
    return r;
  });
  h("apply_update", ({ file }) => updater.applyUpdate({ file }));
  h("reveal_update", ({ file }) => updater.revealUpdate(file));

  // ── publisher avatars ─────────────────────────────────────
  // Shown from Hugging Face at display time; nothing is copied into the app.
  h("publisher_avatar", async ({ author }) => {
    const a = String(author || "").trim();
    if (!/^[\w.-]+$/.test(a)) return { avatar: null };
    for (const url of [
      `https://huggingface.co/api/organizations/${a}/overview`,
      `https://huggingface.co/api/users/${a}/overview`,
    ]) {
      try {
        const d = await getJSON(url);
        const avatar = d && (d.avatarUrl || d.avatar_url || (d.user && d.user.avatarUrl));
        if (typeof avatar === "string" && avatar.startsWith("https://")) return { avatar };
      } catch {
        /* try the next shape, then give up quietly and use the built-in mark */
      }
    }
    return { avatar: null };
  });

  h("open_external", ({ url }) => {
    if (!/^https?:\/\//.test(String(url))) throw new Error("only http(s) links can be opened");
    return shell.openExternal(url);
  });
  h("preview_in_browser", async ({ html, name }) => {
    const dir = path.join(os.tmpdir(), "forge-ai-preview");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, (String(name || "page").replace(/[^a-zA-Z0-9._-]/g, "") || "page") + ".html");
    fs.writeFileSync(file, String(html ?? ""), "utf8");
    await shell.openPath(file);
    return file;
  });
  h("save_text_file", async ({ suggestedName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), String(suggestedName || "forge-ai.html")),
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, String(content ?? ""), "utf8");
    return filePath;
  });
  h("stop_engine", stopEngine);
  h("engine_status", status);
  h("engine_log", () => logTail(200));
  h("open_engine_log", () => shell.showItemInFolder(logFile()));
  h("environment", () => ({
    translocated: translocated(),
    app_path: process.platform === "darwin" ? path.resolve(process.execPath, "..", "..", "..") : process.execPath,
    in_applications: process.execPath.startsWith("/Applications/"),
    models_dir: modelsDir(),
    free_disk_bytes: (() => {
      try {
        const s = fs.statfsSync(modelsDir());
        return s.bavail * s.bsize;
      } catch {
        return 0;
      }
    })(),
    total_memory_bytes: os.totalmem(),
  }));
  h("link_readiness", () => {
    let addr = null;
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
      if (i.family === "IPv4") { const [a, b] = i.address.split(".").map(Number); if (a === 100 && b >= 64 && b <= 127) addr = i.address; }
    }
    return {
      mesh_interface_detected: !!addr,
      mesh_address: addr,
      distributed_inference_enabled: false,
      explanation: addr
        ? "A private mesh address was found on this machine, so the networking side of clustering is in place. Running one model across two computers is still not implemented, so every model runs here."
        : "No private mesh network was found. Clustering is not implemented yet either, so every model runs on this computer.",
    };
  });
}

// ── default browser and incoming links ─────────────────────
// Forge AI asks the operating system to register it for web links only when the person
// presses the button in Settings. It never changes the setting on its own.
const WEB_PROTOCOLS = ["https", "http"];
const defaultBrowserStatus = () => ({
  is_default: WEB_PROTOCOLS.every((p) => app.isDefaultProtocolClient(p)),
  platform: process.platform,
});
// Links that arrive from outside (another app, or the OS) open in the built-in browser.
const pendingLinks = [];
function openLink(url) {
  try { openWeb.checkPageUrl(url); } catch { return; }
  const w = BrowserWindow.getAllWindows()[0];
  if (!w || !w.webContents || w.webContents.isLoading()) { pendingLinks.push(url); return; }
  w.webContents.send("browser://open", { url });
}
const linkFrom = (argv) => (Array.isArray(argv) ? argv.find((a) => /^https?:\/\//i.test(String(a))) : null);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    const link = linkFrom(argv);
    if (link) openLink(link);
  });
}
app.on("open-url", (event, url) => { event.preventDefault(); openLink(url); });

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1280, Math.round(workAreaSize.width * 0.9));
  const height = Math.min(840, Math.round(workAreaSize.height * 0.9));
  const win = new BrowserWindow({
    width, height, minWidth: 820, minHeight: 560, center: true, show: false,
    title: "Forge AI", backgroundColor: "#f6f5f3",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  // Links received before the page was ready are delivered once it has loaded.
  win.webContents.once("did-finish-load", () => {
    for (const url of pendingLinks.splice(0)) win.webContents.send("browser://open", { url });
  });
  const firstLink = linkFrom(process.argv);
  if (firstLink) pendingLinks.push(firstLink);
  return win;
}

// The built-in browser runs web pages in <webview> guests. Each guest is locked down before
// it loads: no preload script, no Node, sandboxed, a separate storage partition, https only,
// and no popups. A page cannot change these settings from its own code.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const onlyPublicHttps = (event, url) => {
    try { openWeb.checkPageUrl(url); } catch { event.preventDefault(); }
  };
  contents.on("will-navigate", onlyPublicHttps);
  contents.on("will-redirect", onlyPublicHttps);
});
app.on("web-contents-created", (_event, contents) => {
  if (!contents || contents.getType() !== "window") return;
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    // Strip anything the renderer asked for, and enforce the guest settings.
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.partition = "persist:forge-browser";
    try { openWeb.checkPageUrl(params.src || ""); } catch { event.preventDefault(); }
  });
});

app.whenReady().then(() => {
  protocol.handle(preview.SCHEME, (req) => {
    const r = preview.respond(req.url);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });
  settings = loadSettings();
  updater.cleanupOldBundles();
  secrets.load(root());
  memory.load(root());
  skills.load(root());
  providerState.load(root());
  connectors.load(root());
  // The renderer is a file:// page; let it read the loopback engine's streamed replies.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["http://127.0.0.1/*"] }, (d, cb) => {
    const h = d.responseHeaders || {};
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith("access-control-")) delete h[k];
    h["Access-Control-Allow-Origin"] = ["*"]; h["Access-Control-Allow-Headers"] = ["*"]; h["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
    cb({ responseHeaders: h, statusLine: d.method === "OPTIONS" ? "HTTP/1.1 204 No Content" : d.statusLine });
  });
  win = createWindow();
  register(win);
  reminders.load(root(), (r, late) => {
    try {
      win.webContents.send("reminder://fired", { reminder: r, late });
    } catch {
      /* the window may be gone; the notification already fired */
    }
  });
  reminders.schedule();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { stopEngine(); reminders.stop(); app.quit(); });
app.on("before-quit", stopEngine);
