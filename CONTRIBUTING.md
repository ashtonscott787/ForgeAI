# Working on Forge AI

## Getting set up

You need Node 22, pnpm 10, and Rust only if you touch `core/`.

```
git clone https://github.com/ashtonscott787/ForgeAI
cd ForgeAI
pnpm install
pnpm dev            # frontend in a browser at :1420, no inference
```

`pnpm dev` runs the UI alone. Hardware detection, downloads and chat need the
desktop shell, which is Electron:

```
# one-off: put the inference engine where the app expects it
mkdir -p engine
curl -sSfL https://github.com/ggml-org/llama.cpp/releases/download/b12180/llama-b12180-bin-macos-arm64.tar.gz | tar xz -C /tmp
cp /tmp/llama-b12180/llama-server /tmp/llama-b12180/*.dylib engine/
# Windows: llama-b12180-bin-win-cpu-x64.zip, copy llama-server.exe and the DLLs

pnpm build && pnpm exec electron .
```

`engine/` is gitignored on purpose — binaries do not belong in the repository.

## How it fits together

- `src/` — React frontend. It never talks to the network except to the local
  engine on `127.0.0.1`.
- `src/lib/ipc.ts` — the single boundary to the shell. Every command the
  frontend can call is typed here; add new ones in pairs with `electron/main.cjs`.
- `electron/main.cjs` — process supervision for `llama-server`, downloads,
  Hugging Face resolution, settings, file dialogs. Runs with Node privileges.
- `electron/preload.cjs` — exposes exactly one object, `window.forge`, over a
  context bridge. The renderer has no Node access.
- `core/` — Rust. Hardware profiling and the placement planner for future
  clustering, with unit tests (`cargo test -p forge-core`).
- `src-tauri/` — the earlier Tauri shell. Still builds, still holds the icons
  and the Rust workspace member.

## House rules

**Do not ship a button that does not work.** If a feature is partial, say so in
the UI text or leave it out. The README's "Not built yet" section is load-bearing.

**No invented numbers.** Speed figures are measured or shown as "unmeasured".
Memory fit comes from detected hardware, never from an estimate presented as a
fact.

**Generated content is untrusted.** Model output renders through React, never
`dangerouslySetInnerHTML`. Generated pages run in an iframe with
`sandbox="allow-scripts"` and nothing else. The `forge-ui` JSON schema is
validated field by field in `src/lib/blocks.ts`; anything malformed falls back
to plain text rather than rendering partially.

**Privacy is the product.** Nothing leaves the machine except model downloads
from Hugging Face and links the user clicks. No telemetry.

## Before you push

```
pnpm build            # type-check + bundle; must be clean
cargo test -p forge-core
cargo fmt --all
```

CI runs the same checks on every push and pull request.

## Branches

Work on a branch and open a pull request. `main` should always build.

Tagging a commit `v0.3.0` (or whatever is next) triggers the installer build and
attaches the results to a draft release.
