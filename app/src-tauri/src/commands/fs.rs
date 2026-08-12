//! Filesystem commands exposed to the renderer (open/save via OS dialogs in
//! the renderer; actual I/O here).

use serde::Serialize;

#[derive(Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
}

fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = read_bytes(&path)?;
    String::from_utf8(bytes).map_err(|e| format!("{path} is not valid UTF-8 text: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("cannot write {path}: {e}"))
}

#[tauri::command]
pub fn text_file_info(path: String) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("cannot stat {path}: {e}"))?;
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&path)
        .to_string();
    Ok(FileInfo { path, name, size: meta.len() })
}

/// One entry in a directory listing for the file explorer sidebar.
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List the immediate children of a directory, sorted with folders first.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let mut out: Vec<DirEntry> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "node_modules" || name == ".git" || name == "target" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }

    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read the raw bytes of a file. Small helper for non-text assets if needed.
#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    read_bytes(&path)
}