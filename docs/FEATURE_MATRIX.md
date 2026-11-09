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
