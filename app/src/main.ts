import { open as dialogOpen, save as dialogSave, message as dialogMessage, ask as dialogAsk } from "@tauri-apps/plugin-dialog";
import { EditorView } from "@codemirror/view";

import { createEditor, editorText } from "./editor";
import { ConsolePanel } from "./console";
import { SerialPanel } from "./serial";
import { Explorer } from "./explorer";
import { HardwarePanel } from "./hardware";
import {
  readTextFile,
  writeTextFile,
  toolchainStatus,
  detectBoards,
  compileFile,
  uploadFile,
  readSettings,
  writeSettings,
  Settings,
  listDir,
  fileNameFromPath,
} from "./api";

const voltFilter = { name: "Volt", extensions: ["volt"] };

let view: EditorView;
let currentPath: string | null = null;
let fileName: string | null = null;
let dirty = false;
let settings: Settings = {};
let lastOpenDir: string | null = null;

const fileLabel = document.getElementById("file-label") as HTMLElement;
const statusPath = document.getElementById("status-path") as HTMLElement;
const statusToolchain = document.getElementById("status-toolchain") as HTMLElement;
const statusHint = document.getElementById("status-hint") as HTMLElement;
const overlay = document.getElementById("editor-overlay") as HTMLElement;

const consolePanel = new ConsolePanel();
const serialPanel = new SerialPanel(() => settings, (open) => {
  document.getElementById("serial-input")?.dispatchEvent(new Event("input"));
});
const explorer = new Explorer((path) => openPath(path));
const hardwarePanel = new HardwarePanel();

function setOverlay(text: string | null) {
  overlay.textContent = text ?? "";
  overlay.classList.toggle("hidden", text === null);
}

function setDirty(value: boolean) {
  dirty = value;
  updateStatusBar();
}

function updateStatusBar() {
  fileLabel.textContent = dirty ? `● ${fileName ?? "No file open"}` : fileName ?? "No file open";
  statusPath.textContent = currentPath ?? "";
}

function onDocumentChange(source: string) {
  if (!dirty) setDirty(true);
  hardwarePanel.update(source);
}

function onLintCounts(_counts: { errors: number; warnings: number }) {
  // Errors are also surfaced as gutters; status hint keeps it readable.
}

async function loadDocument(path: string, contents: string) {
  currentPath = path;
  fileName = fileNameFromPath(path);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contents } });
  setDirty(false);
  hardwarePanel.update(contents);
  updateStatusBar();
  explorer.highlightOpen(path);
}

async function openPath(path: string) {
  try {
    const contents = await readTextFile(path);
    await loadDocument(path, contents);
    refreshPorts();
  } catch (err) {
    await dialogMessage(`Cannot open ${path}: ${err}`, { title: "Volt IDE", kind: "error" });
  }
}

async function openFileDialog() {
  if (!(await confirmDiscard())) return;
  const selected = await dialogOpen({
    multiple: false,
    filters: [voltFilter],
    directory: false,
  });
  if (typeof selected !== "string") return;
  await openPath(selected);
}

async function openFolderDialog() {
  const selected = await dialogOpen({ directory: true, multiple: false });
  if (typeof selected !== "string") return;
  lastOpenDir = selected;
  explorer.setDirectory(selected);
  statusHint.textContent = `folder: ${selected}`;
  // Autodetect home file for convenience.
  const candidates = await listDir(selected);
  const volt = candidates.find((c) => c.name.endsWith(".volt"));
  if (volt) await openPath(volt.path);
  await refreshPorts();
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return dialogAsk("Current file has unsaved changes. Discard them?", {
    title: "Volt IDE",
    kind: "warning",
  });
}

async function saveFile(): Promise<boolean> {
  if (currentPath === null) return saveFileAs();
  try {
    await writeTextFile(currentPath, editorText(view));
    setDirty(false);
    return true;
  } catch (err) {
    await dialogMessage(`Cannot save: ${err}`, { title: "Volt IDE", kind: "error" });
    return false;
  }
}

async function saveFileAs(): Promise<boolean> {
  const selected = await dialogSave({
    defaultPath: fileName ?? "untitled.volt",
    filters: [voltFilter],
  });
  if (selected === null) return false;
  try {
    await writeTextFile(selected, editorText(view));
    currentPath = selected;
    fileName = fileNameFromPath(selected);
    setDirty(false);
    updateStatusBar();
    return true;
  } catch (err) {
    await dialogMessage(`Cannot save: ${err}`, { title: "Volt IDE", kind: "error" });
    return false;
  }
}

// ---- compile / flash -------------------------------------------------

async function requireSavedFile(): Promise<string | null> {
  if (currentPath === null) {
    await dialogMessage("Save the file first.", { title: "Volt IDE", kind: "info" });
    return null;
  }
  if (dirty) {
    const ok = await saveFile();
    if (!ok) return null;
  }
  return currentPath;
}

async function compile() {
  const path = await requireSavedFile();
  if (!path) return;
  setOverlay(`compiling ${fileName}…`);
  await persistPortAndBoard();
  try {
    consolePanel.start("compile", path);
    await compileFile(path, settings);
  } catch (err) {
    consolePanel.append(`compile error: ${err}\n`, "error");
    consolePanel.setDoneHandler(() => {});
  }
}

async function flash() {
  const path = await requireSavedFile();
  if (!path) return;
  const port = settings.port;
  if (!port) {
    await dialogMessage("No serial port selected. Tap Scan and choose a port.", {
      title: "Volt IDE",
      kind: "warning",
    });
    return;
  }
  setOverlay(`uploading ${fileName} → ${port}…`);
  await persistPortAndBoard();
  try {
    consolePanel.start("upload", `${path} → ${port}`);
    await uploadFile(path, port, settings);
  } catch (err) {
    consolePanel.append(`upload error: ${err}\n`, "error");
  }
}

async function persistPortAndBoard() {
  settings = await readSettings();
  const boardSel = document.getElementById("select-board") as HTMLSelectElement;
  const portSel = document.getElementById("select-port") as HTMLSelectElement;
  const board = boardSel.value || settings.board || "uno";
  const port = portSel.value || settings.port || undefined;
  const next = { ...settings, board, port };
  settings = next;
  await writeSettings(next);
}

async function refreshPorts() {
  const portSel = document.getElementById("select-port") as HTMLSelectElement;
  const boardSel = document.getElementById("select-board") as HTMLSelectElement;
  try {
    const boards = await detectBoards();
    portSel.innerHTML = "";
    let sawCurrent = false;
    for (const b of boards) {
      const opt = document.createElement("option");
      opt.value = b.port;
      opt.textContent = b.name ? `${b.name} (${b.port})` : b.port;
      portSel.appendChild(opt);
      if (settings.port && b.port === settings.port) sawCurrent = true;
    }
    portSel.disabled = boards.length === 0;
    if (!sawCurrent && settings.port) {
      const opt = document.createElement("option");
      opt.value = settings.port;
      opt.textContent = settings.port;
      opt.selected = true;
      portSel.appendChild(opt);
    }
    if (settings.port) portSel.value = settings.port;

    // Board drop-down (common AVR boards; FQBN when arduino-cli detected one).
    const known = ["uno", "nano", "mini", "pro", "mega2560", "nano_old"];
    boardSel.innerHTML = "";
    for (const b of known) {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      boardSel.appendChild(opt);
    }
    for (const b of boards) {
      if (b.fqbn) {
        const opt = document.createElement("option");
        opt.value = b.fqbn;
        opt.textContent = b.fqbn;
        opt.selected = true;
        boardSel.appendChild(opt);
      }
    }
    if (settings.board &&
        Array.from(boardSel.options).some((o) => o.value === settings.board)) {
      boardSel.value = settings.board;
    }
  } catch (err) {
    portSel.innerHTML = `<option>port scan failed</option>`;
  }
}

async function initToolchainStatus() {
  try {
    statusToolchain.textContent = "toolchain…";
    const r = await toolchainStatus(settings);
    statusToolchain.textContent = r.resolved ? "✓ AVR toolchain ready" : "✗ toolchain missing";
    statusToolchain.className = r.resolved ? "ok" : "bad";
    statusToolchain.title = r.detail;
  } catch {
    statusToolchain.textContent = "✗ toolchain error";
    statusToolchain.className = "bad";
  }
}

async function toolchainOnCompileDone(ok: boolean) {
  setOverlay(null);
  if (!ok) await initToolchainStatus();
}

function setupToolbar() {
  const btnOpen = document.getElementById("btn-open")!;
  const btnFolder = document.getElementById("btn-open-folder")!;
  const btnSave = document.getElementById("btn-save")!;
  const btnSaveAs = document.getElementById("btn-saveas")!;
  const btnCompile = document.getElementById("btn-compile")!;
  const btnFlash = document.getElementById("btn-flash")!;
  const btnScan = document.getElementById("btn-refresh-ports")!;

  btnOpen.addEventListener("click", openFileDialog);
  btnFolder.addEventListener("click", openFolderDialog);
  btnSave.addEventListener("click", () => saveFile());
  btnSaveAs.addEventListener("click", () => saveFileAs());
  btnCompile.addEventListener("click", compile);
  btnFlash.addEventListener("click", flash);
  btnScan.addEventListener("click", refreshPorts);

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      openFileDialog();
    } else if (key === "k" && event.shiftKey) {
      // Ctrl+Shift+K: open folder (VS Code muscle memory)
      event.preventDefault();
      openFolderDialog();
    } else if (key === "s" && event.shiftKey) {
      event.preventDefault();
      saveFileAs();
    } else if (key === "s") {
      event.preventDefault();
      saveFile();
    } else if (key === "b") {
      event.preventDefault();
      compile();
    } else if (key === "r") {
      event.preventDefault();
      flash();
    }
  });
}

function setupTabs() {
  const bindSidebar = document
    .getElementById("sidebar-tabs")!
    .querySelectorAll("button");
  const bindBottom = document
    .getElementById("bottom-tabs")!
    .querySelectorAll("button");

  const activate = (tabs: NodeListOf<HTMLButtonElement>, prefix: string, name: string) => {
    for (const btn of tabs) btn.classList.toggle("active", btn.dataset.tab === name);
    document.getElementById(`panel-${prefix}-${name}`)?.classList.remove("hidden");
    for (const btn of tabs) {
      if (btn.dataset.tab !== name)
        document.getElementById(`panel-${prefix}-${btn.dataset.tab}`)?.classList.add("hidden");
    }
  };

  for (const btn of bindSidebar) {
    btn.addEventListener("click", () => activate(bindSidebar, "", btn.dataset.tab!));
  }
  for (const btn of bindBottom) {
    btn.addEventListener("click", () => activate(bindBottom, "", btn.dataset.tab!));
  }
}

function applyTheme() {
  document.body.classList.toggle("theme-light", settings.theme === "light");
}

function applyFontSize() {
  const el = document.querySelector("#editor-container .cm-editor") as HTMLElement | null;
  if (el) el.style.fontSize = `${settings.font_size ?? 14}px`;
}

function setupSettings() {
  const btn = document.getElementById("btn-settings")!;
  const popover = document.getElementById("settings-popover")!;
  const theme = document.getElementById("set-theme") as HTMLSelectElement;
  const font = document.getElementById("set-font") as HTMLInputElement;
  const python = document.getElementById("set-python") as HTMLInputElement;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.classList.toggle("hidden");
  });

  document.getElementById("btn-settings-save")!.addEventListener("click", async () => {
    settings = {
      ...settings,
      theme: theme.value,
      font_size: Number(font.value) || 14,
      python: python.value.trim() || undefined,
    };
    await writeSettings(settings);
    applyTheme();
    applyFontSize();
    await initToolchainStatus();
    popover.classList.add("hidden");
  });

  popover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => popover.classList.add("hidden"));
  // Fill popover from the loaded settings on open so the values are current.
  btn.addEventListener("click", (e) => {
    theme.value = settings.theme ?? "dark";
    font.value = String(settings.font_size ?? 14);
    python.value = settings.python ?? "";
  });
}

async function bootstrap() {
  settings = await readSettings().catch(() => ({}));
  const baudEl = document.getElementById("serial-baud") as HTMLInputElement;
  if (settings.baud) baudEl.value = String(settings.baud);
  applyTheme();

  view = createEditor(document.getElementById("editor-container")!, {
    settings: () => settings,
    onChange: onDocumentChange,
    onLint: onLintCounts,
  });
  applyFontSize();

  consolePanel.setDoneHandler(toolchainOnCompileDone);
  setupToolbar();
  setupTabs();
  setupSettings();

  await serialPanel.listen();
  await consolePanel.listen();
  await initToolchainStatus();
  await refreshPorts();

  updateStatusBar();
}

bootstrap();