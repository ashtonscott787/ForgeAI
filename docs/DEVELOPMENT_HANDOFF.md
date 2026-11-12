# Forge AI — development handoff

Written so another session can continue without rediscovering any of this.

**Branch:** `claude/epic-turing-bfqx3r` — never merge to `main` or release
without the owner saying so.
**Latest release:** v0.5.4 (published, verified on a macOS runner).
**Everything since is on the branch and unreleased.**

## Start here

```bash
corepack enable && pnpm install   # pnpm is pinned in packageManager
pnpm engine:get                   # the inference engine; not in the repository
pnpm test                         # unit tests
pnpm test:all                     # everything, and fails if anything failed
pnpm build                        # type-check and bundle
pnpm dist                         # package; refuses without an engine
```

Run Electron through `pnpm exec electron`, never `npx electron` — npx fetches a
different Electron (the project pins 38) and would test a runtime the app never
ships.

## Verified

210 unit tests and 60 UI scenarios, 0 failures, through `scripts/test-all.sh`.
Use that rather than a shell loop: a loop exits with the status of its last
command, so a suite failing in the middle once left the whole run green and a
regression was pushed on the strength of it.

- **Search** — Wikipedia and SearXNG keyless, Brave and Tavily with the user's
  own key, verified by a real test search before the key is kept. Citations are
  numbered, show their host, and open externally. A failed search and an empty
  one are reported differently on purpose.
- **Model metadata** — exact parameter counts summed from GGUF tensor shapes.
  Checked against the published Gemma 2 2B: 2,614,341,888 parameters, read with
  a range request over 26 MB rather than a 1.6 GB download.
- **Documents** — DOCX and ZIP written by hand and read back by independent
  readers (the app's own extractor, and Python's `zipfile`). CSV, Markdown,
  TXT, HTML.
- **Websites** — multipage, internal links resolved against the files present,
  broken links and unreachable pages both reported, per-page preview, ZIP export.
- **Email** — RFC 5322 composition and real SMTP delivery, tested against a
  server that records the whole dialogue. Header injection refused. Passwords
  never cross the network unencrypted. Nothing sends without a person's
  approval, and that flag never reaches the model.
- **Agents** — icons, descriptions, duplicate, no-tool test run, per-action
  status, per-agent knowledge packs. Permissions are checked in the main
  process, not the renderer and not the model.
- **Browser in chat** — pane beside the conversation, Google home, loading and
  error states, find-in-page, summarise, activity recorded on the turn.
- **Responsive** — 700–1600px across five views, nothing past the right edge.

## Not verified

- **PDF generation.** Implemented; never executed anywhere. See below.
- **Real model inference through the app.** The engine runs Gemma 2 2B on a
  macOS CI runner; nobody has loaded a model through the app's own UI.
- **The packaged app launching on a Mac** and reaching its bundled engine.
- **Two machines over Tailscale.** Unit-tested, never run on two machines.
- **Browser loading/error events** against a real guest page.

## Known bugs and open items

| Item | State |
| --- | --- |
| PDF crash: `DisallowJavascriptExecutionScope` | **Fix written, unrun.** `printToPDF` drives printing through the renderer, so the window must allow JavaScript; it was created with `javascript: false`. Window and print options now live in `documents.PDF_WINDOW` / `PDF_OPTIONS`, used by both the app and the verification script so they cannot differ. Needs `pnpm exec electron scripts/verify-pdf.cjs` on a Mac to confirm. |
| Reading an inbox (IMAP) | Not built. Sending works; receiving does not. The panel says so. |
| Agent runs | One at a time. No parallel runs. |
| Linux engine | llama.cpp publishes no Linux build for the pinned tag. Build from source into `engine/`. |
| Code signing | Off by design (`identity: null`). Gatekeeper warns on first open; move the app to Applications first. Developer ID needs certificates nobody here has. |

## Environment limitations

- The cloud session has **no Electron and no GPU**, so anything needing either
  — PDF generation, launching the app, real inference — can only be confirmed
  on the owner's Mac.
- The owner's Mac is **not reachable** from the cloud session: no folder is
  shared through Remote Control, and Remote Control would give files and a
  shell, never the screen.
- The owner's Mac has about **5 GB usable memory**. Agent loops need a 7B-class
  model (~4.5 GB of weights before context), so agents will be unreliable there
  and the Agents page says so. Chat, knowledge packs, search, documents and the
  browser are all fine on Gemma 2 2B.
- Brave, Tavily and SearXNG need the user's own key or instance. No key is
  compiled in; keys live in the OS key store.

## What to do next, in order

1. `pnpm exec electron scripts/verify-pdf.cjs` on a Mac. It prints PASS with the
   file, bytes, pages and Electron version, or FAIL with a reason.
2. Load a model through the app and send one message. Nothing has confirmed
   inference end to end through the UI.
3. `pnpm engine:get && pnpm dist`, then open the packaged app and check it finds
   its engine.
4. `pnpm test:all`.
