import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { autocompletion } from "@codemirror/autocomplete";
import { linter, Diagnostic, setDiagnostics } from "@codemirror/lint";
import { searchKeymap, search } from "@codemirror/search";

import { voltLanguage, voltKeywords, MODULE_METHODS } from "./volt/lang";
import { checkSource, Settings, Diagnostic as VoltDiagnostic } from "./api";

export type LintCallback = (diagnostics: Diagnostic[]) => void;

/**
 * Create the Volt editor with highlighting, indentation, autocomplete,
 * bracket matching (from basicSetup), and a lint source that reports
 * inline gutter markers + underlines from voltc.
 */
export function createEditor(
  container: HTMLElement,
  opts: {
    settings: () => Settings;
    onChange: (doc: string) => void;
    onLint?: (counts: { errors: number; warnings: number }) => void;
    onCursor?: (line: number, col: number) => void;
  },
): EditorView {
  // Volatile capability: debounce lint requests so typing doesn't spam
  // the compiler process.
  let lintTimer: ReturnType<typeof setTimeout> | undefined;
  const lintExt = linter(
    async (view) => {
      if (lintTimer) clearTimeout(lintTimer);
      return new Promise<Diagnostic[]>((resolve) => {
        lintTimer = setTimeout(async () => {
          try {
            const result = await checkSource(
              view.state.doc.toString(),
              "editor.volt",
              opts.settings(),
            );
            const counts = { errors: 0, warnings: 0 };
            for (const d of result.diagnostics) {
              if (d.severity === "error") counts.errors++;
              else counts.warnings++;
            }
            opts.onLint?.(counts);
            resolve(positionDiagnostics(view, result.diagnostics));
          } catch {
            resolve([]);
          }
          lintTimer = undefined;
        }, 400);
      });
    },
    { delay: 200 },
  );

  // Autocomplete: keywords + module methods after a dot, module names elsewhere.
  const completionExt = autocompletion({
    override: [
      (context) => {
        const before = context.state.sliceDoc(context.pos - 30, context.pos);
        // Member completion after `<Module>.`
        const memberMatch = before.match(/([A-Za-z_]\w*)\.([A-Za-z_]*)$/);
        if (memberMatch) {
          const moduleName = memberMatch[1];
          const methods = MODULE_METHODS[moduleName];
          if (methods) {
            const partial = memberMatch[2];
            const options = methods
              .filter((m) => m.startsWith(partial))
              .map((m) => ({
                label: m,
                type: "method",
                apply: m,
              }));
            return {
              from: context.pos - partial.length,
              options,
            };
          }
        }
        const wordMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
        const partial = wordMatch ? wordMatch[1] : "";
        const options = voltKeywords
          .filter((k) => k.startsWith(partial))
          .map((k) => ({
            label: k,
            type: MODULE_METHODS[k] ? "module" : "keyword",
            apply: k,
          }));
        return { from: context.pos - partial.length, options };
      },
    ],
  });

  const state = EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      keymap.of(searchKeymap),
      search(),
      voltLanguage(),
      lintExt,
      completionExt,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          opts.onChange(update.state.doc.toString());
        }
        if (opts.onCursor && (update.docChanged || update.selectionSet)) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          opts.onCursor(line.number, head - line.from + 1);
        }
      }),
    ],
  });

  return new EditorView({ state, parent: container });
}

/**
 * CodeMirror diagnoses are position-based. We only get line/col from voltc,
 * so map them onto the current document.
 */
function positionDiagnostics(view: EditorView, diags: VoltDiagnostic[]): Diagnostic[] {
  const doc = view.state.doc;
  return diags.map((d) => {
    const safeLine = Math.min(Math.max(d.line, 1), doc.lines);
    const line = doc.line(safeLine);
    const from = line.from + Math.min(d.col - 1, line.length);
    const to = Math.min(from + 1, line.to);
    return {
      from,
      to,
      severity: d.severity,
      message: d.message,
      source: "voltc",
    };
  });
}

export function clearLint(view: EditorView) {
  view.dispatch(setDiagnostics(view.state, []));
}

export function editorText(view: EditorView): string {
  return view.state.doc.toString();
}

export function replaceText(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

/** Base editor font size (px) used to compute zoom percentages. */
export const BASE_FONT_SIZE = 14;

/**
 * Set the editor font size and return the resulting zoom percentage
 * (relative to BASE_FONT_SIZE). Used by Ctrl/Cmd +/-/0 and Ctrl+scroll.
 */
export function setEditorFontSize(view: EditorView, px: number): number {
  const el = view.dom.querySelector(".cm-editor") as HTMLElement | null;
  if (el) el.style.fontSize = `${px}px`;
  return Math.round((px / BASE_FONT_SIZE) * 100);
}

/**
 * Move the cursor to `line:col` (1-based) and scroll it into view.
 * Used by clickable console errors that should jump the editor.
 */
export function jumpToPosition(view: EditorView, line: number, col: number) {
  const doc = view.state.doc;
  const safeLine = Math.min(Math.max(line, 1), doc.lines);
  const lineInfo = doc.line(safeLine);
  const pos = lineInfo.from + Math.min(Math.max(col - 1, 0), lineInfo.length);
  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}