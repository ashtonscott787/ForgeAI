// Forge AI offered to Claude and ChatGPT as a tool.
//
// The point of this server is that a question can be answered by the model on
// this computer instead of by a subscription, so what matters is that another
// program can actually drive it: speak the protocol over stdin and stdout, be
// told what the tools are, and call one. These tests do exactly that, through
// a real child process, rather than calling the functions directly.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "electron", "mcp-server.cjs");

/** Speaks newline-delimited JSON-RPC to the server and collects the replies. */
function converse(requests, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    });
    const out = [];
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no answer in ${timeoutMs}ms; stderr: ${stderr}`)); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= requests.filter((r) => "id" in r).length) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(out);
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

test("another program can open a session and be told what is on offer", async () => {
  const [init, list] = await converse([rpc(1, "initialize", { protocolVersion: "2025-06-18" }), rpc(2, "tools/list")]);
  assert.equal(init.result.serverInfo.name, "forge-ai");
  assert.ok(init.result.capabilities.tools, "it offers tools");
  assert.match(init.result.instructions, /this computer/i, "and says what it is for");

  const names = list.result.tools.map((t) => t.name);
  for (const want of ["forge_ask", "forge_models", "forge_machine", "forge_now", "forge_weather"]) {
    assert.ok(names.includes(want), `${want} is offered`);
  }
  for (const t of list.result.tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} explains itself`);
    assert.equal(t.inputSchema.type, "object", `${t.name} has a schema`);
  }
});

test("the tool that costs nothing is described as the reason to use this at all", () => {
  const ask = require("../electron/mcp-server.cjs").TOOLS.find((t) => t.name === "forge_ask");
  assert.match(ask.description, /local compute|usage allowance/i, "it says why a caller would reach for it");
  assert.match(ask.description, /leaves the machine/i, "and that nothing is sent away");
  // It must not oversell a small model.
  assert.match(ask.description, /small/i, "and is honest that the model is small");
});

test("it answers questions about this computer without any model running", async () => {
  const [, machine, when] = await converse([
    rpc(1, "initialize"),
    rpc(2, "tools/call", { name: "forge_machine", arguments: {} }),
    rpc(3, "tools/call", { name: "forge_now", arguments: {} }),
  ]);
  assert.match(machine.result.content[0].text, /os:/i);
  assert.match(machine.result.content[0].text, /cores:/i);
  assert.match(when.result.content[0].text, /\d{4}/, "the year is in there");
});

test("asking without a model says so plainly instead of hanging", async () => {
  const [, r] = await converse([
    rpc(1, "initialize"),
    rpc(2, "tools/call", { name: "forge_ask", arguments: { prompt: "hello" } }),
  ], { env: { FORGE_MODELS_DIR: path.join(__dirname, "fixtures", "no-models-here") } });
  assert.equal(r.result.isError, true, "it is reported as a failed tool call");
  assert.match(r.result.content[0].text, /No models are downloaded/i);
});

test("a failing tool comes back as a result the caller can read, not a protocol error", async () => {
  const [, r] = await converse([rpc(1, "initialize"), rpc(2, "tools/call", { name: "no_such_tool", arguments: {} })]);
  assert.equal(r.error, undefined, "the call itself succeeded");
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No such tool/i);
});

test("weather needs coordinates, and never looks up where anyone is", async () => {
  const [, r] = await converse([
    rpc(1, "initialize"),
    rpc(2, "tools/call", { name: "forge_weather", arguments: {} }),
  ]);
  assert.match(r.result.content[0].text, /does not look up where you are/i);

  const src = require("node:fs").readFileSync(SERVER, "utf8")
    + require("node:fs").readFileSync(path.join(__dirname, "..", "electron", "environment.cjs"), "utf8");
  for (const service of ["ipapi", "ip-api", "ipinfo", "geoip", "ipgeolocation"]) {
    assert.ok(!src.includes(service), `nothing calls ${service}`);
  }
});

test("an unparseable line does not take the server down", async () => {
  const child = require("node:child_process").spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  const got = new Promise((resolve) => {
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n").filter(Boolean);
      if (lines.length >= 2) { child.kill(); resolve(lines.map((l) => JSON.parse(l))); }
    });
  });
  child.stdin.write("{ this is not json\n");
  child.stdin.write(JSON.stringify(rpc(7, "tools/list")) + "\n");
  const [bad, good] = await got;
  assert.equal(bad.error.code, -32700, "the bad line is reported");
  assert.ok(good.result.tools.length > 0, "and the next one is still answered");
});
