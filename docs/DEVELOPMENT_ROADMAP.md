# Development roadmap

Ordered by dependency. Status reflects `FEATURE_MATRIX.md`.

## Phase 0 — Audit and stabilisation (in progress)
- [x] Confirm branch, commits, active shell (Electron).
- [x] Feature matrix and architecture docs.
- [x] CI runs typecheck, build, syntax checks and tests.
- [ ] Repair CSP without breaking the HTML preview (needs a design decision: separate origin for previews).
- [ ] IPC sender validation on every `forge:*` handler.
- [ ] Remove or isolate the legacy Tauri fallback in `src/lib/ipc.ts`.
- [ ] Reproduce `ERR_STREAM_WRITE_AFTER_END`, or prove it no longer occurs, with a test.

## Phase 1 — Reliability
- [ ] Per-request IDs and engine-side cancellation.
- [ ] Engine health monitoring and crash recovery tests.
- [ ] Updater: test against a mock release server; verify on macOS and Windows.
- [ ] Packaged-app smoke test in CI.

## Phase 2 — AI foundations
- [ ] Provider-neutral inference interface.
- [ ] Anthropic and OpenAI adapters, with keys in the keychain.
- [ ] Catalogue filters and licensed provider logos.

## Phase 3 — MCP and skills
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
