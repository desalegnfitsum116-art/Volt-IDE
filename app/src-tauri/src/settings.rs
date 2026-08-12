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