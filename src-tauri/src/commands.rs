//! The complete IPC surface. Every command here does real work; there are no
//! stubs that return fabricated data.

use crate::engine::{self, EngineStatus, SharedEngine};
use crate::settings::Settings;
use forge_core::registry::{Catalogue, Quant};
use forge_core::types::MachineCapability;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct AppState {
    pub engine: SharedEngine,
    pub settings: Mutex<Settings>,
    pub runtime_id: String,
}

#[derive(Serialize)]
pub struct Health {
    pub runtime_available: bool,
    pub runtime_id: String,
    pub models_dir: String,
    pub app_version: String,
}

#[tauri::command]
pub fn health(state: State<AppState>) -> Health {
    Health {
        runtime_available: engine::runtime_available(),
        runtime_id: state.runtime_id.clone(),
        models_dir: crate::paths::models_dir().to_string_lossy().into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
    }
}

#[tauri::command]
pub fn detect_hardware(state: State<AppState>) -> MachineCapability {
    crate::hw::profile(&state.runtime_id)
}

#[tauri::command]
pub fn cpu_label() -> String {
    crate::hw::cpu_label()
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().expect("settings lock").clone()
}

#[tauri::command]
pub fn set_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    let mut g = state.settings.lock().expect("settings lock");
    *g = settings;
    g.save().map_err(|e| e.to_string())
}

/// The bundled catalogue. A signed remote manifest replaces this in a later
/// release; shipping it in-app means a fresh install works offline.
#[tauri::command]
pub fn catalogue() -> Result<Catalogue, String> {
    let raw = include_str!("../catalogue.json");
    let cat: Catalogue = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    cat.validate().map_err(|e| e.to_string())?;
    Ok(cat)
}

#[derive(Serialize)]
pub struct InstalledModel {
    pub file_name: String,
    pub bytes: u64,
}

#[tauri::command]
pub fn installed_models() -> Vec<InstalledModel> {
    crate::download::installed()
        .into_iter()
        .map(|(file_name, bytes)| InstalledModel { file_name, bytes })
        .collect()
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    model_id: String,
    url: String,
    file_name: String,
    sha256: String,
) -> Result<String, crate::download::DownloadError> {
    let path = crate::download::fetch(app, model_id, url, file_name, sha256).await?;
    Ok(path.to_string_lossy().into())
}

#[tauri::command]
pub fn delete_model(file_name: String) -> Result<(), String> {
    crate::download::remove(&file_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_engine(
    state: State<'_, AppState>,
    model_file: String,
) -> Result<EngineStatus, engine::EngineError> {
    let (context, gpu_layers, threads) = {
        let s = state.settings.lock().expect("settings lock");
        (s.context_size, s.gpu_layers, s.threads)
    };
    engine::start(
        state.engine.clone(),
        model_file,
        context,
        gpu_layers,
        threads,
    )
    .await
}

#[tauri::command]
pub fn stop_engine(state: State<AppState>) {
    engine::stop(state.engine.clone());
}

#[tauri::command]
pub fn engine_status(state: State<AppState>) -> EngineStatus {
    engine::status(&state.engine)
}

#[tauri::command]
pub fn link_readiness() -> crate::cluster::LinkReadiness {
    crate::cluster::readiness()
}

/// Plan where a model would run. Informational in 0.1: with one machine the
/// answer is always Local, and the UI says so rather than implying a cluster.
#[tauri::command]
pub fn plan(
    state: State<AppState>,
    model_id: String,
    quant: Quant,
    context: u32,
) -> Result<forge_core::types::PlacementPlan, String> {
    let cat = catalogue()?;
    let entry = cat.get(&model_id).map_err(|e| e.to_string())?;
    let req = entry
        .requirement(quant, context)
        .ok_or_else(|| format!("{model_id} has no {} artifact", quant.label()))?;
    let me = crate::hw::profile(&state.runtime_id);
    let machines = vec![me];
    forge_core::Planner::new(&machines, 1, &state.runtime_id)
        .plan(&req)
        .map_err(|e| e.to_string())
}
