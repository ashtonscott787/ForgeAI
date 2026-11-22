// What the chat does when the engine refuses a request.
//
// "The inference runtime returned 400." was what a person saw when anything
// went wrong, which names no cause and suggests no fix. The engine always
// says why in the body; these tests hold that we read it, and that a request
// refused over a sampling field is tried again without one rather than
// becoming a red message.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "chat.ts"), "utf8");

test("a refusal is read out of the body, not reported as a bare number", () => {
  assert.match(src, /await res\.text\(\)/, "the body is read");
  assert.match(src, /error\?\.message/, "an OpenAI-shaped error is understood");
  assert.match(src, /The model could not answer: \$\{why\}/, "and what it said is shown");
  assert.ok(!/returned \$\{res\.status\}\.`\)/.test(src), "the old bare-status message is gone");
});

test("the status is still reported, for the cases where the body says nothing", () => {
  assert.match(src, /gave no reason/i);
  assert.match(src, /HTTP \$\{res\.status\}/);
});

test("a request refused with a 4xx is tried once more without the sampling fields", () => {
  assert.match(src, /res\.status >= 400 && res\.status < 500/, "only client refusals");
  assert.match(src, /const plain = await send\(core\)/, "the second attempt carries only the core fields");
  assert.match(src, /if \(plain\.ok\) res = plain/, "and is used only if it worked");
});

test("the core of a request carries nothing that an engine could refuse", () => {
  // The declaration itself, not the prose around it: the comment above it
  // mentions the seed, and matching that proved nothing.
  const line = src.slice(src.indexOf("const core ="));
  const core = line.slice(0, line.indexOf("\n"));
  for (const field of ["temperature", "top_p", "seed"]) {
    assert.ok(!core.includes(field), `${field} is not in the core body`);
  }
  for (const field of ["messages", "stream", "cache_prompt"]) {
    assert.ok(core.includes(field), `${field} is`);
  }
});

test("a server error is not retried, because retrying it would not help", () => {
  // A 500 means the engine broke, not that it disliked the request.
  const guard = src.slice(src.indexOf("res.status >= 400"), src.indexOf("const plain"));
  assert.match(guard, /< 500/);
});
