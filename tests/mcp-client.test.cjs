// Forge AI connecting out to other tools.
//
// The peer in most of these is Forge AI's own MCP server, which makes the
// pair testable end to end: if the client can start it, read what it offers
// and call one of its tools, then both halves speak the protocol for real
// rather than each agreeing with a mock of the other.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, describe: describeServer, looksWriting, inspect } = require("../electron/mcp-client.cjs");

const OWN_SERVER = { name: "forge-ai", command: process.execPath, args: [path.join(__dirname, "..", "electron", "mcp-server.cjs")] };

/** Writes a tiny MCP server to a temp file and returns a spec pointing at it. */
function fakeServer(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-"));
  const file = path.join(dir, "server.cjs");
  fs.writeFileSync(file, body);
  return { spec: { name: "fake", command: process.execPath, args: [file] }, dir };
}

const SKELETON = (tools, extra = "") => `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") reply(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "Fake", version: "1.0" }, instructions: "A stand-in." });
    else if (m.method === "tools/list") reply(m.id, { tools: ${JSON.stringify(tools)} });
    else if (m.method === "tools/call") { ${extra || 'reply(m.id, { content: [{ type: "text", text: "did " + m.params.name }] });'} }
  }
});
function reply(id, result) { if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`;

test("it connects to Forge AI's own server and reads what is there", async () => {
  const conn = new Connection(OWN_SERVER);
  try {
    await conn.start();
    assert.equal(conn.info.name, "forge-ai");
    const names = conn.tools.map((t) => t.name);
    assert.ok(names.includes("forge_now"), "it can see the tools");
    assert.ok(conn.instructions.length > 0, "and what the server says it is for");
  } finally {
    conn.stop();
  }
});

test("it can actually run one of the other server's tools", async () => {
  const conn = new Connection(OWN_SERVER);
  try {
    await conn.start();
    const r = await conn.call("forge_machine", {});
    assert.equal(r.failed, false);
    assert.match(r.text, /cores:/i, "the answer came back from the other process");
  } finally {
    conn.stop();
  }
});

test("a tool the server does not have is refused here, not sent and hoped for", async () => {
  const conn = new Connection(OWN_SERVER);
  try {
    await conn.start();
    await assert.rejects(() => conn.call("not_a_tool", {}), /does not offer a tool/i);
  } finally {
    conn.stop();
  }
});

test("a tool that fails on the far side comes back marked as failed", async () => {
  const conn = new Connection(OWN_SERVER);
  try {
    await conn.start();
    // No location is set, so this reports rather than throwing.
    const r = await conn.call("forge_weather", {});
    assert.match(r.text, /does not look up where you are/i);
  } finally {
    conn.stop();
  }
});

test("a server that will not start is reported, not left hanging", async () => {
  const r = await inspect({ name: "nope", command: path.join(os.tmpdir(), "definitely-not-a-program-xyz"), args: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0, "it says what went wrong");
});

test("a server that never answers times out instead of waiting forever", async () => {
  const { spec } = fakeServer("setInterval(() => {}, 1000);"); // reads nothing, says nothing
  const conn = new Connection({ ...spec, startTimeoutMs: 400 });
  try {
    await assert.rejects(() => conn.start(), /did not answer initialize/i);
  } finally {
    conn.stop();
  }
});

test("what a server offers is described for a person deciding whether to allow it", async () => {
  const { spec } = fakeServer(SKELETON([
    { name: "search_notes", description: "Find a note by its text." },
    { name: "delete_note", description: "Remove a note for good." },
  ]));
  const r = await inspect(spec);
  assert.equal(r.ok, true);
  assert.match(r.description, /Fake 1\.0 — 2 tools/);
  assert.match(r.description, /A stand-in\./, "the server's own words are included");
  assert.match(r.description, /search_notes — Find a note by its text\./);
  assert.match(r.description, /one appears to change something: delete_note/i,
    "the one that writes is called out");
  assert.match(r.description, /a guess from the wording, not a guarantee/i,
    "and it is honest that this is a guess");
});

test("a tool that describes nothing is marked as such rather than glossed over", async () => {
  const { spec } = fakeServer(SKELETON([{ name: "mystery" }]));
  const r = await inspect(spec);
  assert.match(r.description, /mystery — it does not say what this does/i);
});

test("a server with no tools says so", async () => {
  const { spec } = fakeServer(SKELETON([]));
  const r = await inspect(spec);
  assert.match(r.description, /nothing an agent could call/i);
});

test("writing tools are guessed from the words, with underscores handled", () => {
  for (const n of ["write_file", "delete-thing", "sendEmail", "run_command"]) {
    assert.equal(looksWriting({ name: n }), true, `${n} looks like it changes something`);
  }
  for (const n of ["read_file", "list_items", "forge_ask", "get_status"]) {
    assert.equal(looksWriting({ name: n }), false, `${n} does not`);
  }
});

test("inspecting does not call anything", async () => {
  const { spec, dir } = fakeServer(SKELETON(
    [{ name: "fire_the_missiles", description: "Does the thing." }],
    `require("node:fs").writeFileSync(require("node:path").join(__dirname, "CALLED"), "x"); reply(m.id, { content: [] });`,
  ));
  await inspect(spec);
  assert.equal(fs.existsSync(path.join(dir, "CALLED")), false, "connecting runs nothing");
});
