# Forge AI

A desktop app that runs open-weight AI models on your own computer. No account,
no cloud inference, no data leaving the machine. macOS and Windows.

## Download

| | |
| --- | --- |
| **macOS** (Apple Silicon) | [Forge-AI-macOS-arm64.zip](https://github.com/ashtonscott787/ForgeAI/releases/latest/download/Forge-AI-macOS-arm64.zip) |
| **Windows** (64-bit) | [Forge-AI-Windows-Setup.exe](https://github.com/ashtonscott787/ForgeAI/releases/latest/download/Forge-AI-Windows-Setup.exe) |

> **The macOS build in release 0.5.2 is broken.** Its engine is missing 104
> library links, so the model will not start (you will see "tried:" with a
> temporary path). Do not use it until a corrected release (0.5.3 or later) is
> published. The Windows build is unaffected by this.

Neither build is code-signed, so each system warns you once on first launch: on
macOS, move the app into Applications first, then right-click it and choose Open.
Running it from the downloads folder or a disk image makes macOS run a temporary
copy, and Forge AI cannot update or find itself in that copy. On Windows choose
More info then Run anyway. `site/download.html` is a download page with the same
links.

> **Status: 0.5.2 release, not yet verified on macOS.** Everything listed under
> *What works* has been built and exercised on the development machine; the
> macOS and Windows installers have not yet run the model end to end on those
> systems. Everything under *Not built yet* is absent rather than stubbed.

## What works

- **Reminders** in plain language — "at 7pm", "in two hours", "every Friday at
  9am" — with native notifications, recurring schedules and snooze. A reminder
  due while the app is closed fires at the next launch and is marked late; the
  app cannot wake a sleeping machine and does not pretend otherwise.
- **Memory** the person controls. The model may propose a memory; only a person
  saves one. Pin, edit, forget, export and import. Pinned and recent memories
  go into the prompt, not the whole list.
- **Live web research** through Perplexity or Firecrawl with your own key. The
  model asks for a lookup mid-answer and gets back real results with sources,
  dates and a fetch time. No provider, no search — never an invented one.
- **Encrypted credentials.** Keys go into the OS key store via safeStorage; if
  that is unavailable the key is not saved at all. An integration reads
  Connected only after a real authenticated call has succeeded.
- **Updates itself.** Checks this repository's releases, shows what changed and
  how large the download is, verifies it against the release's SHA256SUMS.txt,
  and replaces the application in place. Integrity is checked, not authorship —
  neither build is signed, so anyone who can publish a release here can publish
  an update. Needs the repository (or a releases mirror) to be public; no token
  is embedded in the app.
- **Attachments.** PDF, DOCX, PPTX, XLSX, CSV, JSON, Markdown, HTML and source
  files are parsed and handed to the model. Office formats are unpacked without
  a dependency; PDFs go through pdf.js. A file that cannot be read says so
  rather than appearing to have been read. Documents larger than the context
  window are reduced by keyword relevance, not truncated from the top.
- **Measured response timing** under every answer: total from pressing Send,
  plus model loading, time to first token, tokens and tokens per second when
  expanded. Nothing on that panel is estimated.
- **Chat** with streaming replies, saved conversations, light and dark themes.
- **Local inference** through a bundled `llama-server` (llama.cpp `b12180`),
  bound to loopback on a free port. Metal on Apple Silicon; CPU on Windows.
- **Every GGUF model on Hugging Face.** The library has two tabs: a curated set
  across Qwen, Llama, Gemma, DeepSeek, Mistral, Phi, Granite and SmolLM, and a
  search over the whole of Hugging Face, filtered to repositories that publish
  GGUF files. Open any repository to see each quantization it offers with its
  real size and whether it fits your machine. Each download link is resolved from the Hugging Face repository at
  the moment you click Download, so a renamed upload cannot become a dead link.
  Downloads resume, check their SHA-256 when the repository publishes one, and
  refuse to start without the disk space.
- **Add from URL** for any GGUF file the catalogue does not list.
- **Automatic loading.** There is no Load button: sending a message starts the
  model if it is not already running, then sends. Idle models unload after 20
  minutes.
- **Auto model selection.** Picks among *installed* models by matching the
  request against each model's declared strengths and your free memory, and says
  which it chose and why. It never downloads anything and never calls out.
- **Hardware detection** drives the Recommended / Compatible / May be slow /
  Not enough memory labels. They come from measured memory, not guesses.
- **Live HTML preview.** Ask for a page and it renders in a sandboxed frame:
  Preview / Code / Split, three device widths, open in browser, export. The
  frame allows scripts and nothing else — no file access, no app access.
- **Interactive blocks.** A model can emit a `forge-ui` JSON block and get back
  real checkboxes, sliders, dropdowns and dates; your selections are sent as
  your next message. Validated against a strict schema, and anything malformed
  falls back to plain text. Small models mostly ignore the convention; 7B-class
  instruct models use it.
- **Email replies** render with separate copy buttons for recipients, subject
  and body.

## Not built yet

Email and calendar (next, over IMAP and CalDAV with an app-specific password, so
no OAuth application is needed), Google Workspace, Higgsfield, Zapier, agent
mode, computer control and terminal execution.

Machine clustering, invitation links, lightweight remote compute workers and
distributed inference. The planner and capability model for placement exist in
`core/` with unit tests, and the app detects a Tailscale-style mesh address, but
no inference is distributed and the feature ships off. Vision and multi-file
projects are also absent.

Distributing a model across machines raises the memory ceiling. It does not make
a model smarter or faster, and over a high-latency link it is slower than one
machine. The planner refuses to split a model that already fits.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | React + TypeScript frontend |
| `electron/` | Desktop shell: IPC, engine supervision, downloads, reminders, memory, secrets, research |
| `core/` | Rust: hardware profiling, placement planner, catalogue validation (unit-tested) |
| `src-tauri/` | Earlier Tauri shell, kept for the Rust core and the icons |
| `site/` | The marketing and download site, published to GitHub Pages |
| `.github/workflows/` | CI, the installer builds, and the site |

## Building

```
pnpm install
pnpm build                 # type-check + bundle the frontend
pnpm exec electron-builder --mac   # or --win, on that OS
```

The engine is not in this repository. The workflow downloads it from the
llama.cpp release into `engine/` before packaging; do the same locally.

Pushing a tag beginning with `v` builds both platforms and attaches the
installers to a draft release. That workflow has not completed a run yet.

## Licence

MIT, see `LICENSE`. Bundled llama.cpp is MIT. Each model carries its own licence,
shown on its card before you download it.
