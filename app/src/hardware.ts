/**
 * Hardware objects sidebar (Stage 7). Scans the editor document for
 * `<Module>.Init(...)` / `<handle> = <Module>.Init(...)` calls and lists
 * module type + pin, updating live as the user edits.
 */

export interface HardwareObject {
  line: number;
  module: string;
  pin: number | null;
  extras: string[];
}

const MODULE_PIN_POS: Record<string, number> = {
  Servo: 0,
  DigitalPin: 0,
  AnalogPin: 0,
  Arduino: -1, // no pin
};

export function parseHardware(source: string): HardwareObject[] {
  const objects: HardwareObject[] = [];
  const lines = source.split(/\r?\n/);
  const re = /(\bArduino|Servo|DigitalPin|AnalogPin)\.(Init)\s*\(([^)]*)\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only tail after the call: strip `//...`
    const code = line.replace(/\/\/.*$/, "");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const module = m[1];
      const pinIdx = MODULE_PIN_POS[module];
      const args = m[3].split(",").map((a) => a.trim());
      let pin: number | null = null;
      if (pinIdx >= 0 && args[pinIdx] !== undefined) {
        const n = Number(args[pinIdx]);
        if (Number.isInteger(n)) pin = n;
      }
      objects.push({ line: i + 1, module, pin, extras: args });
    }
  }
  return objects;
}

export class HardwarePanel {
  private listEl: HTMLElement;
  private lastSource = "";

  constructor() {
    this.listEl = document.getElementById("hardware-list")!;
  }

  update(source: string) {
    if (source === this.lastSource) return;
    this.lastSource = source;
    const items = parseHardware(source);
    if (items.length === 0) {
      this.listEl.innerHTML = `<div class="explorer-muted">No hardware found yet.</div>`;
      return;
    }
    this.listEl.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "hw-item";

      const info = document.createElement("div");
      const name = document.createElement("span");
      name.className = "hw-module";
      name.textContent = it.module;
      const line = document.createElement("span");
      line.className = "hw-line";
      line.textContent = `  line ${it.line}`;
      info.append(name, line);

      const pin = document.createElement("span");
      pin.className = "hw-pin";
      pin.textContent = it.pin !== null ? `pin ${it.pin}` : "—";

      row.append(info, pin);
      this.listEl.appendChild(row);
    }
  }

  clear() {
    this.lastSource = "";
    this.listEl.innerHTML = `<div class="explorer-muted">No hardware found yet.</div>`;
  }
}