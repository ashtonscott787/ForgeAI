/**
 * What this computer actually is, and what it can actually run.
 *
 * The old answer was two lines: Apple Silicon means Metal, everything else
 * means CPU, and vram_bytes is zero. So a PC with a 24 GB graphics card
 * reported no graphics card, ran everything on the processor, and was
 * offered the same 1.5B model as an eight-year-old laptop. One setting —
 * 8192 context, 999 GPU layers — went to every machine either way.
 *
 * Three things are needed and none of them is a guess:
 *
 *   detect   what is here: memory, free memory, cores, GPU and its memory
 *   tier     which of four kinds of machine this is, and the settings for it
 *   fit      whether a particular model and context will actually fit now
 *
 * Every command this runs is read-only and every one is allowed to fail:
 * nvidia-smi is not installed on most machines, and a machine with no
 * graphics card is a normal machine, not an error. A detection that cannot
 * answer says it does not know, and nothing downstream pretends otherwise.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

const GiB = 1024 ** 3;

/** Runs a command for its output, or returns "" — never throws. */
function tryRun(file, args, timeout = 4000) {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }) || "";
  } catch {
    return "";
  }
}

/**
 * Every call goes through this, including an injected one.
 *
 * The promise this module makes is that a missing command is a normal
 * machine rather than a failure, and that promise has to hold whoever
 * supplies the runner — otherwise it holds only for the one caller that
 * happens to pass the forgiving version.
 */
const safely = (run) => (file, args, timeout) => {
  try {
    return run(file, args, timeout) || "";
  } catch {
    return "";
  }
};

/**
 * Memory that is genuinely available right now.
 *
 * os.freemem() is the wrong number on two of the three platforms. On Linux
 * it excludes the page cache, which the kernel will hand back on demand, so
 * it reads far too low. On macOS it excludes inactive pages for the same
 * reason. MemAvailable and vm_stat give the figure a person would call
 * "free", and loading a model against the wrong one either refuses a model
 * that would have fitted or starts one that sends the machine swapping.
 */
function freeBytes(platform = process.platform, rawRun = tryRun) {
  const run = safely(rawRun);
  if (platform === "linux") {
    try {
      const info = fs.readFileSync("/proc/meminfo", "utf8");
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(info);
      if (m) return Number(m[1]) * 1024;
    } catch {
      /* fall through to the portable answer */
    }
  }
  if (platform === "darwin") {
    const out = run("vm_stat", []);
    const size = Number(/page size of (\d+) bytes/.exec(out)?.[1] || 4096);
    const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] || 0);
    const free = pages("Pages free") + pages("Pages inactive") + pages("Pages purgeable") + pages("File-backed pages");
    if (free > 0) return free * size;
  }
  return os.freemem();
}

/**
 * The graphics card, if there is one worth using.
 *
 * NVIDIA answers exactly, through its own tool. Everything else is read
 * from the operating system's device list, which gives a name but often not
 * the memory — so the memory comes back null rather than zero, because zero
 * reads as "it has none" and null reads as "nobody knows", and those lead to
 * different decisions.
 */
function detectGpu(platform = process.platform, arch = process.arch, rawRun = tryRun) {
  const run = safely(rawRun);
  // NVIDIA first on every platform: it is the one that answers precisely.
  const smi = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  const line = smi.split("\n").map((l) => l.trim()).find(Boolean);
  if (line && line.includes(",")) {
    const [name, mib] = line.split(",").map((x) => x.trim());
    const bytes = Number(mib) * 1024 * 1024;
    return { kind: "nvidia", name, vram_bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null, unified: false };
  }

  if (platform === "darwin") {
    if (arch === "arm64") {
      // Apple Silicon shares one pool between processor and graphics, so the
      // graphics memory is the machine's memory. Saying "0 VRAM" of a 64 GB
      // Mac Studio was the single most wrong number in the old report.
      const name = run("sysctl", ["-n", "machdep.cpu.brand_string"]).trim() || "Apple Silicon";
      return { kind: "apple", name, vram_bytes: os.totalmem(), unified: true };
    }
    return { kind: "none", name: "", vram_bytes: null, unified: false };
  }

  if (platform === "win32") {
    // CIM rather than the deprecated wmic, which recent Windows no longer
    // ships. AdapterRAM is wrong above 4 GB — it is a 32-bit field — so the
    // name is taken and the memory is left unknown.
    const out = run("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)",
    ], 8000).trim();
    if (out) {
      const kind = /nvidia|geforce|rtx|quadro/i.test(out) ? "nvidia"
        : /radeon|amd/i.test(out) ? "amd"
          : /intel|arc|iris|uhd/i.test(out) ? "intel" : "other";
      return { kind, name: out, vram_bytes: null, unified: kind === "intel" };
    }
    return { kind: "none", name: "", vram_bytes: null, unified: false };
  }

  // Linux, no NVIDIA tool: the device list names the card.
  const pci = run("sh", ["-c", "lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -1"]).trim();
  if (pci) {
    const kind = /nvidia/i.test(pci) ? "nvidia" : /amd|radeon/i.test(pci) ? "amd" : /intel/i.test(pci) ? "intel" : "other";
    return { kind, name: pci.replace(/^\S+\s+/, "").slice(0, 80), vram_bytes: null, unified: kind === "intel" };
  }
  return { kind: "none", name: "", vram_bytes: null, unified: false };
}

/**
 * Performance cores, where the distinction exists.
 *
 * On an Apple chip the efficiency cores make generation slower rather than
 * faster if threads are spread across them, so the thread count should
 * follow the performance cores alone.
 */
function cores(platform = process.platform, rawRun = tryRun) {
  const run = safely(rawRun);
  const total = os.cpus().length || 1;
  if (platform === "darwin") {
    const perf = Number(run("sysctl", ["-n", "hw.perflevel0.logicalcpu"]).trim());
    if (Number.isFinite(perf) && perf > 0) return { total, performance: perf };
  }
  return { total, performance: total };
}

/**
 * The four kinds of machine, and what each should be given.
 *
 * The boundaries are memory, because memory is what decides whether a model
 * runs at all. A machine is judged on the memory a model can actually use:
 * its graphics memory where that is separate, its system memory where the
 * two are one pool.
 */
const TIERS = [
  {
    id: "tiny",
    label: "Tiny",
    says: "Small memory and no graphics card. Everything is sized to leave the machine usable.",
    max_model_bytes: 1.6 * GiB,
    context: 4096,
    parallel: 1,
    flash_attention: false,
    kv_type: "q8_0",
    gpu_layers: 0,
  },
  {
    id: "small",
    label: "Small",
    says: "Enough for a small model with room to work.",
    max_model_bytes: 3.5 * GiB,
    context: 8192,
    parallel: 1,
    flash_attention: true,
    kv_type: "q8_0",
    gpu_layers: 999,
  },
  {
    id: "medium",
    label: "Medium",
    says: "A 7–8B model fits comfortably, with a long conversation.",
    max_model_bytes: 7 * GiB,
    context: 16384,
    parallel: 1,
    flash_attention: true,
    kv_type: "f16",
    gpu_layers: 999,
  },
  {
    id: "large",
    label: "Large",
    says: "Room for a large model and a long context at full precision.",
    max_model_bytes: 24 * GiB,
    context: 32768,
    parallel: 1,
    flash_attention: true,
    kv_type: "f16",
    gpu_layers: 999,
  },
];

const tierById = (id) => TIERS.find((t) => t.id === id) || null;

/**
 * Which tier this machine is.
 *
 * Judged on usable memory, then held back one step when there is no graphics
 * acceleration at all: 16 GB with no GPU runs a 7B model, but slowly enough
 * that offering it as the default is doing somebody a disservice.
 */
function tierFor({ ram_bytes, vram_bytes, unified, accelerated }) {
  const pool = unified || !vram_bytes ? ram_bytes : vram_bytes;
  // What a model may actually take: the rest is the operating system, this
  // app, and whatever else the person is doing.
  const usable = unified || !vram_bytes ? pool * 0.6 : pool * 0.9;
  let i = usable >= 20 * GiB ? 3 : usable >= 10 * GiB ? 2 : usable >= 5 * GiB ? 1 : 0;
  if (!accelerated && i > 1) i = 1;
  return TIERS[i];
}

/**
 * How much memory the conversation itself takes.
 *
 * Computed from the model's own layer count and width rather than guessed,
 * because the guess is wrong by a factor of ten between a 1.5B and a 32B.
 * Two caches, keys and values, at the size of one token's hidden state per
 * layer, times the context.
 */
function kvCacheBytes({ block_count, embedding_length, context, kv_type }) {
  if (!block_count || !embedding_length || !context) return null;
  const perElement = kv_type === "q8_0" ? 1 : kv_type === "q4_0" ? 0.5 : 2;
  return 2 * block_count * embedding_length * context * perElement;
}

/**
 * Will this model, at this context, fit in the memory that is free now?
 *
 * Against free memory, not total. Total is what the machine has; free is
 * what is left after everything already running, and loading against the
 * first number is how a machine ends up swapping.
 */
function fits({ model_bytes, kv_bytes, free_bytes, headroom_bytes = 1.5 * GiB }) {
  const needed = model_bytes + (kv_bytes || 0);
  const have = free_bytes - headroom_bytes;
  return {
    ok: needed <= have,
    needed,
    have: Math.max(0, have),
    short: Math.max(0, needed - have),
  };
}

/** Everything, in one call. */
function describeMachine(platform = process.platform, arch = process.arch, rawRun = tryRun) {
  const run = safely(rawRun);
  const gpu = detectGpu(platform, arch, run);
  const c = cores(platform, run);
  const ram = os.totalmem();
  const accelerated = gpu.kind === "nvidia" || gpu.kind === "apple" || gpu.kind === "amd";
  const tier = tierFor({ ram_bytes: ram, vram_bytes: gpu.vram_bytes, unified: gpu.unified, accelerated });
  return {
    ram_bytes: ram,
    free_bytes: freeBytes(platform, run),
    cores: c.total,
    performance_cores: c.performance,
    gpu,
    accelerated,
    tier: tier.id,
    tier_label: tier.label,
    settings: { ...tier },
  };
}

module.exports = {
  GiB, TIERS, tierById, tierFor, detectGpu, cores, freeBytes, kvCacheBytes, fits, describeMachine, tryRun,
};
