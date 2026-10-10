const { packager } = require('@electron/packager');
const fs = require('fs'); const path = require('path');
const V = '44.4.5', APPV = '2.10.0';
const common = {
  dir: __dirname + '/app', out: __dirname + '/dist', electronVersion: V, electronZipDir: '/home/claude', download: { cacheRoot: '/tmp/ecache' },
  name: 'ForgeAI', executableName: 'ForgeAI', appBundleId: 'local.forgeai.app', overwrite: true, asar: false, prune: true,
  ignore: [/^\/data($|\/)/, /^\/test($|\/)/], appVersion: APPV, buildVersion: APPV, appCopyright: 'ForgeAI',
};
// Windows: set the .exe icon and version details in pure JS (no Wine needed).
async function patchExe(exe) {
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const data = fs.readFileSync(exe);
  const pe = R.NtExecutable.from(data, { ignoreCert: true });
  const res = R.NtExecutableResource.from(pe);
  const ico = R.Data.IconFile.from(fs.readFileSync(__dirname + '/ForgeAI.ico'));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const gid = groups.length ? groups[0].id : 1; const lang = groups.length ? groups[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map((i) => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] || R.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(2, 10, 0, 0, 1033); vi.setProductVersion(2, 10, 0, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'ForgeAI', ProductName: 'ForgeAI', CompanyName: 'ForgeAI', LegalCopyright: 'ForgeAI', OriginalFilename: 'ForgeAI.exe', InternalName: 'ForgeAI' });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
}
(async () => {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];
  for (const t of targets) {
    const [platform, arch] = t.split('-');
    // Bundled llama.cpp: only this platform's builds go into the package.
    const keep = { 'darwin-arm64': ['macos-arm64'], 'darwin-x64': ['macos-x64'], 'win32-x64': ['win-vulkan-x64', 'win-cpu-x64'], 'win32-arm64': ['win-vulkan-arm64', 'win-cpu-arm64'] }[t] || [];
    const engineIgnore = new RegExp('^/engines/(?!(' + keep.join('|') + '|VERSION)(/|$))');
    const winOnly = platform === 'win32' ? [] : [/^\/deploy\/Uninstall ForgeAI\.exe$/];
    const opts = { ...common, platform, arch, ignore: [...common.ignore, engineIgnore, ...winOnly] };
    if (platform === 'darwin') Object.assign(opts, { icon: __dirname + '/ForgeAI.icns', appCategoryType: 'public.app-category.business', extendInfo: { LSMinimumSystemVersion: '12.0', NSLocalNetworkUsageDescription: 'ForgeAI finds and connects to other ForgeAI computers on your network.' } });
    const [out] = await packager(opts);
    if (platform === 'win32') {
      await patchExe(path.join(out, 'ForgeAI.exe'));
      // The background-service wrapper ships next to ForgeAI.exe so /SERVICE installs can register it.
      const svc = __dirname + '/win/service/ForgeAIService.exe';
      if (fs.existsSync(svc)) fs.copyFileSync(svc, path.join(out, 'ForgeAIService.exe'));
    }
    console.log('built', out);
  }
})().catch((e) => { console.error(e); process.exit(1); });
