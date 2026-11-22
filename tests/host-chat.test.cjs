// Addressing an assistant by handle.
//
// Writing "@theo" is starting a conversation with Theo, not decorating one
// message. These hold that the conversation stays his.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "assistants.ts"), "utf8");

const HANDLES = [...src.matchAll(/handle: "@([a-z]+)"/g)].map((x) => x[1]);
const AT_START = /^\s*@([a-z][a-z0-9_-]*)[\s,:]*/i;

/** The same rule the module applies: the latest address wins. */
function hostOf(messages) {
  const users = messages.filter((m) => m.role === "user");
  for (let i = users.length - 1; i >= 0; i--) {
    const m = AT_START.exec(users[i].content);
    const h = m && m[1].toLowerCase();
    if (h && HANDLES.includes(h)) return h;
  }
  return undefined;
}

test("the handle is read from the message that carries it", () => {
  assert.equal(hostOf([{ role: "user", content: "@theo what is a bond yield?" }]), "theo");
  assert.equal(hostOf([{ role: "user", content: "  @Nora rewrite this" }]), "nora");
});

test("it holds until somebody else is addressed", () => {
  const convo = [
    { role: "user", content: "@theo what is a bond yield?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "and how does it move with rates?" },
  ];
  assert.equal(hostOf(convo), "theo", "the third message is still Theo's conversation");
});

test("addressing somebody new mid-conversation hands it to them", () => {
  // This used to assert the opposite: the handle was read only from the
  // first message, so writing "@theo" later did nothing at all and the
  // original assistant kept answering. Being able to bring somebody else
  // into a chat is the point of having names.
  const convo = [
    { role: "user", content: "summarise this" },
    { role: "assistant", content: "..." },
    { role: "user", content: "@felix could do this better" },
  ];
  assert.equal(hostOf(convo), "felix");
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
  assert.match(chat, /Answer as \$\{host\.name\}\./);
  assert.match(chat, /never greet them by your own name/i, "and knows it is not the person writing");
  assert.match(chat, /withAssistant &&/, "and the person can see whose conversation it is");
});
