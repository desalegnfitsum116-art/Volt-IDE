/**
 * File explorer sidebar. Shows an opened folder tree of .volt files
 * (and folders). Double-clicking a file opens it. This replaces the old
 * single-file "Open" flow lifecycle.
 */

import { listDir, DirEntry, fileNameFromPath } from "./api";

export class Explorer {
  private root = document.getElementById("explorer-root")!;
  private tree = document.getElementById("explorer-tree")!;
  private currentDir: string | null = null;
  private nodeState = new Map<string, boolean>(); // path -> expanded
  private onOpenFile: (path: string) => void;

  constructor(onOpenFile: (path: string) => void) {
    this.onOpenFile = onOpenFile;
  }

  setDirectory(dir: string) {
    this.currentDir = dir;
    this.root.classList.add("hidden");
    this.tree.classList.remove("hidden");
    this.renderDir(dir, this.tree, 0);
  }

  clear() {
    this.currentDir = null;
    this.root.classList.remove("hidden");
    this.tree.classList.add("hidden");
    this.tree.textContent = "";
  }

  get directory(): string | null {
    return this.currentDir;
  }

  private async renderDir(path: string, parent: HTMLElement, depth: number) {
    let entries: DirEntry[];
    try {
      entries = await listDir(path);
    } catch {
      parent.innerHTML = `<div class="explorer-muted">cannot read ${path}</div>`;
      return;
    }

    const root = document.createElement("div");
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "tree-row";

      if (e.is_dir) {
        const expanded = this.nodeState.get(e.path) ?? true;
        const twisty = document.createElement("span");
        twisty.className = "twisty";
        twisty.textContent = expanded ? "▾" : "▸";
        const icon = document.createElement("span");
        icon.className = "icon folder";
        icon.textContent = "📁";
        const label = document.createElement("span");
        label.textContent = e.name;
        row.append(twisty, icon, label);
        row.style.paddingLeft = `${4 + depth * 14}px`;

        const children = document.createElement("div");
        children.className = "tree-children";
        if (!expanded) children.classList.add("hidden");

        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const now = !(this.nodeState.get(e.path) ?? false);
          this.nodeState.set(e.path, now);
          twisty.textContent = now ? "▾" : "▸";
          children.classList.toggle("hidden", !now);
        });

        root.append(row, children);
        if (expanded) await this.renderDir(e.path, children, depth + 1);
      } else {
        const isVolt = e.name.endsWith(".volt");
        const icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = isVolt ? "🟢" : "📄";
        const label = document.createElement("span");
        label.textContent = e.name;
        if (isVolt) row.classList.add("volt-file");
        else {
          row.classList.add("non-volt");
          label.classList.add("muted-name");
          // Non-Volt files are still clickable (view-only later stages);
          // Stage 3 opens them in the editor as plain text.
        }
        row.append(icon, label);
        row.style.paddingLeft = `${4 + depth * 14}px`;
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.onOpenFile(e.path);
        });
        root.append(row);
      }
    }
    parent.replaceChildren(root);
  }

  /** Mark the currently-open editor file as selected in the tree. */
  highlightOpen(path: string) {
    const name = fileNameFromPath(path);
    const rows = this.tree.querySelectorAll<HTMLElement>(
      ".tree-row.volt-file span:last-child, .tree-row.non-volt span:last-child",
    );
    for (const row of rows) {
      const r = row.closest("div.tree-row") ?? row.parentElement;
      r?.classList.toggle("selected", row.textContent === name);
    }
  }
}