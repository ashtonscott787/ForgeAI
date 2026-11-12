/**
 * Forge AI's own OpenAI-compatible endpoint.
 *
 * Two jobs, one server. It lets other tools on this machine — Claude Desktop,
 * ChatGPT's desktop app, an editor, a script — send chat requests to a model
 * that is already downloaded here instead of to a paid API. And because it can
 * also bind a private mesh address, a second computer running Forge AI can use
 * this machine's models over that mesh.
 *
 * Deliberate choices, because this opens a port:
 *
 * - It never binds 0.0.0.0. Only loopback, plus one explicit mesh address when
 *   that is switched on. A wildcard bind would put someone's models on whatever
 *   café network they joined.
 * - A token is required on every request, including the health check, and the
 *   server refuses to start without one. Model names alone say a lot about a
 *   person, so nothing is readable unauthenticated.
 * - Tokens are compared in constant time, so a wrong guess takes as long as any
 *   other wrong guess.
 * - Bodies are capped. An endpoint that buffers whatever it is sent is a way to
 *   exhaust the machine's memory from outside.
 * - It starts models but never downloads one. A request naming a model that is
 *   not installed is refused by name rather than quietly answered by another.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY = 8 * 1024 * 1024;
const MESH = (a) => { const [x, y] = String(a).split(".").map(Number); return x === 100 && y >= 64 && y <= 127; };

/** Equal-length, constant-time comparison that cannot throw on odd input. */
function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length === 0 || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const newToken = () => crypto.randomBytes(24).toString("base64url");

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};
const fail = (res, status, message, type = "invalid_request_error") => send(res, status, { error: { message, type } });

/**
 * @param deps.listModels  () => [{ file_name, bytes, vision }]
 * @param deps.ensureEngine (fileName) => Promise<{ base_url }>  starts it if needed
 * @param deps.getToken    () => string
 * @param deps.machineName () => string
 */
function createServer(deps) {
  const { listModels, ensureEngine, getToken, machineName = () => "forge-ai" } = deps;

  const authed = (req) => {
    const want = getToken();
    if (!want) return false;
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return sameToken(got, want);
  };

  return http.createServer(async (req, res) => {
    try {
      // No credentials are read from a browser, so no page may call this at all.
      if (req.headers.origin) return fail(res, 403, "This endpoint is for applications, not web pages.", "forbidden");
      if (!authed(req)) {
        res.setHeader("www-authenticate", 'Bearer realm="Forge AI"');
        return fail(res, 401, "A Forge AI access token is required. Copy it from Settings, under Share this machine.", "authentication_error");
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const models = listModels();

      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return send(res, 200, {
          object: "list",
          data: models.map((m) => ({
            id: m.file_name.replace(/\.gguf$/i, ""),
            object: "model",
            owned_by: "forge-ai",
            created: 0,
            // Not part of the OpenAI shape, but a caller choosing a model wants these.
            forge: { file_name: m.file_name, bytes: m.bytes, vision: Boolean(m.vision) },
          })),
        });
      }

      if (req.method === "GET" && url.pathname === "/forge/health") {
        return send(res, 200, { ok: true, machine: machineName(), models: models.length });
      }

      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch { return fail(res, 400, "The request body is not valid JSON."); }

        const asked = String(body.model || "").trim();
        if (!asked) return fail(res, 400, "No model was named. Ask /v1/models for the list.");
        const match = models.find(
          (m) => m.file_name === asked || m.file_name.replace(/\.gguf$/i, "") === asked,
        );
        if (!match) {
          return fail(
            res,
            404,
            `No model called "${asked}" is installed on this machine. Ask /v1/models for the list; Forge AI will not download one to answer a request.`,
            "model_not_found",
          );
        }

        let engine;
        try { engine = await ensureEngine(match.file_name); }
        catch (e) { return fail(res, 503, `The model could not be started: ${e instanceof Error ? e.message : String(e)}`, "engine_error"); }
        if (!engine?.base_url) return fail(res, 503, "The model did not start.", "engine_error");

        // Forwarded as sent, except that the engine is given the file name it knows.
        const out = Buffer.from(JSON.stringify({ ...body, model: match.file_name }), "utf8");
        const target = new URL("/v1/chat/completions", engine.base_url);
        const up = http.request(
          { hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
            headers: { "content-type": "application/json", "content-length": out.length } },
          (ur) => {
            res.writeHead(ur.statusCode || 200, {
              "content-type": ur.headers["content-type"] || "application/json",
              "cache-control": "no-cache",
            });
            ur.pipe(res);
          },
        );
        up.on("error", (e) => { if (!res.headersSent) fail(res, 502, `The engine did not answer: ${e.message}`, "engine_error"); else res.end(); });
        // A caller that hangs up must not leave the engine streaming into nothing.
        res.on("close", () => up.destroy());
        up.end(out);
        return undefined;
      }

      return fail(res, 404, `Nothing is served at ${url.pathname}. This endpoint offers /v1/models and /v1/chat/completions.`, "not_found");
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (!res.headersSent) fail(res, status, e instanceof Error ? e.message : String(e), "server_error");
      else res.end();
    }
  });
}

/**
 * Binds loopback, and the mesh address too when asked. Returns what it actually
 * bound, so the UI shows addresses that exist rather than ones it hoped for.
 */
async function listen(server, { port = 11435, meshAddress = null } = {}) {
  const hosts = ["127.0.0.1"];
  if (meshAddress) {
    if (!MESH(meshAddress)) throw new Error(`${meshAddress} is not a private mesh address, so Forge AI will not bind it.`);
    hosts.push(meshAddress);
  }
  const bound = [];
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hosts[0], () => { server.removeListener("error", reject); resolve(); });
  });
  bound.push(`http://127.0.0.1:${server.address().port}`);
  // Node binds one address per server, so the mesh gets its own listener on the same port.
  let second = null;
  if (hosts[1]) {
    second = http.createServer();
    second.on("request", (q, s) => server.emit("request", q, s));
    await new Promise((resolve, reject) => {
      second.once("error", reject);
      second.listen(server.address().port, hosts[1], () => { second.removeListener("error", reject); resolve(); });
    });
    bound.push(`http://${hosts[1]}:${server.address().port}`);
  }
  return { urls: bound, port: server.address().port, close: () => { try { second?.close(); } catch {} try { server.close(); } catch {} } };
}

module.exports = { createServer, listen, newToken, sameToken, isMeshAddress: MESH, MAX_BODY };
