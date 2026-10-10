'use strict';
/* ForgeAI 2.7 — runs in the background (menu-bar / tray icon by default, can be hidden), low CPU priority by default,
   your other apps come first (ForgeAI steps back when they need the CPU, memory or GPU), agents choose and switch
   computers, and rollouts: enrolment keys, one-line installs for Mac / Windows / Linux, push over SSH. */

// ---------------- Settings → This computer
async function settingsThisComputer(body) {
  const [pr, dk, ld] = await Promise.all([api('/api/settings/priority'), api('/api/settings/desktop'), api('/api/settings/lend').catch(() => null)]);
  const li = (title, sub, ctl) => h('div.li', null, h('div.t', null, h('b', null, title), sub ? h('span', null, sub) : null), h('div.ctl', null, ctl));
  const st = pr.state || {};
  const live = h('div.small', { style: { marginTop: '4px' } });
  const drawLive = (s) => { clear(live).append(s && s.at ? (s.yielding ? h('span', { style: { color: 'var(--orange, #c77700)' } }, icon('moon', 'sm'), ' Stepping back right now — ', s.reason) : h('span.muted', null, icon('check', 'sm'), ` Your apps are using ${s.others ? s.others.cpuPct : '?'}% CPU; ForgeAI ${s.own ? s.own.cpuPct : '?'}% across ${s.own ? s.own.processes : '?'} processes; ${s.mem ? (s.mem.free / 2 ** 30).toFixed(1) : '?'} GB memory free${s.others && s.others.gpu ? `; other apps use ${s.others.gpu.pct}% of GPU memory` : ''}.`)) : h('span.muted', null, 'Measuring…')); };
  drawLive(st);
  // Background
  if (dk.available) {
    body.append(h('div.section-title', { style: { marginTop: 0 } }, 'Running in the background'), h('div.list', null,
      li('Show the ForgeAI icon', S.me && S.me.os === 'darwin' ? 'In the menu bar. ForgeAI has no Dock icon while its window is closed.' : 'In the notification area (system tray). ForgeAI has no taskbar button while its window is closed.', toggle(dk.showIcon, guard(async (v) => { if (!v && !confirm('Hide the icon? ForgeAI keeps running in the background. To open it again, open ForgeAI from ' + (S.me && S.me.os === 'darwin' ? 'Applications or Launchpad' : 'the Start menu') + '.')) { route(); return; } await api('/api/settings/desktop', { method: 'PUT', body: { showIcon: v } }); toast(v ? 'Icon shown' : 'Icon hidden'); }))),
      li('Start when I log in', 'Starts hidden in the background — no window.', toggle(dk.startAtLogin, guard(async (v) => { await api('/api/settings/desktop', { method: 'PUT', body: { startAtLogin: v } }); toast('Saved'); }))),
      li('Start hidden', 'When ForgeAI starts, don’t open the window.', toggle(dk.startHidden, guard(async (v) => { await api('/api/settings/desktop', { method: 'PUT', body: { startHidden: v } }); toast('Saved'); })))));
  }
  // Priority
  const level = sel([['low', 'Low — your apps first (recommended)'], ['lowest', 'Lowest — only spare CPU, efficiency cores on Apple Silicon'], ['normal', 'Normal — same as other apps']], pr.level, { onchange: guard(async (e) => { const r = await api('/api/settings/priority', { method: 'PUT', body: { level: e.target.value } }); toast(r.note || 'Saved'); }) });
  const yieldT = toggle(pr.yield, guard(async (v) => { await api('/api/settings/priority', { method: 'PUT', body: { yield: v } }); toast(v ? 'ForgeAI steps back when your apps need the computer' : 'ForgeAI no longer steps back'); }));
  const num = (k, min, max, suffix) => h('div.row.nowrap', null, h('input', { type: 'number', min, max, value: pr[k], style: { width: '80px' }, onchange: guard(async (e) => { await api('/api/settings/priority', { method: 'PUT', body: { [k]: +e.target.value } }); toast('Saved'); }) }), h('span.faint', { style: { marginLeft: '6px' } }, suffix));
  body.append(h('div.section-title', null, 'Your apps come first'), h('div.list', null,
    li('CPU priority', 'For ForgeAI and every model, cluster and training job it runs. The operating system serves your other apps first.', level),
    li('Step back when other apps need the computer', h('span', null, 'Background work (agents, schedules, work for other computers) waits, idle models are unloaded to free memory, and other computers stop sending work here. Chats you are having keep going.', live), yieldT),
    li('…when other apps use more than', null, num('yieldCpu', 20, 100, '% of the CPU')),
    li('…or free memory drops below', null, num('yieldMemPct', 3, 50, '% of memory')),
    li('…or other apps use more than', 'NVIDIA GPUs only. On a Mac, GPU memory is ordinary memory and is covered above.', num('yieldGpuPct', 20, 100, '% of GPU memory'))),
    h('p.small.muted', null, 'No program can reserve GPU time from another on macOS or Windows; ForgeAI frees GPU memory by unloading models instead.'));
  if (ld) body.append(h('div', { style: { marginTop: '10px' } }, note('info', 'Lending this computer to other ForgeAI computers is under Computers → Lend this computer.')));
  // Keep the live line fresh while the page is open
  const tick = async () => { if (!document.body.contains(live)) return; try { const r = await api('/api/settings/priority'); drawLive(r.state); } catch {} S.pageTimer = setTimeout(tick, 5000); }; S.pageTimer = setTimeout(tick, 5000);
}

// ---------------- Computers → Roll out ForgeAI to more computers
async function rolloutSection(pg) {
  const [d, L] = await Promise.all([api('/api/deploy').catch(() => null), api('/api/link').catch(() => null)]);
  if (!d || !L) return;
  const box = h('div'); pg.append(h('div.section-title', null, 'Roll out to more computers'), box);
  const draw = (d) => {
    clear(box);
    if (!d.hubOn) return box.append(h('div.card', null, h('div.md', { html: md('Turn on **Be the hub** above first. New computers install ForgeAI from this computer and join it by themselves.') })));
    const missing = d.files.filter((f) => !f.ok).map((f) => f.name);
    box.append(h('div.card', null, h('div.md', { html: md(`Install ForgeAI on many computers at once — silently, low priority, and joined to this hub. Each computer downloads the installer **from this computer** (checksums verified) using an **enrolment key** that you can limit and revoke.\n\nInstallers folder: \`${d.dir}\`${missing.length ? `  — missing: ${missing.join(', ')}` : ' — all four packages found'}`) }),
      h('div.row', { style: { gap: '8px', marginTop: '10px' } },
        h('button.btn.primary', { onclick: () => newKeyModal() }, icon('plus', 'sm'), 'New enrolment key'),
        h('button.btn', { onclick: () => sshModal() }, icon('server', 'sm'), 'Push over SSH…'),
        h('button.btn', { onclick: () => uninstallModal(d) }, icon('trash', 'sm'), 'Uninstall commands…'),
        h('button.btn.ghost', { onclick: guard(async () => { const v = prompt('Folder on this computer with the ForgeAI installers (ForgeAI-Mac-AppleSilicon.zip, ForgeAI-Windows.zip…):', d.dir); if (v == null) return; await api('/api/deploy', { method: 'PUT', body: { dir: v } }); draw(await api('/api/deploy')); }) }, 'Change folder'))));
    const reqBox = h('div'); box.append(reqBox); drawRequests(reqBox);
    if (d.enrol.length) box.append(h('div.list', { style: { marginTop: '10px' } }, d.enrol.map((k) => h('div.li', null, icon('key'), h('div.t', null, h('b', null, k.label), h('span', null, `${k.used} of ${k.uses} used · ${k.expired ? 'expired' : 'expires ' + new Date(k.expires).toLocaleDateString()}${(k.joined || []).length ? ' · joined: ' + k.joined.slice(-5).map((j) => j.name).join(', ') : ''}`)),
      h('button.btn.sm.ghost.danger', { onclick: guard(async () => { await api('/api/link/hub/enrol/' + k.id, { method: 'DELETE' }); draw(await api('/api/deploy')); }) }, 'Revoke')))));
  };
  // Computers asking to join (owner-approved claim). The computer gets nothing until you approve it here.
  const drawRequests = async (rbox) => {
    let reqs = []; try { reqs = (await api('/api/link/requests')).requests || []; } catch { return; }
    clear(rbox); if (!reqs.length) return;
    rbox.append(h('div.section-title', { style: { fontSize: '14px', marginTop: '14px' } }, `Computers asking to join (${reqs.length})`),
      h('div.list', null, reqs.map((r) => h('div.li', null, icon('user-check'),
        h('div.t', null, h('b', null, r.name), h('span', null, `${r.os || 'computer'} · ${r.address || 'unknown address'} · asked ${new Date(r.at).toLocaleString()}`)),
        h('div.row', { style: { gap: '6px' } },
          h('button.btn.sm.primary', { onclick: guard(async () => { await api(`/api/link/requests/${r.reqId}/approve`, { method: 'POST' }); toast(`Approved ${r.name} — it will join shortly`); drawRequests(rbox); }) }, 'Approve'),
          h('button.btn.sm.ghost.danger', { onclick: guard(async () => { await api(`/api/link/requests/${r.reqId}/decline`, { method: 'POST' }); drawRequests(rbox); }) }, 'Decline'))))));
  };
  const showCommands = (k) => {
    const c = k.commands; const cmd = (label, text, hint) => h('div', { style: { margin: '10px 0' } }, h('div.row.between', null, h('b', null, label), h('button.btn.sm', { onclick: () => { navigator.clipboard.writeText(text); toast('Copied'); } }, icon('copy', 'sm'), 'Copy')), h('pre.mono.small', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--fill, rgba(127,127,127,.12))', padding: '8px 10px', borderRadius: '8px', margin: '4px 0' } }, text), hint ? h('div.small.muted', null, hint) : null);
    modal('Install commands', h('div', null,
      note('info', `Key “${k.label}”: ${k.uses} installs, valid until ${new Date(k.expires).toLocaleString()}. Shown once — copy it now. Revoke it any time from this page.`),
      h('div.mono', { style: { margin: '8px 0', fontSize: '15px' } }, k.key),
      cmd('Mac (Terminal)', c.mac, 'Installs the desktop app, low priority, starts hidden at login and joins this hub. Add --hide-icon for no menu-bar icon.'),
      cmd('Windows (PowerShell, as the user — add -AllUsers as admin)', c.windows, 'Runs the normal installer silently (/S).'),
      cmd('Linux (shell)', c.linux, 'Installs ForgeAI Server as a service with low CPU priority.'),
      h('details', null, h('summary.small.muted', null, 'Using your own tools (Intune, Jamf, PDQ, Ansible…)?'), h('div.md.small', { html: md(`- **Windows:** \`"Install ForgeAI (x64).exe" /S /ALLUSERS /HUB=${c.hub} /KEY=${k.key} /PRIORITY=low /AUTOSTART /START\`  (also /HIDEICON, /NOYIELD, /LEND=idle|always|never, /NAME=…, /D=C:\\path). Uninstall: \`"Uninstall ForgeAI.exe" /S\` (add /PURGE to delete data).\n- **Mac:** \`sh install-unix.sh --silent --zip ForgeAI-Mac-AppleSilicon.zip --hub ${c.hub} --key ${k.key} --autostart\`\n- **Linux:** \`sudo sh install-unix.sh --silent --zip ForgeAI-Server.zip --hub ${c.hub} --key ${k.key}\`\n\n\`install-unix.sh\` and \`install-windows.ps1\` are in the ForgeAI Server folder.`) }))), [{ label: 'Done', primary: true, onClick: () => route() }], { wide: true });
  };
  const uninstallModal = (d) => {
    const c = d.uninstall; let purge = false; const cmds = h('div');
    const cmd = (label, text, hint) => h('div', { style: { margin: '10px 0' } }, h('div.row.between', null, h('b', null, label), h('button.btn.sm', { onclick: () => { navigator.clipboard.writeText(text); toast('Copied'); } }, icon('copy', 'sm'), 'Copy')), h('pre.mono.small', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--fill, rgba(127,127,127,.12))', padding: '8px 10px', borderRadius: '8px', margin: '4px 0' } }, text), hint ? h('div.small.muted', null, hint) : null);
    const drawCmds = () => clear(cmds).append(
      cmd('Mac (Terminal)', c.mac + (purge ? ' --purge' : ''), 'Put sudo before sh to remove it for every user on that Mac.'),
      cmd('Windows (PowerShell as administrator, or your deployment tool)', purge ? c.windows.replace(/"$/, ' -Purge"') : c.windows, 'Log: %TEMP%\\ForgeAI-uninstall.log (as SYSTEM: C:\\Windows\\Temp).'),
      cmd('Linux (shell)', c.linux + (purge ? ' --purge' : ''), null));
    drawCmds();
    modal('Remove ForgeAI from computers', h('div', null,
      note('info', 'Removes every ForgeAI install on that computer (all users, the background service, shortcuts, start-up entries). For a computer that is already linked, it is easier to open it in Computers and choose Uninstall — that also takes away its access here.'),
      h('div.list', null, h('div.li', null, h('div.t', null, h('b', null, 'Also delete data'), h('span', null, 'Chats, settings, downloaded models and saved keys on those computers. Cannot be undone.')), toggle(false, (v) => { purge = v; drawCmds(); }))),
      cmds,
      h('details', null, h('summary.small.muted', null, 'Using your own tools (Intune, Jamf, PDQ, Ansible…)?'), h('div.md.small', { html: md('- **Windows:** `"Uninstall ForgeAI.exe" /S` — add `/PURGE` to delete data. Exit code 0 = removed (or nothing there), 2 = finish at next restart. It is in the ForgeAI for Windows folder and the installers folder.\n- **Mac / Linux:** `sudo sh uninstall-unix.sh --silent` (add `--purge`, or `--dry-run` to see what it would remove). On a Mac you can also double-click **Uninstall ForgeAI.command**.') }))),
      [{ label: 'Done', primary: true, onClick: () => {} }], { wide: true });
  };
  const newKeyModal = () => {
    const label = h('input', { type: 'text', value: 'Office rollout' }); const uses = h('input', { type: 'number', value: 25, min: 1, max: 10000 }); const days = h('input', { type: 'number', value: 7, min: 1, max: 365 });
    modal('New enrolment key', h('div', null, field('Name', label), h('div.grid.g2', { style: { gap: '12px' } }, field('How many computers', uses), field('Valid for (days)', days)), note('info', 'Anyone with this key can join a computer to this hub until it expires or is used up. Revoke it when the rollout is done.')),
      [{ label: 'Create', primary: true, onClick: async () => { const k = await api('/api/link/hub/enrol', { body: { label: label.value, uses: +uses.value, days: +days.value } }); setTimeout(() => showCommands(k), 50); } }]);
  };
  const sshModal = () => {
    const targets = h('textarea', { rows: 5, placeholder: 'ash@192.168.1.31\nadmin@office-mac.local', style: { width: '100%', fontFamily: 'var(--mono, monospace)' } });
    const osSel = sel([['mac', 'Mac'], ['linux', 'Linux'], ['windows', 'Windows (OpenSSH)']], 'mac'); const out = h('div');
    modal('Push over SSH', h('div', null, field('Computers (user@host, one per line)', targets), field('They are', osSel), note('info', 'Uses this computer’s own SSH keys (no passwords are asked for or stored). Each computer downloads ForgeAI from this hub and joins it. Linux needs passwordless sudo for the service.'), out),
      [{ label: 'Push', primary: true, onClick: async () => { clear(out).append(h('div.row', null, h('span.spinner'), ' Installing… this can take a few minutes per computer')); const r = await api('/api/deploy/ssh', { body: { targets: targets.value, os: osSel.value } }); clear(out).append(h('div.list', { style: { boxShadow: 'none', marginTop: '10px' } }, r.results.map((x) => h('div.li', null, icon(x.ok ? 'check' : 'warn'), h('div.t', null, h('b', null, x.target), h('span', null, x.ok ? 'Installed' : x.error)))))); return false; } }], { wide: true });
  };
  draw(d);
}
const pageNetwork26 = window.pageNetwork;
window.pageNetwork = async function (root) { await pageNetwork26(root); if (!isOwner()) return; const pg = root.querySelector('.page'); if (pg) await rolloutSection(pg); };
