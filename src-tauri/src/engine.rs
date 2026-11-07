//! Supervises the bundled `llama-server`.
//!
//! The server is bound to loopback on an OS-assigned free port, and the
//! frontend talks to it directly over HTTP — which is why chat streaming is
//! real SSE rather than something marshalled through IPC. The port is handed
//! to the UI by `engine_status`.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("the bundled inference runtime is missing from this installation")]
    RuntimeMissing,
    #[error("model file not found: {0}")]
    ModelMissing(String),
    #[error("could not start the runtime: {0}")]
    Spawn(String),
    #[error("the runtime started but did not become healthy within {0} seconds")]
    Unhealthy(u64),
}

impl serde::Serialize for EngineError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Serialize, Default)]
pub struct EngineStatus {
    pub running: bool,
    pub port: u16,
    pub model_file: Option<String>,
    /// Base URL the frontend should call. Empty when not running.
    pub base_url: String,
}

#[derive(Default)]
pub struct Engine {
    child: Option<Child>,
    pub status: EngineStatus,
}

pub type SharedEngine = Arc<Mutex<Engine>>;

/// Ask the OS for a free loopback port. Racy in principle; in practice the
/// runtime binds it within milliseconds, and a collision surfaces as a clean
/// `Unhealthy` error rather than silent breakage.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8730)
}

fn runtime_path() -> Option<PathBuf> {
    crate::paths::sidecar("llama-server")
}

/// True when this installation actually shipped an inference runtime.
/// The UI uses this to explain the situation instead of offering a dead button.
pub fn runtime_available() -> bool {
    runtime_path().is_some()
}

pub async fn start(
    engine: SharedEngine,
    model_file: String,
    context: u32,
    gpu_layers: u32,
    threads: Option<u32>,
) -> Result<EngineStatus, EngineError> {
    stop(engine.clone());

    let bin = runtime_path().ok_or(EngineError::RuntimeMissing)?;
    let model_path = crate::download::path_of(&model_file);
    if !model_path.is_file() {
        return Err(EngineError::ModelMissing(model_file));
    }

    let port = free_port();
    let mut cmd = Command::new(&bin);
    cmd.arg("--model")
        .arg(&model_path)
        .arg("--ctx-size")
        .arg(context.to_string())
        .arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--n-gpu-layers")
        .arg(gpu_layers.to_string());
    if let Some(t) = threads {
        cmd.arg("--threads").arg(t.to_string());
    }
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        // Do not flash a console window on Windows.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn().map_err(|e| EngineError::Spawn(e.to_string()))?;

    {
        let mut g = engine.lock().expect("engine lock");
        g.child = Some(child);
        g.status = EngineStatus {
            running: false,
            port,
            model_file: Some(
                model_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
            ),
            base_url: format!("http://127.0.0.1:{port}"),
        };
    }

    // Poll until the server answers. Loading a large model off disk can take a
    // while, so the window is generous; failing is better than hanging forever.
    let deadline_secs = 180;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/health");
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < deadline_secs {
        if let Ok(r) = client.get(&url).send().await {
            if r.status().is_success() {
                let mut g = engine.lock().expect("engine lock");
                g.status.running = true;
                return Ok(g.status.clone());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }

    stop(engine);
    Err(EngineError::Unhealthy(deadline_secs))
}

pub fn stop(engine: SharedEngine) {
    let mut g = engine.lock().expect("engine lock");
    if let Some(child) = g.child.as_mut() {
        let _ = child.start_kill();
    }
    g.child = None;
    g.status = EngineStatus::default();
}

pub fn status(engine: &SharedEngine) -> EngineStatus {
    engine.lock().expect("engine lock").status.clone()
}
