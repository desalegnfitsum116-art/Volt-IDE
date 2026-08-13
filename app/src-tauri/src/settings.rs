//! Per-user IDE settings stored as one JSON file in the OS app-config dir.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// Board name, e.g. "uno" (used by voltc --board).
    pub board: Option<String>,
    /// Serial port for upload/monitor, e.g. "COM3".
    pub port: Option<String>,
    /// Serial monitor baud rate.
    pub baud: Option<u32>,
    /// Output directory for compiled artifacts.
    pub build_dir: Option<String>,
    /// Python executable override (e.g. "py" or an absolute path).
    pub python: Option<String>,
    /// Editor theme: "dark" | "light".
    pub theme: Option<String>,
    /// Editor font size in px.
    pub font_size: Option<u32>,
    /// Most-recently-opened .volt file paths (most recent first).
    pub recent_files: Vec<String>,
    /// Last-opened project folder (restored on launch).
    pub last_folder: Option<String>,
    /// Persisted window geometry (Stage 7: persistent window size/position).
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
}

pub struct SettingsState(pub Mutex<Settings>);

impl Default for SettingsState {
    fn default() -> Self {
        Self(Mutex::new(Settings::default()))
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn read_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read settings: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid settings.json: {e}"))
}

#[tauri::command]
pub fn write_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("cannot write settings: {e}"))?;

    // Refresh the in-memory copy so `resolve_python` sees overrides.
    if let Some(state) = app.try_state::<SettingsState>() {
        *state.0.lock().unwrap() = settings;
    }
    Ok(())
}

/// Path to the crash-recovery file (dirty buffers persisted on close).
fn recovery_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join("recovery.json"))
}

/// Persist dirty buffers (path → text) so unsaved work survives a crash.
#[tauri::command]
pub fn write_recovery(app: tauri::AppHandle, buffers: std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = recovery_path(&app)?;
    let raw = serde_json::to_string_pretty(&buffers).map_err(|e| format!("serialize recovery: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("cannot write recovery: {e}"))
}

/// Read back any crash-recovered buffers from a previous session.
#[tauri::command]
pub fn read_recovery(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, String>, String> {
    let path = recovery_path(&app)?;
    if !path.exists() {
        return Ok(std::collections::HashMap::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read recovery: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid recovery.json: {e}"))
}

/// Clear the recovery file (called after a clean save of all dirty buffers).
#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle) -> Result<(), String> {
    let path = recovery_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("cannot clear recovery: {e}"))?;
    }
    Ok(())
}
