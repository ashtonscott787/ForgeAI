# Release process

## What exists

- `.github/workflows/desktop.yml`: builds Electron installers for macOS and Windows on CI runners. Steps include caching and fetching the inference engine, `pnpm build`, `electron-builder` packaging, ad-hoc signing and repackaging on macOS, checksum generation, and a GitHub release upload.
- `.github/workflows/checks.yml`: typecheck, build, Electron syntax, unit tests, Rust tests.
- `.github/workflows/site.yml`: publishes the marketing site to GitHub Pages.
- `docs/RELEASING.md` (pre-existing) describes the manual steps.

## What this session verified

Nothing about the release pipeline was executed. The steps above were read from the workflow
files only. No artefact was built, signed, notarised or uploaded in this session.

## Limits

- **macOS**: artefacts are ad-hoc signed, not Developer ID signed or notarised. Gatekeeper behaviour on a clean machine is **unverified**.
- **Windows**: artefacts are unsigned. SmartScreen behaviour is **unverified**.
- **Updates**: verified only by SHA256SUMS in the same release, which does not prove authorship.

## Before a public release

1. `pnpm typecheck`, `pnpm build`, `pnpm test` all pass in CI.
2. Packaged app launches on macOS and Windows from the installed location.
3. Update from the previous released version to the new one, on each platform.
4. Checksums generated and checked against the downloaded files.
5. Release notes written from the actual commit list.
Withhold the release if any step fails.

## Release blocker found: the published macOS build cannot start any model

The v0.5.2 macOS build on GitHub (`Forge-AI-macOS-arm64.zip`) ships its engine's libraries without the
short names the engine asks for (for example `libllama.0.dylib`; the bundle has only
`libllama.0.9.0.dylib`). The engine therefore fails to load on any Mac, from any location. The SHA256
of that zip matches the published checksum, so the file is what was published; the published content is
the problem.

Checked here with `node scripts/engine-links.cjs --check <engine folder>` against that zip: 104 missing references.
After `node scripts/engine-links.cjs <engine folder>` on a copy: all present.

The release workflow now adds the links before packaging and checks the packaged app. The app checks
the engine before every start and names what is missing. A new macOS build is required; the v0.5.2
macOS build should be withdrawn or replaced. Nothing has been published from this branch.

## Test build of the macOS app (no release, no Developer ID needed)

Trigger: GitHub → Actions → "Desktop installers" → Run workflow. Choose branch
`claude/epic-turing-bfqx3r`. Leave "version" blank: nothing is published.

The macOS job then, in order:
1. Packages the app (`electron-builder --mac`), ad-hoc signs it, and rebuilds the zip and dmg.
2. Checks every engine library in the signed app (`scripts/engine-links.cjs --check`).
3. Unzips the released zip and checks its engine, then runs `llama-server --version` (which loads every library).
4. Copies the app into /Applications and checks it again from there.
5. Downloads SmolVLM 256M and Gemma 2 2B Q4_K_M, and runs `scripts/smoke-engine.sh` on each: the engine must
   start, become ready, and return a non-empty reply.
6. Uploads the dmg, zip and exe as the run's artifact "forge-ai-macos-latest" (kept 30 days).

Not covered by this job: launching the Electron window on macOS, clicking through the UI, the in-app
download, Gatekeeper behaviour for a browser-downloaded app, notarisation. Those still need a person on a Mac.

Status: implemented on this branch. Not yet run by GitHub Actions. Nothing here is verified until a run
completes green.
