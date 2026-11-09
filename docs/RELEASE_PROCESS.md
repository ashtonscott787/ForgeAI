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
