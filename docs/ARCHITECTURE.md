# Architecture

## The rule that holds it together

**The UI never talks to a runtime, a peer or the network directly.** It calls
the Rust core, which looks identical whether the model is on this laptop or
split across three machines in another building. That one boundary is why
clustering could be added in Phase 3 without rewriting the chat app.

```
React (src/)
   │  typed invoke, src/lib/ipc.ts — mirrors the serde types exactly
   ▼
Tauri shell (src-tauri/) ─── spawns ──▶ llama-server / rpc-server
   │                                        ▲
   │ calls                                  │ mesh-tunnelled TCP, loopback-bound
   ▼                                        │
forge-core (core/)                   forge-mesh (sidecar/mesh/)
  types · hardware · registry             embedded tsnet node
  planner · runtime                       userspace WireGuard, no driver
```

## Module boundaries

| Crate / dir | Owns | Must not know |
| --- | --- | --- |
| `core/types.rs` | `MachineCapability`, `Placement`, `PlacementPlan` | everything else |
| `core/hardware.rs` | one capability record for this machine, headroom policy | networking, models |
| `core/registry.rs` | catalogue, quantization choice, download sizing, recommendation | inference, peers |
| `core/planner.rs` | model + cluster → a plan, with its predicted cost | how runtimes are spawned |
| `core/runtime.rs` | `Placement` → llama.cpp argument vectors | planning, networking |
| `src-tauri/` | windows, updates, process spawning, per-OS GPU probing | domain decisions |
| `sidecar/mesh/` | mesh identity, peer list, port forwarding | models, placement |

`core/` has no Tauri and no GPU dependency on purpose: it compiles and tests on
a bare CI runner, which is where the logic that actually matters is gated.

## The two contracts

**`MachineCapability`** is the only thing the planner sees about a machine:
usable model bytes, backend, measured links, trust, runtime build ids. Adding
NPUs or a cloud burst node later means extending this record, not touching the
scheduler.

**`Placement`** is the only thing the runtime manager accepts: `Local`,
`Remote`, `Split { shards }` or `Replicated`. Adding tensor-parallel later is a
new variant, not a new architecture.

## Where the honesty lives

`core/planner.rs` encodes the product constraint in executable form:

1. If the model fits on one machine, **never split it.**
2. If it fits on several, **replicate and load-balance** — that is faster.
3. Only split when nothing can hold it alone.
4. **Never split over an unmeasured or slow link.** A WAN peer can be routed
   to whole, never split across.

Every plan returns `predicted_tok_s` alongside `best_single_tok_s`, and
`is_regression()` is true when distributing is strictly worse. The pre-flight
panel renders exactly this, so the product can never silently hand someone a
slower experience and call it a feature.

These rules are covered by tests in `core/src/planner.rs`, including
`never_splits_a_model_that_fits` and `refuses_to_split_over_a_wan_link`.

## Why a Go sidecar beside a Rust core

`tsnet` embeds a complete Tailscale node **inside a process** on a userspace
TCP/IP stack: no root, no system daemon, no virtual network interface, no
WinTUN driver, no macOS NetworkExtension entitlement. For a product whose first
promise is "nothing to install", that is the difference between shipping and
waiting on an Apple entitlement review.

The trade is that only traffic through that process crosses the mesh — which is
exactly what Forge needs. `ControlURL` is configurable, so pointing it at a
self-hosted Headscale removes any dependency on Tailscale-operated
coordination.

`rpc-server` has no authentication or encryption of its own. It is bound to
loopback and is only ever reachable through the mesh tunnel. This is enforced
in `core/runtime.rs` and covered by the
`http_surface_is_always_loopback_only` test.
