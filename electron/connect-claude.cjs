/**
 * Connecting Forge AI to Claude or ChatGPT without anybody typing a path.
 *
 * Both read a JSON file listing the MCP servers they may use. Finding that
 * file, getting the path to this application right and not destroying whatever
 * else is already in it is the whole of the work, and it is the kind of work
 * that is easy to get wrong by hand. So it is done here.
 *
 * Three rules this follows, because it is writing into another application's
 * configuration:
 *
 * 1. Nothing else in the file is touched. The file is read, one key is added
 *    or replaced under mcpServers, and everything else is written back as it
 *    was — including keys this app has never heard of.
 * 2. Nothing is written without being asked. `plan()` says what would change
 *    and is safe to call at any time; `connect()` is the only thing that
 *    writes, and it returns what it did.
 * 3. A file that cannot be parsed is left alone. Overwriting somebody's
 *    working configuration because one character was wrong is not a repair.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEY = "forge-ai";

/** Where each application keeps its list of MCP servers. */
function configPath(app) {
  const home = os.homedir();
  if (app === "claude") {
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
  if (app === "chatgpt") {
    // ChatGPT's desktop app reads the same shape from its own folder.
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "ChatGPT", "mcp_config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "ChatGPT", "mcp_config.json");
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "ChatGPT", "mcp_config.json");
  }
  throw new Error(`No configuration is known for ${app}.`);
}

/**
 * The entry that is written.
 *
 * `command` is the Electron binary of this very application and `args` is the
 * server beside it, with ELECTRON_RUN_AS_NODE so that binary behaves as node.
 * Using this application's own Electron means there is nothing else to
 * install: no Node, no npm, no path to get wrong.
 */
function entry({ execPath, serverPath }) {
  return {
    command: execPath,
    args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { ok: true, config: {}, existed: false };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, why: `That file could not be read: ${e.message}` };
  }
  if (!raw.trim()) return { ok: true, config: {}, existed: true };
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { ok: false, why: "That file does not contain a JSON object." };
    }
    return { ok: true, config, existed: true };
  } catch (e) {
    // Deliberately not repaired: see rule 3.
    return { ok: false, why: `That file is not valid JSON, so it has been left alone: ${e.message}` };
  }
}

/**
 * What connecting would do, without doing any of it.
 *
 * `file` overrides where the configuration is looked for. The application
 * never passes it; the tests do, so that writing into a real configuration is
 * never part of running them.
 */
function plan(app, { execPath, serverPath, file: override }) {
  let file = override;
  if (!file) {
    try {
      file = configPath(app);
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }
  const read = readConfig(file);
  if (!read.ok) return { ok: false, file, why: read.why };

  const servers = read.config.mcpServers && typeof read.config.mcpServers === "object" ? read.config.mcpServers : {};
  const already = servers[KEY];
  const wanted = entry({ execPath, serverPath });
  const same = already && JSON.stringify(already) === JSON.stringify(wanted);

  return {
    ok: true,
    file,
    existed: read.existed,
    others: Object.keys(servers).filter((k) => k !== KEY),
    already: Boolean(already),
    same: Boolean(same),
    entry: wanted,
  };
}

/** Writes the entry, keeping everything else in the file exactly as it was. */
function connect(app, { execPath, serverPath, file }) {
  const p = plan(app, { execPath, serverPath, file });
  if (!p.ok) return p;
  if (p.same) return { ok: true, file: p.file, changed: false, note: "It was already connected." };

  const read = readConfig(p.file);
  if (!read.ok) return { ok: false, file: p.file, why: read.why };

  const config = read.config;
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers[KEY] = p.entry;

  try {
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    // Written beside the real file and moved into place, so an interrupted
    // write cannot leave somebody with half a configuration.
    const tmp = `${p.file}.forge-tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tmp, p.file);
  } catch (e) {
    return { ok: false, file: p.file, why: `That file could not be written: ${e.message}` };
  }

  return {
    ok: true,
    file: p.file,
    changed: true,
    kept: p.others,
    note: p.already ? "The existing entry was replaced." : "Added.",
  };
}

/** Removes the entry again, leaving the rest of the file alone. */
function disconnect(app, { file: override } = {}) {
  let file = override;
  if (!file) {
    try {
      file = configPath(app);
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }
  const read = readConfig(file);
  if (!read.ok) return { ok: false, file, why: read.why };
  const servers = read.config.mcpServers;
  if (!servers || !servers[KEY]) return { ok: true, file, changed: false, note: "It was not connected." };
  delete servers[KEY];
  try {
    fs.writeFileSync(file, `${JSON.stringify(read.config, null, 2)}\n`);
  } catch (e) {
    return { ok: false, file, why: `That file could not be written: ${e.message}` };
  }
  return { ok: true, file, changed: true, note: "Removed." };
}

/** The same thing as a command, for Claude Code and for pasting elsewhere. */
function command({ execPath, serverPath }) {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return `claude mcp add ${KEY} --env ELECTRON_RUN_AS_NODE=1 -- ${q(execPath)} ${q(serverPath)}`;
}

module.exports = { KEY, configPath, entry, plan, connect, disconnect, command, readConfig };
