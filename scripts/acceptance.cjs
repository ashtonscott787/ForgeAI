#!/usr/bin/env node
/**
 * The acceptance tests from the scaling brief, as something runnable.
 *
 * These are not unit tests. Every one of them needs a real machine with a
 * real model on it, and several need particular hardware — an Apple Silicon
 * Mac, a Windows laptop with no dedicated GPU, a PC with an NVIDIA card. So
 * this script is meant to be run on each of those machines in turn, and it
 * says plainly which checks it could not make here rather than passing them
 * quietly.
 *
 *   node scripts/acceptance.cjs                  against a running Forge AI
 *   node scripts/acceptance.cjs --engine URL     against an engine directly
 *
 * What it cannot do: install the app, click anything, or judge whether the
 * interface looked right. Those stay human.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const results = [];
const record = (id, state, note) => {
  results.push({ id, state, note });
  const mark = state === "pass" ? "PASS" : state === "fail" ? "FAIL" : "SKIP";
  console.log(`${mark}  ${id}${note ? ` — ${note}` : ""}`);
};

const ENGINE = flag("--engine") || process.env.FORGE_ENGINE_URL || "";
const KEY = flag("--key") || process.env.FORGE_ENGINE_KEY || "";

async function ask(prompt, { maxTokens = 400, system } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const started = Date.now();
  const res = await fetch(`${ENGINE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0.2, stream: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const choice = body.choices && body.choices[0];
  return {
    text: (choice && choice.message && choice.message.content) || "",
    reasoning: (choice && choice.message && choice.message.reasoning_content) || "",
    finish: choice && choice.finish_reason,
    seconds: (Date.now() - started) / 1000,
  };
}

async function main() {
  console.log(`Forge AI acceptance checks — ${os.platform()} ${os.arch()}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM\n`);

  // ── things that need no engine ──────────────────────────

  // 6. No .part file left behind.
  const models = flag("--models") || path.join(os.homedir(), "Library", "Application Support", "Forge AI", "models");
  if (fs.existsSync(models)) {
    const parts = fs.readdirSync(models).filter((n) => n.endsWith(".part"));
    record(
      "6. no stranded partial download",
      parts.length ? "fail" : "pass",
      parts.length ? `${parts.join(", ")} still in ${models}` : `${models} is clean`,
    );
  } else {
    record("6. no stranded partial download", "skip", `no models folder at ${models} — pass --models`);
  }

  if (!ENGINE) {
    record("engine checks", "skip", "pass --engine http://127.0.0.1:PORT (Settings shows the port)");
    return finish();
  }

  // 9. The engine refuses a request with no key.
  try {
    const res = await fetch(`${ENGINE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
    });
    record(
      "9. engine refuses an unauthenticated request",
      res.status === 401 ? "pass" : "fail",
      `it answered ${res.status}${res.status === 200 ? " — any web page on this machine can use the model" : ""}`,
    );
  } catch (e) {
    record("9. engine refuses an unauthenticated request", "skip", `could not reach ${ENGINE}: ${e.message}`);
    return finish();
  }

  // 2. A plain question, answered, quickly.
  try {
    const r = await ask("What is the capital of New Zealand? One word.");
    const right = /wellington/i.test(r.text);
    record(
      "2. capital of New Zealand in under 5s",
      right && r.seconds < 5 ? "pass" : right ? "fail" : "fail",
      `${r.seconds.toFixed(1)}s, said ${JSON.stringify(r.text.slice(0, 60))}`,
    );
  } catch (e) {
    record("2. capital of New Zealand in under 5s", "fail", e.message);
  }

  // 8. A reasoning model never answers with an empty string.
  try {
    const r = await ask("Think carefully, then answer: what is 17 times 23?");
    record(
      "8. no reply is ever an empty string",
      r.text.trim() ? "pass" : "fail",
      r.text.trim()
        ? `${r.text.trim().slice(0, 60)}`
        : `empty, finish_reason=${r.finish}, ${r.reasoning.length} characters of thinking`,
    );
  } catch (e) {
    record("8. no reply is ever an empty string", "fail", e.message);
  }

  // 3. Extraction that is valid JSON and not cut off.
  try {
    const r = await ask(
      'Return only JSON, no prose: {"vendor":..., "amount":..., "due":...} for: Invoice from Acme Freight for $4,250.00 due 30 Nov',
      { maxTokens: 800 },
    );
    const match = r.text.match(/\{[\s\S]*\}/);
    let ok = false;
    let note = "no JSON object in the reply";
    if (match) {
      try {
        const o = JSON.parse(match[0]);
        ok = String(o.amount || "").includes("4,250") || String(o.amount || "").includes("4250");
        note = ok ? JSON.stringify(o) : `parsed, but the amount is ${JSON.stringify(o.amount)}`;
      } catch (e) {
        note = `cut off or malformed: ${e.message}`;
      }
    }
    record("3. invoice extraction is valid JSON", ok ? "pass" : "fail", note);
  } catch (e) {
    record("3. invoice extraction is valid JSON", "fail", e.message);
  }

  // 4. Measured speed, and memory left over.
  try {
    const r = await ask("Write exactly 100 words about rope.", { maxTokens: 300 });
    const words = r.text.trim().split(/\s+/).length;
    const rate = words / Math.max(0.001, r.seconds);
    const freeGb = os.freemem() / 2 ** 30;
    record("4. speed is measurable", "pass", `about ${rate.toFixed(1)} words/sec, ${freeGb.toFixed(2)} GB RAM free`);
    record(
      "4b. free RAM stays above 1 GB",
      freeGb > 1 ? "pass" : "fail",
      `${freeGb.toFixed(2)} GB free during generation`,
    );
  } catch (e) {
    record("4. speed is measurable", "fail", e.message);
  }

  // ── the ones a script on one machine cannot answer ──────
  record("1. fresh install picks a tier and model unaided", "skip", "needs a clean machine; watch it and time it");
  record("5. NVIDIA PC offloads and is 3x its CPU", "skip", "needs the NVIDIA machine; read the engine log for CUDA/Vulkan");
  record("7. a 20,000-token document is read in parts", "skip", "attach one in the app and watch the status line");
  record("10. Claude Code: search, research, learn, ask", "skip", "needs a Claude Code session against this build");
  record("11. macOS Gatekeeper from Downloads", "skip", "needs a Developer ID certificate; unsigned builds cannot pass");

  finish();
}

function finish() {
  const n = (s) => results.filter((r) => r.state === s).length;
  console.log(`\n${n("pass")} passed, ${n("fail")} failed, ${n("skip")} not checked here.`);
  process.exit(n("fail") ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
