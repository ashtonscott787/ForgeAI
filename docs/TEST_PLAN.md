# Test plan

## Run

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test            # node --test on tests/*.test.cjs
```

CI (`.github/workflows/checks.yml`) runs typecheck, build, Electron syntax checks and `pnpm test`.
Rust tests (`cargo test -p forge-core`) run in the same workflow but were **not run in this session**.

## Current automated tests (12, all passing locally)

| File | What it proves |
| --- | --- |
| `tests/transfer.test.cjs` (6) | Full download + SHA256; resume via Range (206); 416 restart; mid-body drop never produces a final file; checksum mismatch removes the partial; duplicate download refused. |
| `tests/extensions.test.cjs` (6) | Skill CRUD, enabling and prompt selection, validation, non-overwriting import; connector address rules; live request and status; redirect refusal. |

The stream-cancel test (`Chat` `streamChat` against a live SSE server) was run as a one-off
script in the session scratchpad and is **not yet in the repository**.

## Not yet covered

- Stop/Send/Stop rapid sequences in the UI.
- Streaming with multibyte Unicode and very many chunks.
- Engine crash during generation.
- Updater (needs an Electron runtime and a mock release server).
- Packaged application launch on macOS and Windows.
- Every item in the directive's E2E list (sections 17 and 19).
- Knowledge, workspaces, MCP, marketplace, voice, Model Studio, phone companion: no code yet, so no tests.

## Environment limits

This session had no GUI, no display, no macOS or Windows runner, no GPU, and no Electron binary
(installed with `--ignore-scripts`). Electron-dependent code is tested only where its
dependencies can be stubbed.
