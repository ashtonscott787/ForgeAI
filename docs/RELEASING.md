# Producing the installers

The installers are built by GitHub Actions on real macOS and Windows runners.
Nothing here can be done from a Linux machine: the macOS SDK and the MSVC
toolchain only exist on their own operating systems.

## One time

1. Push this repository to GitHub.
2. Settings → Actions → General → Workflow permissions → **Read and write**.
   The release workflow needs it to create the release.

No secrets are required. Builds will be unsigned, which costs each user one
extra click on first open (see `docs/INSTALL.md`).

## Each release

```bash
git tag v0.1.0
git push origin v0.1.0
```

Then watch the **Actions** tab. Three jobs run in parallel — macOS arm64,
macOS x86_64, Windows x64 — each of which:

1. builds llama.cpp from a pinned tag, on that OS,
2. **fails the build if no runtime binary was produced**, so an app that cannot
   run a model is never published,
3. runs `cargo test -p forge-core` on that OS,
4. builds the frontend and bundles the installers.

Expect 15–25 minutes, mostly llama.cpp. The result is a **draft** release.
Download one installer, install it, confirm it opens and answers a prompt, and
only then press Publish.

## Removing the security warnings

Add these repository secrets and the same workflow signs and notarises.

**macOS** (needs a paid Apple Developer account):
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

**Windows** (needs a code-signing certificate): add a signing step to the
Windows job; Tauri's NSIS target supports `signCommand`.

## Adding GPU support on Windows

The deliberate gap in 0.1. To close it:

1. Add a Vulkan SDK step to the Windows job and build llama.cpp with
   `-DGGML_VULKAN=ON`.
2. Test on a machine with an AMD, Intel and NVIDIA GPU. A Vulkan build that
   crashes on one vendor is worse than a CPU build that works on all three.
3. Change `FORGE_RUNTIME_ID` so the build is distinguishable, and update
   `hw.rs` to report Vulkan once a device actually enumerates.
