// Five assistants must not produce one voice, and none of them should answer
// a greeting with a brochure.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
const assistants = read("lib", "assistants.ts");
const prompt = read("lib", "prompt.ts");
const chat = read("views", "Chat.tsx");

// Escaped quotes inside a manner would truncate a naive match, and a
// truncated string then looks "too thin" for reasons that are the test's
// fault rather than the code's.
const manners = [...assistants.matchAll(/manner: "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

test("each assistant has a manner of its own", () => {
  assert.equal(manners.length, 5, "one for each");
  assert.equal(new Set(manners).size, 5, "no two share it");
});

test("a manner describes a habit, not a mood", () => {
  // "is friendly" does nothing to the output; "quotes the document rather
  // than paraphrasing" does.
  for (const m of manners) {
    assert.ok(m.length > 60, `too thin to change anything: ${m}`);
    assert.ok(!/^(is |be )?(friendly|helpful|professional|polite|warm)\b/i.test(m), `an adjective, not a habit: ${m}`);
  }
});

test("the manner is actually sent, not merely stored", () => {
  assert.match(chat, /How you talk: \$\{host\.manner\}/);
});

test("nothing opens with a greeting or thanks you for asking", () => {
  const flat = prompt.replace(/\s+/g, " ");
  assert.match(flat, /Never open with a greeting/i);
  assert.match(flat, /never thank them for the question/i);
  assert.match(flat, /Begin with the answer/i);
});

test("a hello gets a human answer, not a list of capabilities", () => {
  // The reported reply was "Hi, @nora! ... I'm here to help with any
  // questions you have. What's on your mind today?"
  assert.match(prompt.replace(/\s+/g, " "), /do not list what you can do for them unless they ask/i);
});

test("it asks who is speaking instead of reasoning aloud about it", () => {
  // The reported reply was "Based on the conversation history, I don't have
  // any evidence to suggest that I'm speaking as an AI running a search...
  // Therefore, I conclude that the user is speaking as themselves."
  assert.match(prompt.replace(/\s+/g, " "), /Do not reason aloud about who might be speaking/i);
});

test("every reply is sampled afresh, so the same question is not replayed", () => {
  assert.match(read("lib", "chat.ts"), /seed: freshSeed\(\)/);
});
