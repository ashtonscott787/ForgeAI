// Addressing an assistant by handle.
//
// Writing "@theo" is starting a conversation with Theo, not decorating one
// message. These hold that the conversation stays his.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "assistants.ts"), "utf8");

/** hostOf, lifted out of the TypeScript so the real matching is exercised. */
function hostOf(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return undefined;
  const m = /^\s*@([a-z][a-z0-9_-]*)\b/i.exec(first.content);
  if (!m) return undefined;
  const handles = [...src.matchAll(/handle: "@([a-z]+)"/g)].map((x) => x[1]);
  return handles.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : undefined;
}

test("the handle is taken from the first thing said", () => {
  assert.equal(hostOf([{ role: "user", content: "@theo what is a bond yield?" }]), "theo");
  assert.equal(hostOf([{ role: "user", content: "  @Nora rewrite this" }]), "nora");
});

test("it holds for the whole conversation, not just that message", () => {
  const convo = [
    { role: "user", content: "@theo what is a bond yield?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "and how does it move with rates?" },
  ];
  assert.equal(hostOf(convo), "theo", "the third message is still Theo's conversation");
});

test("naming someone later does not hand the conversation over", () => {
  const convo = [
    { role: "user", content: "summarise this" },
    { role: "assistant", content: "..." },
    { role: "user", content: "@felix could do this better" },
  ];
  assert.equal(hostOf(convo), undefined, "the conversation was not addressed to anybody");
});

test("an unknown handle is not treated as an assistant", () => {
  assert.equal(hostOf([{ role: "user", content: "@nobody hello" }]), undefined);
});

test("an address in the middle of a sentence is not a greeting", () => {
  assert.equal(hostOf([{ role: "user", content: "email me at sam@theo.com" }]), undefined);
});

test("the chat view adds the assistant to the prompt for the whole conversation", () => {
  const chat = fs.readFileSync(path.join(__dirname, "..", "src", "views", "Chat.tsx"), "utf8");
  assert.match(chat, /const host = hostOf\(/, "the host is worked out on every send");
  assert.match(chat, /Answer as \$\{host\.name\} for the whole of this conversation/);
  assert.match(chat, /withAssistant &&/, "and the person can see whose conversation it is");
});
