/**
 * Finds a model file on Hugging Face, the same way the app does when you press Download.
 *
 * The catalogue names a repository and a quantisation, not a file. The file name, size and
 * SHA256 are read from the repository's own listing at download time. Projector files (for
 * vision models) are never offered as models.
 */
const https = require("node:https");

function getJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ForgeAI/0.2", Accept: "application/json" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); resolve(getJSON(new URL(res.headers.location, url).toString(), redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Hugging Face returned HTTP ${res.statusCode}`)); return; }
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("unreadable reply from Hugging Face")); } });
    }).on("error", (e) => reject(new Error(`cannot reach Hugging Face: ${e.message}`)));
  });
}
/** The projector for a vision model: the one matching the quant, else f16, else the smallest. */
async function resolveProjector({ repo, quant }) {
  const tree = await getJSON(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`);
  const projectors = (Array.isArray(tree) ? tree : []).filter((f) => f.type === "file" && /(^|\/)mmproj[-_.].*\.gguf$/i.test(f.path));
  if (!projectors.length) return { found: false };
  const norm = (p) => p.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(String(quant || ""));
  const exact = want ? projectors.filter((f) => norm(f.path).includes(want)) : [];
  const f16 = projectors.filter((f) => /f16/i.test(f.path));
  const chosen = (exact[0] ?? f16[0] ?? projectors.sort((a, b) => size(a) - size(b))[0]);
  return {
    found: true,
    file_name: chosen.path.split("/").pop(),
    url: `https://huggingface.co/${repo}/resolve/main/${encodeURI(chosen.path)}?download=true`,
    bytes: size(chosen),
    sha256: (chosen.lfs && typeof chosen.lfs.oid === "string" && chosen.lfs.oid.length === 64) ? chosen.lfs.oid : "",
  };
}
async function resolveArtifact({ repo, quant }) {
  const tree = await getJSON(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`);
  const ggufs = (Array.isArray(tree) ? tree : []).filter((f) => f.type === "file" && /\.gguf$/i.test(f.path));
  if (!ggufs.length) throw new Error(`no GGUF files found in ${repo}`);
  const whole = ggufs.filter((f) => !/-\d{5}-of-\d{5}\./.test(f.path)); // skip split uploads
  // Projectors are not models. Leaving them in the pool would let a small projector win on size.
  const models = ggufs.filter((f) => !/(^|\/)mmproj[-_.]/i.test(f.path));
  const pool = (whole.length ? whole : ggufs).filter((f) => !/(^|\/)mmproj[-_.]/i.test(f.path));
  if (!pool.length || !models.length) throw new Error(`no model GGUF files found in ${repo}`);
  const want = String(quant || "Q4_K_M").toLowerCase().replace(/[^a-z0-9]/g, "");
  const norm = (p) => p.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = pool.filter((f) => norm(f.path).includes(want));
  const chosen = (exact.length ? exact : pool).sort((a, b) => size(a) - size(b))[0];
  return {
    repo, quant, matched_requested_quant: exact.length > 0,
    file_name: chosen.path.split("/").pop(),
    url: `https://huggingface.co/${repo}/resolve/main/${encodeURI(chosen.path)}?download=true`,
    bytes: size(chosen),
    sha256: (chosen.lfs && typeof chosen.lfs.oid === "string" && chosen.lfs.oid.length === 64) ? chosen.lfs.oid : "",
    available_quants: [...new Set(pool.map((f) => (f.path.match(/(IQ|Q)\d[^.\-]*|f16|BF16/i) || [""])[0]).filter(Boolean))],
  };
}
const size = (f) => (f.lfs && f.lfs.size) || f.size || 0;

module.exports = { resolveArtifact, resolveProjector, getJSON, size };
