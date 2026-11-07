#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod cluster;
mod commands;
mod download;
mod engine;
mod hw;
mod paths;
mod settings;

use commands::AppState;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Stamped by `scripts/build-runtime.sh` at release time. A build without it
/// gets an obviously-fake id, so a dev machine is never mistaken for being
/// runtime-compatible with a released peer.
const RUNTIME_ID: &str = match option_env!("FORGE_RUNTIME_ID") {
    Some(id) => id,
    None => "llamacpp-devbuild",
};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("FORGE_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    if let Err(e) = paths::ensure() {
        tracing::error!("could not create application directories: {e}");
    }

    let state = AppState {
        engine: Arc::new(Mutex::new(engine::Engine::default())),
        settings: Mutex::new(settings::Settings::load()),
        runtime_id: RUNTIME_ID.to_string(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::detect_hardware,
            commands::cpu_label,
            commands::get_settings,
            commands::set_settings,
            commands::catalogue,
            commands::installed_models,
            commands::download_model,
            commands::delete_model,
            commands::start_engine,
            commands::stop_engine,
            commands::engine_status,
            commands::link_readiness,
            commands::plan,
        ])
        .on_window_event(|window, event| {
            // Never leave an orphaned inference process behind.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    engine::stop(state.engine.clone());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start Forge AI");
}
