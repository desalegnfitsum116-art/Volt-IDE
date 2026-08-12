//! voltc integration: toolchain status, semantic check (lint), compile/build,
//! upload, and serial-port enumeration.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

use crate::resolve_python;
use crate::settings::Settings;

/// A single diagnostic line from `voltc.py check`, parsed for the editor lint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: String, // "error" | "warning"
    pub message: String,
    pub line: u32, // 1-based
    pub col: u32,  // 1-based
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
}

/// Toolchain summary shown in the UI status bar / hardware sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct ToolchainStatus {
    pub resolved: bool,
    pub detail: String,
}

fn voltc_path() -> PathBuf {
    crate::bundled_voltc_dir().join("voltc.py")
}

/// Suppress the console window Windows creates for spawned console apps
/// (python, arduino-cli). Without this, every voltc/arduino-cli call flashes
/// a terminal — and the editor lints on each typing pause, so it would flash
/// constantly while you type.
#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

fn base_command(python: &str) -> Command {
    let mut cmd = Command::new(python);
    cmd.arg(voltc_path()).current_dir(crate::bundled_voltc_dir());
    hide_console(&mut cmd);
    cmd
}

#[tauri::command]
pub async fn toolchain_status(settings: Settings) -> Result<ToolchainStatus, String> {
    let python = resolve_python(&settings);
    let output = base_command(&python)
        .arg("toolchain")
        .output()
        .await
        .map_err(|e| format!("failed to run python ({python}): {e}"))?;

    let mut lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .chain(String::from_utf8_lossy(&output.stderr).lines())
        .map(|s| s.to_string())
        .collect();
    if !lines.is_empty() {
        lines.retain(|l| !l.trim().is_empty());
    }

    let resolved = output.status.success() && lines.iter().any(|l| l.contains("avr-g++"));
    Ok(ToolchainStatus {
        resolved,
        detail: if lines.is_empty() {
            "toolchain report produced no output".to_string()
        } else {
            lines.join("\n")
        },
    })
}

/// Run `voltc.py check` on a source string without needing a file on disk.
/// Returns parsed diagnostics for the CodeMirror lint gutter.
#[tauri::command]
pub async fn check_source(
    app: AppHandle,
    source: String,
    filename: String,
    settings: Settings,
) -> Result<CheckResult, String> {
    let python = resolve_python(&settings);
    let tmp = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve cache dir: {e}"))?;
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create cache dir: {e}"))?;
    let file = tmp.join(format!("check_{}.volt", std::process::id()));

    std::fs::write(&file, &source).map_err(|e| format!("cannot stage source: {e}"))?;

    let output = base_command(&python)
        .arg("check")
        .arg(&file)
        .current_dir(crate::bundled_voltc_dir())
        .output()
        .await
        .map_err(|e| format!("failed to run voltc check: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    // `voltc.py check` prints diagnostics to stdout, and our codegen errors
    // surface on stderr for syntax/lex errors via `_load`.
    let mut diagnostics = parse_diagnostics(&stdout, &filename);
    diagnostics.extend(parse_diagnostics(&stderr, &filename));
    diagnostics.sort_by_key(|d| (d.line, d.col));

    let ok = output.status.success() && !diagnostics.iter().any(|d| d.severity == "error");
    Ok(CheckResult { ok, diagnostics })
}

fn parse_diagnostics(text: &str, _filename: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // Drop optional "error: " / "warning: " prefixes (syntax/lex path
        // prints `error: <path>:line:col: lexical error: ...` to stderr).
        let line = line
            .strip_prefix("error: ")
            .or_else(|| line.strip_prefix("warning: "))
            .unwrap_or(line);

        // Find the severity token; everything before is `path:line:col`.
        let markers = [": error: ", ": warning: ", ": lexical error: ", ": syntax error: "];
        let Some((marker_idx, mlen, sev)) = markers
            .iter()
            .enumerate()
            .find_map(|(i, m)| line.find(m).map(|p| (p, m.len(), i)))
        else {
            continue;
        };
        let message = line[marker_idx + mlen..].trim().to_string();
        let severity = match sev {
            0 | 2 | 3 => "error",
            _ => "warning",
        };
        let loc = &line[..marker_idx];

        // loc = `<path>:<line>:<col>`; path may contain ':' on Windows drives.
        let mut it = loc.rsplitn(3, ':');
        let (Some(col), Some(line_s), Some(_path)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (Ok(col), Ok(line)) = (col.trim().parse::<u32>(), line_s.trim().parse::<u32>()) else {
            continue;
        };
        out.push(Diagnostic { severity: severity.to_string(), message, line, col });
    }
    out
}

/// Streaming compile: runs `voltc.py build <path> -o <dir>`, emitting one
/// `compile:output` event per output line and a final `compile:done` event.
#[tauri::command]
pub async fn compile_file(
    app: AppHandle,
    path: String,
    settings: Settings,
) -> Result<(), String> {
    let python = resolve_python(&settings);
    let out_dir = settings
        .build_dir
        .clone()
        .unwrap_or_else(|| crate::bundled_voltc_dir().join("build").to_string_lossy().into_owned());

    let mut cmd = base_command(&python);
    cmd.args(["build", &path, "-o", &out_dir]);

    spawn_stream(&app, cmd, "compile").await
}

/// Streaming upload: `voltc.py upload <path> -p <port>`, events `upload:output`
/// and `upload:done`.
#[tauri::command]
pub async fn upload_file(
    app: AppHandle,
    path: String,
    port: String,
    settings: Settings,
) -> Result<(), String> {
    let python = resolve_python(&settings);
    let out_dir = settings
        .build_dir
        .clone()
        .unwrap_or_else(|| crate::bundled_voltc_dir().join("build").to_string_lossy().into_owned());

    let mut cmd = base_command(&python);
    cmd.args(["upload", &path, "-p", &port, "-o", &out_dir]);

    spawn_stream(&app, cmd, "upload").await
}

async fn spawn_stream(app: &AppHandle, mut cmd: Command, kind: &'static str) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn voltc: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app_out = app.clone();
    let task_stdout = tauri::async_runtime::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut buf = Vec::new();
        use tokio::io::AsyncBufReadExt;
        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            let _ = app_out.emit(&format!("{kind}:output"), &text);
        }
    });

    let app_err = app.clone();
    let task_stderr = tauri::async_runtime::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr);
        let mut buf = Vec::new();
        use tokio::io::AsyncBufReadExt;
        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            let _ = app_err.emit(&format!("{kind}:stderr"), &text);
        }
    });

    let status = child.wait().await.map_err(|e| format!("voltc wait failed: {e}"))?;
    let _ = task_stdout.await;
    let _ = task_stderr.await;

    let _ = app.emit(
        &format!("{kind}:done"),
        serde_json::json!({
            "ok": status.success(),
            "code": status.code(),
        }),
    );
    Ok(())
}

/// Enumerate serial ports via the `serialport` crate.
#[tauri::command]
pub fn list_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("enumerate ports: {e}"))?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

/// A detected board: a serial port plus (when arduino-cli recognizes it) an
/// FQBN / friendly name.
#[derive(Debug, Clone, Serialize)]
pub struct DetectedBoard {
    pub port: String,
    pub fqbn: Option<String>,
    pub name: Option<String>,
    pub protocol: Option<String>,
}

/// Auto-detect connected Arduino boards.
///
/// Primary: run `arduino-cli board list --format json` and parse
/// `detected_ports`. Fallback: serialport enumeration with a generic label.
#[tauri::command]
pub async fn detect_boards() -> Result<Vec<DetectedBoard>, String> {
    let cli = find_arduino_cli();
    if let Some(cli) = cli {
        let mut cmd = tokio::process::Command::new(&cli);
        cmd.args(["board", "list", "--format", "json"]);
        hide_console(&mut cmd);
        if let Ok(output) = cmd.output().await {
            if output.status.success() {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    if let Some(ports) = json.get("detected_ports").and_then(|v| v.as_array()) {
                        let boards: Vec<DetectedBoard> = ports
                            .iter()
                            .filter_map(|p| {
                                let port = p
                                    .get("port")
                                    .and_then(|m| m.get("address"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if port.is_empty() {
                                    return None;
                                }
                                let protocol = p
                                    .get("port")
                                    .and_then(|m| m.get("protocol"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                let fqbn = p
                                    .get("matching_boards")
                                    .and_then(|v| v.as_array())
                                    .and_then(|a| a.first())
                                    .and_then(|b| b.get("fqbn"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                let name = p
                                    .get("matching_boards")
                                    .and_then(|v| v.as_array())
                                    .and_then(|a| a.first())
                                    .and_then(|b| b.get("name"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                Some(DetectedBoard { port, fqbn, name, protocol })
                            })
                            .collect();
                        if !boards.is_empty() {
                            return Ok(boards);
                        }
                    }
                }
            }
        }
    }

    // Fallback: raw serialport enumeration.
    let ports = serialport::available_ports().map_err(|e| format!("enumerate ports: {e}"))?;
    Ok(ports
        .into_iter()
        .map(|p| DetectedBoard {
            port: p.port_name,
            fqbn: None,
            name: None,
            protocol: None,
        })
        .collect())
}

/// Locate the `arduino-cli` executable on PATH or in the Arduino install dir.
fn find_arduino_cli() -> Option<std::path::PathBuf> {
    for cand in [
        "arduino-cli".to_string(),
        "arduino-cli.exe".to_string(),
    ] {
        if let Ok(path) = which(cand.clone()) {
            return Some(path);
        }
    }
    // Fallback known location on Windows.
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var_os("LOCALAPPDATA")?;
        let p = std::path::PathBuf::from(&local)
            .join("Programs")
            .join("arduino-cli")
            .join("arduino-cli.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Cross-platform `which`-style lookup via %PATH% / PATH.
fn which(exe: String) -> Result<std::path::PathBuf, ()> {
    let path_var = std::env::var("PATH").map_err(|_| ())?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(&exe);
        if candidate.is_file() {
            return Ok(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            if candidate.extension().is_none() {
                for ext in ["exe", "bat", "cmd"] {
                    let c = dir.join(format!("{exe}.{ext}"));
                    if c.is_file() {
                        return Ok(c);
                    }
                }
            }
        }
    }
    Err(())
}