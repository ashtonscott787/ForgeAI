//! Where Forge keeps things on each OS. Created on demand, never assumed.

use std::path::PathBuf;

fn base() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("ForgeAI")
}

pub fn models_dir() -> PathBuf {
    base().join("models")
}

pub fn settings_file() -> PathBuf {
    base().join("settings.json")
}

pub fn logs_dir() -> PathBuf {
    base().join("logs")
}

pub fn ensure() -> std::io::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(logs_dir())?;
    Ok(())
}

/// Resolve a bundled sidecar binary next to the running executable.
/// Tauri places `externalBin` entries beside the app binary, with the target
/// triple suffix stripped at bundle time.
pub fn sidecar(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = [
        dir.join(name),
        dir.join(format!("{name}.exe")),
        // macOS .app layout: Contents/MacOS/<bin>, resources alongside
        dir.join("../Resources").join(name),
    ];
    candidates.into_iter().find(|p| p.is_file())
}
