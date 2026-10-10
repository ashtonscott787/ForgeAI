'use strict';
// File access control. Every file tool goes through here.
// An agent can only touch: its own workspace folder, plus folders the platform owner granted to its organisation
// AND that were then given to that agent — with the mode (read / read & write) never exceeding the grant.
const fs = require('fs');
const path = require('path');

function real(p) { try { return fs.realpathSync(p); } catch { return null; } }

class FileScope {
  // roots: [{ id, name, path, mode: 'read'|'readwrite' }]; the first 'workspace' root is where outputs go.
  constructor(roots) { this.roots = roots.map((r) => ({ ...r, real: real(r.path) || path.resolve(r.path) })); }
  get workspace() { return this.roots.find((r) => r.id === 'workspace'); }
  describe() { return this.roots.map((r) => `- "${r.name}" (${r.mode === 'readwrite' ? 'read & write' : 'read only'})${r.id === 'workspace' ? ' — your workspace; save new files here' : ''}`).join('\n'); }
  // Accepts "Name/sub/file.txt" or "/sub/file" (workspace) and returns an absolute path after checking it stays inside a root.
  resolve(p, wantWrite) {
    p = String(p || '').replace(/\\/g, '/').trim();
    let root = null, rel = p;
    for (const r of this.roots) {
      if (p === r.name || p.startsWith(r.name + '/')) { root = r; rel = p.slice(r.name.length + 1); break; }
    }
    if (!root) {
      // Absolute paths are allowed only if they fall inside a root.
      if (path.isAbsolute(p) || /^[a-zA-Z]:\//.test(p)) {
        const abs = path.resolve(p);
        const rr = real(abs) || abs;
        root = this.roots.find((r) => rr === r.real || rr.startsWith(r.real + path.sep));
        if (!root) throw new Error(`Access denied: ${p} is outside the folders this agent may use.`);
        rel = path.relative(root.real, rr);
      } else root = this.workspace;
    }
    if (!root) throw new Error('No folder available');
    if (wantWrite && root.mode !== 'readwrite') throw new Error(`"${root.name}" is read-only for this agent.`);
    const target = path.resolve(root.real, rel || '.');
    // Resolve symlinks on the deepest existing ancestor so links cannot escape the root.
    let probe = target; while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const rp = real(probe) || probe;
    if (!(rp === root.real || rp.startsWith(root.real + path.sep))) throw new Error(`Access denied: ${p} is outside "${root.name}".`);
    return { abs: target, root, display: root.name + (path.relative(root.real, target) ? '/' + path.relative(root.real, target).split(path.sep).join('/') : '') };
  }
}

module.exports = { FileScope };
