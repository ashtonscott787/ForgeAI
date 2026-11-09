# Security

## Current controls (verified in code)

- `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Preload exposes three functions only; there is no general `require` or `ipcRenderer` exposure.
- Renderer HTML previews run in `<iframe sandbox="allow-scripts">` with `srcdoc`: no same-origin access.
- New windows are denied; only `https://` links open externally.
- Secrets (API keys, connector tokens) are encrypted with `safeStorage` (OS keychain). Connector tokens are never returned to the renderer.
- Connectors accept only `https://`, or `http://` to `127.0.0.1`/`localhost`. Credentials in URLs are refused. Redirects are not followed. Responses are capped at 200 KB.
- Model downloads: only the file name from the catalogue is used; path separators are refused by `safeName`.
- Updates: only the compiled-in repository is contacted; SHA256SUMS is required; a mismatched file is deleted.

- Cloud API keys (Anthropic, OpenAI) are stored via `safeStorage`, sent only to their provider over https, and never returned to the renderer.
- Cloud requests use a per-request AbortController; Stop aborts the HTTP stream.

## Known gaps (not fixed)

1. **No Content Security Policy.** `index.html` has no CSP. A CSP `script-src 'self'` would block the model-generated HTML preview, because `srcdoc` iframes inherit the parent policy. Fixing it needs a design choice: serve previews from a separate origin, or accept `'unsafe-inline'` for scripts. Not changed in this session.
2. ~~No IPC sender validation.~~ **Fixed:** every `forge:*` handler now checks the sender is the app page (`electron/trust.cjs`, tested).
3. **Plaintext logs are not redacted.** Engine logs and diagnostics are not passed through a redactor.
4. **Connector token exposure to the model.** Tokens are not sent to the model, but the connector response body is shown to the user and not sanitised.
5. **Untrusted content into the prompt.** Web research, attachments and skills are concatenated into the prompt. There is no prompt-injection defence beyond the house-rules text.
6. **No audit log** for connector calls or skill changes.
7. **Unsigned builds.** macOS is ad-hoc signed; Windows is unsigned. Integrity relies on SHA256SUMS in the same release.

## Reporting

Report security issues to the repository owner privately before public disclosure.
