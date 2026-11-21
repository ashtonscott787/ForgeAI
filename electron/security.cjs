/**
 * Looking for weak points in how Forge AI is set up on this machine.
 *
 * Scope, stated plainly because a security feature that overclaims is worse
 * than none: this checks Forge AI's own configuration and what it exposes. It
 * is not an antivirus, it does not scan the operating system, and it does not
 * audit a network. Every finding is something this app can see for itself and
 * something a person can act on.
 *
 * Findings carry a severity, what was actually observed, and what to do. None
 * of them are fixed automatically — a security tool that changes settings on
 * its own is a security problem.
 */
const SEVERITY = { high: 3, medium: 2, low: 1, ok: 0 };

/**
 * @param deps.settings      the saved settings
 * @param deps.secrets       the key store
 * @param deps.shared        the shared-endpoint status
 * @param deps.meshAddress   () => string|null
 * @param deps.engineMissing () => array of unloadable libraries
 * @param deps.version       the app version
 * @param deps.latest        the newest published version, when known
 */
function audit(deps) {
  const { settings = {}, secrets, shared = {}, meshAddress = () => null, engineMissing = () => [], version = "", latest = null, platform = process.platform } = deps;
  const out = [];
  const add = (f) => out.push(f);

  // ── what is reachable from outside ─────────────────────────
  if (shared.enabled && shared.running) {
    const token = settings.share_token || "";
    if (!token) {
      add({
        id: "share-no-token", severity: "high", area: "Sharing",
        title: "The shared endpoint has no access token",
        found: "Sharing is on and no token is set.",
        fix: "Open Settings, Sharing, and press New token. Anything that can reach the port could otherwise use your models.",
      });
    } else if (token.length < 24) {
      add({
        id: "share-weak-token", severity: "medium", area: "Sharing",
        title: "The access token is short",
        found: `The token is ${token.length} characters.`,
        fix: "Press New token in Settings, Sharing. Forge AI generates 32 characters of randomness.",
      });
    }
    if (shared.mesh_enabled) {
      add({
        id: "share-mesh", severity: "low", area: "Sharing",
        title: "Your models are reachable from your private mesh",
        found: `Bound to ${meshAddress() || "a mesh address"}.`,
        fix: "This is what the setting is for. Switch it off in Settings, Sharing, if you no longer want other machines to use this one.",
      });
    }
  }

  // ── credentials ────────────────────────────────────────────
  const available = typeof secrets?.available === "function" ? secrets.available() : true;
  if (!available) {
    add({
      id: "no-keystore", severity: "high", area: "Credentials",
      title: "This machine's key store is unavailable",
      found: "The operating system would not provide encryption, so Forge AI refuses to save keys at all.",
      fix: "On Linux this usually means no keyring is running. Until it is, keys cannot be saved — which is safer than writing them in plain text.",
    });
  }
  if (settings.share_enabled && settings.share_token) {
    add({
      id: "token-in-settings", severity: "low", area: "Credentials",
      title: "The sharing token is kept in settings, not the key store",
      found: "It is stored in settings.json in plain text.",
      fix: "It is a token for a service that is off by default and only reachable from this machine or your mesh. Press New token if you think it has been seen.",
    });
  }

  // ── mail ───────────────────────────────────────────────────
  if (settings.mail_host && settings.mail_secure === false && Number(settings.mail_port) !== 587) {
    add({
      id: "smtp-port", severity: "medium", area: "Email",
      title: "Outgoing mail may not be encrypted",
      found: `Port ${settings.mail_port} with direct TLS off.`,
      fix: "Use 587 with STARTTLS, or 465 with TLS directly. Forge AI refuses to send a password in the clear, so this will fail rather than leak.",
    });
  }
  if (settings.mail_provider === "microsoft") {
    add({
      id: "microsoft-oauth", severity: "low", area: "Email",
      title: "Microsoft will refuse a password",
      found: "The account is set to Outlook or Microsoft 365.",
      fix: "Microsoft switched off password sign-in for mail apps. This needs OAuth, which Forge AI does not have yet.",
    });
  }

  // ── the app itself ─────────────────────────────────────────
  const missing = engineMissing();
  if (missing.length) {
    add({
      id: "engine-broken", severity: "high", area: "This app",
      title: "The inference engine cannot load",
      found: `${missing.length} libraries it needs are missing.`,
      fix: "Download the latest version from the releases page. A build in this state cannot run a model at all.",
    });
  }
  if (latest && version && latest !== version) {
    add({
      id: "out-of-date", severity: "medium", area: "This app",
      title: "A newer version is available",
      found: `This is ${version}; ${latest} has been published.`,
      fix: "Updates carry security fixes. Check for updates in Settings.",
    });
  }
  if (platform === "darwin" && String(process.execPath).includes("/AppTranslocation/")) {
    add({
      id: "translocated", severity: "medium", area: "This app",
      title: "Forge AI is running from a temporary copy",
      found: "macOS has quarantined it, so it runs from a read-only copy.",
      fix: "Quit, drag Forge AI into Applications, and open it from there. It cannot update itself in this state.",
    });
  }

  // ── what the model may do ──────────────────────────────────
  if (Array.isArray(settings.agent_preapproved_global) && settings.agent_preapproved_global.length) {
    add({
      id: "global-preapproval", severity: "high", area: "Agents",
      title: "Some actions are pre-approved for every agent",
      found: settings.agent_preapproved_global.join(", "),
      fix: "Pre-approval belongs to one agent, not all of them. Clear it and tick it per agent instead.",
    });
  }

  out.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
  const counts = out.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});
  return {
    at: Date.now(),
    findings: out,
    counts,
    worst: out.length ? out[0].severity : "ok",
    headline: out.length
      ? `${out.length} thing${out.length === 1 ? "" : "s"} worth looking at`
      : "Nothing to fix in what Forge AI can see",
    // Said every time, so the limits of the check are never implied away.
    scope: "This looks at how Forge AI is set up and what it exposes. It is not an antivirus, and it does not scan your operating system or your network.",
  };
}

module.exports = { audit, SEVERITY };
