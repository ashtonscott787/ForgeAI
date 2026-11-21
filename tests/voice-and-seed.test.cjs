// Asking the same thing twice should not replay the same sentences, and the
// model should be told what day it is rather than inventing one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "lib", f), "utf8");

test("every ordinary request carries a fresh seed", () => {
  const chat = src("chat.ts");
  assert.match(chat, /seed:\s*freshSeed\(\)/, "chat is sampled with a new seed each time");
  assert.match(chat, /temperature:\s*0\.8/, "and is actually sampled, not greedy");
});

test("describing an image stays repeatable", () => {
  // A picture should not be described differently each time it is opened.
  assert.match(src("chat.ts"), /temperature:\s*0,\s*seed:\s*0/);
});

test("the seed is drawn fresh and stays inside the range the engine accepts", () => {
  // freshSeed is renderer TypeScript, so what is checked here is the one
  // thing that can silently go wrong: a constant creeping in where the random
  // draw should be, or a range the server rejects.
  const chat = src("chat.ts");
  const fn = chat.slice(chat.indexOf("export function freshSeed"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /random\(\)/, "it draws from the injected random source");
  assert.match(body, /0x7fffffff/, "and keeps inside 32 bits");
  assert.ok(!/return\s+\d+\s*;/.test(body), "it never returns a constant");
});

test("the house rules tell it not to sound like a form letter", () => {
  const p = src("prompt.ts");
  assert.match(p, /How to sound/i);
  assert.match(p, /not? open every reply the same way/i);
  assert.match(p, /offer of further help/i, "and to stop ending every answer the same way");
});

test("the facts about now are added to the prompt when they are known", () => {
  const p = src("prompt.ts");
  assert.match(p, /environment = ""/, "the prompt takes them");
  assert.match(p, /if \(environment\) out \+=/, "and includes them when there are any");
});

test("chat asks for them and passes them on", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /environmentFacts\(\)/, "the app fetches them at startup");
  const chat = fs.readFileSync(path.join(__dirname, "..", "src", "views", "Chat.tsx"), "utf8");
  assert.match(chat, /systemPrompt\(memories, enabledSkills, props\.environment/, "and chat hands them to the model");
});
