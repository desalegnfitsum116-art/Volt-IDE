/**
 * Serial monitor panel: connect/disconnect, live streamed output, and an
 * input box that sends back to the board.
 */

import {
  serialOpen,
  serialSend,
  serialClose,
  onEvent,
  writeSettings,
  Settings,
} from "./api";

export class SerialPanel {
  private outputEl: HTMLElement;
  private statusEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private baudEl: HTMLInputElement;
  private connectBtn: HTMLButtonElement;
  private sendBtn: HTMLButtonElement;
  private connected = false;
  private disposers: (() => void)[] = [];

  constructor(
    private getSettings: () => Settings,
  ) {
    this.outputEl = document.getElementById("serial-output")!;
    this.statusEl = document.getElementById("serial-status")!;
    this.inputEl = document.getElementById("serial-input") as HTMLInputElement;
    this.baudEl = document.getElementById("serial-baud") as HTMLInputElement;
    this.connectBtn = document.getElementById("btn-serial-connect") as HTMLButtonElement;
    this.sendBtn = document.getElementById("btn-serial-send") as HTMLButtonElement;

    this.connectBtn.addEventListener("click", () =>
      this.connected ? this.disconnect() : this.connect(),
    );
    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.send();
      }
    });
    document.getElementById("btn-serial-clear")!.addEventListener("click", () => {
      this.outputEl.textContent = "";
    });
    this.updateButtons();
  }

  async listen() {
    this.disposers.push(
      await onEvent<string>("serial:data", (t) => this.append(t)),
      await onEvent("serial:closed", () => this.markClosed("port closed")),
    );
  }

  async connect() {
    const settings = this.getSettings();
    const port = settings.port;
    if (!port) {
      this.statusEl.textContent = "no port selected";
      return;
    }
    const baud = Number(this.baudEl.value) || 9600;
    this.connectBtn.disabled = true;
    this.statusEl.textContent = `connecting to ${port}…`;
    try {
      await serialOpen(port, baud);
      await writeSettings({ ...settings, baud });
      this.connected = true;
      this.statusEl.textContent = `${port} @ ${baud} baud`;
    } catch (err) {
      this.statusEl.textContent = `connect failed: ${err}`;
    }
    this.connectBtn.disabled = false;
    this.updateButtons();
  }

  async disconnect() {
    this.connectBtn.disabled = true;
    try {
      await serialClose();
      this.markClosed("closed");
    } catch {
      this.markClosed("close failed");
    }
    this.connectBtn.disabled = false;
  }

  private markClosed(msg: string) {
    this.connected = false;
    this.statusEl.textContent = msg;
    this.updateButtons();
  }

  private send() {
    const text = this.inputEl.value;
    if (!text || !this.connected) return;
    serialSend(text + "\n").catch((e) => this.append(`\r\n[send error: ${e}]\r\n`));
    this.append(`→ ${text}\r\n`);
    this.inputEl.value = "";
  }

  private append(text: string) {
    // Keep raw bytes readable; non-printable a→ '.'.
    let clean = "";
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      clean += c === 13 || c === 10 ? ch : c >= 32 && c < 127 ? ch : "\uFFFD";
    }
    const span = document.createElement("span");
    span.className = "out-stdout";
    span.textContent = clean;
    this.outputEl.appendChild(span);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private updateButtons() {
    this.connectBtn.textContent = this.connected ? "Disconnect" : "Connect";
    this.sendBtn.disabled = !this.connected;
    this.inputEl.disabled = !this.connected;
  }

  dispose() {
    for (const d of this.disposers) d();
  }
}