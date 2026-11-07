//! Persisted user settings. Written atomically; a corrupt file falls back to
//! defaults rather than preventing the app from starting.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "light" | "dark" | "system"
    pub theme: String,
    pub context_size: u32,
    /// Layers to offload to the GPU. 999 means "all".
    pub gpu_layers: u32,
    pub threads: Option<u32>,
    pub selected_model: Option<String>,
    /// Off by default and documented as unverified. See cluster.rs.
    pub experimental_cluster: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            context_size: 8192,
            gpu_layers: 999,
            threads: None,
            selected_model: None,
            experimental_cluster: false,
        }
    }
}

impl Settings {
    pub fn load() -> Self {
        let path = crate::paths::settings_file();
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                tracing::warn!("settings file unreadable ({e}); using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> std::io::Result<()> {
        let path = crate::paths::settings_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }
}
