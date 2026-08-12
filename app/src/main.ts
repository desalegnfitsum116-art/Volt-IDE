import { open as dialogOpen, save as dialogSave, message as dialogMessage, ask as dialogAsk } from "@tauri-apps/plugin-dialog";
import { EditorView } from "@codemirror/view";

import { createEditor, editorText, jumpToPosition } from "./editor";
import { ConsolePanel, ConsoleErrorRef } from "./console";
import { SerialPanel } from "./serial";
import { Explorer } from "./explorer";
import { HardwarePanel } from "./hardware";
import { TabManager } from "./tabs";
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
  dirNameFromPath,
  onFileDrop,
} from "./api";

const voltFilter = { name: "Volt", extensions: ["volt"] };
const MAX_RECENT = 10;

let view: EditorView;
let settings: Settings = {};

/** Per-open-tab document buffers (so switching tabs never loses edits). */
const buffers = new Map<string, string>();
let tabs: TabManager;

const fileLabel = document.getElementById("file-label") as HTMLElement;
const statusPath = document.getElementById("status-path") as HTMLElement;
const statusToolchain = document.getElementById("status-toolchain") as HTMLElement;
const statusHint = document.getElementById("status-hint") as HTMLElement;
const statusBoard = document.getElementById("status-board") as HTMLElement;
const overlay = document.getElementById("editor-overlay") as HTMLElement;
const startScreen = document.getElementById("start-screen") as HTMLElement;
const recentList = document.getElementById("recent-list") as HTMLElement;

const consolePanel = new ConsolePanel();
const serialPanel = new SerialPanel(() => settings);
const explorer = new Explorer((path) => openPath(path));
const hardwarePanel = new HardwarePanel();

function setOverlay(text: string | null) {
  overlay.textContent = text ?? "";
  overlay.classList.toggle("hidden", text === null);
}

function setStatusDot(state: "idle" | "compiling" | "uploading" | "ok" | "error") {
  const dot = document.getElementById("status-dot")!;
  dot.className = `status-dot ${state}`;
  dot.title = state;
}

function activePath(): string | null {
  return tabs.active?.path ?? null;
}

function updateStatusBar() {
  const tab = tabs.active;
  const label = tab ? (tab.dirty ? `● ${tab.name}` : tab.name) : "No file open";
  fileLabel.textContent = label;
  statusPath.textContent = tab?.path ?? "";
}

/** Persist the current editor buffer back into the tab's buffer map. */
function commitActiveBuffer() {
  const path = activePath();
  if (path) buffers.set(path, editorText(view));
}

/** Load a tab's buffer into the editor and mark it active. */
function loadBufferIntoEditor(path: string) {
  const text = buffers.get(path) ?? "";
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  hardwarePanel.update(text);
  explorer.highlightOpen(path);
  updateStatusBar();
}

function activeTabDirty(): boolean {
  return tabs.active?.dirty ?? false;
}

function setActiveDirty(dirty: boolean) {
  const path = activePath();
  if (!path) return;
  tabs.setDirty(path, dirty);
  updateStatusBar();
}

function onDocumentChange(source: string) {
  const path = activePath();
  if (path) {
    buffers.set(path, source);
    if (!activeTabDirty()) setActiveDirty(true);
  }
  hardwarePanel.update(source);
}

function onLintCounts(_counts: { errors: number; warnings: number }) {
  // Errors are also surfaced as gutters; status hint keeps it readable.
}

async function pushRecentFile(path: string) {
  const existing = settings.recent_files ?? [];
  const next = [path, ...existing.filter((p) => p !== path)].slice(0, MAX_RECENT);
  settings = { ...settings, recent_files: next };
  await writeSettings(settings).catch(() => {});
  renderStartScreen();
}

/** Open a path in a tab (reusing the open buffer if already open). */
async function openPath(path: string) {
  try {
    const contents = await readTextFile(path);
    if (!tabs.isOpen(path)) buffers.set(path, contents);
    tabs.open(path);
    loadBufferIntoEditor(path);

    if (!explorer.directory) {
      // Opening a file directly (not via the explorer) — show its folder
      // so the project context is visible.
      const dir = dirNameFromPath(path);
      if (dir) explorer.setDirectory(dir);
    }
    await pushRecentFile(path);
    refreshPorts();
  } catch (err) {
    await dialogMessage(`Cannot open ${path}: ${err}`, { title: "Volt IDE", kind: "error" });
  }
}

async function openFileDialog() {
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
  explorer.setDirectory(selected);
  statusHint.textContent = `folder: ${selected}`;
  // Autodetect home file for convenience.
  const candidates = await listDir(selected);
  const volt = candidates.find((c) => c.name.endsWith(".volt"));
  if (volt) await openPath(volt.path);
  await refreshPorts();
}

async function confirmDiscard(path: string): Promise<boolean> {
  if (!tabs.all.some((t) => t.path === path)) return true;
  // Only prompt if the tab is dirty.
  const tab = tabs.all.find((t) => t.path === path);
  if (!tab?.dirty) return true;
  return dialogAsk(`"${tab.name}" has unsaved changes. Discard them?`, {
    title: "Volt IDE",
    kind: "warning",
  });
}

async function saveActiveFile(): Promise<boolean> {
  const path = activePath();
  if (!path) return false;
  try {
    await writeTextFile(path, editorText(view));
    buffers.set(path, editorText(view));
    setActiveDirty(false);
    return true;
  } catch (err) {
    await dialogMessage(`Cannot save: ${err}`, { title: "Volt IDE", kind: "error" });
    return false;
  }
}

async function saveFileAs(): Promise<boolean> {
  const tab = tabs.active;
  if (!tab) return false;
  const selected = await dialogSave({
    defaultPath: tab.name,
    filters: [voltFilter],
  });
  if (selected === null) return false;
  try {
    await writeTextFile(selected, editorText(view));
    // Re-key the buffer under the new path and update the tab.
    const oldPath = tab.path;
    buffers.delete(oldPath);
    buffers.set(selected, editorText(view));
    tabs.close(oldPath);
    tabs.open(selected);
    loadBufferIntoEditor(selected);
    await pushRecentFile(selected);
    return true;
  } catch (err) {
    await dialogMessage(`Cannot save: ${err}`, { title: "Volt IDE", kind: "error" });
    return false;
  }
}

async function closeTab(path: string) {
  if (!(await confirmDiscard(path))) return;
  commitActiveBuffer();
  buffers.delete(path);
  const next = tabs.close(path);
  if (next) {
    loadBufferIntoEditor(next);
  } else {
    // No tabs left — show the start screen.
    showStartScreen();
    hardwarePanel.clear();
    updateStatusBar();
  }
}

function showStartScreen() {
  startScreen.classList.remove("hidden");
  document.getElementById("editor-region")!.classList.add("hidden");
  renderStartScreen();
}

function hideStartScreen() {
  startScreen.classList.add("hidden");
  document.getElementById("editor-region")!.classList.remove("hidden");
}

function renderStartScreen() {
  const recents = settings.recent_files ?? [];
  recentList.textContent = "";
  if (recents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No recent files yet — open a .volt file to get started.";
    recentList.appendChild(empty);
    return;
  }
  for (const path of recents) {
    const row = document.createElement("button");
    row.className = "recent-row";
    row.title = path;
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = fileNameFromPath(path);
    const dir = document.createElement("span");
    dir.className = "recent-dir";
    dir.textContent = dirNameFromPath(path);
    row.append(name, dir);
    row.addEventListener("click", () => openPath(path));
    recentList.appendChild(row);
  }
}

// ---- compile / flash -------------------------------------------------

async function requireSavedFile(): Promise<string | null> {
  const path = activePath();
  if (path === null) {
    await dialogMessage("Open a file first.", { title: "Volt IDE", kind: "info" });
    return null;
  }
  if (activeTabDirty()) {
    const ok = await saveActiveFile();
    if (!ok) return null;
  }
  return path;
}

async function compile() {
  const path = await requireSavedFile();
  if (!path) return;
  setOverlay(`compiling ${fileNameFromPath(path)}…`);
  setStatusDot("compiling");
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
  setOverlay(`uploading ${fileNameFromPath(path)} → ${port}…`);
  setStatusDot("uploading");
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
  updateBoardStatus();
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
  updateBoardStatus();
}

function updateBoardStatus() {
  const boardSel = document.getElementById("select-board") as HTMLSelectElement;
  const portSel = document.getElementById("select-port") as HTMLSelectElement;
  const board = boardSel.value || settings.board || "uno";
  const port = portSel.value || settings.port;
  statusBoard.textContent = port ? `Board: ${board} (${port})` : `Board: ${board}`;
  statusBoard.className = port ? "connected" : "";
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
  setStatusDot(ok ? "ok" : "error");
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
  btnSave.addEventListener("click", () => saveActiveFile());
  btnSaveAs.addEventListener("click", () => saveFileAs());
  btnCompile.addEventListener("click", compile);
  btnFlash.addEventListener("click", flash);
  btnScan.addEventListener("click", refreshPorts);

  // Start screen buttons.
  document.getElementById("btn-start-open")!.addEventListener("click", openFileDialog);
  document.getElementById("btn-start-folder")!.addEventListener("click", openFolderDialog);

  (document.getElementById("select-board") as HTMLSelectElement).addEventListener(
    "change",
    updateBoardStatus,
  );
  (document.getElementById("select-port") as HTMLSelectElement).addEventListener(
    "change",
    updateBoardStatus,
  );

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
      saveActiveFile();
    } else if (key === "w") {
      // Ctrl+W: close the active tab
      event.preventDefault();
      const path = activePath();
      if (path) closeTab(path);
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
  tabs = new TabManager(
    (path) => {
      // Switching tabs: commit current buffer, load the new one.
      commitActiveBuffer();
      loadBufferIntoEditor(path);
      hideStartScreen();
    },
    (path) => {
      closeTab(path);
    },
  );
}

function setupDragAndDrop() {
  onFileDrop(async (paths) => {
    for (const p of paths) {
      try {
        const entries = await listDir(p);
        // Directory: use it as the explorer project folder.
        explorer.setDirectory(p);
        statusHint.textContent = `folder: ${p}`;
        const volt = entries.find((c) => c.name.endsWith(".volt"));
        if (volt) await openPath(volt.path);
      } catch {
        // Not a directory — treat as a file.
        if (p.toLowerCase().endsWith(".volt")) {
          await openPath(p);
        }
      }
    }
    await refreshPorts();
  });
}

function applyFontSize() {
  const el = document.querySelector("#editor-container .cm-editor") as HTMLElement | null;
  if (el) el.style.fontSize = `${settings.font_size ?? 14}px`;
}

function setupSettings() {
  const btn = document.getElementById("btn-settings")!;
  const popover = document.getElementById("settings-popover")!;
  const font = document.getElementById("set-font") as HTMLInputElement;
  const python = document.getElementById("set-python") as HTMLInputElement;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.classList.toggle("hidden");
  });

  document.getElementById("btn-settings-save")!.addEventListener("click", async () => {
    settings = {
      ...settings,
      font_size: Number(font.value) || 14,
      python: python.value.trim() || undefined,
    };
    await writeSettings(settings);
    applyFontSize();
    await initToolchainStatus();
    popover.classList.add("hidden");
  });

  popover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => popover.classList.add("hidden"));
  // Fill popover from the loaded settings on open so the values are current.
  btn.addEventListener("click", () => {
    font.value = String(settings.font_size ?? 14);
    python.value = settings.python ?? "";
  });
}

async function bootstrap() {
  settings = await readSettings().catch(() => ({}));
  const baudEl = document.getElementById("serial-baud") as HTMLInputElement;
  if (settings.baud) baudEl.value = String(settings.baud);

  view = createEditor(document.getElementById("editor-container")!, {
    settings: () => settings,
    onChange: onDocumentChange,
    onLint: onLintCounts,
  });
  applyFontSize();

  setupTabs();
  setupToolbar();
  setupTabsUI();
  setupSettings();
  setupDragAndDrop();

  consolePanel.setDoneHandler(toolchainOnCompileDone);
  consolePanel.setJumpHandler(onConsoleErrorJump);
  await serialPanel.listen();
  await consolePanel.listen();
  await initToolchainStatus();
  await refreshPorts();

  updateStatusBar();
  showStartScreen();
}

/**
 * Jump the editor to a compiler-reported location. If the path isn't the
 * active file (e.g. an include or an error from a different tab), open it
 * first, then move the cursor.
 */
async function onConsoleErrorJump(ref: ConsoleErrorRef) {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const active = activePath();
  if (active && norm(active) === norm(ref.path)) {
    jumpToPosition(view, ref.line, ref.col);
    return;
  }
  // Try to open the errored file, then jump once it's loaded.
  try {
    await openPath(ref.path);
    // openPath loads the buffer synchronously via loadBufferIntoEditor,
    // so the cursor jump can run immediately after.
    jumpToPosition(view, ref.line, ref.col);
  } catch {
    // File no longer exists or unreadable — keep the error visible in console.
  }
}

/** Wire the static tab-bar elements once tabs exist. */
function setupTabsUI() {
  document.getElementById("tab-bar")!.addEventListener("auxclick", (e) => {
    // Middle-click closes a tab.
    if (e.button === 1) {
      const tabEl = (e.target as HTMLElement).closest<HTMLElement>(".tab");
      if (tabEl) {
        const path = tabEl.dataset.path;
        if (path) closeTab(path);
      }
    }
  });
}

bootstrap();
