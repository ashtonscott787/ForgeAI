/**
 * Making your own model out of one you already have.
 *
 * Two operations, both done by tools that ship inside the app, both producing
 * a real new .gguf file that can then be selected and run like any other:
 *
 *   Shrink   llama-quantize   stores the weights at lower precision. The file
 *                             gets smaller and faster and a little less
 *                             accurate. This is how every "Q4_K_M" on a model
 *                             listing was made.
 *   Combine  llama-export-lora  bakes an adapter — someone's fine-tune,
 *                             distributed as a small file — permanently into
 *                             a base model, giving one model that behaves the
 *                             way the adapter taught it to.
 *
 * What is NOT here, said plainly because the gap matters: this cannot train a
 * model from nothing, and it cannot fine-tune one on your own writing. Training needs a
 * training runtime that is not in this app and would not run usefully on most
 * machines. Making an adapter happens elsewhere; bringing one here and baking
 * it in is what this does.
 *
 * Every job writes to a new file and never touches its input. A job that is
 * cancelled or that fails leaves a partial file behind under a .part name,
 * which is removed rather than left looking like a finished model.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The formats offered, smallest first.
 *
 * Not every type llama-quantize accepts — there are dozens, most of them of
 * interest only to people benchmarking them. These are the ones worth
 * choosing between, with what they cost in plain words.
 */
const FORMATS = [
  { id: "Q3_K_M", label: "Q3_K_M", note: "Smallest. Noticeably less accurate; worth it only when memory is tight." },
  { id: "Q4_K_M", label: "Q4_K_M", note: "The usual choice. About half the size of Q8 and hard to tell apart in use." },
  { id: "Q5_K_M", label: "Q5_K_M", note: "Larger, slightly closer to the original." },
  { id: "Q6_K", label: "Q6_K", note: "Close to indistinguishable from Q8, and smaller." },
  { id: "Q8_0", label: "Q8_0", note: "Barely lossy, and barely a saving over the original if it is already Q8." },
];

const isFormat = (id) => FORMATS.some((f) => f.id === id);

/** A file name that cannot escape the models folder or collide by accident. */
function safeOutputName(name) {
  const base = String(name || "")
    .trim()
    .replace(/\.gguf$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return base ? `${base}.gguf` : "";
}

/** What a shrunk copy of this model would be called, by default. */
function suggestName(sourceFile, format) {
  const base = String(sourceFile).replace(/\.gguf$/i, "");
  // Models are usually already named after their format; replacing it reads
  // better than "model-Q8_0-Q4_K_M.gguf".
  const swapped = base.replace(/[-.](IQ\d[A-Z_]*|Q\d[A-Z0-9_]*|F16|F32|BF16)$/i, "");
  return safeOutputName(`${swapped}-${format}`);
}

/**
 * Runs one job, reporting progress as it goes.
 *
 * The tools print their progress to stderr, in lines rather than percentages,
 * so what comes back is the tool's own words. Inventing a percentage from
 * them would be inventing a number.
 */
function runTool({ bin, args, cwd, env, onLine, signal }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, why: `${path.basename(bin)} could not be started: ${e.message}` });
      return;
    }
    const tail = [];
    const feed = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 400) tail.shift();
        onLine?.(line);
      }
    };
    proc.stdout.on("data", feed);
    proc.stderr.on("data", feed);
    const stop = () => { try { proc.kill(); } catch { /* already gone */ } };
    signal?.addEventListener("abort", stop, { once: true });
    proc.on("error", (e) => resolve({ ok: false, why: e.message, tail }));
    proc.on("close", (code) => {
      signal?.removeEventListener?.("abort", stop);
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, why: "It was stopped.", tail });
      resolve(code === 0 ? { ok: true, tail } : { ok: false, why: `it stopped with code ${code}`, tail });
    });
  });
}

/** Checks the inputs before anything is spawned, so a mistake costs no time. */
function planShrink({ dir, source, format, outName }) {
  if (!isFormat(format)) return { ok: false, why: `${format} is not one of the formats offered.` };
  const src = path.join(dir, path.basename(String(source || "")));
  if (!source || !fs.existsSync(src)) return { ok: false, why: "That model is not in the models folder." };
  const out = safeOutputName(outName || suggestName(path.basename(src), format));
  if (!out) return { ok: false, why: "Give the new model a name." };
  const dest = path.join(dir, out);
  if (path.resolve(dest) === path.resolve(src)) return { ok: false, why: "The new model needs a different name from the one it is made from." };
  if (fs.existsSync(dest)) return { ok: false, why: `There is already a model called ${out}.` };
  return { ok: true, src, dest, out };
}

function planCombine({ dir, source, adapter, outName }) {
  const src = path.join(dir, path.basename(String(source || "")));
  if (!source || !fs.existsSync(src)) return { ok: false, why: "That model is not in the models folder." };
  if (!adapter || !fs.existsSync(adapter)) return { ok: false, why: "That adapter file could not be found." };
  if (!/\.gguf$/i.test(adapter)) {
    return { ok: false, why: "The adapter has to be a .gguf file. An adapter published as safetensors has to be converted first, which this app cannot do." };
  }
  const out = safeOutputName(outName);
  if (!out) return { ok: false, why: "Give the new model a name." };
  const dest = path.join(dir, out);
  if (path.resolve(dest) === path.resolve(src)) return { ok: false, why: "The new model needs a different name from the one it is made from." };
  if (fs.existsSync(dest)) return { ok: false, why: `There is already a model called ${out}.` };
  return { ok: true, src, dest, out, adapter };
}

/**
 * Writes to a .part file and renames it only on success.
 *
 * A half-written .gguf sitting in the models folder is worse than no file:
 * it appears in the list, is selectable, and fails at the moment somebody
 * tries to use it.
 */
async function finishInto({ dest, run }) {
  const part = `${dest}.part`;
  try { fs.rmSync(part, { force: true }); } catch { /* nothing there */ }
  const result = await run(part);
  if (!result.ok) {
    try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
    return result;
  }
  if (!fs.existsSync(part) || fs.statSync(part).size < 1024 * 1024) {
    try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
    return { ok: false, why: "The tool reported success but wrote nothing usable.", tail: result.tail };
  }
  fs.renameSync(part, dest);
  return { ok: true, file: path.basename(dest), bytes: fs.statSync(dest).size, tail: result.tail };
}

module.exports = { FORMATS, isFormat, safeOutputName, suggestName, planShrink, planCombine, runTool, finishInto };
