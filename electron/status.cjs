/**
 * What is actually connected, measured rather than assumed.
 *
 * Every row here is the result of a real check with a real duration. Nothing
 * reports "connected" because it is configured: a mail server that is set up
 * but refusing a password is not connected, and showing it green would be the
 * single most misleading thing this view could do.
 *
 * Checks run in parallel, each with its own timeout, so one slow service
 * cannot hold up the rest of the picture.
 */
const net = require("node:net");
const tls = require("node:tls");

const TIMEOUT = 6000;

/** Opens a socket and reports how long it took. Never throws. */
function probe({ host, port, secure = false, timeout = TIMEOUT }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve({ ok, ms: Date.now() - started, detail });
    };
    const socket = secure
      ? tls.connect({ host, port, servername: host, timeout }, () => finish(true, ""))
      : net.connect({ host, port, timeout }, () => finish(true, ""));
    socket.on("timeout", () => finish(false, "did not answer in time"));
    socket.on("error", (e) => finish(false, e.code || e.message));
  });
}

/**
 * Groups, in the shape the view draws: a hub with branches. Each entry is a
 * live check; `state` is one of connected, off, failed, or not_set_up — four
 * different things that a single red or green dot would flatten.
 */
async function snapshot(deps) {
  const {
    engine,            // { running, port, model_file }
    shared,            // { enabled, running, urls, mesh_address }
    settings,
    secrets,
    models,            // installed()
    packs,             // number of knowledge packs
    agents,            // number of agents
    meshAddress,
  } = deps;

  const rows = [];
  const add = (group, name, detail, state, ms = null, note = "") =>
    rows.push({ group, name, detail, state, ms, note });

  // ── this machine ───────────────────────────────────────────
  if (engine?.running && engine.port) {
    const r = await probe({ host: "127.0.0.1", port: engine.port });
    add("This computer", "Inference engine", engine.model_file || "a model", r.ok ? "connected" : "failed", r.ms, r.ok ? "" : r.detail);
  } else {
    add("This computer", "Inference engine", "no model loaded", "off", null, "It starts when you send a message.");
  }
  add("This computer", "Models", `${models.length} installed`, models.length ? "connected" : "not_set_up", null,
    models.length ? "" : "Download one from the Models page.");
  add("This computer", "Knowledge", `${packs} pack${packs === 1 ? "" : "s"}`, packs ? "connected" : "not_set_up");
  add("This computer", "Agents", `${agents} saved`, agents ? "connected" : "not_set_up");

  // ── private mesh ───────────────────────────────────────────
  const mesh = meshAddress();
  if (mesh) {
    add("Private mesh", "Tailscale", mesh, "connected", null, "This machine has a mesh address.");
    if (shared?.enabled && shared?.mesh_enabled) {
      const bound = (shared.urls || []).some((u) => u.includes(mesh));
      add("Private mesh", "Shared to the mesh", bound ? `reachable at ${mesh}` : "switched on, not bound",
        bound ? "connected" : "failed", null, bound ? "" : "The mesh address was not available when sharing started.");
    } else {
      add("Private mesh", "Shared to the mesh", "off", "off", null, "Settings, Sharing, to let another computer use these models.");
    }
  } else {
    add("Private mesh", "Tailscale", "no mesh address", "not_set_up", null,
      "Start Tailscale to join this machine to your other computers.");
  }

  // ── shared endpoint ────────────────────────────────────────
  if (shared?.enabled && shared?.running) {
    const url = new URL(shared.urls[0]);
    const r = await probe({ host: url.hostname, port: Number(url.port) });
    add("Sharing", "Local endpoint", shared.urls[0], r.ok ? "connected" : "failed", r.ms, r.ok ? "" : r.detail);
  } else {
    add("Sharing", "Local endpoint", "off", "off", null, "Other apps cannot use these models until this is on.");
  }

  // ── email ──────────────────────────────────────────────────
  const checks = [];
  if (settings.imap_host) {
    checks.push(probe({ host: settings.imap_host, port: Number(settings.imap_port) || 993, secure: true })
      .then((r) => add("Email", "Incoming (IMAP)", settings.imap_host, r.ok ? "connected" : "failed", r.ms, r.ok ? "" : r.detail)));
  } else {
    add("Email", "Incoming (IMAP)", "not set up", "not_set_up", null, "Settings, Email.");
  }
  if (settings.mail_host) {
    checks.push(probe({ host: settings.mail_host, port: Number(settings.mail_port) || 587, secure: Boolean(settings.mail_secure) })
      .then((r) => add("Email", "Outgoing (SMTP)", settings.mail_host, r.ok ? "connected" : "failed", r.ms, r.ok ? "" : r.detail)));
  } else {
    add("Email", "Outgoing (SMTP)", "not set up", "not_set_up", null, "Settings, Email.");
  }

  // ── search ─────────────────────────────────────────────────
  const provider = settings.search_provider || "wikipedia";
  const needsKey = provider === "brave" || provider === "tavily";
  const ready = provider === "searxng" ? Boolean(settings.searxng_instance) : needsKey ? Boolean(secrets.get(provider)) : true;
  add("Search", provider, ready ? "ready" : "needs setting up", ready ? "connected" : "not_set_up", null,
    ready ? "" : needsKey ? "Add your key in Settings, Internet and search." : "Set the address in Settings.");

  await Promise.all(checks);

  const counts = rows.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
  return {
    at: Date.now(),
    rows,
    counts,
    // A one-line verdict that does not round a failure up to "fine".
    headline: counts.failed
      ? `${counts.failed} not working`
      : counts.connected
        ? `${counts.connected} connected`
        : "nothing connected yet",
    worst: counts.failed ? "failed" : counts.connected ? "connected" : "off",
  };
}

module.exports = { snapshot, probe, TIMEOUT };
