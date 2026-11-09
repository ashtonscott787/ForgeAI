# Test plan

## Commands

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test          # unit and integration, node --test, 53 tests
pnpm test:ui       # end-to-end in Chromium, 11 scenarios (needs a build first)
```

CI (`.github/workflows/checks.yml`) runs typecheck, build, Electron syntax checks and unit tests
in the `frontend` job; the Rust tests in `core`; and the UI suite in `ui`, which installs
Playwright's Chromium with `playwright install --with-deps`.

To run the UI suite locally with a Chromium you already have, set `FORGE_CHROMIUM=/path/to/chromium`.

## Unit and integration (`tests/*.test.cjs`)

| File | Tests | What it proves |
| --- | --- | --- |
| `transfer.test.cjs` | 6 | Downloads: full file with SHA256, resume (206), 416 restart, truncation never installs, checksum mismatch discards, duplicate refused. |
| `extensions.test.cjs` | 6 | Skills CRUD and prompt selection, validation, non-overwriting import; connector address rules, live request, redirect refusal. |
| `trust.test.cjs` | 2 | IPC sender rule: app page trusted; remote, nested, foreign, missing senders refused. |
| `providers.test.cjs` | 7 | Anthropic and OpenAI streaming formats, auth headers, UTF-8, 401/429, abort mid-stream, refusals. |
| `providers-cloud.test.cjs` | 17 | Model listing with pagination and filtering; 401 with key redaction; malformed lists and responses; redirects; timeouts; model-ID validation; oversized requests; usage reported or null; malformed frames; error events; two concurrent streams; cancelling one leaves the other. |
| `provider-state.test.cjs` | 4 | Verified vs failed states; manual IDs; state file contains no key material; unknown providers refused. |
| `engine-log.test.cjs` | 4 | Reproduces `ERR_STREAM_WRITE_AFTER_END`; guarded log ignores late writes; second engine on the same path; destroyed log. |
| `preview.test.cjs` | 7 | App policy blocks inline/eval script; frames limited to previews; preview policy has no network; unknown and oversized pages refused; bounded store; index.html policy equals code. |

## End-to-end UI (`tests/ui/cloud-ui.cjs`)

Runs the production build (`dist/`, served over HTTP with the app's real CSP) in Chromium.
`tests/ui/harness.cjs` stands in for the Electron bridge (`window.forge`). It replaces only the
process boundary; the React app, its state and its streaming code run as shipped.

| Scenario | Checks |
| --- | --- |
| connect a key | key saved, authenticated test ran, key not in the page, models listed |
| rejected key | shown as saved but failed; provider's reason visible; never shown as connected |
| disconnect / remove | disconnect keeps the key; remove deletes it after confirmation |
| cloud reply streams | request has the right model and message; tokens render; usage recorded |
| Stop on cloud | cancel names the same request; later tokens dropped; earlier text kept; input usable |
| switching chats mid-reply | each reply lands in its own chat |
| Stop in one chat | does not stop another chat's reply |
| default model | the chosen cloud model is saved to settings |
| local model streams | complete reply from a stand-in engine; no cloud request |
| local Stop | stops mid-reply; input recovers; next message works |
| generated page | script runs in its frame under the preview policy; its network request is blocked |

## Not covered anywhere yet

- The real Electron main process, including `forge-preview:` and the CSP as Electron applies it.
- Live calls to Anthropic or OpenAI. These need real keys, which this project does not hold.
- Real llama-server runs and engine-side cancellation.
- Stop/Send/Stop rapid sequences and Unicode-heavy streams (planned).
- Updater against a mock release server.
- Packaged macOS and Windows applications.
- Every item in the directive's end-to-end list beyond cloud and local chat.
- Knowledge, workspaces, MCP, marketplace, voice, Model Studio, phone companion: no code yet.
