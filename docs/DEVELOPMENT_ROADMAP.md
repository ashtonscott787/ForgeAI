# Development roadmap

Ordered by dependency. Status reflects `FEATURE_MATRIX.md`.

## Phase 0 — Audit and stabilisation (in progress)
- [x] Confirm branch, commits, active shell (Electron).
- [x] Feature matrix and architecture docs.
- [x] CI runs typecheck, build, syntax checks and tests.
- [x] Content-Security-Policy on the app page; generated previews moved to `forge-preview:` with their own policy (tested in Chromium; the scheme itself needs a check in Electron).
- [x] IPC sender validation on every `forge:*` handler (tested).
- [ ] Remove or isolate the legacy Tauri fallback in `src/lib/ipc.ts`.
- [~] `ERR_STREAM_WRITE_AFTER_END`: engine log writes moved behind a guard, with a regression test. The original crash was not reproduced in the packaged app.

## Phase 1 — Reliability
- [ ] Per-request IDs and engine-side cancellation.
- [ ] Engine health monitoring and crash recovery tests.
- [ ] Updater: test against a mock release server; verify on macOS and Windows.
- [ ] Packaged-app smoke test in CI.

## Phase 2 — AI foundations
- [ ] Provider-neutral inference interface.
- [x] Anthropic and OpenAI streaming adapters, keys in the keychain, IPC wired (tested against fixtures).
- [x] Settings panel (connect, test, disconnect, remove, manual models) and unified model selector, with UI tests.
- [ ] Live API verification with real keys (needs the owner's keys).
- [ ] Provider logos: neutral badges only; official logos need brand permission.
- [ ] Cost estimates: needs a trustworthy, maintained price source. Not shown.
- [~] One selector and one send path for local and cloud; local still streams from llama-server directly.
- [ ] Catalogue filters and licensed provider logos.

## Phase 3 — MCP and skills
- [~] MCP client: design written (`docs/MCP.md`); no code yet.
- [ ] MCP client using the official SDK over stdio and HTTP.
- [ ] Visual skills builder; skill manifest schema and validation.
- [ ] Model-requested tool calls through an approval gate outside the model.

## Phase 4 — Private knowledge
- [ ] Parsers (PDF, DOCX, MD, TXT, CSV, HTML), chunking, local embeddings, retrieval with citations, deletion propagation.

## Phase 5 — Voice and meetings
- [ ] Microphone permissions, transcription, consent indicator, export.

## Phase 6 — Model Studio
- [ ] Dataset tools, then MLX-LM or Unsloth adapter training with hardware checks, evaluation against baseline.

## Phase 7 — Business workspaces
- [ ] Requires a server with authentication. Not started; out of scope for the desktop-only build.

## Phase 8 — Marketplace
- [ ] Starts after the skills manifest and permission model exist.

## Phase 9 — Phone companion
- [ ] Starts after an authenticated remote API exists.

## Phase 10 — Final hardening
- [ ] Full regression suite, accessibility review, security review, release verification.
