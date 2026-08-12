/**
 * Bottom console panel: streams compile/upload output from the Rust backend
 * events and renders stdout/stderr with severity classes.
 */

import { onEvent } from "./api";

export type ConsoleKind = "compile" | "upload";

export class ConsolePanel {
  private outputEl: HTMLElement;
  private statusEl: HTMLElement;
  private kind: ConsoleKind | null = null;
  private running = false;
  private disposers: (() => void)[] = [];
  private onDone: (ok: boolean) => void = () => {};

  constructor() {
    this.outputEl = document.getElementById("console-output")!;
    this.statusEl = document.getElementById("console-status")!;
    document.getElementById("btn-console-clear")!.addEventListener("click", () =>
      this.clear(),
    );
  }

  setDoneHandler(fn: (ok: boolean) => void) {
    this.onDone = fn;
  }

  async listen() {
    this.disposers.push(
      await onEvent<string>("compile:output", (t) => this.append(t, "stdout")),
      await onEvent<string>("compile:stderr", (t) => this.append(t, "stderr")),
      await onEvent<string>("upload:output", (t) => this.append(t, "stdout")),
      await onEvent<string>("upload:stderr", (t) => this.append(t, "stderr")),
      await onEvent<{ ok: boolean; code: number }>("compile:done", (p) =>
        this.finish("compile", p.ok),
      ),
      await onEvent<{ ok: boolean; code: number }>("upload:done", (p) =>
        this.finish("upload", p.ok),
      ),
    );
  }

  clear() {
    this.outputEl.textContent = "";
  }

  start(kind: ConsoleKind, detail: string) {
    this.kind = kind;
    this.running = true;
    this.statusEl.textContent = `running ${kind}… ${detail}`;
    this.statusEl.style.color = "";
    this.append(`── starting ${kind} ──\n`, "info");
  }

  append(text: string, cls: string) {
    const span = document.createElement("span");
    span.className = `out-${cls}`;
    span.textContent = text;
    this.outputEl.appendChild(span);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private finish(kind: ConsoleKind, ok: boolean) {
    if (this.kind !== kind) return;
    this.running = false;
    this.statusEl.textContent = ok ? `${kind} completed` : `${kind} failed`;
    this.statusEl.style.color = ok ? "#57c58f" : "#e5534b";
    this.onDone(ok);
  }

  isRunning() {
    return this.running;
  }

  dispose() {
    for (const d of this.disposers) d();
  }
}