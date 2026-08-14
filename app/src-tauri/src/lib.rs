//! Volt IDE Tauri backend.
//!
//! Owns filesystem access, settings persistence, voltc (compiler) invocation,
//! and serial-port enumeration. The webview talks to this surface only
//! through the explicit, allow-listed commands declared in `run()`.

pub mod commands;
pub mod settings;

use commands::serial::SerialState;
use settings::Settings;
use tauri::Emitter;

/// Absolute path to the bundled `voltc.py` inside this repo's `toolchain/`.
pub fn bundled_voltc_dir() -> std::path::PathBuf {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()          // app/
        .expect("no parent for CARGO_MANIFEST_DIR")
        .parent()          // volt-ide/
        .expect("no parent for app/")
        .join("toolchain")
}

/// Resolve the python executable to spawn voltc with.
pub fn resolve_python(settings: &Settings) -> String {
    if let Some(path) = settings.python.as_deref() {
        if !path.trim().is_empty() {
            return path.to_string();
        }
    }
    "python".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(settings::SettingsState::default())
        .manage(SerialState::default())
        .on_window_event(|window, event| {
            // Drag-and-drop .volt files/folders onto the window (Stage 3).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let paths: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = window.emit("file-drop", paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_text_file,
            commands::fs::write_text_file,
            commands::fs::text_file_info,
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::toolchain::toolchain_status,
            commands::toolchain::check_source,
            commands::toolchain::compile_file,
            commands::toolchain::upload_file,
            commands::toolchain::list_ports,
            commands::toolchain::detect_boards,
            commands::serial::serial_open,
            commands::serial::serial_send,
            commands::serial::serial_close,
            commands::serial::serial_is_open,
            crate::settings::read_settings,
            crate::settings::write_settings,
            crate::settings::write_recovery,
            crate::settings::read_recovery,
            crate::settings::clear_recovery,
            commands::update::check_update,
            commands::update::download_update,
            commands::update::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Volt IDE");
}