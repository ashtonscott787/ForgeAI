/**
 * The arguments llama-server is started with, in one place.
 *
 * There were two sets. The window built a careful one — tier-sized context,
 * one slot, the performance cores, a compressed cache where memory is
 * short, the access key — and the MCP server built its own: a fixed
 * `--ctx-size 4096`, no slot count, no layer count, no key. A prompt of ten
 * thousand tokens through Claude Code therefore failed against a context a
 * sixth the size of the one the window would have given it, and the
 * engine's raw JSON came back as the answer.
 *
 * Two code paths building the same command line is the same shape of
 * defect as the two engine manifests that shipped 0.7.0 without three of
 * its four tools. So: one builder, and a test that fails if either caller
 * assembles its own.
 */

/**
 * Builds the command line.
 *
 * `tuning` comes back separately as well as inside `args`, because an
 * engine that does not recognise a tuning flag refuses to start rather
 * than ignoring it, and the caller retries without exactly those.
 */
function engineArgs({
  modelPath,
  port,
  contextTokens,
  gpuLayers,
  threads,
  parallel = 1,
  kvType = "f16",
  flashAttention = false,
  apiKey = "",
  projectorPath = "",
  noMmap = false,
  rpcPeers = [],
  extra = [],
}) {
  const args = [
    "--model", modelPath,
    "--ctx-size", String(contextTokens),
    "--port", String(port),
    "--host", "127.0.0.1",
    "--n-gpu-layers", String(gpuLayers),
    // One conversation, not four. The engine reserves the whole context for
    // every slot it is given, so the default of 4 took four times the
    // memory in an application that holds one conversation at a time.
    "--parallel", String(parallel),
  ];

  // Without a key the engine answers anybody who can reach the port, and on
  // this machine that includes any web page the person has open.
  if (apiKey) {
    args.push("--api-key", apiKey);
    // Credentials are never needed — the key travels in a header — and
    // refusing them stops a page using an ambient cookie against it.
    //
    // The origin list is deliberately left at llama.cpp's default of "*".
    // The obvious tightening, "localhost", would break the app: its window
    // is loaded with loadFile, so its own requests carry Origin: null,
    // which does not match, and the browser would refuse the engine's
    // replies. The key is what actually closes the hole — a page cannot
    // read it, so it gets 401 whatever the origin header says.
    args.push("--no-cors-credentials");
  }

  // Performance cores only, where the distinction exists: spreading threads
  // onto an Apple chip's efficiency cores makes generation slower, not
  // faster.
  if (threads > 0) args.push("--threads", String(threads));

  // A vision model's projector sits beside it; the engine reads images only with it.
  if (projectorPath) args.push("--mmproj", projectorPath);
  // Reads the whole file into memory instead of paging it from disk.
  if (noMmap) args.push("--no-mmap");

  // Other computers, already checked as reachable by the caller. An address
  // nothing is listening on makes the engine refuse to start.
  if (rpcPeers.length) args.push("--rpc", rpcPeers.join(","));

  // Kept separate so the caller can drop exactly these and try again.
  const tuning = [];
  if (flashAttention) tuning.push("--flash-attn", "on");
  if (kvType && kvType !== "f16") tuning.push("--cache-type-k", kvType, "--cache-type-v", kvType);

  return { args: [...args, ...extra], tuning, all: [...args, ...extra, ...tuning] };
}

/**
 * Which layers go to the graphics hardware, given what the person has asked
 * for and what the machine is.
 *
 * The tier supplies the default; an explicit setting wins over it. "cpu"
 * and "split" are the person saying something specific, so they win over
 * both.
 */
function layersFrom(settings, tierLayers) {
  if (settings.run_mode === "cpu") return 0;
  if (settings.run_mode === "split") return Math.max(0, Number(settings.split_layers) || 0);
  if (Number(settings.gpu_layers) > 0) return Number(settings.gpu_layers);
  return tierLayers;
}

/** Everything the engine needs, worked out from the machine and the settings. */
function planEngine({ modelPath, port, settings = {}, machine, apiKey, projectorPath = "", rpcPeers = [] }) {
  const tune = machine.tier_settings;
  const contextTokens = Number(settings.context_size) > 0 ? Number(settings.context_size) : tune.context;
  return engineArgs({
    modelPath,
    port,
    contextTokens,
    gpuLayers: layersFrom(settings, tune.gpu_layers),
    threads: Number(settings.threads) > 0 ? Number(settings.threads) : machine.performance_cores,
    parallel: tune.parallel,
    kvType: tune.kv_type,
    flashAttention: tune.flash_attention,
    apiKey,
    projectorPath,
    noMmap: Boolean(settings.load_into_memory),
    rpcPeers,
  });
}

/** One line for the log, so "is it using the GPU" is read rather than inferred. */
function describeEngine({ machine, contextTokens, layers }) {
  const tune = machine.tier_settings;
  return `forge: ${machine.tier_label} tier${machine.tier_is_override ? " (chosen by hand)" : ""}`
    + ` on ${machine.gpu_name || machine.gpu_kind} — ${layers} GPU layers, ${contextTokens} context,`
    + ` ${tune.parallel} slot, ${tune.kv_type} cache${tune.flash_attention ? ", flash attention" : ""}.`;
}

module.exports = { engineArgs, layersFrom, planEngine, describeEngine };
