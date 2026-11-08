// Forge AI desktop shell (Electron). Mirrors the Tauri command surface so the
// same React frontend runs unchanged. Inference is the bundled llama.cpp
// `llama-server`, bound to 127.0.0.1 on a free port.
const { app, BrowserWindow, ipcMain, screen, shell, session, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const RUNTIME_ID = "llamacpp-b12180";
const IDLE_UNLOAD_MS = 20 * 60 * 1000;
const GiB = 1024 ** 3;
const root = () => path.join(app.getPath("userData"));
const modelsDir = () => { const d = path.join(root(), "models"); fs.mkdirSync(d, { recursive: true }); return d; };
const settingsFile = () => path.join(root(), "settings.json");
const engineDir = () => app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(__dirname, "..", "engine-dev");
const serverBin = () => path.join(engineDir(), process.platform === "win32" ? "llama-server.exe" : "llama-server");

// ── settings ────────────────────────────────────────────────
const DEFAULTS = { theme: "system", context_size: 8192, gpu_layers: 999, threads: null, selected_model: null, experimental_cluster: false };
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
    usable_model_bytes: usableBytes(ram, 0, mac), runtimes: [RUNTIME_ID], links: [], load: 0, online: true,
  };
}
const cpuLabel = () => `${os.cpus()[0]?.model?.trim() ?? "CPU"} · ${os.cpus().length} threads`;

// ── models ──────────────────────────────────────────────────
const safeName = (n) => { if (!n || n !== path.basename(n) || !n.endsWith(".gguf")) throw new Error("invalid model file name"); return n; };
function installed() {
  return fs.readdirSync(modelsDir()).filter((f) => f.endsWith(".gguf"))
    .map((f) => ({ file_name: f, bytes: fs.statSync(path.join(modelsDir(), f)).size }));
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
async function download(win, { modelId, url, fileName, sha256 }) {
  const name = safeName(fileName);
  const final = path.join(modelsDir(), name), part = final + ".part";
  if (fs.existsSync(final)) return final;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await get(url, have ? { Range: `bytes=${have}-` } : {});
  if (res.statusCode === 200) have = 0; // server ignored Range: restart
  else if (res.statusCode !== 206) { res.resume(); throw new Error(`download failed: HTTP ${res.statusCode}`); }
  const total = have + Number(res.headers["content-length"] || 0);
  const free = (() => { try { return fs.statfsSync(modelsDir()).bavail * fs.statfsSync(modelsDir()).bsize; } catch { return Infinity; } })();
  if (total - have > free) { res.resume(); throw new Error("not enough free disk space for this model"); }
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  let received = have, last = 0, lastBytes = have, t0 = Date.now();
  await new Promise((resolve, reject) => {
    res.on("data", (c) => {
      received += c.length;
      const now = Date.now();
      if (now - last > 250) {
        const bps = ((received - lastBytes) * 1000) / Math.max(1, now - (last || t0));
        last = now; lastBytes = received;
        win.webContents.send("download://progress", { model_id: modelId, received, total, bytes_per_sec: bps, done: false });
      }
    });
    res.pipe(out);
    res.on("error", reject); out.on("error", reject); out.on("finish", resolve);
  });
  if (sha256) {
    const h = crypto.createHash("sha256");
    await new Promise((r, j) => fs.createReadStream(part).on("data", (c) => h.update(c)).on("end", r).on("error", j));
    if (h.digest("hex") !== sha256.toLowerCase()) { fs.rmSync(part); throw new Error("downloaded file failed its checksum and was discarded"); }
  }
  fs.renameSync(part, final);
  win.webContents.send("download://progress", { model_id: modelId, received, total, bytes_per_sec: 0, done: true });
  return final;
}


// ── Hugging Face resolution ─────────────────────────────────
// Catalogue entries name a repository, not a file. The exact GGUF file name is
// read from the repository at download time, so a renamed upload does not turn
// into a dead link inside the app.
function getJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ForgeAI/0.2", Accept: "application/json" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); resolve(getJSON(new URL(res.headers.location, url).toString(), redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Hugging Face returned HTTP ${res.statusCode}`)); return; }
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("unreadable reply from Hugging Face")); } });
    }).on("error", (e) => reject(new Error(`cannot reach Hugging Face: ${e.message}`)));
  });
}
async function resolveArtifact({ repo, quant }) {
  const tree = await getJSON(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`);
  const ggufs = (Array.isArray(tree) ? tree : []).filter((f) => f.type === "file" && /\.gguf$/i.test(f.path));
  if (!ggufs.length) throw new Error(`no GGUF files found in ${repo}`);
  const whole = ggufs.filter((f) => !/-\d{5}-of-\d{5}\./.test(f.path)); // skip split uploads
  const pool = whole.length ? whole : ggufs;
  const want = String(quant || "Q4_K_M").toLowerCase().replace(/[^a-z0-9]/g, "");
  const norm = (p) => p.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = pool.filter((f) => norm(f.path).includes(want));
  const chosen = (exact.length ? exact : pool).sort((a, b) => size(a) - size(b))[0];
  return {
    repo, quant, matched_requested_quant: exact.length > 0,
    file_name: chosen.path.split("/").pop(),
    url: `https://huggingface.co/${repo}/resolve/main/${encodeURI(chosen.path)}?download=true`,
    bytes: size(chosen),
    sha256: (chosen.lfs && typeof chosen.lfs.oid === "string" && chosen.lfs.oid.length === 64) ? chosen.lfs.oid : "",
    available_quants: [...new Set(pool.map((f) => (f.path.match(/(IQ|Q)\d[^.\-]*|f16|BF16/i) || [""])[0]).filter(Boolean))],
  };
}
const size = (f) => (f.lfs && f.lfs.size) || f.size || 0;

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
let idleTimer = null;
function touchEngine() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (engine.proc) stopEngine(); }, IDLE_UNLOAD_MS);
}
async function ensureEngine({ modelFile }) {
  if (engine.proc && engine.model_file === modelFile) { touchEngine(); return status(); }
  return startEngine({ modelFile });
}
async function startEngine({ modelFile }) {
  stopEngine();
  const model = path.join(modelsDir(), safeName(modelFile));
  if (!fs.existsSync(model)) throw new Error("model file not found — download it first");
  if (!fs.existsSync(serverBin())) throw new Error("AI engine missing from this copy of Forge AI");
  const port = await freePort();
  const args = ["--model", model, "--ctx-size", String(settings.context_size), "--port", String(port), "--host", "127.0.0.1", "--n-gpu-layers", String(settings.gpu_layers)];
  if (settings.threads) args.push("--threads", String(settings.threads));
  const log = fs.createWriteStream(logFile(), { flags: "w" });
  const proc = spawn(serverBin(), args, { cwd: engineDir(), windowsHide: true, env: { ...process.env, PATH: engineDir() + path.delimiter + process.env.PATH } });
  proc.stdout.pipe(log); proc.stderr.pipe(log);
  let exited = null;
  proc.on("exit", (code) => { exited = code; if (engine.proc === proc) engine = { proc: null, port: 0, model_file: null }; });
  proc.on("error", (e) => { exited = String(e); });
  engine = { proc, port, model_file: modelFile };
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      const tail = (() => { try { return fs.readFileSync(logFile(), "utf8").split("\n").slice(-8).join("\n"); } catch { return ""; } })();
      throw new Error(`the AI engine stopped while loading (${exited}).\n${tail}`);
    }
    try {
      const ok = await new Promise((r) => http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); r(res.statusCode === 200); }).on("error", () => r(false)));
      if (ok) { touchEngine(); return status(); }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  stopEngine();
  throw new Error("the AI engine did not become ready within 3 minutes");
}

// ── IPC ─────────────────────────────────────────────────────
function register(win) {
  const h = (name, fn) => ipcMain.handle("forge:" + name, async (_e, a) => {
    try { return await fn(a || {}); } catch (e) { throw new Error(e?.message || String(e)); }
  });
  h("health", () => ({ runtime_available: fs.existsSync(serverBin()), runtime_id: RUNTIME_ID, models_dir: modelsDir(), app_version: app.getVersion() }));
  h("detect_hardware", hardware);
  h("cpu_label", cpuLabel);
  h("get_settings", () => settings);
  h("set_settings", ({ settings: s }) => { settings = { ...DEFAULTS, ...s }; saveSettings(settings); });
  h("catalogue", () => JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue.json"), "utf8")));
  h("installed_models", installed);
  h("download_model", (a) => download(win, a));
  h("delete_model", ({ fileName }) => { const p = path.join(modelsDir(), safeName(fileName)); if (engine.model_file === fileName) stopEngine(); fs.rmSync(p, { force: true }); fs.rmSync(p + ".part", { force: true }); });
  h("start_engine", startEngine);
  h("ensure_engine", ensureEngine);
  h("resolve_artifact", resolveArtifact);
  h("search_hub", (a) => searchHub(a || {}));
  h("list_repo_files", (a) => listRepoFiles(a || {}));
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
  h("link_readiness", () => {
    let addr = null;
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
      if (i.family === "IPv4") { const [a, b] = i.address.split(".").map(Number); if (a === 100 && b >= 64 && b <= 127) addr = i.address; }
    }
    return { mesh_interface_detected: !!addr, mesh_address: addr, distributed_inference_enabled: false,
      explanation: "Distributed inference is not enabled in this release. A Tailscale-style mesh address is detected for future clustering, but models only run on this computer." };
  });
}

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1280, Math.round(workAreaSize.width * 0.9));
  const height = Math.min(840, Math.round(workAreaSize.height * 0.9));
  const win = new BrowserWindow({
    width, height, minWidth: 820, minHeight: 560, center: true, show: false,
    title: "Forge AI", backgroundColor: "#f6f5f3",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return win;
}

app.whenReady().then(() => {
  settings = loadSettings();
  // The renderer is a file:// page; let it read the loopback engine's streamed replies.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["http://127.0.0.1/*"] }, (d, cb) => {
    const h = d.responseHeaders || {};
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith("access-control-")) delete h[k];
    h["Access-Control-Allow-Origin"] = ["*"]; h["Access-Control-Allow-Headers"] = ["*"]; h["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
    cb({ responseHeaders: h, statusLine: d.method === "OPTIONS" ? "HTTP/1.1 204 No Content" : d.statusLine });
  });
  const win = createWindow();
  register(win);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { stopEngine(); app.quit(); });
app.on("before-quit", stopEngine);
