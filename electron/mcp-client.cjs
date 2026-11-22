/**
 * Connecting Forge AI to other tools over the Model Context Protocol.
 *
 * The other half of electron/mcp-server.cjs. That one lets Claude or ChatGPT
 * drive Forge AI; this one lets Forge AI drive everything else — a filesystem
 * server, a database, a company's internal tools, anything that speaks MCP.
 *
 * What "understand them" means here: a server is asked what it offers and the
 * answer is read back in plain words, so somebody can see what connecting it
 * would let an agent do before anything is allowed to run. Nothing is called
 * merely by connecting.
 *
 * Transport is stdio: the server is a program on this computer, started as a
 * child process and spoken to over its standard input and output. That keeps
 * the whole arrangement local, which is the point of this application.
 */
const { spawn } = require("node:child_process");

const PROTOCOL = "2025-06-18";
const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * One connection to one server.
 *
 * Deliberately small: start, ask what it has, call one of them, stop. There is
 * no reconnection and no queueing of work across a restart, because a tool
 * that silently came back as something else is worse than one that is plainly
 * not there.
 */
class Connection {
  constructor({ name, command, args = [], env = {}, cwd, startTimeoutMs, callTimeoutMs }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    // Held on the connection rather than as file constants so a test can
    // prove the timeout happens instead of waiting twenty seconds for it.
    this.startTimeoutMs = startTimeoutMs || START_TIMEOUT_MS;
    this.callTimeoutMs = callTimeoutMs || CALL_TIMEOUT_MS;
    this.proc = null;
    this.tools = [];
    this.info = null;
    this.instructions = "";
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
  }

  get running() {
    return !!this.proc && this.proc.exitCode === null;
  }

  async start() {
    if (this.running) return this;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...this.env },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this.#read(d));
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code, signal) => {
      const why = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      for (const [, p] of this.pending) p.reject(new Error(`${this.name} ${why}.`));
      this.pending.clear();
    });
    this.proc.on("error", (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
    });

    const hello = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "forge-ai", version: require("../package.json").version },
    }, this.startTimeoutMs);
    this.info = hello.serverInfo || null;
    this.instructions = hello.instructions || "";
    this.#notify("notifications/initialized");

    const listed = await this.request("tools/list", {}, this.startTimeoutMs);
    this.tools = Array.isArray(listed.tools) ? listed.tools : [];
    return this;
  }

  #read(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // not ours to interpret
      const waiting = this.pending.get(msg.id);
      if (!waiting) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message || "the server reported an error"));
      else waiting.resolve(msg.result);
    }
  }

  #notify(method, params) {
    if (!this.running) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }

  request(method, params, timeoutMs = this.callTimeoutMs) {
    if (!this.proc) return Promise.reject(new Error(`${this.name} is not running.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Runs one of the server's tools and returns its text. */
  async call(tool, args = {}) {
    if (!this.tools.some((t) => t.name === tool)) {
      throw new Error(`${this.name} does not offer a tool called ${tool}.`);
    }
    const r = await this.request("tools/call", { name: tool, arguments: args });
    const text = (r && Array.isArray(r.content) ? r.content : [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { text, failed: r && r.isError === true };
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already gone */ }
    this.proc = null;
  }
}

/**
 * What a server is, said in words.
 *
 * This is the "understand it" step. It is written for somebody deciding
 * whether to let an agent use the thing, so it leads with what the tools would
 * let it do, and says plainly when a server offers nothing or describes
 * nothing. It never guesses at a purpose from the server's name.
 */
function describe(conn) {
  const name = (conn.info && conn.info.name) || conn.name;
  const version = conn.info && conn.info.version ? ` ${conn.info.version}` : "";
  const lines = [`${name}${version} — ${conn.tools.length} ${conn.tools.length === 1 ? "tool" : "tools"}.`];
  if (conn.instructions) lines.push(conn.instructions.trim());
  if (!conn.tools.length) {
    lines.push("It offers nothing an agent could call.");
    return lines.join("\n");
  }
  const writers = conn.tools.filter((t) => looksWriting(t));
  for (const t of conn.tools) {
    const d = (t.description || "").trim().split("\n")[0];
    lines.push(`- ${t.name}${d ? ` — ${d}` : " — it does not say what this does."}`);
  }
  if (writers.length) {
    lines.push(`Of these, ${writers.length === 1 ? "one appears to change something" : `${writers.length} appear to change something`}`
      + `: ${writers.map((t) => t.name).join(", ")}. Treat that as a guess from the wording, not a guarantee —`
      + " only the server knows what it really does.");
  }
  return lines.join("\n");
}

/** A guess, from the name and description alone, at whether a tool writes. */
function looksWriting(tool) {
  // Underscores and hyphens are word characters to a regular expression, so
  // write_file does not match \bwrite\b until they are turned into spaces.
  const hay = `${tool.name} ${tool.description || ""}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // sendEmail
    .replace(/[_-]+/g, " ")                  // send_email, send-email
    .toLowerCase();
  return /\b(write|writes|create|creates|delete|deletes|remove|removes|update|updates|edit|edits|send|sends|publish|publishes|post|posts|put|upload|uploads|move|moves|rename|renames|install|installs|run|runs|execute|executes)\b/.test(hay);
}

/** Opens a connection, reads what it offers, and closes it again. */
async function inspect(spec) {
  const conn = new Connection(spec);
  try {
    await conn.start();
    return { ok: true, name: (conn.info && conn.info.name) || spec.name, tools: conn.tools, description: describe(conn) };
  } catch (e) {
    const detail = conn.stderr.trim().split("\n").slice(-3).join(" ");
    return { ok: false, name: spec.name, tools: [], description: "", error: detail ? `${e.message} ${detail}` : e.message };
  } finally {
    conn.stop();
  }
}

module.exports = { Connection, describe, looksWriting, inspect, PROTOCOL };
