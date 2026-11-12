# Feature matrix

Classifications: **Working** · **Partial** · **Broken** · **Missing** · **Untested** · **Blocked externally**.
"Evidence" names what supports the classification. Code presence alone is not evidence.

Test key: **U** = unit/integration (`pnpm test`, 53 tests). **UI** = end-to-end in Chromium against the
production build (`pnpm test:ui`, 11 scenarios). The UI suite replaces the Electron main process with a
stand-in bridge (see `tests/ui/harness.cjs`); it does not exercise Electron itself.

## Cloud models

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Save an API key (keychain) | **Working** | UI: "connect a key". Key goes to `secrets.cjs` (`safeStorage`). Keychain round-trip itself not tested here. |
| Test connection with an authenticated request | **Working (fixtures)** · live **Blocked externally** | U: `providers-cloud.test.cjs` (listing, pagination, 401, redirect, timeout). Not run against real Anthropic/OpenAI: no keys. |
| Connected vs saved vs failed shown separately | **Working** | UI: "rejected key is saved but failed". State in `provider-state.cjs` (U: `provider-state.test.cjs`). |
| Disconnect (keeps key) / Remove key | **Working** | UI: "disconnect keeps the key; remove key deletes it". |
| Manually entered model IDs | **Working** | Validated by regex; stream refuses models not on the connection's list (main process). |
| Unified selector: local + cloud | **Working** | Cloud rows come from verified lists (`lib/cloud.ts`). UI: default-model scenario, local and cloud both send. |
| Default model setting | **Working** | UI: "default model setting picks a cloud model". Saved via `set_settings`. |
| Auto picks local; falls back to cloud if no local model | **Working** | Auto only considers local models (`router.ts`). Fallback in `Chat.tsx`. UI-tested indirectly (cloud sends without a local model). |
| Authentic provider logos | **Not done (by design)** | Shows a neutral "A"/"O" badge. Vendor logos require brand permission; see below. |
| Streaming replies (Anthropic, OpenAI) | **Working (fixtures + UI stand-in)** | U: UTF-8 streaming, usage, malformed frames, error events. UI: streams into bubble. Live API **Blocked externally**. |
| Stop cancels a cloud request | **Working** | UI: "Stop cancels the cloud request…". Cancel is per request id; U: cancelling one stream leaves another running. |
| Responses land in the conversation they started in | **Working** | UI: "reply finishing after switching chats". Writes use `setMessagesFor(conversationId)`. |
| Concurrent chats with independent requests | **Working** | UI: two chats streaming at once; Stop in one leaves the other running. |
| Token usage | **Partial** | Shown when the provider reports it; null is shown as not reported. Input tokens are stored but not displayed. |
| Cost estimate | **Missing (deliberate)** | No trustworthy price source is fetched. Nothing is estimated. |
| Attachments for cloud models | **Partial** | Text files are folded into the prompt (same as local). Images and PDFs are not sent to cloud models. |
| Context length, vision, tool support per model | **Not shown** | The provider list does not report them here. Nothing is claimed. |
| Request limits: timeout, size, redirects | **Working (fixtures)** | U: timeout kind, oversized request refused, redirect refused, response size cap. |
| Key never in renderer state after submit | **Working (UI)** | UI: key not in page HTML after connect; field cleared. Renderer sends the key once to the main process. |
| Key redacted from error text | **Working** | U: redaction tests, including keys echoed in error bodies. |

## Security and rendering

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| IPC sender validation | **Working** | U: `trust.test.cjs`. Every `forge:*` handler checks the sender is the app page. |
| Content Security Policy (app window) | **Working (Chromium)** | `index.html` meta policy; U checks it equals the policy in code; UI runs under it. Electron itself not run. |
| Generated HTML previews | **Working (Chromium stand-in)** | Each page is served from `forge-preview:` with its own policy (`preview.cjs`). UI: page script runs, its network request is blocked. The real `forge-preview:` scheme is **Untested** (Electron only). |
| Engine log writes never reach an ended stream | **Working (unit)** | U: `engine-log.test.cjs` reproduces the `ERR_STREAM_WRITE_AFTER_END` code and shows the guard. The original crash was **not reproduced** in the packaged app. |

## Local models and downloads

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Local chat streams a complete reply | **Working (stand-in engine)** | UI: "local model still streams". The real llama-server is not run here. |
| Stop on a local reply | **Working (stand-in engine)** | UI: "Stop works on a local reply mid-stream". Engine-side cancellation is not verified. |
| Model download: resume, 416, truncation, stall, duplicate | **Working** | U: `transfer.test.cjs` (6 tests). |
| Model download: checksum where available | **Working** | U: checksum mismatch test. Models without a published SHA256 get size and format checks only. |
| Hardware detection, memory-aware loading | **Untested** | No GPU or low-RAM machine here. |
| Updater (check, verify, apply) | **Untested** | `updater.cjs`. Truncation check added; no mock release server yet. |
| macOS App Translocation, /Applications | **Untested** | No macOS environment. |
| Packaged desktop build | **Untested here** | `desktop.yml` builds on CI; no artefact produced in this session. |
| Code signing / notarisation | **Blocked externally** | No Developer ID or Windows certificate here. |

## Built-in browser and open-source lookup

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Built-in browser (tabs, address bar, back/forward/reload) | **Working (Chromium stand-in)** | UI: "address bar opens https", "search opens a result in a new tab". Real `<webview>` behaviour needs Electron: **Untested here**. |
| Pages run isolated | **Working (main process, unit-tested policy)** | Guests get no preload, no Node, sandbox on, a separate partition (`persist:forge-browser`), https only, popups denied. The guest settings are enforced in `main.cjs` and the URL rule is tested (`open-web.test.cjs`). Not run inside Electron. |
| Keyless search (Wikipedia public API) | **Working (fixtures)** | U: `open-web.test.cjs` (sources with URLs, markup removed, redirects, malformed replies, timeouts). Live Wikipedia **Blocked externally** in this sandbox. Used when no Perplexity or Firecrawl key is saved. |
| Send page text to chat | **Working (stand-in)** | UI: text lands in the composer unsent. Text extraction from a live page needs Electron. |
| Screenshot of a page | **Partial** | Saves a PNG through a save dialog (`save_screenshot`). Not run in Electron. |
| Model analysis of screenshots | **Missing** | The local engine takes text only. A vision model and its projector file are needed; none is wired in. |
| Official search engines (Google, Bing) | **Not built (deliberate)** | Scraping their results breaks their terms. |
| Default browser setting | **Not built** | The operating system only lets the person set it. Forge AI does not change it silently. |
| Lookalike branding of other companies | **Not built (deliberate)** | Forge AI uses its own design. |

## Skills and connectors

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Skills: create, edit, enable, import, export | **Working** | U: `extensions.test.cjs`. |
| Connectors: address rules, live request, redirect refusal | **Working** | U: `extensions.test.cjs`. Token path needs a keychain, untested in CI. |
| Model-invoked connector calls | **Missing** | Intentionally absent until approval gating exists. |
| Visual skills builder | **Missing** | Not started. |
| Visual REST connector builder | **Missing** | Not started. |

## Not started

| Feature | Status | Note |
| --- | --- | --- |
| MCP client | **Missing** | Design only: `docs/MCP.md`. |
| Private knowledge bases | **Missing** | |
| Forge Model Studio | **Missing** | |
| Voice and meetings | **Missing** | |
| Business workspaces | **Missing** | Needs a server with authentication. |
| Skills marketplace | **Missing** | |
| Phone companion | **Missing** | |
| Tailscale / remote host | **Blocked externally** | Needs a tailnet and two machines. |

## Verified on this machine (real Electron, real engine, live network)

Run on Linux under Xvfb, with the Electron binary from node_modules and a llama-server built from the
pinned llama.cpp tag (b12180 is the release the workflow uses; the build here is from the same
tag's source). Not run on macOS or Windows.

| Feature | Status | Evidence |
| --- | --- | --- |
| Real Electron app starts and renders | **Working** | `pnpm test:e2e`: 10 checks, all passing. |
| Built-in browser opens a real https page in a webview | **Working** | E2E: example.com loads; guest prefs: no Node, sandboxed, no preload, persistent partition. |
| Plain http is never opened as a guest | **Working** | E2E. |
| Screenshot of the guest, saved as a real PNG | **Working** | E2E: PNG signature and size checked. The dialog is stubbed to a path. |
| Generated page runs its script; its network request is blocked | **Working** | E2E through the real `forge-preview:` scheme. |
| App page CSP blocks injected inline script | **Working** | E2E. |
| Link from another launch opens in the running window | **Working** | E2E: second process with a URL argument. |
| Screenshot analysis by a vision model (SmolVLM-256M + projector) | **Working (narrow)** | Engine: "Red." for a red image. E2E: the reply names the colour through the real engine. Quality beyond a solid-colour check is **not evaluated**. |
| Image requests use a short instruction | **Working** | The app's full house rules made the 256M model answer off-topic ("Forge."). Measured on this machine. |
| Empty model replies shown as errors | **Working** | Code path in Chat.tsx; not separately tested. |
| Live Wikipedia search and summary | **Working (live, rate-limited)** | `FORGE_LIVE=1 pnpm test:live`: 2 of 2 passed on the third attempt. Wikipedia rate-limits this shared address (HTTP 429); the app reports that plainly. |
| Keyless lookups follow the system proxy | **Working (code)** | Requests go through Electron's `net` in the app. Node's `https` ignores the proxy, so tests use Node unless the transport is injected. Not exercised behind a real corporate proxy. |
| Default browser: status is shown | **Working** | E2E reads the status. |
| Default browser: button registers Forge for web links | **Untested** | Pressing it would change this machine's registration. Not pressed in tests. macOS and Windows behaviour not checked. |
| Vision model download (model + projector) | **Untested end to end** | The projector is fetched after the model. Resolver tested by reading code; the download itself was not run through the app. |

## Reported on macOS (this round)

| Item | Status | Evidence / gap |
| --- | --- | --- |
| Models stuck "Starting…" from the translocated copy | **Improved, not verified on macOS** | The app now refuses to start the engine from the App Translocation location, with a message to move it to Applications. Quarantine itself is only removed by a signed, notarised build, which this project does not yet produce. |
| Stop does not work while a model is starting | **Fixed (UI-tested)** | Stop now also stops the engine start. UI scenario "Stop while the engine is starting". Not verified against a real slow Mac start. |
| Each model shows its own logo | **Fixed (code)** | Catalogue repos belong to one uploader, so every card showed that uploader's avatar. Models now show their original publisher's Hugging Face organisation (mapping in `src/lib/publisher.ts`), with the built-in mark as fallback. |
| Reminders page is basic | **Improved (UI-tested)** | Edit text and time, mark done, snooze 10 min / 1 hour / tomorrow, overdue highlight, clear past, reopen, examples when empty. Backend unit tests for reminders are still missing. |
| Latest release on GitHub | **v0.5.3 published** | Built from `claude/epic-turing-bfqx3r` (run 42718297271) and served by `releases/latest`. Not yet merged into `main`. |
| Agents | **Missing** | No Agents view exists in any release. |

## Download from GitHub and Hugging Face (verified this round)

| Item | Status | Evidence |
| --- | --- | --- |
| Gemma 2 2B Q4_K_M: resolved file name, size and SHA256 | **Working (live)** | `FORGE_LIVE=1 NODE_USE_ENV_PROXY=1 node --test tests/live-download.test.cjs`. |
| Gemma 2 2B download completes and verifies | **Working (live)** | 1.7 GB downloaded through the app's transfer code; hashed on disk against the published SHA256; GGUF signature checked; no partial file left. |
| Dropped connection retried and resumed | **Working (unit)** | `transfer.test.cjs`: a connection dropped mid-download is retried from the partial file. Live drop occurred once during testing and was refused rather than installed. |
| v0.5.2 Windows setup from GitHub matches SHA256SUMS | **Working** | Downloaded and hashed. Its contents are not verified (no 7-Zip here). |
| v0.5.2 macOS zip from GitHub | **Superseded; still broken** | Checksum matched, but its engine is missing 104 library links. Replaced by v0.5.3. |
| v0.5.3 macOS zip from GitHub matches SHA256SUMS | **Working** | Downloaded from the release: checksum matches, engine passes the library check, nine unversioned links are real symlinks with correct targets, bundle reports 0.5.3. |
| v0.5.3 Windows installers match SHA256SUMS | **Working** | Downloaded and hashed. Contents not inspected (no extraction tool here). |
| macOS engine loads | **Working in v0.5.3 (CI)** | On a macOS runner: the app was installed into Applications, every library checked, `llama-server --version` loaded them all. |
| Engine runs Gemma 2 2B on macOS | **Working (CI)** | `scripts/smoke-engine.sh` against the installed app on a macOS runner: the engine started, became ready, and returned a non-empty reply. Not run on user hardware. |
| Engine runs Gemma 2 2B on Linux | **Working** | Real llama-server, `/v1/chat/completions` answered. |

## Added this round

| Item | Status | Evidence |
| --- | --- | --- |
| Other apps can use this machine's models | **Working (unit)** | OpenAI-compatible endpoint, off by default. `tests/share-server.test.cjs`: 13 tests, mostly refusals. Not yet pointed at by a real Claude or ChatGPT install. |
| Another computer over a private mesh | **Partly verified** | The endpoint binds a Tailscale address and refuses any non-mesh one (unit-tested). Two real machines have not been joined — that needs two machines. |
| Knowledge packs (your own material) | **Working (unit)** | `tests/knowledge.test.cjs`: 16 tests covering chunking, BM25 ranking, export/import round-trip and hostile import files. Retrieval, not weight training; the panel says so. |
| Show the model's working | **Working (unit + UI)** | `<think>` blocks parsed out before rendering: `tests/thinking.test.cjs`, 6 tests. Off by default in Settings. |
| Finish time under an answer | **Working** | `finished_at` recorded at both completion sites and shown in the timing panel. |
| Temporary chat (ghost button) | **Working (UI)** | 2 UI scenarios: it is marked, kept out of the chat list, never reaches localStorage, and ends when left. |
| Regenerate an answer | **Working (UI)** | Rebuilds from before the question, so it is not duplicated. |
| Find an old chat | **Working (UI)** | Searches titles and message bodies. |
| Agents | **Working (unit + UI), untested on a real loop** | Saved workers with a name, role, standing instructions, model and an explicit permission list. 22 unit tests on the permission checks and 6 UI scenarios on the configuration. The loop itself has not been run against a real model here. |
| Agent permissions enforced in the main process | **Working (unit)** | `agent_act` re-checks every call against what the agent was granted. The renderer's claim and the model's request are both ignored. |
| The model operating the browser | **Working (unit)** | In chat the model emits a `forge-browse` block naming a page; the address is shown and a person presses the button, then the pane opens there and the page's text goes back to the model. Agents do the same through their own tools. The model never fetches on its own. |
| A model cannot steer the app at this machine | **Working (unit)** | `parseBrowse` refuses file:, ftp:, javascript:, data:, localhost, 127.0.0.1 and .local, and upgrades http to https. Tested against each. |
| Fine-tuning model weights | **Not planned for laptops** | Needs a training stack and far more memory than the target machines have. Knowledge packs are the supported route. |
