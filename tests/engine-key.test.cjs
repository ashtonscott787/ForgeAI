// The engine's own key.
//
// llama-server binds to 127.0.0.1, which keeps other machines out but not
// other programs on this one — and that includes any web page open in a
// browser, which can reach localhost and which the engine answers with
// Access-Control-Allow-Origin: *. Its log said so on every launch: "no API
// key is set and CORS allows all origins". A page could find the port and
// use the model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const main = read("electron", "main.cjs");
const mcp = read("electron", "mcp-server.cjs");
const share = read("electron", "share-server.cjs");
const chat = read("src", "lib", "chat.ts");

test("every engine this app starts is started with a key", () => {
  for (const [name, src] of [["the app", main], ["the MCP server", mcp]]) {
    assert.match(src, /"--api-key"/, `${name} passes --api-key`);
  }
});

test("the key is made fresh and never written down", () => {
  assert.match(main, /randomBytes\(\d+\)\.toString\("hex"\)/, "generated, not a constant");
  assert.match(mcp, /randomBytes\(\d+\)\.toString\("hex"\)/);
  // A key in the settings file survives the process that made it, and is
  // then readable by anything that can read the file.
  assert.doesNotMatch(main, /engineKey[^\n]*saveSettings|settings\.engine_key/, "never stored in settings");
  assert.doesNotMatch(main, /writeFileSync[^\n]*engineKey/, "never written to disk");
});

test("the flag the engine actually understands is the one passed", () => {
  // Checked against the shipped binary rather than from memory: the flag
  // lives in libllama-common, and a wrong name would make the engine refuse
  // to start at all.
  const lib = path.join(root, "engine", "libllama-common.dylib");
  if (!fs.existsSync(lib)) return; // no macOS engine in this checkout
  const strings = fs.readFileSync(lib);
  assert.ok(strings.includes("--api-key"), "the engine takes --api-key");
});

test("every caller sends it", () => {
  assert.match(chat, /Authorization: `Bearer \$\{apiKey\}`/, "the chat window");
  assert.match(share, /authorization: `Bearer \$\{engine\.api_key\}`/, "the share server, forwarding");
  assert.match(mcp, /authorization: `Bearer \$\{key\}`/, "the MCP server");
});

test("credentials are refused, and the origin list is left alone on purpose", () => {
  assert.match(main, /"--no-cors-credentials"/, "a page cannot use an ambient cookie against the engine");
  // Tightening --cors-origins to "localhost" would break the app: its window
  // is loaded with loadFile, so its requests carry Origin: null, which does
  // not match, and the browser would refuse the reply. The key is the
  // control; this records why the obvious change was not made.
  assert.doesNotMatch(main, /"--cors-origins"/, "origins are not narrowed blind");
  assert.match(main, /Origin: null/, "and the reason is written down where the flag is");
});

test("the flags passed are flags this engine has", () => {
  const lib = path.join(root, "engine", "libllama-common.dylib");
  if (!fs.existsSync(lib)) return;
  const bin = fs.readFileSync(lib);
  for (const flag of ["--api-key", "--no-cors-credentials"]) {
    assert.ok(bin.includes(flag), `the engine takes ${flag}`);
  }
});

test("the key reaches the window only while an engine is running", () => {
  // status() is what the renderer is told. An empty string when nothing is
  // running means a stale key cannot be used against a later engine.
  assert.match(main, /api_key: engine\.proc \? engineKey : ""/);
});

test("the share server's own token and the engine's key stay separate", () => {
  // The caller's token gets them through the share endpoint. The engine's
  // key gets the share endpoint through to the engine. Confusing the two
  // would hand a remote caller the local key.
  const forward = share.slice(share.indexOf("const up = http.request"), share.indexOf("up.on(\"error\""));
  assert.doesNotMatch(forward, /share_token|settings\.share_token/, "the caller's token is not forwarded");
  assert.match(forward, /engine\.api_key/);
});

test("the key is used as a header and never written into a response", () => {
  // ensureEngine now hands the share server the whole engine status, key
  // included. It must reach exactly one place: the Authorization header on
  // the hop to the engine. Anything that serialises it would send a local
  // secret to whoever is on the other end of a shared endpoint.
  // Lines, not occurrences: the header line names it twice, once to test
  // and once to use.
  const lines = share.split("\n").filter((l) => l.includes("api_key"));
  assert.equal(lines.length, 1, "exactly one line in the share server touches it");
  assert.match(lines[0], /authorization/i, "and that line is the header");

  for (const bad of [/res\.end\([^)]*api_key/, /JSON\.stringify\([^)]*engine\b[^)]*\)/]) {
    assert.doesNotMatch(share, bad, "no response carries the engine object");
  }
});
