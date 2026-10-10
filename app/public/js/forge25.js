'use strict';
/* ForgeAI 2.5 — remote link (built-in tunnel between ForgeAI computers on different networks), cluster links over any
   connection (Thunderbolt/USB-C, Ethernet, Wi-Fi, remote link), lend-when-idle, strict model selection, downloads to any
   computer, "where to run". Loaded after forge24.js. */

Object.assign(ICONS, { link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>', moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>' });
const fmtBytes25 = (b) => (b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : b >= 2 ** 20 ? (b / 2 ** 20).toFixed(0) + ' MB' : Math.round(b / 1024) + ' KB');
const ago25 = (t) => { if (!t) return '—'; const s = (Date.now() - new Date(t)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

// ---------------- Remote link section (Computers & Network)
async function linkSection(pg) {
  const L = await api('/api/link').catch(() => null); if (!L) return;
  const box = h('div'); pg.append(h('div.section-title', null, 'Remote link — computers on other networks'), box);
  const redraw = async () => { const n = await api('/api/link'); clear(box).append(draw(n)); };
  const draw = (L) => {
    const out = h('div');
    const hub = L.hub, sp = L.spoke;
    out.append(h('div.card', { style: { marginBottom: '12px' } }, h('div.md', { html: md(`Built into ForgeAI — no VPN or other app needed. One computer is the **hub** (it needs an address the others can reach: a ForgeAI Server on a small cloud machine, or a home computer with one port opened on the router — ForgeAI can try to open it for you). Every other computer **connects out** to the hub over an encrypted link and nothing on them needs opening. Linked computers appear under *Computers doing the work*, can join clusters, and can be reached from anywhere through the hub. Nothing goes through any third-party service.`) })));
    // --- hub
    const hubList = h('div.list');
    hubList.append(h('div.li', null, icon('server', 'lg'), h('div.t', null, h('b', null, 'Be the hub'), h('span', null, hub.enabled ? `Other computers connect to this one${L.listen ? ` on port ${L.listen.port} (HTTPS)` : ''}.` : 'Turns on “Allow other computers” + HTTPS and lets other ForgeAI computers pair with this one.')),
      toggle(hub.enabled, guard(async (v) => { if (v && !confirm('Make this computer the hub? It will accept encrypted connections from computers you pair with a one-time code. Other computers must be able to reach this one (same network, or a port opened on the router).')) { await redraw(); return; } await api('/api/link/hub', { method: 'POST', body: { enabled: v } }); toast(v ? 'Hub on — the dashboard may reconnect' : 'Hub off'); setTimeout(redraw, 1500); }))));
    if (hub.enabled) {
      hubList.append(h('div.li', null, h('div.t', null, h('b', null, 'Pair a computer'), h('span', null, 'Make a one-time code (valid 15 minutes). On the other computer: Computers & Network → Remote link → “Connect to a hub”, enter this computer’s address and the code.')),
        h('button.btn.sm.tint', { onclick: guard(async () => { const r = await api('/api/link/hub/code', { method: 'POST' }); const addrs = L.addresses.map((a) => `${a.address}:${L.listen.port}`); modal('Pairing code', h('div', null, h('div', { style: { font: '650 34px/1.2 var(--mono, monospace)', letterSpacing: '0.08em', textAlign: 'center', margin: '8px 0 14px' } }, r.code), h('p.faint', null, `Valid for ${r.expiresInMinutes} minutes, one use. Hub address to enter on the other computer:`), ...addrs.map((a) => h('div.mono', { style: { margin: '2px 0' } }, a)), h('p.faint.small', null, 'From another network use your public address (or domain) and the port you opened on the router.')), [{ label: 'Done', primary: true, onClick: () => {} }]); }) }, icon('plus', 'sm'), 'New code')));
      hubList.append(h('div.li', null, h('div.t', null, h('b', null, 'Reachable from the internet?'), h('span', null, `Other networks need a way in: a public address + port ${L.listen ? L.listen.port : ''} forwarded to this computer. ForgeAI can ask your router to open it (NAT-PMP / UPnP). Cloud ForgeAI Servers usually already are reachable.`)),
        h('div.row.nowrap', null, h('button.btn.sm', { onclick: guard(async () => { const r = await api('/api/link/router', { method: 'POST', body: { port: L.listen.port } }); toast(`Port ${r.port} opened on the router via ${r.method}${r.externalIp ? ' — public address ' + r.externalIp : ''} (lease ${Math.round((r.lifetime || 0) / 3600)} h, renewed while ForgeAI runs)`); }) }, 'Open port on router'),
          h('button.btn.sm.ghost', { title: 'Looks up this network’s public address at api.ipify.org (the only request that leaves your network)', onclick: guard(async () => { const r = await api('/api/link/public-ip', { method: 'POST' }); modal('Public address', h('div', null, h('div.mono', { style: { fontSize: '18px' } }, `${r.ip}:${L.listen.port}`), h('p.faint.small', null, r.note + ' Enter this as the hub address on computers outside this network, once the port is open.')), [{ label: 'Close', primary: true, onClick: () => {} }]); }) }, 'Find public address'))));
      for (const s of hub.spokes) {
        const exposeBtn = s.expose ? h('button.btn.sm.ghost', { onclick: guard(async () => { await api(`/api/link/hub/spokes/${s.id}/unexpose`, { method: 'POST' }); toast('No longer reachable from outside'); redraw(); }) }, `Stop sharing port ${s.expose}`)
          : h('button.btn.sm.ghost', { title: 'Let people reach this computer’s ForgeAI sign-in page through the hub (e.g. you on your phone). HTTPS on that computer is required.', onclick: () => { const port = h('input', { type: 'number', value: 4600 + hub.spokes.indexOf(s), min: 1024, max: 65535 }); modal(`Reach ${s.name} from outside`, h('div', null, h('p', null, `Anyone who knows the hub address and this port will see ${s.name}’s ForgeAI sign-in page. They still need a username and password. Only do this if the hub is on a trusted address and ${s.name} uses HTTPS.`), h('label', null, 'Port on the hub'), port, note('warn', 'This exposes a sign-in page to the internet. Use a strong password on that computer.')), [{ label: 'Expose', primary: true, onClick: async () => { await api(`/api/link/hub/spokes/${s.id}/expose`, { method: 'POST', body: { port: +port.value, confirm: true } }); toast('Reachable through the hub'); redraw(); } }]); } }, 'Reach from outside');
        hubList.append(h('div.li', null, icon('laptop'), h('div.t', null, h('b', null, s.name, ' ', s.online ? h('span.badge.ok', null, h('span.dot'), 'Connected') : h('span.badge', null, 'Offline')),
          h('span', null, [s.online ? `since ${ago25(s.since)} · from ${s.address || '?'}` : `last seen ${ago25(s.lastSeen)}`, s.version ? 'ForgeAI ' + s.version : null, s.scheme === 'https' ? 'HTTPS' : 'HTTP', s.online ? `${fmtBytes25(s.bytesIn)} in / ${fmtBytes25(s.bytesOut)} out` : null, s.expose ? `reachable on hub port ${s.expose}` : null, s.availability && s.availability.available === false ? `busy: ${s.availability.reason}` : null].filter(Boolean).join(' · '))),
          h('div.row.nowrap', null, exposeBtn, h('button.btn.sm.ghost.danger', { onclick: guard(async () => { if (!confirm(`Remove ${s.name} from the hub? It will need a new pairing code to come back.`)) return; await api(`/api/link/hub/spokes/${s.id}`, { method: 'DELETE' }); redraw(); }) }, 'Remove'))));
      }
      if (!hub.spokes.length) hubList.append(h('div.li', null, h('div.t', null, h('span.faint', null, 'No computers paired yet.'))));
    }
    out.append(h('div.section-title', { style: { fontSize: '14px' } }, 'This computer as the hub'), hubList);
    // --- spoke
    const spList = h('div.list');
    if (sp.enabled) {
      const st = { connected: ['ok', 'Connected'], connecting: ['', 'Connecting…'], retrying: ['warn', 'Reconnecting'], off: ['', 'Off'] }[sp.status] || ['', sp.status];
      spList.append(h('div.li', null, icon('link', 'lg'), h('div.t', null, h('b', null, `Hub: ${sp.hubName || sp.hub}`, ' ', h('span.badge' + (st[0] ? '.' + st[0] : ''), null, st[0] === 'ok' ? h('span.dot') : null, st[1])), h('span', null, [sp.hub, sp.since ? 'since ' + ago25(sp.since) : null, sp.error, sp.fingerprint ? 'certificate pinned' : null].filter(Boolean).join(' · '))),
        h('div.row.nowrap', null, sp.status !== 'connected' ? h('button.btn.sm', { onclick: guard(async () => { await api('/api/link/reconnect', { method: 'POST' }); setTimeout(redraw, 1500); }) }, 'Retry now') : null, h('button.btn.sm.ghost.danger', { onclick: guard(async () => { if (!confirm('Disconnect from the hub? Computers reached through it will disappear from this ForgeAI.')) return; await api('/api/link/disconnect', { method: 'POST' }); redraw(); }) }, 'Disconnect'))));
      for (const p of sp.peers) spList.append(h('div.li', null, icon(p.id === 'hub' ? 'server' : 'laptop'), h('div.t', null, h('b', null, p.name), h('span', null, [p.id === 'hub' ? 'the hub' : 'reached through the hub', p.availability && p.availability.available === false ? `busy: ${p.availability.reason}` : null].filter(Boolean).join(' · '))), p.online ? h('span.badge.ok', null, h('span.dot'), 'Online') : h('span.badge', null, 'Offline')));
    } else {
      spList.append(h('div.li', null, icon('link', 'lg'), h('div.t', null, h('b', null, 'Connect to a hub'), h('span', null, 'Enter the hub’s address and the one-time code shown on it. This computer then keeps one encrypted outgoing connection open; nothing needs opening here.')),
        h('button.btn.sm.tint', { onclick: () => { const addr = h('input', { type: 'text', placeholder: 'ai.example.com:4545 or 203.0.113.5:4545' }); const code = h('input', { type: 'text', placeholder: '1234-5678', style: { fontFamily: 'var(--mono, monospace)' } });
          modal('Connect to a hub', h('div', null, h('label', null, 'Hub address'), addr, h('label', null, 'Pairing code (from the hub)'), code, note('info', 'The first connection records the hub’s certificate fingerprint and refuses to connect if it ever changes.')), [{ label: 'Connect', primary: true, onClick: async () => { const r = await api('/api/link/pair', { method: 'POST', body: { hub: addr.value, code: code.value } }); toast(`Paired with ${r.hubName}`); redraw(); } }]); } }, 'Connect to a hub')));
      // Owner-approved join: no code — just ask, and the hub owner approves this computer.
      const reqNow = L.request && L.request.status ? L.request : null;
      spList.append(h('div.li', null, icon('user-check', 'lg'), h('div.t', null, h('b', null, 'Ask a hub to let this computer join'), h('span', null, reqNow && reqNow.status === 'pending' ? `Waiting for the owner of ${reqNow.hub} to approve this computer…` : reqNow && reqNow.status === 'declined' ? `The hub owner declined this computer. You can ask again.` : 'No code needed. This computer asks the hub to join; it gets no access until the hub’s owner approves it.')),
        reqNow && reqNow.status === 'pending'
          ? h('button.btn.sm.ghost.danger', { onclick: guard(async () => { await api('/api/link/request', { method: 'DELETE' }); toast('Cancelled'); redraw(); }) }, 'Cancel request')
          : h('button.btn.sm.tint', { onclick: () => { const addr = h('input', { type: 'text', placeholder: 'ai.example.com:4545 or 203.0.113.5:4545' });
              modal('Ask a hub to let this computer join', h('div', null, h('label', null, 'Hub address'), addr, note('info', 'This computer sends only its name and address — never a password or token. It joins only after the hub’s owner approves it, and it then remembers the hub’s certificate fingerprint.')), [{ label: 'Send request', primary: true, onClick: async () => { const r = await api('/api/link/request', { method: 'POST', body: { hub: addr.value } }); toast('Asked to join — waiting for the owner to approve'); redraw(); } }]); } }, 'Ask to join')));
    }
    out.append(h('div.section-title', { style: { fontSize: '14px' } }, 'This computer as a connected computer'), spList);
    if (L.log && L.log.length) out.append(h('details', { style: { marginTop: '10px' } }, h('summary.faint.small', null, 'Link log'), h('div.mono.small', null, L.log.map((l) => h('div', null, `${new Date(l.at).toLocaleTimeString()}  ${l.text}`)))));
    out.append(h('div.card', { style: { marginTop: '12px' } }, h('div.md', { html: md(`**Without a hub?** Tailscale (a free private network app) also works: install it on both computers, turn on *Allow other computers to connect*, and add the other computer by its Tailscale address. The built-in link is for when you’d rather not install anything else.`) })));
    return out;
  };
  box.append(draw(L));
}
// ---------------- Lend this computer when idle
async function lendSection(pg) {
  const L = await api('/api/settings/lend').catch(() => null); if (!L) return;
  const box = h('div'); pg.append(h('div.section-title', null, 'Lend this computer'), box);
  const draw = (L) => {
    const now = L.now || {}; const st = now.available === false ? h('span.badge.warn', null, 'In use — not lent') : L.mode === 'never' ? h('span.badge', null, 'Not lent') : h('span.badge.ok', null, h('span.dot'), L.mode === 'idle' ? 'Idle — lent' : 'Always lent');
    const mode = sel([['always', 'Always — other ForgeAI computers may use it any time'], ['idle', 'Only when idle — join when nobody is using it, leave when someone comes back'], ['never', 'Never — keep this computer to itself']], L.mode);
    const idleMin = h('input', { type: 'number', min: 1, max: 720, value: L.idleMinutes, style: { width: '90px' } }); const maxCpu = h('input', { type: 'number', min: 10, max: 100, value: L.maxCpu, style: { width: '90px' } }); let batt = L.notOnBattery;
    const detail = [now.idleSec == null ? null : now.idleSec === Infinity ? 'no user input on this system (server)' : `last input ${now.idleSec < 60 ? now.idleSec + ' s' : Math.round(now.idleSec / 60) + ' min'} ago`, now.cpuPct != null ? `CPU ${now.cpuPct}%` : null, now.onBattery ? 'on battery' : null].filter(Boolean).join(' · ');
    return h('div', null, h('div.list', null,
      h('div.li', null, icon('moon', 'lg'), h('div.t', null, h('b', null, 'Other computers may use this one'), h('span', null, 'Applies to work sent here by other ForgeAI computers (chat, agents, clusters). Your own use of this computer is never limited. A request already running is always finished first.')), st),
      h('div.li', null, h('div.t', null, h('b', null, 'When'), h('span', null, now.reason ? `Right now: ${now.reason}${detail ? ' (' + detail + ')' : ''}` : '')), h('div.ctl', null, mode)),
      h('div.li', null, h('div.t', null, h('b', null, 'Counts as idle after'), h('span', null, 'Minutes without any key press or mouse movement.')), h('div.row.nowrap', null, idleMin, h('span.faint', null, 'min'))),
      h('div.li', null, h('div.t', null, h('b', null, 'Only while CPU is below'), h('span', null, 'So a machine busy with something else (a render, a backup) is left alone.')), h('div.row.nowrap', null, maxCpu, h('span.faint', null, '%'))),
      h('div.li', null, h('div.t', null, h('b', null, 'Never on battery'), h('span', null, 'Laptops are only lent while plugged in.')), toggle(batt, (v) => { batt = v; })),
      h('div.li', null, h('div.t', null, h('b', null, 'Save')), h('button.btn.primary', { onclick: guard(async () => { const r = await api('/api/settings/lend', { method: 'PUT', body: { mode: mode.value, idleMinutes: +idleMin.value, maxCpu: +maxCpu.value, notOnBattery: batt } }); toast('Saved'); clear(box).append(draw(r)); }) }, 'Save'))),
      h('div.card', { style: { marginTop: '10px' } }, h('div.md', { html: md('**How clusters behave.** Computers that each run whole models simply stop receiving new requests while in use. A model **split** across computers cannot lose one mid-answer, so ForgeAI stops that cluster, restarts it on the computers still free (if the model fits), and brings the busy computer back when it is idle again. The cluster card shows this as *Paused on …*.') })));
  };
  box.append(draw(L));
}
// Replace the "From anywhere in the world" card with the remote-link section.
const pageNetwork24 = window.pageNetwork;
window.pageNetwork = async function (root) {
  await pageNetwork24(root);
  if (!isOwner()) return;
  const pg = root.querySelector('.page'); if (!pg) return;
  const titles = [...pg.querySelectorAll('.section-title')]; const t = titles.find((x) => x.textContent === 'From anywhere in the world');
  if (t) { const card = t.nextElementSibling; t.remove(); if (card && card.classList.contains('card')) card.remove(); }
  await linkSection(pg);
  await lendSection(pg);
};
