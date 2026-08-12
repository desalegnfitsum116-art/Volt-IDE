/**
 * Bottom console panel: streams compile/upload output from the Rust backend
 * and renders stdout/stderr with severity classes. Error/warning lines that
 * follow `path:line:col:` are rendered as clickable links that jump the
 * editor to that location.
 */

import { onEvent } from "./api";

export type ConsoleKind = "compile" | "upload";

export interface ConsoleErrorRef {
  path: string;
  line: number;
  col: number;
}

/** A parsed location from a voltc diagnostic line. */
interface ParsedError {
  ref: ConsoleErrorRef;
  severity: "error" | "warning";
  message: string;
}

/**
 * Match `path:line:col: error: message` / `... warning: message`.
 * The path may contain Windows drive letters and colons, so delimit from the
 * right: line:col are the last two numeric groups before the severity marker.
 */
const ERR_RE = /^(.+):(\d+):(\d+):\s*(error|warning|lexical error|syntax error):\s*(.*)$/;

/** Parse a single output line into an error/warning reference, or null. */
export function parseErrorLine(line: string): ParsedError | null {
  const m = ERR_RE.exec(line.trim());
  if (!m) return null;
  const severity = m[4] === "warning" ? "warning" : "error";
  return {
    ref: {
      path: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
    },
    severity,
    message: m[5],
  };
}

export class ConsolePanel {
  private outputEl: HTMLElement;
  private statusEl: HTMLElement;
  private kind: ConsoleKind | null = null;
  private running = false;
  private disposers: (() => void)[] = [];
  private onDone: (ok: boolean) => void = () => {};
  private onJump: (ref: ConsoleErrorRef) => void = () => {};

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

  /** Register a handler invoked when the user clicks a clickable error line. */
  setJumpHandler(fn: (ref: ConsoleErrorRef) => void) {
    this.onJump = fn;
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

  /**
   * Append a chunk of output. Each line is inspected for a `file:line:col:
   * error/warning:` pattern and rendered as a clickable link when found;
   * otherwise it is appended as plain text.
   */
  append(text: string, cls: string) {
    // Chunks may contain multiple lines; split while preserving trailing
    // newline so spans still wrap correctly.
    const lines = text.split(/(\r?\n)/);
    let buf = "";
    const flush = () => {
      if (buf.length === 0) return;
      const parsed = parseErrorLine(buf);
      if (parsed) {
        const link = this.buildErrorLink(parsed);
        this.outputEl.appendChild(link);
      } else {
        const span = document.createElement("span");
        span.className = `out-${cls}`;
        span.textContent = buf;
        this.outputEl.appendChild(span);
      }
      buf = "";
    };

    for (const part of lines) {
      if (part === "\n" || part === "\r\n") {
        flush();
        const nl = document.createElement("span");
        nl.className = `out-${cls}`;
        nl.textContent = part;
        this.outputEl.appendChild(nl);
      } else {
        buf += part;
      }
    }
    // Trailing partial line (no newline yet) — keep buffered so we don't
    // create bogus links from a half-received line.
    buf = "";

    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  /** Render a parsed error/warning line as a clickable jump link. */
  private buildErrorLink(parsed: ParsedError): HTMLElement {
    const link = document.createElement("span");
    link.className = `console-error-link ${parsed.severity}`;
    link.title = `Click to jump to ${parsed.ref.path}:${parsed.ref.line}:${parsed.ref.col}`;

    const location = document.createElement("span");
    location.className = "console-error-loc";
    location.textContent = `${parsed.ref.line}:${parsed.ref.col}`;

    const msg = document.createElement("span");
    msg.className = `console-error-msg ${parsed.severity}`;
    msg.textContent = ` ${parsed.severity}: ${parsed.message}`;

    link.append(location, msg);
    link.addEventListener("click", () => this.onJump(parsed.ref));
    return link;
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