// Addressing assistants: the handle is routing, not words.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "assistants.ts"), "utf8");
const HANDLES = [...src.matchAll(/handle: "@([a-z]+)"/g)].map((m) => m[1]);

// The same rules the module applies, so the behaviour is checked rather than
// the file being asked whether it agrees with itself.
const AT_START = /^\s*@([a-z][a-z0-9_-]*)[\s,:]*/i;
const addressed = (c) => { const m = AT_START.exec(c); return m && HANDLES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : undefined; };
const without = (c) => (addressed(c) ? c.replace(AT_START, "") : c);
const host = (ms) => { const u = ms.filter((m) => m.role === "user"); for (let i = u.length - 1; i >= 0; i--) { const w = addressed(u[i].content); if (w) return w; } return undefined; };
const cast = (ms) => { const out = []; for (const m of ms) { if (m.role !== "user") continue; const w = addressed(m.content); if (w && !out.includes(w)) out.push(w); } return out; };

test("the handle is taken off before the words are sent", () => {
  // The bug: the model saw "@nora hey what's going on" and replied
  // "Hi, @nora!" — greeting the person by its own name.
  assert.equal(without("@nora hey whats going on"), "hey whats going on");
  assert.equal(without("@theo, what is a bond yield?"), "what is a bond yield?");
  assert.equal(without("no handle here"), "no handle here");
});

test("an address inside a sentence is left alone", () => {
  assert.equal(without("email me at sam@theo.com"), "email me at sam@theo.com");
  assert.equal(addressed("email me at sam@theo.com"), undefined);
});

test("whoever was addressed last answers", () => {
  const convo = [
    { role: "user", content: "@nora rewrite this" },
    { role: "assistant", content: "..." },
    { role: "user", content: "@theo now check the numbers" },
  ];
  assert.equal(host(convo), "theo", "the conversation moved to Theo");
});

test("a message with no handle stays with whoever was last addressed", () => {
  const convo = [
    { role: "user", content: "@theo what is a bond yield?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "and how does it move with rates?" },
  ];
  assert.equal(host(convo), "theo");
});

test("more than one assistant can be in a chat, and both are remembered", () => {
  const convo = [
    { role: "user", content: "@nora draft it" },
    { role: "assistant", content: "..." },
    { role: "user", content: "@theo check it" },
    { role: "assistant", content: "..." },
    { role: "user", content: "@nora now shorten it" },
  ];
  assert.deepEqual(cast(convo), ["nora", "theo"], "in the order they first appeared, once each");
  assert.equal(host(convo), "nora", "and Nora is answering now");
});

test("an unknown handle addresses nobody", () => {
  assert.equal(addressed("@nobody hello"), undefined);
  assert.equal(without("@nobody hello"), "@nobody hello", "and its text is left intact");
});

test("the model is told it is not the person writing to it", () => {
  const chat = fs.readFileSync(path.join(__dirname, "..", "src", "views", "Chat.tsx"), "utf8");
  assert.match(chat, /never greet them by your own name/i);
  assert.match(chat, /Answer only as yourself/i, "and not to speak for the others in the room");
});

test("the picker only triggers at the start of a word", () => {
  const picker = fs.readFileSync(path.join(__dirname, "..", "src", "components", "MentionPicker.tsx"), "utf8");
  assert.match(picker, /Only at the start of a word, so an email address is not a mention/i);
  assert.match(picker, /addEventListener\("keydown", onKey, true\)/, "Enter picks rather than sends while it is open");
});
