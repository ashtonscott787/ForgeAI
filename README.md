# Forge AI

A desktop app that runs open-weight AI models on your own computer. No account,
no cloud inference, no data leaving the machine. macOS and Windows.

## Download

| | |
| --- | --- |
| **macOS** (Apple Silicon) | [Forge-AI-macOS-arm64.zip](https://github.com/ashtonscott787/ForgeAI/releases/latest/download/Forge-AI-macOS-arm64.zip) |
| **Windows** (64-bit) | [Forge-AI-Windows-Setup.exe](https://github.com/ashtonscott787/ForgeAI/releases/latest/download/Forge-AI-Windows-Setup.exe) |

Neither build is code-signed, so each system warns you once on first launch: on
macOS right-click the app and choose Open, on Windows choose More info then Run
anyway. `web/index.html` is a download page with the same links.

> **Status: 0.3.0, early.** Everything listed under *What works* has been built
> and exercised; everything under *Not built yet* is absent rather than stubbed.
> Where something has not been verified, it says so.

## What works

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
| `electron/` | Desktop shell: IPC, engine supervision, downloads, Hugging Face resolution |
| `core/` | Rust: hardware profiling, placement planner, catalogue validation (unit-tested) |
| `src-tauri/` | Earlier Tauri shell, kept for the Rust core and the icons |
| `.github/workflows/` | CI and the installer builds |

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
