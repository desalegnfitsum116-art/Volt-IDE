# Volt IDE — Stage 0: Tech Stack & Architecture Spec

**Status:** Proposed — this is the Stage 0 deliverable. No application code is
written yet; this document only decides and justifies the stack.
**Date:** 2026-08-12
**Repo:** https://github.com/desalegnfitsum116-art/Volt-IDE.git

---

## 1. Goal Recap

A lightweight, purpose-built desktop IDE for the **Volt** language (Python-like
syntax compiling to C for Arduino/AVR). The kit: a dark-navy, shadcn-themed
editor with Volt syntax highlighting, file/tab management, compile + output
console with clickable errors, board/port detection, upload-to-board, serial
monitor, hardware-object sidebar, zoom, quality-of-life features, and
auto-update — visual identity matching the Volt lightning-bolt brand.

---

## 2. Tech Stack Decision

| Concern | Choice | Justification |
|---|---|---|
| App framework | **Tauri 2 (Rust)** | Bundle ~5–15 MB vs Electron ~150–250 MB; native `serialport` crate; Rust owns subprocess control (voltc/avrdude/arduino-cli), serial, updater — no JS security surface for native ops. Already proven on this machine. |
| UI framework | **React 18 + Vite + TypeScript** | shadcn/ui is a React component library (Radix primitives + Tailwind). React gives the declarative component model shadcn's `cn()`/variants expect. |
| Component library | **shadcn/ui (Radix + Tailwind)** | Brief-mandated. CSS-variable token theming maps the Volt palette onto shadcn's standard tokens so Button/Tabs/Dialog/DropdownMenu/Tooltip/Toast/Resizable all inherit the theme. |
| Styling | **Tailwind CSS 4** | Used by shadcn's theming model; `@theme`/CSS-variable tokens. Single default **dark** theme (v1). |
| Editor component | **CodeMirror 6** | Lightweight and purpose-built; first-class custom language modes, `HighlightStyle` theme, lint gutters, autocomplete, bracket matching, indentation. Monaco is VS Code-weight. Keeps the app "minimal tool", not a general IDE. |
| App shell language | **React/TS (renderer)** + **Rust (native)** | TS owns the UI; Rust owns processes + serial + fs + settings + updates. |
| voltc/avrdude I/O | External process spawn from Rust, streamed to UI over Tauri events | Same model as the CLI; zero in-process coupling; easy to debug. |
| Auto-update | **Tauri updater** (`tauri-plugin-updater`, Rust-side), **GitHub Releases** as source | Official, native, signed (minisign); supports silent background download + restart prompt. GitHub Releases on this repo per brief §7. |

### 2.1 Why Tauri over Electron

1. **Bundle size (brief-required factor).** Electron ships Chromium (~150–250
   MB). Tauri reuses the OS webview (WebView2 / WebKitGTK / WKWebView) and
   ships a ~5–15 MB binary. Icon/assets stay inside one small package.
2. **Native performance.** Compile/flash/serial is I/O-bound shelling out, so
   backend perf barely matters — but Rust + `tokio` + `tauri::Emitter` make
   long-lived streams (compiler logs, serial rx, updater progress) cleaner
   than Node's callback glue and with no GC pauses.
3. **Serial-port access.** The Rust `serialport` crate is mature and
   cross-platform (Windows/macOS/Linux). No `node-serialport` ABI rebuilds
   against each Electron version.
4. **Updater fits the stack.** `tauri-plugin-updater` (Rust) + minisign
   signing + GitHub Releases is the canonical Tauri path; no extra
   `electron-updater` + code-sign dance for the same feature set.
5. **Toolchain already present.** Rust `1.97.1`/`cargo` are installed and the
   backend already compiles; the portable Node build is already vendored for
   frontend builds only.

### 2.2 Why shadcn/ui + Tailwind (React)

The brief mandates "shadcn/ui (Radix primitives + Tailwind CSS)". shadcn is a
React+Tailwind library whose theming approach is CSS variables referenced by
its own components (`--background`, `--foreground`, `--primary`, `--muted`,
`--destructive`, `--border`, …). We therefore adopt React 18:

- **Theming by token, not one-off styles.** Every shadcn component (Button,
  Tabs, Dialog, DropdownMenu, Tooltip, Toast, Resizable) reads the same CSS
  variables; we map §1's palette onto those tokens and get a coherent brand
  skin for free.
- **Arduino-IDE-like resizable layout.** shadcn's `ResizablePanelGroup` gives
  draggable sidebar/editor/console splits with minimal code.
- **Subtle rounding.** shadcn defaults to `rounded-md` — a precision tool look,
  matching the brief.

**Justification vs the existing vanilla-TS frontend:** the current tree was an
earlier hand-rolled CSS shell. The brief now mandates shadcn/ui as the
component foundation, so Stage 1 re-platforms the renderer onto
React+Tailwind+shadcn. The existing **Rust command surface** (fs, compile,
upload, serial, board detection, settings) is architecturally sound and is
**kept and reused** — only the renderer is rebuilt. This avoids redoing proven
native code while satisfying the new UI mandate.

### 2.3 Why CodeMirror 6 over Monaco

- **Purpose-built & minimal** (brief: not a heavyweight IDE). Monaco is the VS
  Code editor — far heavier and opinionated.
- CM6 gives exactly what v1 needs as first-class APIs: a Volt `StreamParser`
  (`volt/lang.ts`), a `HighlightStyle` theme mapping §4's Volt token colors,
  `@codemirror/lint` for inline gutter/underline errors, `@codemirror/search`
  for find/replace, bracket matching, indentation, and `EditorView` font-size
  zoom for §5.
- React wrapper is a thin component around `EditorView`; no heavy bindings.

### 2.4 Auto-update choice — Tauri updater + GitHub Releases

| Concern | Choice |
|---|---|
| Mechanism | `tauri-plugin-updater` (Rust) with minisign public-key verification |
| Update source | GitHub Releases on this repo (`Volt-IDE`), serving signed `.tar.gz`/`sig` assets per platform |
| Check cadence | On launch (silent, non-blocking); manual **Check for Updates** menu item too |
| Download behavior | Background download when available; non-intrusive Toast prompting restart-to-apply |
| Changelog | "What's new" snippet shown on apply, sourced from the release notes |

Signing keys are generated in Stage 8 and the public key is committed to the
repo; the private key stays out of the repo (documented in the release
playbook).

---

## 3. Visual Identity → shadcn Token Mapping

Volt palette (§1) mapped onto shadcn's standard CSS-variable tokens. Here
`--primary` is the electric **`#7B61FF`**, the whole app is dark navy, and the
hardware copper accent is a custom token used only by hardware surfaces.

| shadcn token(s) | Hex | Volt brand usage |
|---|---|---|
| `--background` | `#0B0F1D` | App + editor background |
| `--card`, `--sidebar`, `--secondary`, `--muted/background`-adjacent | `#141A2E` | Panels, sidebar, toolbar, tab bar |
| `--popover`, `--popover-foreground`, dialogs | `#1B2238` | Dialogs, dropdowns, popovers |
| `--border`, `--input`, `--ring`-adjacent | `#232A45` | Panel dividers, input borders |
| `--foreground` | `#D8DCEE` | Default text |
| `--muted-foreground` | `#7A82A6` | Secondary text, disabled, line numbers |
| `--primary`, `--ring` (focus) | `#7B61FF` | Buttons, active tabs, focus rings, primary actions |
| `--accent`-foreground/hover | `#A9B8FF` | Hover states, highlights, logo glow |
| `--destructive` | `#F87171` | Errors, inline underlines, failed upload |
| `--warning` (custom) | `#FBBF24` | Compiler warnings |
| `--success` (custom) | `#4FD1C5` | Successful compile/upload, connected board |
| `--hardware` (custom) | `#E3A15B` | Hardware object sidebar, board/pin indicators, hardware tokens |

Custom tokens (`--warning`, `--success`, `--hardware`) are exposed as Tailwind
colors (`warning-*`, `success-*`, `hardware-*`) via the shadcn token bridge so
both shadcn components and hand-placed elements (status dot, hardware rows,
console severity text) share exact values.

---

## 4. Editor Token Color List → CodeMirror HighlightStyle

Applied as a proper CM6 `HighlightStyle` (part of the Volt language/theme
definition — **not** inline regex styling):

| Volt token | Example | Hex | CodeMirror tag |
|---|---|---|---|
| Keywords | `def if elif else while for return import` | `#7B61FF` | `keyword` |
| Hardware module calls | `Arduino.Init()`, `Servo.Init(5)` | `#E3A15B` | `namespace` (copper) |
| Function names | `def sweep():` → `sweep` | `#61AFEF` | `function(special)` |
| Strings | `"hello"` | `#A3E635` | `string` |
| Numbers | `90`, `0.5` | `#F5A97F` | `number` |
| Comments | `// like this` | `#5C6370` italic | `comment` |
| Operators | `= + - * / == <` | `#ABB2BF` | `operator` |
| Variables | `myServo` | `#D8DCEE` | `variableName` |
| Booleans/constants | `true false` | `#D19A66` | `bool`, `constant` |

Hardware module identifiers (`Arduino`, `Servo`, `DigitalPin`, `AnalogPin`,
`Serial`) are emitted as `namespace` from the StreamParser so they get the
copper `#E3A15B` treatment and visually pop from ordinary calls (brief §4).

---

## 5. Architecture Diagram

```
┌──────────────────────────── Desktop window (one OS process) ─────────────────────────────┐
│                                                                                          │
│  ┌───────────────────────────── WebView: React 18 + Vite ───────────────────────────┐    │
│  │  shadcn/ui (Tailwind tokens)                                                     │    │
│  │                                                                                  │    │
│  │  Toolbar: Verify · Upload · Board▾ · Port▾ · status dot                          │    │
│  │  ResizablePanelGroup:                                                            │    │
│  │    ├─ Explorer sidebar           │ tabs(file.volt) + CodeMirror 6 │ Hardware sidebar│   │
│  │    └─ bottom console (Tabs: Output | Serial Monitor)                            │    │
│  │  Status bar: Ln/Col · Zoom % · Board (Port)                                        │    │
│  └───────────────▲─────────────────────────────────────────┬──────────────────────────┘    │
│                  │ invoke()/events (allow-listed IPC)      │                              │
│  ┌───────────────▼─────────────────────────────────────────▼──────────────────────────┐  │
│  │                          Tauri main (Rust)                                          │  │
│  │  Commands: fs(read/write/list) · compile · upload · detect_boards ·                 │  │
│  │            serial(open/send/close) · settings · update(check/download/install)     │  │
│  │  Workers:  spawn voltc 🡒 stream · spawn arduino-cli/avrdude 🡒 stream ·              │  │
│  │            serialport rx (tokio) 🡒 emit · updater check 🡒 toast                    │  │
│  └───────────────┬──────────────────────────────────────────────────────────────────┘  │
│                  │  subprocesses (CREATE_NO_WINDOW on Windows)                          │
│                  ├──► python toolchain/voltc.py build|upload …                          │
│                  ├──► arduino-cli board list (detection)                                │
│                  └──► serialport device (board USB-UART)                                │
└──────────────────┼──────────────────────────────────────────────────────────────────────┘
                   └──► GitHub Releases (Volt-IDE) — signed update artifacts
```

Data/process flows:

| Flow | Path |
|---|---|
| Open/save/tabs | Renderer ⇄ `fs` commands (OS dialogs via `tauri-plugin-dialog`) |
| Verify | Renderer → Rust → `python voltc.py build` → `compile:output` events → console + clickable errors |
| Upload | Renderer → Rust → `python voltc.py upload -p PORT` → `upload:*` events |
| Board detect | Renderer → Rust → `arduino-cli board list --format json` (+ `serialport` fallback) → selectors, live on connect/disconnect (Stage 7) |
| Serial monitor | Rust owns `serialport`; rx thread → `serial:data`; input → `serial:send` |
| Hardware sidebar | Renderer parses buffer for `(\w+)\.Init\((arg)\)` (copper theme) |
| Zoom | Renderer `EditorView` font-size × defaultTheme override; % in status bar |
| Update | Rust `tauri-plugin-updater` → GitHub Releases → toast on ready |

---

## 6. Auto-Update Design

- **Library:** `tauri-plugin-updater` enabled in the Rust `Builder`.
- **Endpoints:** releases on this repo provide `Volt-IDE_{version}_x64-setup.exe`
  (+ `.sig`) for Windows and equivalent per-platform artifacts, plus the
  updater metadata file, all signed with minisign.
- **Runtime behavior:**
  1. Launch → background check (silent; never blocks startup).
  2. If update available → begin download in background; show progress in
     status bar; on completion show a non-intrusive **Toast** ("Update ready —
     restart to apply").
  3. In-app menu action **Check for Updates** triggers the same flow manually.
  4. On apply/restart, show version number + "what's new" changelog snippet
     from the release notes.
- **Signing:** minisign keypair generated in Stage 8. Public key committed;
   private key stored out-of-repo and documented in `RELEASING.md`.

---

## 7. Project Layout (plan for Stages 1–9)

```
volt-ide/
  toolchain/           bundled Volt compiler: voltc.py  src/volt/*  examples/
  app/
    src-tauri/         Rust backend (reused): src/commands/*, settings.rs, serial.rs
      tauri.conf.json  window + updater config (+ signing pubkey at Stage 8)
      capabilities/
    src/               React 18 + Vite renderer (rebuilt from Stage 1)
      components/ui/   shadcn components (button, tabs, dialog, dropdown, tooltip, toast, resizable)
      components/      Toolbar, Explorer, Editor (CodeMirror), HardwareSidebar, Console, SerialPanel
      lib/             utils (cn), hooks, api.ts (invoke wrappers), settings.ts
      volt/            lang.ts (StreamParser) + theme.ts (HighlightStyle) + completions.ts
      styles/          globals.css with shadcn tokens (Volt palette)
    index.html  package.json  vite.config.ts  tailwind.config.json(→ CSS)  tsconfig.json
  docs/                architecture.md (this spec), STAGES.md, RELEASING.md
  .github/workflows/   release workflow producing signed artifacts (Stage 8)
  .gitignore  README.md
```

---

## 8. Security Model

- All native capability gated behind Tauri v2 commands + capabilities; the
  webview never gains arbitrary shell access — only the allow-listed
  `voltc.py build|upload`, `arduino-cli board list`, serial I/O, fs helpers,
  settings, and updater calls.
- Spawned-process arguments built in Rust from validated inputs; ports
  validated against the enumerated device list.
- Updater artifacts verified against the committed minisign public key; no
  unsigned payloads install.
- Windows console suppression (`CREATE_NO_WINDOW`) on every spawned tool so no
  terminal windows flash while typing/linting.

---

## 9. Decisions & Assumptions (tell me if you disagree)

1. **Render to React 18 + Tailwind 4 + shadcn/ui** for the renderer (mandated
   by §2), re-platforming away from the current vanilla-TS shell. The Rust
   command surface is reused unchanged.
2. **Editor = CodeMirror 6** (Minimal over Monaco).
3. **Auto-update = `tauri-plugin-updater` + GitHub Releases + minisign.**
4. **Dark theme only for v1** (per §1). No light theme.
5. **Board detection = `arduino-cli board list --format json`** primary with
   `serialport` fallback; live connect/disconnect via polling re-scan on
   launch + interval + after upload (Stage 7 refines to device-change events
   where feasible).
6. **Verify = `voltc.py build`**; **Upload = `voltc.py upload -p PORT`**
   (build + avrdude in one), matching the existing CLI surface.
7. **Zoom via `EditorView` font-size override; percentage persisted per
   session** in-memory (both allowed by §5).
8. **Keyboard defaults:** Ctrl+Enter = Verify, Ctrl+Shift+Enter or Ctrl+U =
   Upload; Ctrl+S save; Ctrl+F/H find & replace; Ctrl+/= zoom. (Assumption;
   refinable per stage.)
9. Existing prior-stage artifacts (BOM, toolchain copy) stay put; the
   toolchain is the bundled compiler the IDE shells out to.
10. Proof-of-run platform: **Windows** (WebView2 present).

### Risks & mitigations
- **React re-platform churn** → renderer is rebuilt fresh per-stage while the
  Rust surface is stable; CM6 React wrapper is a thin component, low risk.
- **Tailwind 4 vs shadcn tokens** → shadcn v4 supports Tailwind 4 via CSS
  `@theme`; pin versions in lockfiles.
- **Auto-update signing** → minisign is offline-capable; keys generated in
  Stage 8 with a committed public key; private key handled carefully.
- **Webview variance across OSes** → dependency-free renderer, per-OS QA in
  Stage 9.

---

## 10. Staged Plan (brief §8) with Git gates

| Stage | Deliverable | Git gate |
|---|---|---|
| 0 | This spec, pushed | ✅ this commit |
| 1 | React + shadcn shell with Volt palette, empty layout, status bar | push |
| 2 | CodeMirror 6 + Volt syntax/theme (§4) | push |
| 3 | FS explorer, tabs, open/save, DnD, recent files | push |
| 4 | Verify + output console with clickable errors | push |
| 5 | Board/port + Upload + Hardware sidebar | push |
| 6 | Serial monitor | push |
| 7 | Zoom (§5) + QoL (§6) incl. live board scan, crash recovery | push |
| 8 | Auto-update (§7) + menu + changelog | push |
| 9 | Icon, installers, visual QA vs palette | push |

Each stage ends only after its commit is pushed and verified per Ground Rules.

---

**Stage 0 complete — pushed to repo — awaiting approval to proceed.**