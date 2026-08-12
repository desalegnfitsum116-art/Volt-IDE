//! Serial monitor backing the Stage 6 panel.
//!
//! One port may be open at a time. The open handle is kept in a managed
//! `SerialState`; a reader thread clones the port and pushes `serial:data`
//! events to the webview until the port is closed (or the board disconnects).

use serialport::SerialPort;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct SerialState(pub Mutex<Option<Box<dyn SerialPort>>>);

impl Default for SerialState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Open a serial port for monitoring. Spawns a reader thread that emits
/// `serial:data` events; errors end the session and emit `serial:closed`.
#[tauri::command]
pub fn serial_open(
    app: AppHandle,
    state: State<'_, SerialState>,
    port: String,
    baud: u32,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Err("a serial port is already open".to_string());
    }

    let ser = serialport::new(&port, baud)
        .timeout(std::time::Duration::from_millis(100))
        .open()
        .map_err(|e| format!("cannot open {port}: {e}"))?;

    let mut reader = ser.try_clone().map_err(|e| format!("clone port: {e}"))?;
    *guard = Some(ser);

    let app = app.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 256];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = reader_app.emit("serial:data", &text);
                }
                Ok(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break,
            }
        }
        let _ = reader_app.emit("serial:closed", ());
    });

    let _ = app.emit("serial:opened", &port);
    Ok(())
}

/// Write raw bytes to the open port (used by the monitor's input box).
#[tauri::command]
pub fn serial_send(state: State<'_, SerialState>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let Some(ser) = guard.as_mut() else {
        return Err("serial port is not open".to_string());
    };
    ser.write_all(data.as_bytes())
        .map_err(|e| format!("serial write failed: {e}"))
}

/// Close the open serial port if any.
#[tauri::command]
pub fn serial_close(state: State<'_, SerialState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if guard.take().is_some() {
        // Dropping the Box<dyn SerialPort> closes the device handle.
    }
    Ok(())
}

/// Whether a serial session is currently active (for the UI toggle state).
#[tauri::command]
pub fn serial_is_open(state: State<'_, SerialState>) -> bool {
    let guard = state.0.lock().unwrap();
    guard.is_some()
}