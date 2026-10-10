'use strict';
// Run ForgeAI without the desktop app (server, VPS, Linux box, Raspberry Pi):  node headless.js
//   --worker        share this computer's models and llama.cpp with a main ForgeAI (turns on network access + HTTPS)
//   --port 4545     port to listen on
// Data folder: AICORE_DATA (default ./data). Secrets are encrypted with a key file in that folder,
// or with AICORE_MASTER_KEY if set. Remote access / HTTPS can also be changed in the dashboard (Settings → Access).
const path = require('path');
const os = require('os');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) { console.error(`ForgeAI needs Node.js 22.5 or newer (this is ${process.version}). Install it from https://nodejs.org or with the install script.`); process.exit(1); }
const args = process.argv.slice(2); const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const { createApp } = require('./server');
const dataDir = process.env.AICORE_DATA || path.join(__dirname, 'data');
const app = createApp({ dataDir, version: require('./package.json').version });
let token = null;
const managed = args.includes('--service') || process.env.FORGEAI_SERVICE === '1';
if (args.includes('--worker') || process.env.FORGEAI_WORKER === '1' || managed) token = app.enableWorker({ port: arg('--port') || process.env.AICORE_PORT, https: !args.includes('--no-https'), managed });
if (args.includes('--print-token')) { // used by the install scripts: set up worker mode, show how to connect, exit
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(JSON.stringify({ token: token || app.enableWorker({ port: arg('--port') }), addresses: addrs, port: +(arg('--port') || 4545) }));
  process.exit(0);
}
app.start().then(async (info) => {
  // setup.json from a silent / command-line install: applied once, then renamed.
  const fs = require('fs'); const sj = path.join(dataDir, 'setup.json');
  if (fs.existsSync(sj)) { try { await app.applySetup(JSON.parse(fs.readFileSync(sj, 'utf8'))); fs.renameSync(sj, path.join(dataDir, 'setup.applied.json')); console.log('Applied setup.json'); } catch (e) { console.error('setup.json:', e.message); } }
  console.log(`ForgeAI running at ${info.localUrl} (${info.remote ? 'remote access ON' : 'this computer only'})`);
  console.log('Data folder:', dataDir);
  if (token) {
    const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `${info.https ? 'https' : 'http'}://${a.address}:${info.port}`);
    console.log('\nWorker mode is ON. On your main ForgeAI: Computers → Add Computer → Another computer running ForgeAI');
    console.log('  Address:', addrs.join('  or  ') || `port ${info.port}`);
    console.log('  Computer token:', token);
    if (info.fingerprint) console.log('  Certificate fingerprint (check it matches when you trust it):', info.fingerprint);
  }
  if (!app.auth.hasUsers()) console.log('First-time setup code (needed when setting up from another computer):', app.setupCode);
});
process.on('SIGINT', () => { app.stop(); process.exit(0); });
process.on('SIGTERM', () => { app.stop(); process.exit(0); });
