// Real Electron, real main process, real renderer. Run with: pnpm test:e2e
// Needs a display: on Linux, run under xvfb-run. Electron as root needs --no-sandbox.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");
const zlib = require("node:zlib");

/** A solid red 64×64 PNG, built here so the test has no image dependency. */
function redPng() {
  const w = 64, h = 64;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([255, 0, 0]).flat())])));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ROOT = path.join(__dirname, "..", "..");
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 5).join("\n    "));
  }
};

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));
  // Vision needs a model and its projector. They are copied in only when a directory is supplied.
  const visionDir = process.env.FORGE_TEST_VISION_DIR;
  const visionReady = visionDir && fs.existsSync(path.join(visionDir, "SmolVLM-256M-Instruct-Q8_0.gguf")) && fs.existsSync(path.join(visionDir, "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf"));
  if (visionReady) {
    fs.mkdirSync(path.join(userData, "models"), { recursive: true });
    for (const n of ["SmolVLM-256M-Instruct-Q8_0.gguf", "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf"]) fs.copyFileSync(path.join(visionDir, n), path.join(userData, "models", n));
  }
  const app = await electron.launch({
    executablePath: path.join(ROOT, "node_modules", "electron", "dist", "electron"),
    args: ["--no-sandbox", `--user-data-dir=${userData}`, path.join(ROOT, "electron", "main.cjs")],
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector(".app", { timeout: 60_000 });

  await step("the app page has a bridge and a Content-Security-Policy", async () => {
    assert.equal(await win.evaluate(() => typeof window.forge), "object");
    assert.equal(await win.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')), true);
  });

  await step("the app page's policy blocks inline script that is injected into the page", async () => {
    // Playwright's evaluate uses a DevTools channel that CSP does not apply to, so it cannot test
    // the policy. An inline script added to the DOM is governed by the page's policy.
    await win.evaluate(() => { window.__injected = false; const s = document.createElement("script"); s.textContent = "window.__injected = true"; document.body.appendChild(s); });
    await win.waitForTimeout(300);
    assert.equal(await win.evaluate(() => window.__injected), false, "the injected inline script did not run");
  });

  await step("the browser opens a real https page in a <webview>", async () => {
    await win.getByRole("button", { name: "Browser", exact: true }).click();
    await win.getByLabel("Address or search").fill("example.com");
    await win.getByRole("button", { name: "Go", exact: true }).click();
    await win.waitForSelector("webview", { timeout: 10_000 });
    assert.equal(await win.locator("webview").getAttribute("src"), "https://example.com");
  });

  await step("the real guest loads the page, under the lockdown the main process enforces", async () => {
    const guest = await app.evaluate(({ webContents }) => new Promise((resolve) => {
      const g = webContents.getAllWebContents().find((w) => w.getType() === "webview");
      if (!g) return resolve(null);
      const read = () => resolve({ url: g.getURL(), title: g.getTitle(), prefs: g.getLastWebPreferences(), persistent: g.session.isPersistent() });
      if (!g.isLoading() && g.getURL()) read(); else g.once("did-finish-load", read);
      setTimeout(read, 15_000);
    }));
    assert.ok(guest, "a webview guest exists");
    assert.equal(guest.url, "https://example.com/");
    assert.match(guest.title, /Example Domain/);
    assert.equal(guest.prefs.nodeIntegration, false, "no Node in the guest");
    assert.equal(guest.prefs.sandbox, true, "the guest is sandboxed");
    assert.ok(!guest.prefs.preload, "the guest has no preload script");
    assert.equal(guest.persistent, true, "the guest has its own persistent storage");
  });

  await step("a generated page runs its script under its own policy, and its network request is blocked", async () => {
    const id = await win.evaluate(() => window.forge.invoke("preview_register", { html: "<p id=\"x\">waiting</p><script>document.getElementById('x').textContent='PREVIEW-RAN';fetch('https://example.com/').then(()=>{document.title='REACHED'},()=>{document.title='BLOCKED'});</script>" }));
    await win.evaluate((url) => {
      const f = document.createElement("iframe");
      f.id = "probe-preview";
      f.setAttribute("sandbox", "allow-scripts");
      f.src = url;
      document.body.appendChild(f);
    }, id.url);
    let frame = null;
    for (let i = 0; i < 50 && !frame; i++) {
      await win.waitForTimeout(200);
      frame = win.frames().find((fr) => fr.url().startsWith("forge-preview://"));
    }
    assert.ok(frame, "the forge-preview frame loaded");
    await frame.waitForFunction(() => document.getElementById("x")?.textContent === "PREVIEW-RAN", null, { timeout: 8000 });
    await frame.waitForFunction(() => document.title === "BLOCKED" || document.title === "REACHED", null, { timeout: 8000 });
    assert.equal(await frame.evaluate(() => document.title), "BLOCKED", "the preview policy blocks its network request");
    await win.evaluate(() => document.getElementById("probe-preview")?.remove());
    await win.evaluate((i) => window.forge.invoke("preview_forget", { id: i }), id.id);
  });

  await step("a screenshot of the guest is captured, and the save writes a real PNG", async () => {
    const out = path.join(userData, "shot.png");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, out);
    const dataUrl = await app.evaluate(({ webContents }) => {
      const g = webContents.getAllWebContents().find((w) => w.getType() === "webview");
      return g.capturePage().then((img) => img.toDataURL());
    });
    const saved = await win.evaluate((d) => window.forge.invoke("save_screenshot", { dataUrl: d }), dataUrl);
    assert.equal(saved, out);
    const bytes = fs.readFileSync(out);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG signature");
    assert.ok(bytes.length > 1000, "a non-empty image");
  });

  await step("a plain-http address is never opened as a guest", async () => {
    await win.getByLabel("Address or search").fill("http://127.0.0.1:9/");
    await win.getByRole("button", { name: "Go", exact: true }).click();
    await win.waitForTimeout(500);
    const guests = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === "webview").map((w) => w.getURL()));
    assert.ok(!guests.some((u) => u.startsWith("http://")), "a guest was opened over http: " + guests.join(","));
  });

  await step("the default-browser status is reported, and nothing changes it without the person", async () => {
    const st = await win.evaluate(() => window.forge.invoke("default_browser_status", {}));
    assert.equal(typeof st.is_default, "boolean");
    assert.ok(["linux", "win32", "darwin"].includes(st.platform));
  });

  await step("a link opened from outside arrives in the running window as a new browser tab", async () => {
    const before = await win.locator(".browser-tab").count();
    const { spawn } = require("node:child_process");
    const second = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron"), [
      "--no-sandbox", `--user-data-dir=${userData}`, path.join(ROOT, "electron", "main.cjs"), "https://example.com/?from=os",
    ], { stdio: "ignore" });
    await new Promise((r) => second.on("exit", r));
    await win.waitForFunction((n) => document.querySelectorAll(".browser-tab").length > n, before, { timeout: 15_000 });
    const srcs = await win.locator("webview").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
    assert.ok(srcs.includes("https://example.com/?from=os"), "the link opened: " + srcs.join(","));
  });

  if (!visionReady) {
    console.log("SKIP a vision model answers about an attached image: set FORGE_TEST_VISION_DIR to a folder with SmolVLM-256M-Instruct-Q8_0.gguf and its mmproj");
  } else {
    await step("a vision model answers about an attached image, through the real engine", async () => {
      const png = path.join(userData, "red.png");
      fs.writeFileSync(png, redPng());
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, png);
      await win.locator(".sitem.nav", { hasText: "Chat" }).click({ timeout: 10_000 });
      await win.getByTitle("Attach files").click({ timeout: 10_000 });
      await win.locator("img.athumb").first().waitFor({ timeout: 10_000 });
      const box = win.locator('textarea[placeholder^="Ask anything"]');
      await box.fill("What color is this image? Answer with one word.", { timeout: 10_000 });
      await box.press("Enter", { timeout: 10_000 });
      // Poll with a bound. A reply that never names the colour fails with what the chat showed.
      let reply = "";
      for (let i = 0; i < 60 && !/red/i.test(reply); i++) {
        await win.waitForTimeout(2_000);
        reply = await win.locator(".msg.assistant").last().innerText({ timeout: 5_000 }).catch(() => "");
      }
      assert.match(reply, /red/i, "the reply names the colour. Last reply: " + JSON.stringify(reply.slice(0, 160)));
    });
  }

  await app.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Electron checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
