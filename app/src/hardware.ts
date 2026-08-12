/**
 * Hardware objects sidebar (Stage 5). Scans the editor document for
 * `<handle> = <Module>.Init(...)` / `<Module>.Init(...)` calls and lists
 * module type + pin, updating live as the user edits. Clicking an item
 * jumps the editor to that hardware object's line.
 */

export interface HardwareObject {
  line: number;
  module: string;
  pin: number | null;
  extras: string[];
  /** Optional variable handle, e.g. `myServo` in `myServo = Servo.Init(5)`. */
  handle: string | null;
}

const MODULE_PIN_POS: Record<string, number> = {
  Servo: 0,
  DigitalPin: 0,
  AnalogPin: 0,
  Arduino: -1, // no pin
};

/**
 * Parse hardware objects from Volt source. Matches both bare module
 * initializers (`Servo.Init(5)`) and handle initializers
 * (`myServo = Servo.Init(5)`), skipping comment tails per line.
 */
export function parseHardware(source: string): HardwareObject[] {
  const objects: HardwareObject[] = [];
  const lines = source.split(/\r?\n/);
  const re = /(?:(\w+)\s*=\s*)?(\bArduino|Servo|DigitalPin|AnalogPin)\.(Init)\s*\(([^)]*)\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only tail after the call: strip `//...`
    const code = line.replace(/\/\/.*$/, "");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const handle = m[1] ?? null;
      const module = m[2];
      const pinIdx = MODULE_PIN_POS[module];
      const args = m[4].split(",").map((a) => a.trim());
      let pin: number | null = null;
      if (pinIdx >= 0 && args[pinIdx] !== undefined) {
        const n = Number(args[pinIdx]);
        if (Number.isInteger(n)) pin = n;
      }
      objects.push({ line: i + 1, module, pin, extras: args, handle });
    }
  }
  return objects;
}

export class HardwarePanel {
  private listEl: HTMLElement;
  private lastSource = "";
  private onJump: (line: number) => void = () => {};

  constructor() {
    this.listEl = document.getElementById("hardware-list")!;
  }

  /** Register a handler invoked when the user clicks a hardware item. */
  setJumpHandler(fn: (line: number) => void) {
    this.onJump = fn;
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
      row.title = `Click to jump to line ${it.line}`;
      row.addEventListener("click", () => this.onJump(it.line));

      const info = document.createElement("div");
      info.className = "hw-info";

      const name = document.createElement("span");
      name.className = "hw-module";
      name.textContent = it.module;

      const pin = document.createElement("span");
      pin.className = "hw-pin";
      pin.textContent = it.pin !== null ? `Pin ${it.pin}` : "—";

      info.append(name, pin);
      row.append(info);

      if (it.handle) {
        const handle = document.createElement("span");
        handle.className = "hw-handle";
        handle.textContent = it.handle;
        row.append(handle);
      }

      const line = document.createElement("span");
      line.className = "hw-line";
      line.textContent = `line ${it.line}`;
      row.append(line);

      this.listEl.appendChild(row);
    }
  }

  clear() {
    this.lastSource = "";
    this.listEl.innerHTML = `<div class="explorer-muted">No hardware found yet.</div>`;
  }
}