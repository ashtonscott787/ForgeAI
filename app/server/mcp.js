'use strict';
// Connectors: Model Context Protocol (MCP) servers — the standard way to plug in outside tools and AI services
// (Canva, Figma, Expo, Supabase, GitHub, Notion, Zapier, other AIs…). Local (command) and remote (URL) servers,
// remote ones with header keys or OAuth sign-in. Secrets stay in the vault.
const crypto = require('crypto');
const { now } = require('./db');

class McpManager {
  constructor(store, vault, getBaseUrl, openExternal) {
    this.store = store; this.vault = vault; this.getBaseUrl = getBaseUrl; this.openExternal = openExternal || (() => {});
    this.clients = new Map(); // id -> { client, transport }
    this.pendingAuth = new Map(); // state -> serverId
  }
  list(orgId) { return this.store.all('SELECT * FROM mcp_servers WHERE org_id IS NULL OR org_id=? ORDER BY name', orgId || null); }
  get(id) { return this.store.get('SELECT * FROM mcp_servers WHERE id=?', id); }
  slug(s) { return String(s.name || s.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'mcp'; }

  oauthProvider(s) {
    const self = this;
    const load = () => { try { return JSON.parse(self.vault.reveal(s.oauth_ref) || '{}'); } catch { return {}; } };
    const save = (patch) => { const cur = { ...load(), ...patch }; const ref = self.vault.put(JSON.stringify(cur), s.oauth_ref || undefined); if (!s.oauth_ref) { s.oauth_ref = ref; self.store.run('UPDATE mcp_servers SET oauth_ref=? WHERE id=?', ref, s.id); } };
    return {
      get redirectUrl() { return `${self.getBaseUrl()}/api/mcp/oauth/callback`; },
      get clientMetadata() { return { client_name: 'ForgeAI', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      state() { const st = crypto.randomBytes(12).toString('hex'); self.pendingAuth.set(st, s.id); return st; },
      clientInformation() { return load().client; },
      saveClientInformation(c) { save({ client: c }); },
      tokens() { return load().tokens; },
      saveTokens(t) { save({ tokens: t }); },
      redirectToAuthorization(url) { self.store.run('UPDATE mcp_servers SET status=?, status_detail=? WHERE id=?', 'needs_sign_in', url.toString(), s.id); self.openExternal(url.toString()); },
      saveCodeVerifier(v) { save({ verifier: v }); },
      codeVerifier() { return load().verifier; },
    };
  }

  async connect(id) {
    if (this.clients.has(id)) return this.clients.get(id);
    const s = this.get(id); if (!s) throw new Error('Connector not found');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    let transport;
    if (s.transport === 'stdio') {
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
      let env = {}; try { env = JSON.parse(this.vault.reveal(s.env_ref) || '{}'); } catch {}
      transport = new StdioClientTransport({ command: s.command, args: JSON.parse(s.args || '[]'), env: { ...process.env, ...env }, stderr: 'ignore' });
    } else {
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      let headers = {}; try { headers = JSON.parse(this.vault.reveal(s.headers_ref) || '{}'); } catch {}
      const opts = { requestInit: { headers } };
      if (!Object.keys(headers).length) opts.authProvider = this.oauthProvider(s);
      transport = new StreamableHTTPClientTransport(new URL(s.url), opts);
    }
    const client = new Client({ name: 'ForgeAI', version: '2.0.0' });
    try { await client.connect(transport); }
    catch (e) {
      if (/Unauthorized/i.test(e.name + e.message)) { this.clients.set('auth:' + id, { transport }); throw new Error('Sign-in needed — a browser window has opened to connect your account. Finish it, then try again.'); }
      throw e;
    }
    const entry = { client, transport };
    this.clients.set(id, entry);
    transport.onclose = () => this.clients.delete(id);
    return entry;
  }
  async finishAuth(state, code) {
    const id = this.pendingAuth.get(state); if (!id) throw new Error('Unknown or expired sign-in');
    this.pendingAuth.delete(state);
    const pend = this.clients.get('auth:' + id); if (!pend) throw new Error('Sign-in session expired — press Connect again');
    await pend.transport.finishAuth(code); this.clients.delete('auth:' + id);
    await this.refresh(id);
    return id;
  }
  async refresh(id) {
    try {
      this.disconnect(id);
      const { client } = await this.connect(id);
      const tools = (await client.listTools()).tools || [];
      this.store.run('UPDATE mcp_servers SET status=?, status_detail=?, tools=? WHERE id=?', 'connected', `${tools.length} tools`, JSON.stringify(tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 1000), inputSchema: t.inputSchema, annotations: t.annotations || {} }))), id);
      return tools;
    } catch (e) {
      const s = this.get(id);
      if (!(s && s.status === 'needs_sign_in')) this.store.run('UPDATE mcp_servers SET status=?, status_detail=? WHERE id=?', 'error', String(e.message).slice(0, 300), id);
      throw e;
    }
  }
  disconnect(id) { const e = this.clients.get(id); if (e) { try { e.client.close(); } catch {} this.clients.delete(id); } }
  tools(id) { const s = this.get(id); try { return JSON.parse((s && s.tools) || '[]'); } catch { return []; } }
  async call(id, name, args, signal) {
    const { client } = await this.connect(id);
    const r = await client.callTool({ name, arguments: args || {} }, undefined, { signal, timeout: 180000 });
    const texts = []; const images = [];
    for (const c of r.content || []) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'image') images.push({ mime: c.mimeType, b64: c.data });
      else if (c.type === 'resource' && c.resource) texts.push(c.resource.text || `[resource ${c.resource.uri}]`);
      else if (c.type === 'resource_link') texts.push(`[${c.name || 'link'}] ${c.uri}`);
    }
    if (r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent));
    return { content: (r.isError ? 'Error: ' : '') + texts.join('\n').slice(0, 60000), images };
  }
}

module.exports = { McpManager };
