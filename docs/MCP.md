# MCP client: architecture (design only, not built)

**Status: Missing.** Nothing in `electron/` speaks the Model Context Protocol yet. This
document fixes the design so the first implementation has clear boundaries. It is not a
description of working code.

## Goals

- Connect to MCP servers over **stdio** (a local command the person approved) and
  **Streamable HTTP** (a remote URL the person approved).
- Negotiate capabilities and protocol version using the **official MCP SDK**
  (`@modelcontextprotocol/sdk`), not a hand-written client.
- Discover tools, resources and prompts. Show each tool's description and the
  permissions it needs before anything runs.
- Run tool calls only through a permission gate in the **main process**. The model can
  propose a call; it cannot approve one.

## Where it sits

```
Model output  ──►  proposed tool call (text, untrusted)
                        │
                        ▼
              electron/mcp/gate.cjs      policy + consent + audit   (main process)
                        │ allowed & approved
                        ▼
              electron/mcp/client.cjs    one connection per server   (SDK)
                        │  stdio | streamable HTTP
                        ▼
                   MCP server
```

The renderer never holds a server connection. It asks the main process to list servers,
change their state, or approve a specific call.

## Components (planned)

| Module | Responsibility | Must not |
| --- | --- | --- |
| `mcp/registry.cjs` | Stores server definitions (name, transport, command or URL, enabled). Secrets go to the keychain via `secrets.cjs`. | Store tokens in plain text. |
| `mcp/client.cjs` | Opens one SDK client per enabled server, handles reconnects, timeouts, health checks. | Run a server command that the person has not approved. |
| `mcp/gate.cjs` | Decides whether a proposed call may run: server enabled, tool allowed, consent recorded for this exact call when it is consequential. | Trust the model's description of what a tool does. |
| `mcp/audit.cjs` | Append-only record of every proposed, approved, denied and completed call, with secrets redacted. | Record secret values. |
| `src/components/McpPanel.tsx` | Servers, status, tools, permissions, recent activity, enable/disable, remove, test. | Execute tools directly. |

## Rules that do not depend on the model

1. **Imported configuration is previewed, not run.** An imported server definition shows
   its exact command, arguments, environment variable names and URL. Nothing starts until
   the person approves that definition.
2. **Local commands require explicit approval** each time the command or its arguments
   change. A changed command is treated as a new server.
3. **Remote servers must use https://**, or http:// to this computer only. Redirects are
   refused. The same SSRF checks used for connectors apply: private and link-local
   addresses are blocked unless the person marks that server as local.
4. **Tool descriptions are untrusted.** A server may describe a tool misleadingly
   ("read-only" for a tool that writes). The permission the person sees is derived from
   the tool's declared annotations and from a per-tool setting the person sets, never
   from the description text alone.
5. **Consequential calls need consent for that call**: sending mail, deleting or changing
   files, running shell commands, changing calendars, spending money. Consent is recorded
   with the exact arguments.
6. **Timeouts and cancellation** are enforced by the gate. A call that exceeds its limit
   is cancelled through the SDK, and the result is marked as failed, not as success.
7. **Responses are capped** in size and returned to the model as data, labelled as coming
   from the named tool.

## Milestones

1. Registry and a read-only **test connection** over stdio, using the SDK, with a fixture
   MCP server in `tests/`.
2. Tool listing in the panel, with the permission preview.
3. Gated execution for read-only tools, with audit records.
4. Consent prompts for consequential tools.
5. Streamable HTTP transport with the SSRF rules above.
6. Import and export with the preview step.

## Not in this design

- Acting as an MCP server. Forge AI is a client only.
- Automatic installation of servers from a marketplace. That waits for the marketplace
  design and its review rules.
