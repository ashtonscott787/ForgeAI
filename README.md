# Forge AI

A local-first desktop AI app for macOS and Windows. Download a model, run it on
your own hardware, chat with it. No account, no API key, nothing else to
install.

<p align="center"><em>Your AI. Your hardware. Your control.</em></p>

## Getting the app

**Users:** the download page is `web/index.html`, and installers come from the
Releases page. Step-by-step instructions are in **[docs/INSTALL.md](docs/INSTALL.md)**.

**Maintainer:** no installers exist until you tag a release — see
**[docs/RELEASING.md](docs/RELEASING.md)**. It is two commands.

## Verification status

Everything in this table was checked on a Linux x86_64 machine, which is where
the code was written. **No macOS or Windows installer has been produced or
opened yet** — that happens on GitHub's runners, and it is the one thing that
cannot be done anywhere else.

| Part | Status | How it was checked |
| --- | --- | --- |
| `forge-core` — types, hardware, registry, planner, runtime | **Verified** | `cargo test` — 26 tests pass |
| Workspace lint | **Verified** | `cargo clippy --workspace --all-targets -- -D warnings` clean |
| Desktop shell — downloads, engine supervision, settings, IPC | **Compiles** | `cargo check -p forge-ai`, clippy clean |
| Frontend — chat streaming, model manager, settings, themes | **Compiles** | `tsc --noEmit` clean, `vite build` succeeds |
| **Whole app, built and bundled** | **Verified on Linux** | `tauri build` produced a working binary and a 7 MB `.deb` |
| macOS `.dmg` / Windows `.exe` | **Not yet built** | needs GitHub's macOS and Windows runners |
| Inference against a real model | **Not yet run** | needs a built installer and a downloaded model |
| Distributed inference across machines | **Off, by design** | designed and unit-tested; never run on two real machines |

The Linux `.deb` matters more than it looks: it proves the Rust core, the
embedded frontend and Tauri's bundler all work together. The macOS and Windows
jobs run the same code through the same bundler with a different target.

## What 0.1 does

Working, and built rather than mocked:

- **Chat** with a local model, streaming token by token, with a Stop button.
- **Models** — browse a bundled catalogue, download with live progress,
  resume an interrupted download, verify sha256 before use, load, unload, delete.
- **Hardware detection** — RAM, CPU, GPU backend, VRAM via `nvidia-smi`, and an
  honest usable-memory budget with real headroom.
- **Settings** — context size, GPU layers, CPU threads, theme. Persisted
  atomically.
- **Themes** — light, dark, or follow the OS.
- **Model selector** — searchable, keyboard-navigable, with a preview card whose
  four metric bars respond live to the quantization and reasoning controls
  inside it.

Deliberately not in 0.1:

- **GPU acceleration on Windows.** macOS uses Metal; Windows ships CPU-only.
  A Vulkan build needs an SDK on the runner and three GPU vendors to test
  against, and an untested GPU path means crashes.
- **Distributed inference.** The planner is implemented and tested and
  `sidecar/mesh` holds a working mesh design, but it has never run across two
  real machines, so the app reports it as off. See `src-tauri/src/cluster.rs`.
- Vision and document models, agents, tools, memory.

## No invented numbers

A speed figure appears only after a real run, measured from that run. The
bundled catalogue sets `reference_tok_s` to `0` for every entry and the UI shows
"unmeasured", because Forge has not benchmarked those models. A catalogue entry
with an empty `sha256` is labelled "Unverified digest" in the UI and logs a
warning rather than quietly skipping verification.

## Architecture

The rule: **the UI never talks to a runtime, a peer or the network directly.**

```
React (src/)
   │  typed invoke — src/lib/ipc.ts mirrors the serde types
   ▼
Tauri shell (src-tauri/)  ──spawns──▶  llama-server (loopback only)
   │                                        ▲
   │ calls                                  │ direct SSE from the webview
   ▼                                        │  (CSP permits 127.0.0.1 only)
forge-core (core/) ─────────────────────────┘
```

`core/` has no Tauri and no GPU dependency, so the logic that matters tests on a
bare runner. Full detail in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Developing

Prerequisites: Rust stable, Node 22 + pnpm 10, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install

cargo test --workspace                  # the gate — runs anywhere
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck

pnpm dev          # frontend in a browser; the core is unreachable, says so
pnpm tauri dev    # the real app
```

`pnpm tauri dev` runs without a bundled runtime — the app opens and says it has
no inference runtime, which is the honest state. To get a working runtime
locally, build llama.cpp and drop `llama-server` into `src-tauri/binaries/`
named with your target triple; the release workflow shows the exact commands.

## Layout

```
core/            Rust domain logic. No Tauri, no GPU deps.
src-tauri/       Desktop shell: downloads, engine supervision, settings, IPC.
src/             React + TypeScript frontend.
sidecar/mesh/    Go mesh sidecar — NOT wired in. See sidecar/README.md.
web/             The installer download page.
docs/            INSTALL, RELEASING, ARCHITECTURE.
```

## Licensing

MIT. Bundled llama.cpp is MIT. Model weights keep their own licences — some
forbid commercial use — and `CatalogueEntry.license` carries each one so the UI
can show it before download. `sidecar/mesh` would depend on the Tailscale client
(BSD-3); get that reviewed before shipping it commercially.
