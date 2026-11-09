/**
 * User-defined connectors: an HTTPS endpoint the person describes, with an
 * optional token kept in the OS keychain. The model cannot call them; only the
 * person can, with an explicit "Send" in the app. Secrets never reach the
 * renderer or the model.
 */
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const secrets = require("./secrets.cjs");

let file = "";
let items = [];
const LIMITS = { name: 60, description: 200, path: 300 };
const MAX_RESPONSE = 200 * 1024;

const id = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const save = () => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, file);
};
const secretKey = (cid) => `connector:${cid}`;

function load(dir) {
  file = path.join(dir, "connectors.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    items = Array.isArray(raw) ? raw.filter((c) => c && typeof c.id === "string") : [];
  } catch {
    items = [];
  }
  return items;
}

/** Only https, or plain http to this computer. Anything else is refused. */
function checkBase(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error("The address is not a valid URL."); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("Connectors must use https://, or http:// only for this computer.");
  }
  if (u.username || u.password) throw new Error("Put credentials in the token field, not in the address.");
  return u.toString().replace(/\/$/, "");
}

function clean(input) {
  const name = String(input.name ?? "").trim().slice(0, LIMITS.name);
  if (!name) throw new Error("A connector needs a name.");
  const base_url = checkBase(input.base_url);
  const header = String(input.auth_header ?? "Authorization").trim();
  if (!/^[A-Za-z0-9-]{1,40}$/.test(header)) throw new Error("The header name may only contain letters, digits and dashes.");
  return {
    name,
    description: String(input.description ?? "").trim().slice(0, LIMITS.description),
    base_url,
    auth_header: header,
  };
}

const list = () => items.map((c) => ({ ...c, has_token: Boolean(secrets.get(secretKey(c.id))) }));

function add(input) {
  const row = { id: id(), ...clean(input), created: Date.now() };
  items.push(row);
  if (input.token) secrets.set(secretKey(row.id), String(input.token).trim());
  save();
  return row;
}

function update(patch) {
  const row = items.find((c) => c.id === patch.id);
  if (!row) throw new Error("That connector no longer exists.");
  Object.assign(row, clean({ ...row, ...patch }));
  if ("token" in patch) secrets.set(secretKey(row.id), patch.token ? String(patch.token).trim() : "");
  save();
  return row;
}

function remove(cid) {
  secrets.set(secretKey(cid), "");
  items = items.filter((c) => c.id !== cid);
  save();
}

/** One request, chosen by the person. Returns status and a capped text body. */
function call(cid, { path: subpath = "", method = "GET", body } = {}) {
  const row = items.find((c) => c.id === cid);
  if (!row) throw new Error("That connector no longer exists.");
  const sub = String(subpath ?? "").trim();
  if (sub.length > LIMITS.path || /\s/.test(sub)) throw new Error("The path is not valid.");
  const url = new URL(row.base_url + (sub.startsWith("/") ? sub : `/${sub}`));
  if (!url.toString().startsWith(row.base_url)) throw new Error("The path leaves the connector's address.");
  const verb = method === "POST" ? "POST" : "GET";
  const headers = { "User-Agent": "ForgeAI-connector", Accept: "application/json, text/plain;q=0.9" };
  const token = secrets.get(secretKey(cid));
  if (token) headers[row.auth_header] = row.auth_header.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
  let payload;
  if (verb === "POST" && body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: verb, headers, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new Error(`The connector answered with a redirect (HTTP ${res.statusCode}); redirects are not followed.`));
        return;
      }
      let text = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        size += Buffer.byteLength(c);
        if (size <= MAX_RESPONSE) text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, body: text.slice(0, MAX_RESPONSE), truncated: size > MAX_RESPONSE }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The connector did not answer within 15 seconds.")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { load, list, add, update, remove, call, LIMITS };
