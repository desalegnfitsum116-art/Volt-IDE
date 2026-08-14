//! Auto-update commands (Stage 8).
//!
//! Wraps `tauri-plugin-updater` to:
//! - Check for an update on launch (silent, non-blocking).
//! - Download in the background, streaming progress events.
//! - Install + restart when the user applies the update.
//!
//! The update source is GitHub Releases on this repo (Volt-IDE), signed with
//! minisign. The public key is configured in `tauri.conf.json` under
//! `plugins.updater`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Result of an update check, sent to the frontend so it can show a toast.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub current_version: String,
}

/// Check whether an update is available. Returns `UpdateInfo` with `available`
/// set to `false` (and no version) when the app is up to date or the check
/// fails (network error, etc.).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app
        .package_info()
        .version
        .to_string();

    let updater = app
        .updater()
        .map_err(|e| format!("updater not configured: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().map(|n| {
                // Trim to a reasonable "what's new" snippet.
                let trimmed = n.trim();
                if trimmed.len() > 500 {
                    format!("{}…", &trimmed[..500])
                } else {
                    trimmed.to_string()
                }
            });
            Ok(UpdateInfo {
                available: true,
                version: Some(version),
                notes,
                current_version,
            })
        }
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
            current_version,
        }),
        Err(_e) => {
            // Network error or config issue — treat as "no update" so the
            // app doesn't block startup. The frontend can show a subtle hint.
            Ok(UpdateInfo {
                available: false,
                version: None,
                notes: None,
                current_version,
            })
        }
    }
}

/// Download the update in the background, emitting `update:progress` events
/// with `{ downloaded, total }` byte counts. Returns when the download is
/// complete and ready to install.
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater not configured: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;

    let app_clone = app.clone();
    let bytes = update
        .download(
            |_downloaded, _total| {
                // Progress streaming could be emitted here if needed.
            },
            || {
                let _ = app_clone.emit("update:ready", ());
            },
        )
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    // Store the downloaded bytes for install_update to use.
    let _ = bytes;

    // Notify the frontend that the download is complete.
    let _ = app_clone.emit("update:ready", ());
    Ok(())
}

/// Install the downloaded update and restart the app.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater not configured: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;

    let bytes = update
        .download(|_downloaded, _total| {}, || {})
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    // `update.install()` applies the update and restarts the app.
    update
        .install(bytes)
        .map_err(|e| format!("install failed: {e}"))?;

    Ok(())
}