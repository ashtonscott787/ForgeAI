'use strict';
/* 2.8 Topology — a live map of the hub, its computers (local, on your network, on other VLANs, and remote over the
   link), clusters and links. Click a computer to configure it, restart it, open its own dashboard, or uninstall it. */

function topoStatus(n) {
  if (n.is_local) return { k: 'hub', dot: 'var(--accent)', label: 'This hub' };
  if (n.status !== 'online') return { k: 'off', dot: 'var(--muted, #888)', label: n.error ? 'Offline' : (n.status || 'offline') };
  const av = n.availability; if (av && av.available === false) return { k: 'busy', dot: 'var(--orange, #d9822b)', label: 'In use by its owner' };
  return { k: 'on', dot: 'var(--green, #1fa37a)', label: 'Online' };
}
function topoScope(n) {
  if (n.is_local) return 'Hub';
  if (n.link_id) return 'Remote link';
  return { local: 'This computer', lan: 'Your network', vpn: 'Private VPN', internet: 'Another network' }[n.scope] || 'Network';
}
function nodeTps(n) { const t = (n.models || []).map((m) => m.tps).filter(Boolean); return t.length ? Math.round(Math.max(...t)) : null; }

async function pageTopology(root) {
  const page = h('div.page.wide');
  page.append(h('div.phead', null, h('h1', null, 'Computers'),
    h('div.row', { style: { gap: '8px' } },
      h('button.btn.sm.ghost', { onclick: () => draw(true) }, icon('refresh', 'sm'), 'Refresh'),
      h('a.btn.sm.ghost', { href: '#/vms' }, icon('cube', 'sm'), 'Virtual machines'),
      h('a.btn.sm.ghost', { href: '#/network' }, icon('monitor', 'sm'), 'Network'))));
  const canvasWrap = h('div', { style: { position: 'relative' } });
  page.append(canvasWrap);
  root.append(page);

  let timer = null, lastKey = '';
  const draw = async (force) => {
    let cluster, link;
    try { [cluster, link] = await Promise.all([api('/api/cluster'), api('/api/link').catch(() => null)]); }
    catch (e) { clear(canvasWrap).append(note('warn', e.message)); return; }
    const nodes = cluster.nodes || [];
    // Only redraw the map when something that affects it changed (keeps it from flickering every tick).
    const key = JSON.stringify(nodes.map((n) => [n.id, n.name, n.status, n.inflight, (n.models || []).length, n.availability && n.availability.available, nodeTps(n)]));
    if (!force && key === lastKey) return; lastKey = key;
    render(nodes, link);
  };

  const render = (nodes, link) => {
    clear(canvasWrap);
    const hub = nodes.find((n) => n.is_local) || { id: 'hub', name: S.platformName, is_local: true, models: [] };
    const others = nodes.filter((n) => !n.is_local);
    const W = Math.max(320, canvasWrap.clientWidth || page.clientWidth || 900);
    const small = W < 680;

    // Summary strip
    const online = others.filter((n) => n.status === 'online').length;
    const linked = others.filter((n) => n.link_id).length;
    canvasWrap.append(h('div.row', { style: { gap: '16px', flexWrap: 'wrap', margin: '0 0 14px', color: 'var(--muted)', fontSize: '13px' } },
      h('span', null, h('b', { style: { color: 'var(--text)' } }, String(others.length)), ' computers'),
      h('span', null, h('b', { style: { color: 'var(--green,#1fa37a)' } }, String(online)), ' online'),
      linked ? h('span', null, h('b', { style: { color: 'var(--text)' } }, String(linked)), ' over the remote link') : null,
      h('span', { style: { marginLeft: 'auto' } }, 'Click a computer to configure, open or restart it')));

    if (small || others.length > 10) { renderList(hub, others, link); return; }

    // Radial map: hub in the centre, computers around it.
    const H = Math.min(620, Math.max(420, 220 + others.length * 36));
    const cx = W / 2, cy = H / 2;
    const rx = Math.min(W * 0.38, 380), ry = Math.min(H * 0.36, 230);
    const stage = h('div', { style: { position: 'relative', width: '100%', height: H + 'px' } });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    stage.append(svg);
    const place = (el, x, y, w, hh) => { el.style.cssText += `position:absolute;left:${x - w / 2}px;top:${y - hh / 2}px;width:${w}px;`; stage.append(el); };

    const pos = others.map((n, i) => { const a = -Math.PI / 2 + (i / Math.max(1, others.length)) * Math.PI * 2; return { n, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }; });
    // lines hub -> node
    for (const p of pos) {
      const st = topoStatus(p.n);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx); line.setAttribute('y1', cy); line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);
      line.setAttribute('stroke', st.k === 'on' ? 'var(--green,#1fa37a)' : st.k === 'busy' ? 'var(--orange,#d9822b)' : 'var(--border,#ccc)');
      line.setAttribute('stroke-width', String(1 + Math.min(4, p.n.inflight || 0)));
      line.setAttribute('opacity', st.k === 'off' ? '0.4' : '0.8');
      if (p.n.link_id) line.setAttribute('stroke-dasharray', '6 5');
      svg.append(line);
      if (p.n.inflight) { const mid = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); mid.setAttribute('cx', (cx + p.x) / 2); mid.setAttribute('cy', (cy + p.y) / 2); mid.setAttribute('r', '3'); mid.setAttribute('fill', 'var(--orange,#d9822b)'); svg.append(mid); }
    }
    // hub card
    const hubCard = h('div', { style: { textAlign: 'center', padding: '14px 12px', borderRadius: '14px', background: 'var(--accent)', color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,.18)', cursor: 'pointer' }, onclick: () => { location.hash = '#/settings/computer'; } },
      h('div', { style: { fontWeight: '700' } }, hub.name || S.platformName), h('div', { style: { fontSize: '12px', opacity: '.85' } }, 'This hub · ' + ((hub.models || []).length) + ' models'));
    place(hubCard, cx, cy, 170, 60);
    // node cards
    for (const p of pos) place(nodeCard(p.n, link), p.x, p.y, 190, 92);
    canvasWrap.append(stage);
    legend();
  };

  const renderList = (hub, others, link) => {
    const list = h('div.list');
    list.append(h('div.li', { style: { cursor: 'pointer' }, onclick: () => { location.hash = '#/settings/computer'; } },
      h('div.monogram', { style: { background: 'var(--accent)', color: '#fff' } }, icon('home', 'sm')),
      h('div.t', null, h('b', null, hub.name || S.platformName), h('span', null, 'This hub · ' + ((hub.models || []).length) + ' models'))));
    for (const n of others) list.append(nodeRow(n, link));
    canvasWrap.append(list);
    legend();
  };

  const badge = (n) => { const st = topoStatus(n); return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--muted)' } }, h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: st.dot } }), st.label); };

  const openInterface = async (n) => {
    if (n.is_local) { location.hash = '#/settings/computer'; return; }
    if (!n.link_id && n.url) { window.open(n.url, '_blank', 'noopener'); return; }
    // Linked spoke: reach its dashboard through the hub (expose a port once), then open it.
    const sp = link && link.hub && (link.hub.spokes || []).find((s) => s.id === n.link_id);
    try {
      if (sp && sp.expose) { window.open(`https://${location.hostname}:${sp.expose}/`, '_blank', 'noopener'); return; }
      const port = 4700 + ((link.hub.spokes || []).findIndex((s) => s.id === n.link_id) + 1);
      if (!confirm(`Open ${n.name}’s own ForgeAI page?\n\nThis makes it reachable through this hub on port ${port}. It still needs a sign-in. You can stop sharing it again under Computers → Remote link.`)) return;
      await api(`/api/link/hub/spokes/${n.link_id}/expose`, { method: 'POST', body: { port, confirm: true } });
      toast('Opening ' + n.name + '…'); setTimeout(() => window.open(`https://${location.hostname}:${port}/`, '_blank', 'noopener'), 400);
    } catch (e) { toast(e.message); }
  };
  const restartNode = async (n) => { if (!confirm(`Restart ForgeAI on ${n.name}?`)) return; try { await api(`/api/nodes/${n.id}/restart`, { body: {} }); toast(n.name + ': restarting'); } catch (e) { toast(e.message); } };

  const actions = (n) => h('div.row', { style: { gap: '4px', marginTop: '6px', justifyContent: 'center' } },
    h('button.btn.sm.ghost', { title: 'Configure', onclick: (e) => { e.stopPropagation(); nodeModal(n); } }, icon('sliders', 'sm')),
    h('button.btn.sm.ghost', { title: 'Open its ForgeAI page', onclick: (e) => { e.stopPropagation(); openInterface(n); } }, icon('share', 'sm')),
    n.kind === 'worker' ? h('button.btn.sm.ghost', { title: 'Restart ForgeAI there', onclick: (e) => { e.stopPropagation(); restartNode(n); } }, icon('refresh', 'sm')) : null);

  const nodeCard = (n, link) => { const tps = nodeTps(n); return h('div', { style: { textAlign: 'center', padding: '8px 10px', borderRadius: '12px', background: 'var(--card, var(--bg2,#fff))', border: '1px solid var(--border,rgba(127,127,127,.2))', boxShadow: '0 2px 10px rgba(0,0,0,.08)', cursor: 'pointer' }, onclick: () => nodeModal(n) },
    h('div', { style: { fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, n.name),
    h('div', { style: { fontSize: '11px', color: 'var(--muted)', margin: '2px 0' } }, topoScope(n) + ' · ' + ((n.models || []).length) + ' models' + (tps ? ` · ${tps} tok/s` : '')),
    badge(n), actions(n)); };

  const nodeRow = (n, link) => { const tps = nodeTps(n); return h('div.li', { style: { cursor: 'pointer' }, onclick: () => nodeModal(n) },
    h('div.monogram', { style: { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' } }, icon(n.link_id ? 'network' : 'monitor', 'sm')),
    h('div.t', null, h('b', null, n.name), h('span', null, [topoScope(n), (n.models || []).length + ' models', tps ? tps + ' tok/s' : null, n.inflight ? n.inflight + ' running' : null].filter(Boolean).join(' · '))),
    h('div.row', { style: { gap: '4px', alignItems: 'center' } }, badge(n),
      h('button.btn.sm.ghost', { title: 'Open its ForgeAI page', onclick: (e) => { e.stopPropagation(); openInterface(n); } }, icon('share', 'sm')),
      n.kind === 'worker' ? h('button.btn.sm.ghost', { title: 'Restart', onclick: (e) => { e.stopPropagation(); restartNode(n); } }, icon('refresh', 'sm')) : null)); };

  const legend = () => canvasWrap.append(h('div.row', { style: { gap: '16px', flexWrap: 'wrap', marginTop: '14px', fontSize: '12px', color: 'var(--muted)' } },
    legItem('var(--green,#1fa37a)', 'Online'), legItem('var(--orange,#d9822b)', 'In use by its owner'), legItem('var(--muted,#888)', 'Offline'),
    h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span', { style: { width: '22px', height: '0', borderTop: '2px dashed var(--muted,#888)' } }), 'Remote link')));
  const legItem = (c, t) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: c } }), t);

  await draw(true);
  timer = setInterval(() => draw(false), 4000);
  // stop refreshing when leaving the page
  const stop = () => { if (!document.body.contains(page)) { clearInterval(timer); window.removeEventListener('hashchange', stop); } };
  window.addEventListener('hashchange', stop);
  window.addEventListener('resize', () => { lastKey = ''; draw(true); });
}

// ---- Virtual machines & isolated sandboxes (2.10) -------------------------------------------------
// A place for agents to run risky or untrusted commands away from the real computer. Shows exactly which
// isolation the host can provide, so no one is misled about how strong it is.
async function pageVMs(root) {
  const page = h('div.page.wide');
  const head = h('div.phead', null, h('h1', null, 'Virtual machines'),
    h('div.row', { style: { gap: '8px' } },
      h('a.btn.sm.ghost', { href: '#/topology' }, icon('network', 'sm'), 'Computers'),
      h('button.btn.sm.ghost', { onclick: () => draw() }, icon('refresh', 'sm'), 'Refresh')));
  page.append(head);
  const body = h('div'); page.append(body); root.append(page);

  const tierColor = (ok) => ok ? 'var(--green,#1fa37a)' : 'var(--muted,#888)';
  const draw = async () => {
    clear(body).append(h('div.muted', null, 'Loading…'));
    let data; try { data = await api('/api/vms'); } catch (e) { clear(body).append(note('warn', e.message)); return; }
    clear(body);
    const c = data.capabilities;
    // What isolation is available
    body.append(h('div.card', { style: { marginBottom: '14px' } },
      h('div.row', { style: { alignItems: 'center', gap: '10px', marginBottom: '6px' } }, icon('shield', 'sm'), h('b', null, c.summary)),
      h('div.muted', { style: { fontSize: '13px', marginBottom: '10px' } }, `Host: ${c.platform} / ${c.arch}. An agent’s sandbox always uses the strongest option available below.`),
      h('div', null, ...c.backends.map((b) => h('div.row', { style: { gap: '10px', alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--line,#2a2a2a)' } },
        h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: tierColor(b.available), flex: '0 0 auto', position: 'relative', top: '2px' } }),
        h('div', null, h('b', null, b.tech), b.id === c.best && b.available ? h('span.pill', { style: { marginLeft: '8px' } }, 'in use') : null,
          h('div.muted', { style: { fontSize: '12.5px' } }, b.reason)))))));

    // Base image for full VMs
    const img = data.image || {};
    body.append(h('div.card', { style: { marginBottom: '14px' } },
      h('b', null, 'Full-VM base image'),
      h('div.muted', { style: { fontSize: '13px', margin: '4px 0 8px' } }, 'Full virtual machines need a base disk image on this computer. Leave empty to use container/namespace isolation instead.'),
      (() => { const pathIn = h('input.input', { value: img.path || '', placeholder: '/path/to/base.qcow2 or disk image', style: { width: '100%', marginBottom: '6px' } });
        const contIn = h('input.input', { value: img.container || '', placeholder: 'Container image for container tier (default alpine:3.20)', style: { width: '100%', marginBottom: '8px' } });
        return h('div', null, pathIn, contIn,
          h('button.btn.sm', { onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; try { await api('/api/vms/image', { method: 'PUT', body: { path: pathIn.value.trim(), container: contIn.value.trim() } }); toast('Saved'); draw(); } catch (err) { toast(err.message); btn.disabled = false; } } }, 'Save image settings')); })()));

    // Sandboxes + a quick test
    const list = data.instances || [];
    const testOut = h('pre', { style: { display: 'none', whiteSpace: 'pre-wrap', background: 'var(--bg2,#111)', padding: '10px', borderRadius: '8px', fontSize: '12.5px', marginTop: '8px', maxHeight: '260px', overflow: 'auto' } });
    const cmdIn = h('input.input', { placeholder: 'echo hello; uname -a', style: { flex: '1' } });
    const runTest = async () => { const cmd = cmdIn.value.trim(); if (!cmd) return; testOut.style.display = 'block'; testOut.textContent = 'Creating an isolated sandbox and running…';
      try { const inst = await api('/api/vms', { method: 'POST', body: { name: 'test', backend: 'auto' } });
        const r = await api(`/api/vms/${inst.id}/exec`, { method: 'POST', body: { command: cmd } });
        testOut.textContent = `[${inst.isolation}]\n\n${r.stdout || ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}\n[exit: ${r.code}]`;
        await api(`/api/vms/${inst.id}`, { method: 'DELETE' }); draw2(); }
      catch (e) { testOut.textContent = e.message; } };
    const sandboxCard = h('div.card',
      h('b', null, 'Try it'),
      h('div.muted', { style: { fontSize: '13px', margin: '4px 0 8px' } }, 'Run a command in a throwaway isolated sandbox. It is deleted straight after. (This is the same isolation agents get.)'),
      h('div.row', { style: { gap: '8px' } }, cmdIn, h('button.btn.sm', { onclick: runTest }, 'Run')), testOut);
    body.append(sandboxCard);

    const liveWrap = h('div', { style: { marginTop: '14px' } }); body.append(liveWrap);
    const draw2 = async () => { let d; try { d = await api('/api/vms'); } catch { return; } const li = d.instances || [];
      clear(liveWrap); if (!li.length) return;
      liveWrap.append(h('h3', { style: { margin: '6px 0' } }, 'Running sandboxes'),
        ...li.map((v) => h('div.li', null, h('div.monogram', null, icon('cube', 'sm')),
          h('div.t', null, h('b', null, v.name), h('span', null, `${v.isolation} · created ${new Date(v.createdAt).toLocaleTimeString()}`)),
          h('button.btn.sm.ghost', { onclick: async () => { await api(`/api/vms/${v.id}`, { method: 'DELETE' }); draw2(); } }, 'Destroy')))); };
    draw2();
  };
  await draw();
}
