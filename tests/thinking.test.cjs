// Reasoning models put their working in <think> tags. It must never be
// mistaken for the answer, and must survive being read mid-stream.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// blocks.ts is TypeScript, so it is compiled once into a throwaway directory.
const OUT = path.join(require("node:os").tmpdir(), `forge-blocks-${process.pid}`);
test.before(() => {
  execFileSync("npx", ["tsc", "src/lib/blocks.ts", "--module", "commonjs", "--target", "es2020", "--outDir", OUT, "--skipLibCheck"], {
    cwd: path.join(__dirname, ".."), stdio: "pipe",
  });
});
test.after(() => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {} });
const load = () => require(path.join(OUT, "blocks.js"));

test("a finished think block is split from the answer", () => {
  const { parseSegments } = load();
  const segs = parseSegments("<think>The user wants 2+2. That is 4.</think>The answer is 4.");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].kind, "thinking");
  assert.equal(segs[0].open, false, "a closed tag is finished working");
  assert.match(segs[0].text, /2\+2/);
  assert.equal(segs[1].kind, "text");
  assert.match(segs[1].text, /The answer is 4/);
  assert.ok(!segs[1].text.includes("2+2"), "the working never leaks into the answer");
});

test("a think block still being written is marked open", () => {
  const { parseSegments } = load();
  const segs = parseSegments("<think>Still working this out");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "thinking");
  assert.equal(segs[0].open, true, "an unterminated tag is still in progress");
});

test("the other spellings models use are recognised", () => {
  const { parseSegments } = load();
  for (const tag of ["think", "thinking", "reasoning"]) {
    const segs = parseSegments(`<${tag}>working</${tag}>answer`);
    assert.equal(segs[0].kind, "thinking", `<${tag}> is understood`);
    assert.equal(segs[1].text.trim(), "answer");
  }
});

test("a reply with no think tags is unchanged", () => {
  const { parseSegments } = load();
  const segs = parseSegments("Just an answer, with `code` in it.");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "text");
});

test("code blocks around the working still parse", () => {
  const { parseSegments } = load();
  const segs = parseSegments("<think>pick python</think>Here:\n\n```python\nprint(1)\n```\n");
  const kinds = segs.map((s) => s.kind);
  assert.ok(kinds.includes("thinking"), "the working is separated");
  assert.ok(kinds.includes("code"), "the code block is still a code block");
  const code = segs.find((s) => s.kind === "code");
  assert.match(code.code, /print\(1\)/);
});

test("several think blocks in one reply are all separated", () => {
  const { parseSegments } = load();
  const segs = parseSegments("<think>one</think>first<think>two</think>second");
  assert.equal(segs.filter((s) => s.kind === "thinking").length, 2);
  const text = segs.filter((s) => s.kind === "text").map((s) => s.text.trim()).join("|");
  assert.equal(text, "first|second");
});
