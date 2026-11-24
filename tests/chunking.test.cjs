// Input longer than the context window.
//
// A ten-thousand-token prompt through Claude Code failed and the engine's
// raw JSON — "exceeds the available context size (4096 tokens)" — came back
// as the answer. Two faults: the MCP server started engines with a fixed
// 4096-token context, and nothing checked the length before sending.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const c = require(path.join(__dirname, "..", "electron", "chunking.cjs"));

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const paragraphs = (n, each = 60) => Array.from({ length: n }, (_, i) => `Paragraph ${i}. ${words(each)}`).join("\n\n");

test("something that fits is not split", () => {
  const p = c.planFor("a short note", 8192);
  assert.equal(p.needed, false);
  assert.deepEqual(p.parts, ["a short note"]);
  assert.equal(c.describePlan(p), "", "and nothing is said about it");
});

test("something too long is split, and nothing is lost", () => {
  const p = c.planFor(paragraphs(60), 4096);
  assert.equal(p.needed, true);
  assert.ok(p.parts.length > 1);
  const joined = p.parts.join("\n\n");
  for (let i = 0; i < 60; i += 7) {
    assert.match(joined, new RegExp(`Paragraph ${i}\\.`), `paragraph ${i} survived`);
  }
});

test("every part fits the budget", () => {
  const p = c.planFor(paragraphs(120), 4096);
  for (const part of p.parts) {
    assert.ok(part.length / c.CHARS_PER_TOKEN <= p.budget);
  }
});

test("it cuts at a boundary rather than mid-word where it can", () => {
  const parts = c.splitText(paragraphs(40), 400);
  assert.ok(parts.length > 1);
  for (const part of parts.slice(1)) {
    assert.match(part, /^(Paragraph|word)/, `starts cleanly: ${part.slice(0, 30)}`);
  }
});

test("a wall of characters with no breaks is still split", () => {
  const parts = c.splitText("x".repeat(20000), 500);
  assert.ok(parts.length > 1);
  assert.equal(parts.join("").length, 20000, "and nothing is dropped");
});

test("each part is read against the actual question", () => {
  const out = c.mapPrompt("what is the total due?", "Invoice total $4,250.00", 0, 3);
  assert.match(out, /part 1 of 3/);
  assert.match(out, /what is the total due\?/);
  assert.match(out, /NOTHING/, "a part with nothing in it can say so");
});

test("the last pass is told not to go beyond the notes", () => {
  const out = c.reducePrompt("what is the total?", ["total is $4,250.00", "NOTHING", "due 30 Nov"]);
  assert.match(out, /\$4,250\.00/);
  assert.doesNotMatch(out, /NOTHING/, "parts that said nothing are left out");
  assert.match(out, /do not invent anything that is not in them/);
});

test("the engine's own count is used when it will give one", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const { content } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tokens: content.split(/\s+/).filter(Boolean).map((_, i) => i) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await c.countTokens({ baseUrl: base, text: "one two three" }), 3);
  } finally {
    server.close();
  }
  // No engine: null, so the caller falls back to the estimate rather than
  // treating zero as a length.
  assert.equal(await c.countTokens({ baseUrl: "http://127.0.0.1:1", text: "x" }), null);
});

test("something that cannot be split says so in two numbers, not in JSON", () => {
  const why = c.tooLong({ tokens: 10500, contextTokens: 4096, answerTokens: 1024 });
  assert.match(why, /10,500 tokens/);
  assert.match(why, /3,072/, "and the room there actually is");
  assert.doesNotMatch(why, /[{}]/, "no raw engine shape in a message meant for a person");
});

test("the window and the MCP server read the same implementation", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  const mcp = fs.readFileSync(path.join(root, "electron", "mcp-server.cjs"), "utf8");
  assert.match(mcp, /require\("\.\/chunking\.cjs"\)/, "the MCP server calls it directly");

  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  assert.match(main, /h\("chunk_plan"/, "and the window asks for a plan over IPC");

  // The renderer had its own copy. Two implementations of the same
  // splitting is the arrangement that produced two engine manifests and
  // two command-line builders.
  assert.equal(fs.existsSync(path.join(root, "src", "lib", "chunking.ts")), false, "no second copy in the renderer");
});
