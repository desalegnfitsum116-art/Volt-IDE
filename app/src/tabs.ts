/**
 * Multi-tab editing (Stage 3). Manages the tab bar: open tabs, activation,
 * close buttons, and unsaved-changes dot indicators. The editor itself stays
 * single-instance; switching tabs swaps the document in/out of the editor.
 */

import { fileNameFromPath } from "./api";

export interface Tab {
  path: string;
  name: string;
  dirty: boolean;
}

export class TabManager {
  private bar: HTMLElement;
  private tabs: Tab[] = [];
  private activePath: string | null = null;

  private onActivate: (path: string) => void;
  private onClose: (path: string) => void;

  constructor(
    onActivate: (path: string) => void,
    onClose: (path: string) => void,
  ) {
    this.bar = document.getElementById("tab-bar")!;
    this.onActivate = onActivate;
    this.onClose = onClose;
  }

  /** Open a tab (or activate it if already open). Returns the tab. */
  open(path: string): Tab {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.activate(path);
      return existing;
    }
    const tab: Tab = { path, name: fileNameFromPath(path), dirty: false };
    this.tabs.push(tab);
    this.render();
    this.activate(path);
    return tab;
  }

  /** Mark the given tab (default: active) as dirty/clean. */
  setDirty(path: string, dirty: boolean) {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.render();
  }

  /** Close a tab. Returns the path of the tab to activate next, or null. */
  close(path: string): string | null {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return null;
    this.tabs.splice(idx, 1);
    this.render();

    // If we closed the active tab, activate the neighbor (or last remaining).
    if (this.activePath === path) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activePath = next ? next.path : null;
      if (next) this.render();
      return next ? next.path : null;
    }
    return null;
  }

  /** Activate a tab by path. */
  activate(path: string) {
    if (this.activePath === path) return;
    this.activePath = path;
    this.render();
    this.onActivate(path);
  }

  get active(): Tab | null {
    return this.tabs.find((t) => t.path === this.activePath) ?? null;
  }

  get all(): Tab[] {
    return [...this.tabs];
  }

  isOpen(path: string): boolean {
    return this.tabs.some((t) => t.path === path);
  }

  hasDirty(): boolean {
    return this.tabs.some((t) => t.dirty);
  }

  private render() {
    this.bar.textContent = "";
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab";
      el.dataset.path = tab.path;
      if (tab.path === this.activePath) el.classList.add("active");

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.name;
      label.title = tab.path;
      label.addEventListener("click", () => this.activate(tab.path));

      const dot = document.createElement("span");
      dot.className = "tab-dot";
      dot.classList.toggle("dirty", tab.dirty);
      dot.title = tab.dirty ? "Unsaved changes" : "Saved";

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close tab";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onClose(tab.path);
      });

      el.append(label, dot, close);
      this.bar.appendChild(el);
    }
  }
}