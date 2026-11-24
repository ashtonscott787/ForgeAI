/**
 * Running one model across more than one computer.
 *
 * llama.cpp can split a model's layers over several machines: one of them
 * runs the server and holds the conversation, and the others run
 * ggml-rpc-server and contribute memory and compute over the network. Until
 * now Forge AI said plainly that this was not implemented. This is the
 * implementation.
 *
 * The shape of it:
 *
 *   This computer, lending itself out       Another computer, doing the asking
 *   ────────────────────────────────        ──────────────────────────────────
 *   ggml-rpc-server -H 0.0.0.0 -p 50052  ←  llama-server --rpc that-machine:50052
 *
 * A machine can be either, or both. What it cannot be is quietly either: the
 * worker only ever runs because somebody switched it on, and it is bound to
 * an address they chose.
 *
 * Three things this is careful about, because it is putting a port on a
 * network:
 *
 * 1. Nothing listens by default. The worker is off until it is switched on.
 * 2. A worker accepts anything the other end sends it — the RPC protocol has
 *    no authentication of any kind, and llama.cpp's own documentation says so
 *    in as many words. Forge AI therefore refuses to bind it to a public
 *    address without the person saying so, and the interface says why.
 * 3. A peer that cannot be reached is reported as unreachable rather than
 *    silently dropped. A model that was meant to be split over two machines
 *    and quietly ran on one is a wrong answer about what the machine did.
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");

/** llama.cpp's own default for ggml-rpc-server. */
const DEFAULT_PORT = 50052;

/**
 * Addresses that are safe to listen on without asking.
 *
 * Loopback reaches nothing but this machine. A private-range address reaches
 * the home or office network it is on. Anything else — a public address, or
 * the all-interfaces wildcard — exposes an unauthenticated port to whatever
 * can route to it, and is only used when explicitly allowed.
 */
function isPrivateAddress(host) {
  if (!host) return false;
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, which Tailscale uses
    return false;
  }
  // IPv6 unique-local and link-local.
  return /^(fc|fd|fe80)/i.test(host);
}

/** The addresses of this machine another computer could reach it on. */
function localAddresses() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const [name, list] of Object.entries(nics)) {
    for (const nic of list || []) {
      if (nic.internal) continue;
      if (nic.family !== "IPv4" && nic.family !== 4) continue;
      out.push({ name, address: nic.address, private: isPrivateAddress(nic.address) });
    }
  }
  return out;
}

/** "host:port", validated. Returns null rather than a half-parsed peer. */
function parsePeer(text, fallbackPort = DEFAULT_PORT) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let host = raw;
  let port = fallbackPort;
  // [::1]:50052 as well as 192.168.1.5:50052
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const parts = raw.split(":");
    if (parts.length === 2) {
      host = parts[0];
      port = Number(parts[1]);
    } else if (parts.length > 2) {
      return null; // a bare IPv6 address needs brackets to carry a port
    }
  }
  host = host.trim();
  if (!host) return null;
  if (!/^[a-z0-9._-]+$/i.test(host) && !/^[0-9a-f:]+$/i.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const peerLabel = (p) => (p.host.includes(":") ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`);

/**
 * Is something listening there?
 *
 * A TCP connection that opens is honest evidence of a listener and nothing
 * more: it does not prove the thing listening is an RPC worker, and this
 * never claims it does. `ok` means reachable; what it is, the engine finds
 * out when it tries to use it.
 */
function reach(peer, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true, ms: Date.now() - started }));
    socket.once("timeout", () => done({ ok: false, why: "it did not answer in time" }));
    socket.once("error", (e) =>
      done({
        ok: false,
        why:
          e.code === "ECONNREFUSED"
            ? "nothing is listening on that port"
            : e.code === "ENOTFOUND" || e.code === "EAI_AGAIN"
              ? "that name could not be resolved"
              : e.message,
      }),
    );
    socket.connect(peer.port, peer.host);
  });
}

/** Every peer checked at once, in the order they were given. */
async function reachAll(peers, timeoutMs) {
  const checked = await Promise.all(peers.map((p) => reach(p, timeoutMs)));
  return peers.map((p, i) => ({ ...p, ...checked[i], label: peerLabel(p) }));
}

/**
 * The flags that make llama-server use the other machines.
 *
 * Only peers that answered are passed. Handing the engine an address nothing
 * is listening on makes it fail to start at all, which turns one unplugged
 * laptop into "Forge AI is broken".
 */
function rpcFlags(reachablePeers) {
  const live = reachablePeers.filter((p) => p.ok);
  if (!live.length) return [];
  return ["--rpc", live.map(peerLabel).join(",")];
}

/**
 * This machine, lending itself to another.
 *
 * The worker is a separate process with no access to the conversation, the
 * models or the files: it is handed tensors and hands back results.
 */
function startWorker({ bin, host = "127.0.0.1", port = DEFAULT_PORT, allowPublic = false, onLine, cwd, env }) {
  if (!isPrivateAddress(host) && host !== "0.0.0.0" && !allowPublic) {
    throw new Error(
      `${host} is not a private address. The worker has no password of any kind, so anything that can reach that port can use this machine. Bind it to your local network address instead.`,
    );
  }
  if (host === "0.0.0.0" && !allowPublic) {
    throw new Error(
      "Listening on every interface would offer this machine to any network it joins, and the worker has no password of any kind. Choose the address of the network you mean.",
    );
  }
  const proc = spawn(bin, ["--host", host, "--port", String(port)], {
    cwd,
    windowsHide: true,
    env,
  });
  if (onLine) {
    const feed = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach(onLine);
    proc.stdout.on("data", feed);
    proc.stderr.on("data", feed);
  }
  return proc;
}

module.exports = {
  DEFAULT_PORT,
  isPrivateAddress,
  localAddresses,
  parsePeer,
  peerLabel,
  reach,
  reachAll,
  rpcFlags,
  startWorker,
};
