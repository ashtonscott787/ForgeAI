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

## Chat request lifecycle (renderer)

`Chat.tsx` `send()` creates a run record `{ stopped, handle }` in `activeRun`.
Stop (`stopRun`) marks it stopped, cancels the fetch via `AbortController`, and
clears the waiting state. Every async stage checks `run.stopped` before it
continues. Stream callbacks ignore events once a run is stopped.

**Not yet implemented:** a per-request ID visible to the main process, so that
cancelling a local inference request also asks the engine to stop generating
(today the HTTP connection is closed, and the engine's own behaviour on disconnect
is assumed, not verified).

## Legacy Rust core (for reference)

| Crate / dir | Owns |
| --- | --- |
| `core/types.rs` | `MachineCapability`, `Placement`, `PlacementPlan` |
| `core/hardware.rs` | one capability record for this machine |
| `core/registry.rs` | catalogue, quantisation choice, download sizing |
| `core/planner.rs` | model + cluster → placement plan |
| `core/runtime.rs` | placement → llama.cpp argument vectors |
| `sidecar/mesh/` | Go mesh node for two-computer operation (not verified in this session) |
