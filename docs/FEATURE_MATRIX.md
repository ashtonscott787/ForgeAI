# Feature matrix

Classifications: **Working** · **Partial** · **Broken** · **Missing** · **Untested** · **Blocked externally**.
"Evidence" lists what actually supports the classification. Nothing is marked Working
on the basis of code presence alone.

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Chat send and streaming (local engine) | **Untested** in packaged app | Streaming logic unit-tested against a live SSE server (cancel). Not exercised in the app. |
| Stop button, all stages | **Partial** | Stop cancels attachment reading, engine start, and streaming (`Chat.tsx`). Local inference is not told to stop server-side. Not clicked in the app. |
| Streaming token rendering | **Working (code)** | Stray `return` removed; rendering not visually verified. |
| `ERR_STREAM_WRITE_AFTER_END` | **Untested** | Root cause not reproduced. Late callbacks are now guarded; no reproduction test exists. |
| Model download: resume (206) / restart (200, 416) | **Working (tested)** | `tests/transfer.test.cjs`: 6 tests pass against a local HTTP server. |
| Model download: truncation refused | **Working (tested)** | Test "connection dropped mid-body". |
| Model download: checksum verification | **Working (tested)** | Test "checksum mismatch". Only when the catalogue supplies a SHA256 (Hugging Face LFS oid). Models without one are installed on size/format checks only. |
| Model download: disk-full handling | **Partial** | Pre-check against `statfs`; not tested. |
| Update check (GitHub releases) | **Untested** | Code in `electron/updater.cjs`. No network test. |
| Update download + SHA256SUMS verification | **Partial** | Truncation check added; sha check existed. Not tested. |
| macOS update apply (App Translocation, /Applications) | **Untested / unverified** | Code exists; no macOS test environment here. |
| Windows update apply | **Untested** | Code exists; no Windows test environment here. |
| Model loading / hardware detection | **Untested** | No test environment with GPU or low-RAM hardware. |
| Skills (text): create, edit, enable, delete, import, export | **Working (tested)** | `tests/extensions.test.cjs`. UI not clicked in app. |
| Skills in prompt | **Working (tested)** | `systemPrompt()` filters enabled skills; not unit-tested yet. |
| Connectors: add, validate address, call, redirect refusal | **Working (tested)** | `tests/extensions.test.cjs`. Token storage path **untested** (keychain not available in CI). |
| Connectors: model-invoked calls | **Missing** | Intentionally absent until an approval flow exists. |
| Visual skills builder | **Missing** | Not built. |
| MCP client | **Missing** | Not built. |
| Visual REST connector builder (pagination, error mapping) | **Missing** | Not built. |
| Private knowledge bases | **Missing** | Not built. |
| Forge Model Studio (datasets, LoRA) | **Missing** | Not built. |
| Voice and meetings | **Missing** | Not built. |
| Business workspaces (server-enforced) | **Missing** | Not built. Requires a backend. |
| Skills marketplace | **Missing** | Not built. |
| Phone companion | **Missing** | Not built. |
| Memory, reminders, web research, attachments | **Untested** | Code present in `electron/`; no tests. |
| Tailscale / remote host | **Blocked externally** | Requires a tailnet and two machines. Mesh sidecar not verified. |
| Cloud API providers: Anthropic, OpenAI adapters | **Partial (tested, no UI)** | `electron/providers.cjs`: streaming, cancellation, typed errors, https-only. 7 tests against fixture servers (`tests/providers.test.cjs`). IPC `provider_stream` / `provider_cancel` / key storage wired. No model picker or settings UI for cloud models yet. Not tested against live vendor APIs (no keys). |
| Stop for cloud requests | **Partial (tested at adapter level)** | `AbortController` per request id; test shows no tokens after abort. |
| IPC sender validation | **Working (tested)** | Every `forge:*` handler refuses messages not from the app page (`electron/trust.cjs`, 2 tests). |
| Provider-neutral model interface (local + cloud) | **Missing** | Local path still calls llama-server directly from `chat.ts`; cloud path is separate. Not unified. |
| Packaged desktop build (macOS, Windows) | **Untested here** | `desktop.yml` builds on CI runners; no artefact was produced or inspected in this session. |
| Code signing / notarisation | **Blocked externally** | No Developer ID or Windows certificate in this environment. |
