/**
 * Forge AI as a tool for Claude or ChatGPT.
 *
 * This is a Model Context Protocol server. Point Claude Code, the Claude
 * desktop app or ChatGPT's developer mode at it and they can hand work to the
 * model on this machine instead of doing it themselves — which is the point:
 * a question answered here costs nothing against a subscription's limits and
 * never leaves the computer.
 *
 * It runs on its own. The Forge AI window does not have to be open; this
 * starts its own copy of the engine from the installed app, uses a model
 * already downloaded, and stops it again when the conversation ends.
 *
 *   node electron/mcp-server.cjs
 *
 * In Claude Code:
 *   claude mcp add forge-ai -- node "/Applications/Forge AI.app/Contents/Resources/app.asar/electron/mcp-server.cjs"
 *
 * Overrides, for a development checkout or an unusual install:
 *   FORGE_ENGINE_DIR   where llama-server lives
 *   FORGE_MODELS_DIR   where the .gguf files live
 *   FORGE_MODEL        which model file to use by default
 */
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const env = require("./environment.cjs");

const reasoning = require("./reasoning.cjs");

const PROTOCOL = "2025-06-18";
const NAME = "forge-ai";

// ── where things are ────────────────────────────────────────
function userData() {
  const n = "Forge AI";
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", n);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), n);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), n);
}

const modelsDir = () => process.env.FORGE_MODELS_DIR || path.join(userData(), "models");

function engineDir() {
  if (process.env.FORGE_ENGINE_DIR) return process.env.FORGE_ENGINE_DIR;
  // Inside the packaged app this file sits in Resources/app.asar/electron,
  // and the engine is its sibling in Resources.
  const packaged = path.resolve(__dirname, "..", "..", "engine");
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, "..", "engine-dev");
}

const serverBin = () => path.join(engineDir(), process.platform === "win32" ? "llama-server.exe" : "llama-server");

const isProjector = (f) => /^mmproj[-.]/i.test(f) || /[-.]mmproj[-.]/i.test(f);

function models() {
  const d = modelsDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith(".gguf") && !isProjector(f))
    .map((f) => ({ file: f, bytes: fs.statSync(path.join(d, f)).size }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

// ── the engine ──────────────────────────────────────────────
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

let engine = null; // { proc, port, file }

async function engineFor(file) {
  if (engine && engine.file === file) return engine;
  if (engine) stopEngine();
  const bin = serverBin();
  if (!fs.existsSync(bin)) throw new Error(`The engine is not where this expected it: ${bin}. Set FORGE_ENGINE_DIR.`);
  const model = path.join(modelsDir(), path.basename(file));
  if (!fs.existsSync(model)) throw new Error(`No such model: ${file}. Ask for forge_models to see what is here.`);

  const port = await freePort();
  // Its own key, made fresh here, for the same reason the app's engine has
  // one: 127.0.0.1 keeps other machines out and other programs on this one
  // in, and the engine answers any origin that asks.
  const key = require("node:crypto").randomBytes(24).toString("hex");
  const proc = spawn(bin, ["--model", model, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "4096", "--no-webui", "--api-key", key], {
    cwd: engineDir(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PATH: engineDir() + path.delimiter + (process.env.PATH || "") },
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  proc.on("exit", () => { if (engine && engine.proc === proc) engine = null; });

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`The engine stopped while starting.\n${stderr.trim().split("\n").slice(-6).join("\n")}`);
    if (Date.now() > deadline) { proc.kill("SIGKILL"); throw new Error("The engine did not become ready within two minutes."); }
    const ok = await new Promise((r) => {
      // /health needs no key; everything else does.
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); r(res.statusCode === 200); });
      req.on("error", () => r(false));
      req.setTimeout(1500, () => { req.destroy(); r(false); });
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  engine = { proc, port, file: path.basename(file), key };
  return engine;
}

function stopEngine() {
  if (!engine) return;
  try { engine.proc.kill(); } catch { /* already gone */ }
  engine = null;
}

function postJson(url, body, timeoutMs = 600_000, key = "") {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`The engine answered with something that is not JSON: ${out.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("The engine took too long to answer.")); });
    req.end(data);
  });
}

const getJson = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { accept: "application/json" } }, (res) => {
    let out = "";
    res.on("data", (c) => { out += c; });
    res.on("end", () => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
  req.on("error", reject);
  req.setTimeout(15_000, () => req.destroy(new Error("timed out")));
});

// ── the tools ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "forge_ask",
    description:
      "Put a question or a piece of work to the language model running on this computer. "
      + "Use it to spend local compute instead of your own context or usage allowance: summarising, drafting, "
      + "rewriting, classifying, extracting, answering from text you paste in. The model is small, so prefer it "
      + "for bounded work and keep the hardest reasoning for yourself. Nothing sent here leaves the machine.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the local model should do." },
        system: { type: "string", description: "Optional instruction about how to answer." },
        model: { type: "string", description: "A file name from forge_models. Defaults to the only model, or FORGE_MODEL." },
        max_tokens: { type: "integer", description: "Upper bound on the length of the reply. Default 1024." },
        temperature: { type: "number", description: "0 for the same answer every time, higher for more variety. Default 0.7." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "forge_models",
    description: "List the language models downloaded on this computer, with their file names and sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_machine",
    description: "Describe the computer this is running on: operating system, processor, cores, memory, uptime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_now",
    description: "The current date, time, weekday and time zone on this computer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_weather",
    description:
      "Current weather for a latitude and longitude. Forge AI never looks up where the user is; "
      + "coordinates must be supplied. This is the only tool here that uses the network.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        label: { type: "string", description: "What to call the place in the answer." },
      },
      required: ["lat", "lon"],
    },
  },
];

function defaultModel() {
  if (process.env.FORGE_MODEL) return process.env.FORGE_MODEL;
  const list = models();
  if (!list.length) throw new Error("No models are downloaded. Open Forge AI and download one first.");
  return list[0].file;
}

async function call(name, args = {}) {
  switch (name) {
    case "forge_models": {
      const list = models();
      if (!list.length) return "No models are downloaded on this computer yet.";
      return list.map((m) => `${m.file} — ${(m.bytes / 1024 ** 3).toFixed(2)} GB`).join("\n");
    }
    case "forge_machine": {
      const m = env.machine();
      return Object.entries(m).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
    }
    case "forge_now": {
      const t = env.now();
      return `${t.date}, ${t.time} (${t.timezone}, UTC${t.utc_offset})`;
    }
    case "forge_weather": {
      const w = await env.weather({ lat: args.lat, lon: args.lon, label: args.label }, getJson);
      if (!w.known) return w.why;
      return `${w.place}: ${w.description}, ${w.temperature_c}°C (feels like ${w.feels_like_c}°C), `
        + `humidity ${w.humidity_pct}%, wind ${w.wind_kmh} km/h`;
    }
    case "forge_ask": {
      const file = args.model || defaultModel();
      const e = await engineFor(file);
      const messages = [];
      if (args.system) messages.push({ role: "system", content: String(args.system) });
      messages.push({ role: "user", content: String(args.prompt ?? "") });
      // A reasoning model needs room to think and then answer. Asked for
      // 1024 tokens flat, the shipped R1 distill spent all of them thinking
      // and returned an empty string, which this tool passed on as the
      // answer.
      const fields = reasoning.requestFields(file, args.max_tokens);
      const body = {
        messages,
        ...fields,
        temperature: Number.isFinite(args.temperature) ? args.temperature : 0.7,
        stream: false,
      };
      let r = await postJson(`http://127.0.0.1:${e.port}/v1/chat/completions`, body, 600_000, e.key);
      if (r && r.error && fields.reasoning_budget) {
        // An older build refuses the field outright rather than ignoring it.
        const { reasoning_budget: _drop, ...plain } = body;
        r = await postJson(`http://127.0.0.1:${e.port}/v1/chat/completions`, plain, 600_000, e.key);
      }
      const choice = r && r.choices && r.choices[0];
      const message = (choice && choice.message) || {};
      const text = typeof message.content === "string" ? message.content : "";
      if (!choice) throw new Error(`The engine answered in an unexpected shape: ${JSON.stringify(r).slice(0, 300)}`);
      // Never hand back an empty string as though it were an answer.
      const why = reasoning.explainEmpty({
        content: text,
        reasoning: message.reasoning_content,
        finishReason: choice.finish_reason,
        modelLabel: file,
        maxTokens: fields.max_tokens,
      });
      if (why) throw new Error(why);
      return text.trim();
    }
    default:
      throw new Error(`No such tool: ${name}`);
  }
}

// ── the protocol ────────────────────────────────────────────
function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: require("../package.json").version },
      instructions:
        "Forge AI runs a language model on this computer. Hand it work with forge_ask to spend local "
        + "compute rather than your own allowance, and nothing you send it leaves the machine.",
    };
  }
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "ping") return {};
  if (method === "tools/call") {
    return call(params && params.name, (params && params.arguments) || {}).then(
      (text) => ({ content: [{ type: "text", text: String(text) }] }),
      // A failed tool is reported to the caller as a result it can read and
      // act on, not as a protocol error, which is what the specification asks
      // for and what lets the model try something else.
      (e) => ({ content: [{ type: "text", text: e.message }], isError: true }),
    );
  }
  if (typeof id === "undefined") return undefined; // a notification
  const err = new Error(`Unknown method: ${method}`);
  err.code = -32601;
  throw err;
}

function serve(input = process.stdin, output = process.stdout) {
  let buf = "";
  const send = (o) => output.write(JSON.stringify(o) + "\n");
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      let out;
      try { out = handle(msg); } catch (e) {
        if (typeof msg.id !== "undefined") send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message } });
        continue;
      }
      if (out === undefined) continue;
      Promise.resolve(out).then(
        (result) => { if (typeof msg.id !== "undefined") send({ jsonrpc: "2.0", id: msg.id, result }); },
        (e) => { if (typeof msg.id !== "undefined") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } }); },
      );
    }
  });
  input.on("end", () => { stopEngine(); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopEngine(); process.exit(0); });
}

module.exports = { TOOLS, handle, call, serve, models, modelsDir, engineDir, stopEngine };

if (require.main === module) serve();
