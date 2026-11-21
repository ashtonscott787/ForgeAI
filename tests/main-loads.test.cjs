// The app's main process must at least load.
//
// 0.5.5 shipped an app that could not open at all: a module was used at load
// time and declared two hundred lines below, so Node threw
// "Cannot access 'search' before initialization" before any window appeared.
// Nothing caught it, because nothing here had ever loaded main.cjs — the CI
// smoke tests run llama-server, not Electron.
//
// This loads it with a stand-in for electron. It will not prove the app works,
// but it does prove the file can be executed, which is the failure that got out.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const os = require("node:os");

/** Enough of electron to get through module evaluation. */
function stubElectron() {
  const noop = () => undefined;
  const chainable = () => ({ on: noop, once: noop, send: noop, removeListener: noop });
  const win = function BrowserWindow() {
    return {
      on: noop, once: noop, loadURL: async () => undefined, loadFile: async () => undefined,
      destroy: noop, show: noop, focus: noop, isMinimized: () => false, restore: noop,
      webContents: { on: noop, once: noop, send: noop, setWindowOpenHandler: noop, printToPDF: async () => Buffer.alloc(0) },
    };
  };
  win.getAllWindows = () => [];
  win.fromWebContents = () => null;

  return {
    app: {
      whenReady: () => new Promise(() => {}),   // never resolves: nothing should start
      on: noop, once: noop, quit: noop, exit: noop,
      getPath: (k) => path.join(os.tmpdir(), `forge-stub-${k}`),
      getVersion: () => "0.0.0-test",
      getName: () => "Forge AI",
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient: () => true,
      isDefaultProtocolClient: () => false,
      removeAsDefaultProtocolClient: () => true,
      setLoginItemSettings: noop, getLoginItemSettings: () => ({}),
      disableHardwareAcceleration: noop,
    },
    BrowserWindow: win,
    ipcMain: { handle: noop, on: noop, removeHandler: noop },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    shell: { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: noop },
    session: { fromPartition: () => ({ setPermissionRequestHandler: noop, webRequest: { onHeadersReceived: noop } }), defaultSession: { webRequest: { onHeadersReceived: noop } } },
    dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) },
    protocol: { registerSchemesAsPrivileged: noop, handle: noop },
    net: { request: () => chainable() },
    Notification: function Notification() { return { show: noop, on: noop }; },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" },
    nativeTheme: { on: noop, themeSource: "system" },
    webUtils: { getPathForFile: () => "" },
    contextBridge: { exposeInMainWorld: noop },
    ipcRenderer: { invoke: async () => undefined, on: noop, removeListener: noop },
  };
}

/** Loads a file with electron stubbed, and returns whatever it threw. */
function loadWithStub(file) {
  const stub = stubElectron();
  const original = Module._load;
  const touched = [];
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return stub;
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return null; } })();
    if (resolved && resolved.includes(`${path.sep}electron${path.sep}`)) touched.push(resolved);
    return original.apply(this, arguments);
  };
  try {
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${path.sep}electron${path.sep}`)) delete require.cache[k];
    }
    require(file);
    return null;
  } catch (e) {
    return e;
  } finally {
    Module._load = original;
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${path.sep}electron${path.sep}`)) delete require.cache[k];
    }
  }
}

test("the main process file loads without throwing", () => {
  const err = loadWithStub(path.join(__dirname, "..", "electron", "main.cjs"));
  assert.equal(err, null, `main.cjs threw while loading: ${err && (err.stack || err.message)}`);
});

test("no module is used at load time before it is declared", () => {
  // The exact shape of the 0.5.5 crash, checked directly: a top-level
  // `thing.method(` whose `const thing = require(...)` comes later in the file.
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8").split("\n");
  const declaredAt = new Map();
  src.forEach((line, i) => {
    const m = line.match(/^const\s+(\w+)\s*=\s*require\(/);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  });
  const problems = [];
  src.forEach((line, i) => {
    const m = line.match(/^(\w+)\s*\./);           // a top-level use, not indented
    if (!m) return;
    const at = declaredAt.get(m[1]);
    if (at !== undefined && at > i) problems.push(`${m[1]} used on line ${i + 1}, declared on line ${at + 1}`);
  });
  assert.deepEqual(problems, [], `used before declaration:\n${problems.join("\n")}`);
});

test("the preload file loads too", () => {
  const err = loadWithStub(path.join(__dirname, "..", "electron", "preload.cjs"));
  assert.equal(err, null, `preload.cjs threw while loading: ${err && (err.stack || err.message)}`);
});
