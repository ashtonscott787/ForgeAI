# Architecture

**Status as of commit 0d09c94 (branch `claude/epic-turing-bfqx3r`).**

## Active shells

| Shell | Status | Evidence |
| --- | --- | --- |
| **Electron** (`electron/`) | Active. Shipped by `.github/workflows/desktop.yml`. `package.json` `main` = `electron/main.cjs`. | Read the workflow and `package.json`. |
| **Tauri** (`src-tauri/`) | Legacy. Still compiled into `src/lib/ipc.ts` as a fallback when `window.forge` is absent. Not packaged by `desktop.yml`. | `grep @tauri-apps src` finds `src/lib/ipc.ts`; `package.json` still lists `@tauri-apps/*`. |
| **Rust core** (`core/`, `Cargo.toml`) | Exists; `cargo test -p forge-core` runs in `checks.yml`. **Not run in this session** (no Rust toolchain was exercised). | `.github/workflows/checks.yml` |

`docs/ARCHITECTURE.md` used to describe only the Tauri/Rust design. That description
applies to the legacy shell and is kept below for reference.

## Electron process model

```
Renderer (React, src/)            sandbox: true, contextIsolation: true, nodeIntegration: false
   │  window.forge.invoke(cmd,args)  (preload.cjs, one generic channel)
   ▼
Preload (electron/preload.cjs)     exposes invoke / on / pathForFile only
   │  ipcRenderer.invoke("forge:<cmd>")
   ▼
Main (electron/main.cjs)           h(name, fn) registers each forge:* handler
   ├─ transfer.cjs     model downloads (resumable, checksum-verified)
   ├─ updater.cjs      GitHub release check, verified download, apply
   ├─ skills.cjs       user skills (JSON file, atomic write)
   ├─ connectors.cjs   user HTTP connectors (token in OS keychain via secrets.cjs)
   ├─ secrets.cjs      safeStorage-encrypted values
   ├─ memory.cjs, reminders.cjs, research.cjs, extract.cjs, when.cjs
   └─ spawns llama-server (engine) and talks to it over 127.0.0.1 HTTP
Engine (llama-server)              streamed to the renderer via fetch/SSE (src/lib/chat.ts)
```

## Cloud models

```
Chat.tsx send()  ──  parseCloud(value) = { provider, model }
   │  api.providerStream({ requestId, provider, model, system, messages })
   ▼
main: provider_stream  ── checks: key saved, model on the connection's list, message shape
   │  providers.stream()  (https only, redirects refused, timeouts, size caps)
   ▼
Anthropic Messages API  |  OpenAI Chat Completions   (SSE)
   │  provider://token {requestId, text}   (per-request events)
   ▼
Chat.tsx writes into the conversation that started the request
```

Verification is separate from saving. `provider_test` makes an authenticated listing request and
records the result in `providers.json`. The selector offers only models from that list, plus
models the person typed in.

## Generated pages

A ```html block is stored in the main process (`preview.cjs`) and loaded from `forge-preview:`.
The app page's policy allows frames only from that scheme. Each page carries its own policy.

## Chat request lifecycle (renderer)

`Chat.tsx` `send()` creates a run record `{ stopped, handle }` in `activeRun`.
Stop (`stopRun`) marks it stopped, cancels the fetch via `AbortController`, and
clears the waiting state. Every async stage checks `run.stopped` before it
continues. Stream callbacks ignore events once a run is stopped.

Each request has its own run record and its own id. Stop cancels that run only. Cloud requests
are cancelled in the main process by id. Local requests close the HTTP stream; whether the engine
stops generating on disconnect is assumed, not verified.

**Not yet implemented:** a cancel for local generation that the engine itself acknowledges.

## Legacy Rust core (for reference)

| Crate / dir | Owns |
| --- | --- |
| `core/types.rs` | `MachineCapability`, `Placement`, `PlacementPlan` |
| `core/hardware.rs` | one capability record for this machine |
| `core/registry.rs` | catalogue, quantisation choice, download sizing |
| `core/planner.rs` | model + cluster → placement plan |
| `core/runtime.rs` | placement → llama.cpp argument vectors |
| `sidecar/mesh/` | Go mesh node for two-computer operation (not verified in this session) |
