import { StreamLanguage, StreamParser, LanguageSupport, indentService, indentUnit, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { keymap } from "@codemirror/view";
import { indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";

// Volt lexical grammar mirrored from toolchain/src/volt/tokens.py and
// toolchain/src/volt/modules.py.
const KEYWORDS = new Set([
  "func", "var", "if", "elif", "else", "while", "for", "return",
  "import", "in", "break", "continue",
  "module", "const", "not", "or", "and",
]);

/** Literal/boolean constants (`true`, `false`, `null`). */
export const CONSTANTS = new Set(["true", "false", "null"]);

const TYPES = new Set(["int", "float", "bool", "string"]);

const MODULES = new Set([
  "Arduino", "Servo", "DigitalPin", "AnalogPin", "Serial",
]);

const BUILTINS = new Set([
  "Delay", "DelayMicroseconds", "Millis", "Micros", "INPUT", "OUTPUT", "INPUT_PULLUP",
]);

/** Known module → method completions (mirrors volt/modules.py). */
export const MODULE_METHODS: Record<string, string[]> = {
  Arduino: ["Init()"],
  Servo: ["Init(pin)", "write(angle)", "read()", "attached()", "detach()"],
  DigitalPin: ["Init(pin, mode)", "write(value)", "read()"],
  AnalogPin: ["Init(pin)", "read()", "write(value)"],
  Serial: ["begin(baud)", "print(value)", "println(value)", "write(byte)", "available()", "read()"],
};

/** Known module constants that appear after `<Module>.`: `<Module>.NAME`. */
export const MODULE_CONSTANTS: Record<string, string[]> = {
  DigitalPin: ["INPUT", "OUTPUT", "INPUT_PULLUP"],
};

/** Doc types describing the language for the file explorer filtering. */
export const VOLT_EXTENSION = "volt";

interface VoltState {
  lineStart: boolean;
  afterModule: boolean; // last significant token was a hardware module name
  afterDot: boolean;    // last token was '.'
  afterFunc: boolean;   // last keyword token was `func` (next ident is a def name)
}

const voltParser: StreamParser<VoltState> = {
  name: "volt",

  startState() {
    return { lineStart: true, afterModule: false, afterDot: false, afterFunc: false };
  },

  token(stream, state) {
    // Indentation (only meaningful at line start).
    if (stream.sol()) {
      if (stream.eatSpace()) {
        state.lineStart = true;
        return null;
      }
      state.lineStart = false;
    }

    // Line comment `// ...`
    if (stream.match("//")) {
      state.afterModule = false;
      state.afterDot = false;
      stream.skipToEnd();
      return "comment";
    }

    // String literal "..." with escapes
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
      state.afterModule = false;
      state.afterDot = false;
      return "string";
    }

    // Number literal (int or float)
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?/)) {
      state.afterModule = false;
      state.afterDot = false;
      return "number";
    }

    // Member access after a module / handle: `<Module>.Init(...)`,
    // `<Module>.OUTPUT`, `<handle>.write(...)`
    if (stream.match(".")) {
      state.afterDot = true;
      return "operator";
    }

    // Identifier / keyword / type / module
    const m = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (typeof m === "object" && m !== null) {
      const word = m[0];
      let tag: string | null = "variableName";
      if (state.afterDot) {
        // Member access after `<Module>.`: constants for known `<Module>.NAME`,
        // methods (Init/write/...) as hardware function calls.
        if (state.afterModule) {
          tag = Object.values(MODULE_CONSTANTS).some((cs) => cs.includes(word))
            ? "constant"
            : "namespace";
        } else {
          tag = "function";
        }
      } else if (state.afterFunc) {
        // `func name():` — the identifier after `func` is the function name.
        tag = "function";
      } else if (CONSTANTS.has(word)) {
        tag = "constant";
      } else if (KEYWORDS.has(word)) {
        tag = "keyword";
        // `func` declares a function; the next identifier is its def name.
        // Early-return so the afterFunc flag survives the bottom reset.
        if (word === "func") {
          state.afterModule = false;
          state.afterDot = false;
          return tag;
        }
      } else if (TYPES.has(word)) {
        tag = "typeName";
      } else if (MODULES.has(word)) {
        tag = "namespace";
        state.afterModule = true;
        return tag;
      } else if (BUILTINS.has(word)) {
        tag = "builtin";
      }
      state.afterModule = false;
      state.afterFunc = false;
      state.afterDot = false;
      return tag;
    }

    // Operators & punctuation
    if (stream.match(/^(==|!=|<=|>=|\&\&|\|\||->|:=)/)) {
      state.afterDot = false;
      return "operator";
    }
    if (stream.match(/^[+\-*/%=<>!]/)) {
      state.afterDot = false;
      return "operator";
    }
    if (stream.match(/^[\.,;\[\]\(\)]/)) {
      state.afterDot = false;
      return "punctuation";
    }
    if (stream.match(/^[{}]/)) {
      state.afterDot = false;
      return "bracket";
    }

    stream.next();
    state.afterDot = false;
    return null;
  },
};

/**
 * Volt is indentation-sensitive (like Python). These indentation rules make a
 * fresh line one unit deeper after a header line ending in ':', and dedent a
 * line that starts with `else`/`elif` back to the starting keyword's level.
 * Tabs are folded into the configured unit (4 spaces) by `indentWithTab`.
 */
const voltIndent = indentService.of((context, pos) => {
  const unit = context.unit;
  const line = context.state.doc.lineAt(pos);
  const indentOf = (text: string) => /^\s*/.exec(text)![0].length;
  const blank = /^\s*$/.test(line.text);

  // Previous non-blank line.
  let prevIdx = line.number - 1;
  while (prevIdx >= 1) {
    const prev = context.state.doc.line(prevIdx);
    if (!/^\s*$/.test(prev.text)) break;
    prevIdx--;
  }

  if (prevIdx < 1 && blank) return 0;
  const prev = context.state.doc.line(Math.max(1, prevIdx));

  // Blank new line being completed after an existing line: adopt the
  // previous line's level, bumped up after a header line ending in ':'.
  if (blank) {
    if (/:\s*(\/\/.*)?$/.test(prev.text)) return indentOf(prev.text) + unit;
    return indentOf(prev.text);
  }

  // Non-blank line (Ctrl-]/_ or explicit reindent): keep its own or the
  // previous line's indent, minus one unit for else/elif.
  const own = indentOf(line.text);
  const base = indentOf(prev.text);
  if (/^(else|elif)\b/.test(line.text.trimStart())) {
    return Math.max(0, base - unit);
  }
  if (/:\s*(\/\/.*)?$/.test(prev.text) && own <= base) {
    return base + unit;
  }
  return Math.max(own, base);
});

/** CodeMirror keymap giving Volt Python-style behavior (Tab indents). */
export const voltKeymap = keymap.of([
  indentWithTab,
  { key: "Enter", run: insertNewlineAndIndent },
  { key: "Shift-Enter", run: insertNewlineAndIndent },
]);

/**
 * Volt editor theme — maps the brief's Section 4 token color list onto a
 * CodeMirror `HighlightStyle` (not inline regex styling). Applied as part of
 * the language definition so the grammar and its colors ship together.
 */
export const voltTheme = HighlightStyle.define([
  { tag: tags.keyword, color: "#7B61FF", fontWeight: "600" },
  { tag: tags.namespace, color: "#E3A15B", fontWeight: "600" },
  { tag: tags.function(tags.name), color: "#61AFEF" },
  { tag: tags.string, color: "#A3E635" },
  { tag: tags.number, color: "#F5A97F" },
  { tag: tags.comment, color: "#5C6370", fontStyle: "italic" },
  { tag: tags.operator, color: "#ABB2BF" },
  { tag: tags.variableName, color: "#D8DCEE" },
  { tag: tags.typeName, color: "#56B6C2" },
  { tag: tags.bool, color: "#D19A66" },
  { tag: tags.constant(tags.name), color: "#D19A66" },
  { tag: tags.standard(tags.name), color: "#A9B8FF" },
]);

/** Language support for Volt: grammar (highlighting) + indentation + theme. */
export function voltLanguage(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(voltParser), [
    syntaxHighlighting(voltTheme),
    voltIndent,
    indentUnit.of("    "),
    voltKeymap,
  ]);
}

/** Keywords/types/modules/builtins used for autocomplete & highlighting. */
export const voltKeywords = [
  ...KEYWORDS,
  ...CONSTANTS,
  ...TYPES,
  ...MODULES,
  ...BUILTINS,
].sort();