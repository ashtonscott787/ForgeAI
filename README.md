# ForgeAI

A private, multi-tenant AI platform: an Electron desktop app (macOS / Windows) plus a headless **ForgeAI Server** edition. It runs local and cloud models, pools idle compute across many computers into one cluster, and runs tool-using agents — all isolated per organisation.

**Current version: 2.10.0**

## What's in 2.10.0
- **Distributed agent tasks** — one request splits into independent pieces that run in parallel on different computers, then combine (`distribute` agent tool).
- **Infrastructure Auto-Pilot** — run the fleet in plain language: list computers, find/add them, move models, diagnose slowness, restart — every change checked against the requester's permission (`infra_*` agent tools, `server/index.js` → `app.infra`).
- **Virtual machines / isolated sandboxes** — agents run risky commands in a throwaway machine, using the strongest isolation the host offers (full VM → container → namespace → process), with honest capability detection (`server/vm.js`, Virtual machines page).
- **Owner-approved claim** — a computer can ask to join a hub; it gets nothing until the owner approves that specific request (no auto token hand-out). See `server/link.js` (`addJoinRequest` / `approveJoinRequest` / `claimDecision`).

## Repository layout
- `app/` — the application (Electron main in `app/electron`, server in `app/server`, UI in `app/public`).
  - `app/server/` — HTTP API, model routing, cluster/link, agents, engine, VM manager, vault.
  - `app/public/` — vanilla-JS UI (`js/*.js`, `styles*.css`).
  - `app/deploy/` — the `forgeai` CLI and install scripts.
- `win/` — NSIS installer/uninstaller and the Windows background-service wrapper.
- `server-edition/` — headless install scripts + README.
- `build.js` — packages the Electron app for mac/win (via `@electron/packager` + `resedit`).
- `release.sh` — full release: mac (signed), Windows installers, Server edition, zips + checksums.

## Not tracked here (and why)
- `app/node_modules/` — run `npm install` in `app/`.
- `app/engines/` — bundled llama.cpp binaries per platform (~430 MB). Obtain them from a release build or the engine kit; only `engines/VERSION` is tracked.
- `dist/`, `out/`, `data/`, secrets — build output and runtime state.

## Develop
```bash
cd app
npm install
npm start            # launches the Electron desktop app
```
The server can also run headless (see `server-edition/`).

## Build a release
From the repo root, with the platform engine binaries present in `app/engines/`:
```bash
./release.sh         # outputs installers + zips to out/ (filenames carry the version)
```
Mac apps are ad-hoc signed; installer/uninstaller `.exe` filenames carry the version (e.g. `Install ForgeAI 2.10.0 (x64).exe`).

## Security note
ForgeAI stays visible to the device owner and admin — it is never hidden from Services, the apps list, or security tooling. Adding computers always requires an enrolment key or explicit owner approval.
