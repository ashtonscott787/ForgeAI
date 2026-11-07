# Installing Forge AI

## 1. Get the installer

Two routes:

- **The download page** — open `web/index.html`, or host it (GitHub Pages works:
  Settings → Pages → deploy from `main`, folder `/web`). Edit the `REPO` and
  `VERSION` constants at the bottom of that file first.
- **Straight from GitHub** — the Releases page of your repository.

Which file:

| Your computer | File |
| --- | --- |
| Mac with Apple Silicon (M1 and later) | `Forge.AI_<version>_aarch64.dmg` |
| Mac with an Intel processor | `Forge.AI_<version>_x64.dmg` |
| Windows 10 or 11, 64-bit | `Forge.AI_<version>_x64-setup.exe` |

Not sure which Mac you have: Apple menu → About This Mac. "Apple M…" means
Apple Silicon.

## 2. Install

### macOS

1. Open the `.dmg`.
2. Drag **Forge AI** into Applications.
3. **First open only:** right-click (or Control-click) Forge AI in Applications
   and choose **Open**, then **Open** again in the dialog.

That third step exists because the build is unsigned. Double-clicking an
unsigned app shows "cannot be opened because the developer cannot be verified"
with no way forward; right-click → Open gives you the confirm button. macOS
remembers the decision, so this is once per install.

If you get "Forge AI is damaged and should be moved to the Bin", macOS has
quarantined it. Clear the flag:

```
xattr -dr com.apple.quarantine "/Applications/Forge AI.app"
```

To remove the warning for everyone, add the Apple signing secrets to the
release workflow — the names are listed at the bottom of
`.github/workflows/release.yml`. That needs a paid Apple Developer account.

### Windows

1. Run the `.exe`.
2. If you see **"Windows protected your PC"**, click **More info** →
   **Run anyway**. Same reason as above: the build is unsigned.
3. Follow the installer. Forge AI lands in the Start menu.

The `.msi` is there for managed deployments; for a normal install use the
`.exe`.

## 3. First run

1. Open Forge AI. It reads your hardware and shows what it found under
   **Hardware**. Nothing leaves your machine.
2. Open **Models**. Download **Qwen2.5 1.5B Instruct** — about 1.1 GB, and the
   quickest route to a working first answer. Download progress is shown live
   and can be resumed if interrupted.
3. Press **Load**. The first load reads the whole file from disk, so give it a
   moment.
4. Go to **Chat** and type.

Models are stored in:

- macOS — `~/Library/Application Support/ForgeAI/models`
- Windows — `%APPDATA%\ForgeAI\models`

Deleting a model from the Models screen deletes the file.

## Performance, honestly

macOS builds use Metal, so inference runs on the GPU. **Windows builds in 0.1
are CPU-only** — a 1.5B model is comfortable, a 7B model is slow. CUDA and
Vulkan builds need an SDK on the build runner and a GPU to test against, and
shipping an untested GPU path would mean shipping crashes.

The app never shows an invented speed figure. Numbers appear after a real run
and are measured from that run.

## Troubleshooting

**"No inference runtime in this build"** — the installer was built without
llama.cpp. The release workflow fails the build rather than producing this, so
it means the app was built locally without the bundled binaries. See the README.

**A model downloads but will not load** — the most likely cause is memory. The
Hardware screen shows how much Forge will use for weights; a model larger than
that will not load. Try a smaller one, or lower **GPU layers** in Settings to
move work to system RAM.

**Nothing happens when I press Send** — check the Models screen shows a model
as "loaded". Chat needs a loaded model and says so if none is.

**Logs** — `~/Library/Application Support/ForgeAI/logs` on macOS,
`%APPDATA%\ForgeAI\logs` on Windows. Run with `FORGE_LOG=debug` for more.

## Uninstalling

- macOS — drag Forge AI from Applications to the Bin, then delete
  `~/Library/Application Support/ForgeAI` to remove models and settings.
- Windows — Settings → Apps → Forge AI → Uninstall, then delete
  `%APPDATA%\ForgeAI`.
