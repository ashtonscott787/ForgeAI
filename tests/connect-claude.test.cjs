// Writing Forge AI into Claude's and ChatGPT's list of MCP servers.
//
// This writes into another application's configuration, so the tests are
// mostly about what it must not do to a file it did not create.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const connect = require("../electron/connect-claude.cjs");

const WHO = { execPath: "/Applications/Forge AI.app/Contents/MacOS/Forge AI", serverPath: "/Applications/Forge AI.app/Contents/Resources/app.asar/electron/mcp-server.cjs" };

/** Runs a case against a temporary config file in place of the real one. */
function withConfig(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfg-"));
  const file = path.join(dir, "claude_desktop_config.json");
  if (contents !== null) fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the entry runs this application's own Electron, so nothing else must be installed", () => {
  const e = connect.entry(WHO);
  assert.equal(e.command, WHO.execPath);
  assert.deepEqual(e.args, [WHO.serverPath]);
  assert.equal(e.env.ELECTRON_RUN_AS_NODE, "1", "which is what makes that binary behave as node");
});

test("every other server in the file survives being connected", () => {
  withConfig(JSON.stringify({
    mcpServers: { filesystem: { command: "npx", args: ["-y", "server-filesystem"] } },
    someOtherKey: { kept: true },
  }), (file) => {
    const r = connect.connect("claude", { ...WHO, file });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(after.mcpServers.filesystem, "the other server is still there");
    assert.deepEqual(after.someOtherKey, { kept: true }, "and a key this app knows nothing about");
    assert.equal(after.mcpServers["forge-ai"].command, WHO.execPath);
  });
});

test("a file that is not valid JSON is left exactly as it was", () => {
  const broken = '{ "mcpServers": { oops';
  withConfig(broken, (file) => {
    const r = connect.connect("claude", { ...WHO, file });
    assert.equal(r.ok, false);
    assert.match(r.why, /left alone/i);
    assert.equal(fs.readFileSync(file, "utf8"), broken, "not one character changed");
  });
});

test("a missing file is created rather than reported as a problem", () => {
  withConfig(null, (file) => {
    const r = connect.connect("claude", { ...WHO, file });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.ok(fs.existsSync(file));
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["forge-ai"]);
  });
});

test("connecting twice changes nothing the second time", () => {
  withConfig(null, (file) => {
    connect.connect("claude", { ...WHO, file });
    const again = connect.connect("claude", { ...WHO, file });
    assert.equal(again.changed, false);
    assert.match(again.note, /already connected/i);
  });
});

test("an entry pointing at an old install is replaced, not duplicated", () => {
  withConfig(JSON.stringify({ mcpServers: { "forge-ai": { command: "/old/path", args: [] } } }), (file) => {
    const r = connect.connect("claude", { ...WHO, file });
    assert.equal(r.changed, true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(Object.keys(after.mcpServers).length, 1);
    assert.equal(after.mcpServers["forge-ai"].command, WHO.execPath);
  });
});

test("planning says what would happen and writes nothing", () => {
  withConfig(JSON.stringify({ mcpServers: { other: {} } }), (file) => {
    const before = fs.readFileSync(file, "utf8");
    const p = connect.plan("claude", { ...WHO, file });
    assert.equal(p.ok, true);
    assert.equal(p.already, false);
    assert.deepEqual(p.others, ["other"], "it says what else is in there");
    assert.equal(fs.readFileSync(file, "utf8"), before, "and the file is untouched");
  });
});

test("disconnecting removes only our entry", () => {
  withConfig(JSON.stringify({ mcpServers: { keep: { command: "x" } } }), (file) => {
    connect.connect("claude", { ...WHO, file });
    const r = connect.disconnect("claude", { file });
    assert.equal(r.changed, true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(after.mcpServers.keep, "the other one stays");
    assert.equal(after.mcpServers["forge-ai"], undefined);
  });
});

test("the command for Claude Code quotes paths with spaces", () => {
  const c = connect.command(WHO);
  assert.match(c, /claude mcp add forge-ai/);
  assert.match(c, /ELECTRON_RUN_AS_NODE=1/);
  assert.ok(c.includes(`"${WHO.execPath}"`), "a path with a space is quoted");
});
