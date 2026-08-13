import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
  col: number;
}

export interface CheckResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface DetectedBoard {
  port: string;
  fqbn: string | null;
  name: string | null;
  protocol: string | null;
}

export interface Settings {
  board?: string | null;
  port?: string | null;
  baud?: number | null;
  build_dir?: string | null;
  python?: string | null;
  theme?: string | null;
  font_size?: number | null;
  recent_files?: string[] | null;
  last_folder?: string | null;
  window_width?: number | null;
  window_height?: number | null;
  window_x?: number | null;
  window_y?: number | null;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// ---- fs ---------------------------------------------------------------

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function readFileRaw(path: string): Promise<number[]> {
  return invoke<number[]>("read_file", { path });
}

// ---- toolchain ------------------------------------------------------

export function checkSource(
  source: string,
  filename: string,
  settings: Settings,
): Promise<CheckResult> {
  return invoke<CheckResult>("check_source", { source, filename, settings });
}

export function compileFile(path: string, settings: Settings): Promise<void> {
  return invoke("compile_file", { path, settings });
}

export function uploadFile(
  path: string,
  port: string,
  settings: Settings,
): Promise<void> {
  return invoke("upload_file", { path, port, settings });
}

export function toolchainStatus(settings: Settings): Promise<{
  resolved: boolean;
  detail: string;
}> {
  return invoke("toolchain_status", { settings });
}

export function listPorts(): Promise<string[]> {
  return invoke<string[]>("list_ports");
}

export function detectBoards(): Promise<DetectedBoard[]> {
  return invoke<DetectedBoard[]>("detect_boards");
}

// ---- serial ----------------------------------------------------------

export function serialOpen(port: string, baud: number): Promise<void> {
  return invoke("serial_open", { port, baud });
}

export function serialSend(data: string): Promise<void> {
  return invoke("serial_send", { data });
}

export function serialClose(): Promise<void> {
  return invoke("serial_close");
}

export function serialIsOpen(): Promise<boolean> {
  return invoke<boolean>("serial_is_open");
}

// ---- events (streamed from Rust) ------------------------------------

export function onEvent<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  return listen<T>(event, (e) => cb(e.payload));
}

/** Files/folders dropped onto the window (emitted by the Rust backend). */
export function onFileDrop(cb: (paths: string[]) => void): Promise<() => void> {
  return onEvent<string[]>("file-drop", cb);
}

// ---- settings --------------------------------------------------------

export function readSettings(): Promise<Settings> {
  return invoke<Settings>("read_settings");
}

export function writeSettings(settings: Settings): Promise<void> {
  return invoke("write_settings", { settings });
}

// ---- recovery --------------------------------------------------------

export function clearRecovery(): Promise<void> {
  return invoke("clear_recovery");
}

// ---- misc ------------------------------------------------------------

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirNameFromPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? "" : path.slice(0, idx);
}

export async function detectVoltFiles(
  path: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > 2) return;
  let entries: DirEntry[];
  try {
    entries = await listDir(path);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.is_dir) {
      await detectVoltFiles(e.path, depth + 1, out);
    } else if (e.name.endsWith(".volt")) {
      out.push(e.path);
    }
  }
}