import { open as dialogOpen, save as dialogSave, message as dialogMessage, ask as dialogAsk } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { EditorView } from "@codemirror/view";

import { createEditor, editorText, jumpToPosition, setEditorFontSize, BASE_FONT_SIZE } from "./editor";
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
  clearRecovery,
  Settings,
  listDir,
  fileNameFromPath,
  dirNameFromPath,
  onFileDrop,
} from "./api";

const voltFilter = { name: "Volt", extensions: ["volt"] };
const MAX_RECENT = 10;
const AUTOSAVE_DELAY_MS = 3000; // debounce: save after 3s of inactivity
const BOARD_POLL_MS = 5000; // live board/port re-scan interval

let view: EditorView;
let settings: Settings = {};
let zoomPct = 100;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let boardPollTimer: ReturnType<typeof setInterval> | undefined;

/** Per-open-tab document buffers (so switching tabs never loses edits). */
const buffers = new Map<string, string>();
let tabs: TabManager;

const fileLabel = document.getElementById("file-label") as HTMLElement;
const statusPath = document.getElementById("status-path") as HTMLElement;
const statusToolchain = document.getElementById("status-toolchain") as HTMLElement;
const statusHint = document.getElementById("status-hint") as HTMLElement;
const statusBoard = document.getElementById("status-board") as HTMLElement;
const statusZoom = document.getElementById("status-zoom") as HTMLElement;
const statusCursor = document.getElementById("status-cursor") as HTMLElement;
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
    scheduleAutosave();
  }
  hardwarePanel.update(source);
}

// ---- zoom (brief §5) -------------------------------------------------

function applyZoom(pct: number) {
  zoomPct = Math.min(300, Math.max(50, pct));
  const px = Math.round((BASE_FONT_SIZE * zoomPct) / 100);
  setEditorFontSize(view, px);
  statusZoom.textContent = `${zoomPct}%`;
}

function zoomIn() {
  applyZoom(zoomPct + 10);
}

function zoomOut() {
  applyZoom(zoomPct - 10);
}

function zoomReset() {
  applyZoom(100);
}

// ---- auto-save (brief §6) --------------------------------------------

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = undefined;
    void autosaveActive();
  }, AUTOSAVE_DELAY_MS);
}

async function autosaveActive() {
  const path = activePath();
  if (!path || !activeTabDirty()) return;
  try {
    await writeTextFile(path, editorText(view));
    buffers.set(path, editorText(view));
    setActiveDirty(false);
    statusHint.textContent = "saved";
    setTimeout(() => {
      if (statusHint.textContent === "saved") statusHint.textContent = "";
    }, 2000);
    // Stage 7: if no tabs are dirty anymore, clear the crash-recovery file.
    if (!tabs.hasDirty()) {
      await clearRecovery().catch(() => {});
    }
  } catch {
    // Silent — the user can still save manually; don't nag on every keystroke.
  }
}

// ---- live board detection (brief §6) ---------------------------------

function startBoardPolling() {
  if (boardPollTimer) clearInterval(boardPollTimer);
  boardPollTimer = setInterval(() => {
    void refreshPorts();
  }, BOARD_POLL_MS);
}

// ---- persistent window state (brief §6) ------------------------------

let windowStateTimer: ReturnType<typeof setTimeout> | undefined;

/** Save current window size/position into settings (debounced). */
async function saveWindowState() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(async () => {
    windowStateTimer = undefined;
    try {
      const win = getCurrentWindow();
      const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
      settings = {
        ...settings,
        window_width: size.width,
        window_height: size.height,
        window_x: pos.x,
        window_y: pos.y,
      };
      await writeSettings(settings).catch(() => {});
    } catch {
      // Non-fatal — window state is best-effort.
    }
  }, 500);
}

/** Restore window size/position from settings on launch. */
async function restoreWindowState() {
  if (!settings.window_width || !settings.window_height) return;
  try {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(settings.window_width!, settings.window_height!));
    if (settings.window_x !== undefined && settings.window_y !== undefined) {
      await win.setPosition(new LogicalPosition(settings.window_x!, settings.window_y!));
    }
  } catch {
    // Non-fatal — fall back to default window size.
  }
}

// ---- crash recovery (brief §6) ---------------------------------------

/** Persist dirty buffers to a recovery file so unsaved work isn't lost. */
async function persistRecovery() {
  const dirty: Record<string, string> = {};
  for (const tab of tabs.all) {
    if (tab.dirty) {
      const text = buffers.get(tab.path);
      if (text !== undefined) dirty[tab.path] = text;
    }
  }
  try {
    await invoke("write_recovery", { buffers: dirty });
  } catch {
    // Non-fatal; recovery is best-effort.
  }
}

/** Restore any crash-recovered buffers on launch. */
async function restoreRecovery() {
  try {
    const recovered = await invoke<Record<string, string>>("read_recovery");
    for (const [path, text] of Object.entries(recovered)) {
      if (!tabs.isOpen(path)) {
        buffers.set(path, text);
        tabs.open(path);
        tabs.setDirty(path, true);
      }
    }
    if (Object.keys(recovered).length > 0) {
      statusHint.textContent = "recovered unsaved changes";
      setTimeout(() => {
        if (statusHint.textContent === "recovered unsaved changes") statusHint.textContent = "";
      }, 4000);
    }
  } catch {
    // No recovery file or read error — fine.
  }
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
  // Stage 7: persist last-open project folder.
  settings = { ...settings, last_folder: selected };
  await writeSettings(settings).catch(() => {});
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
    // Stage 7: if no tabs are dirty anymore, clear the crash-recovery file.
    if (!tabs.hasDirty()) {
      await clearRecovery().catch(() => {});
    }
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
    // Stage 7: if no tabs are dirty anymore, clear the crash-recovery file.
    if (!tabs.hasDirty()) {
      await clearRecovery().catch(() => {});
    }
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
    } else if (key === "=" || key === "+") {
      // Ctrl/Cmd + : zoom in
      event.preventDefault();
      zoomIn();
    } else if (key === "-" || key === "_") {
      // Ctrl/Cmd - : zoom out
      event.preventDefault();
      zoomOut();
    } else if (key === "0") {
      // Ctrl/Cmd 0 : reset zoom
      event.preventDefault();
      zoomReset();
    }
  });

  // Ctrl/Cmd + mouse scroll zooms the editor (brief §5).
  document.getElementById("editor-container")!.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    },
    { passive: false },
  );
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

/**
 * Jump the editor to a hardware object's source line (from the hardware
 * sidebar click). The hardware panel always reflects the active buffer, so
 * the line belongs to the active file.
 */
function onHardwareJump(line: number) {
  const path = activePath();
  if (!path) return;
  hideStartScreen();
  loadBufferIntoEditor(path);
  view.dispatch({
    selection: { anchor: view.state.doc.line(Math.min(line, view.state.doc.lines)).from },
    scrollIntoView: true,
  });
  view.focus();
}

async function bootstrap() {
  settings = await readSettings().catch(() => ({}));
  const baudEl = document.getElementById("serial-baud") as HTMLInputElement;
  if (settings.baud) baudEl.value = String(settings.baud);

  // Stage 7: restore persisted window size/position.
  await restoreWindowState();

  view = createEditor(document.getElementById("editor-container")!, {
    settings: () => settings,
    onChange: onDocumentChange,
    onLint: onLintCounts,
    onCursor: (line, col) => {
      statusCursor.textContent = `Ln ${line}, Col ${col}`;
    },
  });
  applyFontSize();
  applyZoom(100);

  setupTabs();
  setupToolbar();
  setupTabsUI();
  setupSettings();
  setupDragAndDrop();

  // Stage 7: persist window geometry on resize/move (debounced).
  const win = getCurrentWindow();
  win.listen("tauri://resize", () => saveWindowState());
  win.listen("tauri://move", () => saveWindowState());

  // Stage 7: crash recovery — persist dirty buffers before the window closes.
  // Use Tauri's close-requested event (synchronous) instead of beforeunload,
  // which browsers don't wait for when the handler is async.
  win.listen("tauri://close-requested", async () => {
    await persistRecovery();
  });

  consolePanel.setDoneHandler(toolchainOnCompileDone);
  consolePanel.setJumpHandler(onConsoleErrorJump);
  hardwarePanel.setJumpHandler(onHardwareJump);
  await serialPanel.listen();
  await consolePanel.listen();
  await initToolchainStatus();
  await refreshPorts();

  // Stage 7: restore any crash-recovered buffers, then start live board
  // polling so connect/disconnect is reflected without a manual refresh.
  await restoreRecovery();
  startBoardPolling();

  // Stage 7: restore last-open project folder if any.
  if (settings.last_folder) {
    try {
      await explorer.setDirectory(settings.last_folder);
      const candidates = await listDir(settings.last_folder);
      const volt = candidates.find((c) => c.name.endsWith(".volt"));
      if (volt) await openPath(volt.path);
    } catch {
      // Folder no longer accessible — ignore.
    }
  }

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
