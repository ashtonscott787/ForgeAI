/**
 * The one list of what the engine folder must contain.
 *
 * It exists because there were two lists. `scripts/get-engine.cjs` had one,
 * used when a developer sets up locally; the release workflow had its own
 * inline `find ... -name llama-server` and never called the script at all.
 * Adding ggml-rpc-server, llama-quantize and llama-export-lora to the script
 * therefore changed nothing about the app that people downloaded: 0.7.0
 * shipped with clustering and the model workshop both unable to run, because
 * their binaries were not in the build. The release tests passed, because
 * they checked the script and the source-build fallback — the two paths CI
 * does not take.
 *
 * So: one list, here, read by the script, by the packaging check and by the
 * workflow. A tool is added in one place or it is not added.
 */

/**
 * `required` binaries make the app refuse to package when missing — without
 * them it cannot run a model at all. `optional` ones gate a feature: the app
 * checks for each at runtime and says that feature is unavailable rather
 * than failing when somebody reaches for it.
 */
const BINARIES = [
  { name: "llama-server", required: true, gives: "running a model at all" },
  { name: "ggml-rpc-server", required: false, gives: "splitting a model across computers" },
  { name: "llama-quantize", required: false, gives: "making a smaller copy of a model" },
  { name: "llama-export-lora", required: false, gives: "baking an adapter into a model" },
];

/** Names of every binary, with the Windows suffix where it applies. */
const binaryNames = (platform = process.platform) =>
  BINARIES.map((b) => (platform === "win32" ? `${b.name}.exe` : b.name));

/** Matches any shipped binary, with or without .exe, for filtering an archive. */
const BINARY_RE = new RegExp(`^(${BINARIES.map((b) => b.name).join("|")})(\\.exe)?$`);

/** Libraries and licences travel with them. */
const KEEP_RE = /\.(dylib|so|dll)$|^LICENSE/;

const keep = (fileName) => BINARY_RE.test(fileName) || KEEP_RE.test(fileName);

/**
 * A short string that changes whenever this list does.
 *
 * The release workflow caches the engine folder. Its key was the llama.cpp
 * tag alone, so when the list of binaries grew and the tag did not, the
 * cache hit and restored the previous folder — the exact mechanism that
 * shipped 0.7.0 without three of its four tools. The key now carries this.
 */
const signature = () => BINARIES.map((b) => b.name).sort().join("+");

module.exports = { BINARIES, BINARY_RE, KEEP_RE, binaryNames, keep, signature };
