// forge_ask, against a stand-in engine.
//
// From the 0.7.1 report: forge_ask with max_tokens: 20 returned about 600
// tokens that stopped mid-word ("…captured by chloroplasts, whe"), with
// isError: false. Two causes — the limit was multiplied by four with a
// floor of 3072, and a cut-off answer looked identical to a complete one.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const reasoning = require(path.join(__dirname, "..", "electron", "reasoning.cjs"));

/**
 * An engine that answers with as many tokens as it was allowed, the way a
 * model with nothing capping its thinking does.
 */
function engine({ ignoreBudget = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const asked = JSON.parse(body || "{}");
      seen.push(asked);
      // Spends everything it is given, which is the behaviour that turned a
      // 20-token request into six hundred tokens.
      const budget = asked[reasoning.BUDGET_FIELD] || 0;
      const room = ignoreBudget ? asked.max_tokens : asked.max_tokens - budget;
      const words = Array.from({ length: Math.max(1, room) }, (_, i) => `word${i}`).join(" ");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: words }, finish_reason: "length" }],
      }));
    });
  });
  return { server, seen };
}

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

test("the request carries the asked length plus room to think, not four times it", () => {
  const fields = reasoning.requestFields("DeepSeek-R1-Distill-Qwen-1.5B.gguf", 20);
  const budget = reasoning.budgetFor("DeepSeek-R1-Distill-Qwen-1.5B.gguf", 20);
  assert.equal(budget.answer_tokens, 20);
  assert.equal(fields.max_tokens, 20 + budget.reasoning_budget);
  assert.ok(fields[reasoning.BUDGET_FIELD] > 0, "sent under the name the engine reads");
  assert.ok(fields.max_tokens < 3072, "the floor that caused this is gone");
});

test("an engine that spends its whole allowance still yields an answer of the asked length", async () => {
  const { server } = engine({ ignoreBudget: true });
  const port = await listen(server);
  try {
    const budget = reasoning.budgetFor("DeepSeek-R1-Distill.gguf", 20);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...reasoning.requestFields("DeepSeek-R1-Distill.gguf", 20), messages: [] }),
    });
    const body = await res.json();
    const choice = body.choices[0];
    const raw = choice.message.content;
    // What the engine sent back is far more than was asked for.
    assert.ok(raw.split(" ").length > 500, "the engine ignored the budget, as some builds do");

    // What the caller receives is not.
    const capped = reasoning.capAnswer(raw, budget.answer_tokens);
    assert.equal(capped.cut, true);
    assert.ok(capped.text.length <= budget.answer_tokens * 4);
    const note = reasoning.explainTruncated({ content: raw, finishReason: choice.finish_reason, answerTokens: budget.answer_tokens });
    assert.match(note, /cut off at the 20-token limit/);
  } finally {
    server.close();
  }
});

test("an engine that honours the budget leaves the answer the asked length", async () => {
  const { server, seen } = engine({ ignoreBudget: false });
  const port = await listen(server);
  try {
    const fields = reasoning.requestFields("DeepSeek-R1-Distill.gguf", 20);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, messages: [] }),
    });
    const body = await res.json();
    assert.equal(seen[0][reasoning.BUDGET_FIELD], fields[reasoning.BUDGET_FIELD], "the budget was sent");
    const words = body.choices[0].message.content.split(" ").length;
    assert.equal(words, 20, "and the answer came back the length that was asked for");
  } finally {
    server.close();
  }
});

test("a complete answer carries no note at all", () => {
  const note = reasoning.explainTruncated({ content: "Wellington.", finishReason: "stop", answerTokens: 1024 });
  assert.equal(note, null);
  assert.equal(reasoning.capAnswer("Wellington.", 1024).cut, false);
});

test("forge_ask declares what its limit means and offers strict", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp-server.cjs"), "utf8");
  const schema = src.slice(src.indexOf("name: \"forge_ask\""), src.indexOf("name: \"forge_models\""));
  assert.match(schema, /length of the ANSWER/, "the description says what the number bounds");
  assert.match(schema, /strict/, "and a caller can refuse a partial answer");

  const impl = src.slice(src.indexOf('case "forge_ask"'), src.indexOf('default:'));
  assert.match(impl, /capAnswer/, "the answer is held to the limit here, not only at the engine");
  assert.match(impl, /explainTruncated|cut off at the/, "and a cut answer says so");
  assert.match(impl, /budgetHonoured/, "whether the engine took the budget is judged from the reply");
  assert.match(impl, /stripStrayThink/, "and a closing tag for a block that never opened is removed");
});

test("a tool may answer with more than one piece of content", () => {
  // The note travels beside the answer rather than being glued onto it,
  // so a caller can read the text without the warning in the middle of it.
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp-server.cjs"), "utf8");
  assert.match(src, /Array\.isArray\(out\)/, "a tool result may be a list of content items");
});
