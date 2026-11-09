# Security

## Controls in place (and where they are tested)

**Desktop shell**
- `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Preload exposes three functions only: `invoke`, `on`, `pathForFile`.
- Every `forge:*` IPC handler checks that the sender is the app page (`trust.cjs`; tested).
- New windows are denied; only `https://` links open externally.
- The app page has a Content-Security-Policy (`index.html`, identical to `APP_CSP` in
  `preview.cjs`; tested). It allows scripts only from the bundle, and connections only to
  the app and to `127.0.0.1`. Images may come from `https:` (publisher avatars).
- Generated HTML pages load from the `forge-preview:` scheme under their own policy:
  inline script and style only, no network, no frames, no forms (`preview.cjs`; tested for the
  policy text; the scheme itself is **untested in Electron**).

**Credentials**
- API keys (model providers, connectors) are encrypted with `safeStorage`, which uses the OS keychain.
- Keys are never returned to the renderer. The renderer sends a key once, to save it, and then clears it.
- Keys are removed from any error text before it is shown (tested).
- Provider state (`providers.json`) holds verification results and model names, never a key (tested).

**Network**
- Cloud providers: https only, or http to this computer. No credentials in addresses. Redirects refused.
  Timeouts: 20 seconds for tests, 10 minutes for a reply. Request size 2 MB. Reply size 400k characters.
- Connectors: the same address rules, responses capped at 200 KB.
- Model names must match a strict pattern and come from the connection's own verified or typed-in list.
  The renderer cannot name an arbitrary model.
- Model downloads: file names are checked against a strict pattern; one transfer per file; stalls time out; truncated bodies are never installed.
- Updates: only the compiled-in repository is contacted; SHA256SUMS is required; truncated downloads are refused.

**Data**
- Cloud chats leave this computer. The UI says so in the Cloud models panel. Local models do not send data out.
- The engine log is written through a guard that cannot write to an ended stream (tested).

**Built-in browser**
- Page content runs in `<webview>` guests with no preload and no Node access, in their own storage partition.
  The main process enforces these settings on every guest before it loads, and refuses non-https navigation.
- Popups are denied. Local and private addresses cannot be opened in the browser.
- Reading a page runs a fixed script in the page and sends only the visible text, when the person presses the button.

## Known gaps (not fixed)

1. **`style-src 'unsafe-inline'`** is required by the React app's inline styles. Scripts are not
   affected, but styles can still be injected by page content that reaches the DOM.
2. **The `forge-preview:` scheme is not exercised in Electron.** Its policy is tested as text and
   behaviour is tested in Chromium through a stand-in that uses the same policy. Verify in the
   packaged app before release.
3. **Model output is untrusted.** Generated HTML runs in its isolated frame, but generated
   *actions* (emails, reminders, search queries) are only suggestions the person approves. A
   central approval gate for actions is not built yet.
4. **Prompt injection** from documents, web research and skills is not filtered. Skills and
   attachments are concatenated into the prompt. No defence beyond the house rules text.
5. **No audit log** for cloud requests, connector calls or skill changes.
6. **Logs are not redacted** beyond removing keys from provider errors. Engine logs may contain
   prompt fragments.
7. **Unsigned builds.** macOS is ad-hoc signed; Windows is unsigned. Integrity relies on SHA256SUMS in the same release.
8. **Provider brand assets** are not used. Neutral badges avoid trademark issues; this is a product decision for the owner.

## Reporting

Report security issues to the repository owner privately before public disclosure.
