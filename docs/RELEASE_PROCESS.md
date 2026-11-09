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

## Resolved: the 0.5.2 macOS build could not start any model

The v0.5.2 macOS build (`Forge-AI-macOS-arm64.zip`) shipped its engine's libraries without the
short names the engine asks for (for example `libllama.0.dylib`; the bundle had only
`libllama.0.9.0.dylib`). The engine failed to load on any Mac, from any location. The SHA256 of that
zip matched its published checksum, so the file was what was published; the content was the problem.

Measured with `node scripts/engine-links.cjs --check <engine folder>` against that zip: 104 missing
references. After `node scripts/engine-links.cjs <engine folder>` on a copy: all present.

Why it was published: v0.5.2 was built by a manual run on `main` (run 42594701670), and `main` has
neither the link step nor any post-packaging check. The publish job's only conditions were that the
build job succeeded and that a version was given — nothing inspected the engine.

Fixed in v0.5.3 (run 42718297271, built from `claude/epic-turing-bfqx3r`):

- the build creates the links before packaging and checks the signed app, the zip and an installed
  copy. The dmg gets the same check, added after v0.5.3 was built, so v0.5.3's dmg was not checked by
  CI — use the zip on macOS, which is what the README and the download page link to;
- a macOS runner installed the app into Applications and ran Gemma 2 2B Q4_K_M through the bundled
  engine to a real reply;
- the publish job unpacks the exact macOS zip it is about to upload and refuses to release it if any
  library is missing, whichever branch the release is built from.

Verified after publication, by downloading from the release: all five assets match `SHA256SUMS.txt`,
the macOS zip's engine passes the library check, its nine unversioned links are real symlinks with
correct targets, and the bundle reports version 0.5.3.

v0.5.2 is still on the releases page and still broken on macOS. It is superseded by v0.5.3, which
`releases/latest` now serves.

## Test build of the macOS app (no release, no Developer ID needed)

Trigger: GitHub → Actions → "Desktop installers" → Run workflow. Choose the branch to build.
Leave "version" blank: nothing is published. Give a version (e.g. 0.5.3) to publish a release.

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

Status: run green on GitHub Actions (run 42716715808 without a release, run 42718297271 for v0.5.3).
