# Volt IDE

A lightweight, purpose-built desktop IDE for the **Volt** language — a
Python-syntax language that compiles to C for Arduino/AVR boards. Volt IDE
bundles the `voltc` compiler, so hobbyists can edit, compile, flash, and
monitor boards without leaving one app.

Built with **Tauri 2 (Rust)** + **React 18 / shadcn-ui (Tailwind)** +
**CodeMirror 6** — a single small desktop binary that reuses the OS webview,
with native `serialport` access, subprocess control of `voltc` / `arduino-cli`,
and Tauri updater + GitHub Releases for auto-update (see
`docs/architecture.md` for the full Stage 0 spec and decisions).

## Features

- **Editor:** Volt syntax highlighting, line numbers, auto-indent
  (indentation-sensitive), bracket matching, autocomplete for keywords and
  hardware modules (`Servo.Init(pin)`, `DigitalPin.OUTPUT`, …)
- **Projects:** open/save `.volt` files and folders; file-explorer sidebar
- **Compile:** runs voltc, streams output to a console panel, and reports
  inline gutter markers / underlines with error positions
- **Flash:** auto-detects boards/ports (via `arduino-cli`), then compiles and
  uploads over serial with `voltc.py upload`
- **Serial monitor:** live output window with an input box to send data back
- **Hardware sidebar:** lists `<Module>.Init(pin)` objects in the open file

## Requirements

- **Windows/macOS/Linux** desktop OS
- The AVR toolchain (avr-g++, avrdude) — Volt IDE auto-detects it from the
  Arduino install (e.g. `%LOCALAPPDATA%\Arduino15`), or you can override tool
  paths in the IDE settings.
- Python 3.x (for the bundled `voltc.py` compiler). `arduino-cli` is optional
  and improves board auto-detection.

## Development

```bash
# 1. Install the portable Node build in .tooling/ (or use a system Node).
#    Node is a BUILD-TIME dependency only; end users never need it.

# 2. Frontend deps + Vite dev server
cd app
npm install
npm run dev

# 3. Tauri backend (build & run the desktop app)
cd app/src-tauri
cargo run
```

### One-shot build & release

```bash
cd app
npm run tauri build            # debug -> release binary
npm run dist                   # release + installers (MSI/NSIS on Windows)
```

Artifacts land in `app/src-tauri/target/release/`.

## Repository layout

```
volt-ide/
  toolchain/            # bundled Volt compiler (voltc.py + src/volt/*)
    examples/           # blink.volt, servo_sweep.volt, serial_echo.volt
  app/
    src/                # TS frontend (editor, panels, explorer, serial)
    src-tauri/          # Rust backend (fs, compile/upload, serial, settings)
  docs/architecture.md  # Stage 0 spec + implementation status
```