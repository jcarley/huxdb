// The tooltip inside a function call: its overloads, with the current argument marked.
// State derived from the editor, as CodeMirror's tooltips are declarative.

import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import type { CatalogFunction } from "../../lib/types";
import { findFunctions } from "./catalogIndex";
import type { CatalogIndex } from "./catalogIndex";
import { callAtCursor } from "./sqlScope";

const MAX_OVERLOADS = 6;

export interface Signature {
  /** Where the `(` is. */
  open: number;
  name: string;
  /** Input arguments, one line per overload. */
  overloads: { parameters: string[]; result?: string }[];
  /** How many more there are than `overloads` shows. */
  hidden: number;
  argument: number;
}

/** Splits `pg_get_function_arguments` at its top-level commas: a default can hold
 * commas, in quotes or a call. OUT arguments aren't passed, so they're left out. */
export function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "(" || c === "[") {
      depth++;
    } else if (c === ")" || c === "]") {
      depth--;
    } else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts.filter((part) => !/^(OUT|TABLE)\b/.test(part));
}

const accepts = (fn: CatalogFunction, argument: number) => fn.variadic || argument < fn.maxArgs || (argument === 0 && fn.maxArgs === 0);

/** Those that can take this many arguments, or all of them if none can, so a
 * mistake still shows what the function takes. Shortest first. */
export function pickOverloads(overloads: CatalogFunction[], argument: number): CatalogFunction[] {
  const fitting = overloads.filter((fn) => accepts(fn, argument));
  return [...(fitting.length > 0 ? fitting : overloads)].sort((a, b) => a.maxArgs - b.maxArgs);
}

export function signatureAt(state: EditorState, index: CatalogIndex): Signature | null {
  const { main } = state.selection;
  if (!main.empty) return null;
  const call = callAtCursor(syntaxTree(state), (from, to) => state.sliceDoc(from, to), main.head);
  if (!call) return null;
  const overloads = findFunctions(index, call.path);
  if (overloads.length === 0) return null;
  const picked = pickOverloads(overloads, call.argument);
  return {
    open: call.open,
    name: overloads[0].name,
    overloads: picked.slice(0, MAX_OVERLOADS).map((fn) => ({ parameters: splitArguments(fn.arguments), result: fn.result })),
    hidden: Math.max(0, picked.length - MAX_OVERLOADS),
    argument: call.argument,
  };
}

function render({ name, overloads, hidden, argument }: Signature): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-signature";
  for (const { parameters, result } of overloads) {
    const line = dom.appendChild(document.createElement("div"));
    line.append(`${name}(`);
    parameters.forEach((parameter, i) => {
      if (i > 0) line.append(", ");
      // A variadic argument takes every argument from its place on.
      const current = i === argument || (i === parameters.length - 1 && argument > i && parameter.startsWith("VARIADIC"));
      if (!current) {
        line.append(parameter);
        return;
      }
      line.appendChild(document.createElement("strong")).textContent = parameter;
    });
    line.append(result ? `) → ${result}` : ")");
  }
  if (hidden > 0) dom.appendChild(document.createElement("div")).textContent = `+${hidden} more`;
  return dom;
}

const dismiss = StateEffect.define<number>();

interface HelpState {
  tooltip: Tooltip | null;
  /** What it was built from, so typing inside an argument doesn't rebuild it. */
  key: string;
  /** The `(` that Escape dismissed: closed until the cursor leaves that call. */
  dismissed: number | null;
}

function nextHelp(state: EditorState, index: CatalogIndex, previous: HelpState | null, dismissed: number | null): HelpState {
  const signature = signatureAt(state, index);
  if (!signature || signature.open === dismissed) {
    return { tooltip: null, key: "", dismissed: signature ? dismissed : null };
  }
  const key = JSON.stringify(signature);
  if (previous?.tooltip && previous.key === key) return { ...previous, dismissed: null };
  const tooltip: Tooltip = { pos: signature.open, above: true, strictSide: false, create: () => ({ dom: render(signature) }) };
  return { tooltip, key, dismissed: null };
}

export function signatureHelp(index: CatalogIndex): Extension {
  const field = StateField.define<HelpState>({
    create: (state) => nextHelp(state, index, null, null),
    update(value, tr) {
      const hidden = tr.effects.find((effect) => effect.is(dismiss));
      if (!tr.docChanged && !tr.selection && !hidden) return value;
      const dismissed = hidden ? hidden.value : value.dismissed === null || !tr.docChanged ? value.dismissed : tr.changes.mapPos(value.dismissed);
      return nextHelp(tr.state, index, value, dismissed);
    },
    provide: (f) => showTooltip.from(f, (value) => value.tooltip),
  });
  return [
    field,
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          const signature = view.state.field(field).tooltip && signatureAt(view.state, index);
          if (!signature) return false;
          view.dispatch({ effects: dismiss.of(signature.open) });
          return true;
        },
      },
    ]),
    EditorView.baseTheme({
      ".cm-signature": { padding: "2px 6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", maxWidth: "60ch" },
      ".cm-signature strong": { color: "var(--color-primary)" },
    }),
  ];
}
