// The statement a Run would use: highlighted under the cursor, as the backend's
// scanner sees it. Split results arrive shortly after an edit, and until then
// the last ones follow the text.

import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import * as api from "../../lib/api";
import type { RunScope, TextRange } from "../../lib/types";

const SPLIT_DELAY_MS = 150;

const setStatements = StateEffect.define<TextRange[]>();

const statements = StateField.define<TextRange[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      next = next.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(setStatements)) next = effect.value;
    }
    return next;
  },
});

/** Picks a statement as the backend does: the last that starts at or before `pos`, else the first. */
function statementAt(ranges: TextRange[], pos: number) {
  let found = ranges[0];
  for (const range of ranges) {
    if (range.from <= pos) found = range;
  }
  return found;
}

const mark = Decoration.mark({ class: "cm-current-statement" });

const highlight = EditorView.decorations.compute([statements, "selection"], (state) => {
  const selection = state.selection.main;
  // A selection is what would run instead.
  const current = selection.empty ? statementAt(state.field(statements), selection.head) : undefined;
  if (!current || current.to <= current.from) return Decoration.none;
  return Decoration.set([mark.range(current.from, Math.min(current.to, state.doc.length))]);
});

/** Asks the backend for the statements, once the text has settled. */
const splitter = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.schedule();
    }

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.split(), SPLIT_DELAY_MS);
    }

    async split() {
      const doc = this.view.state.doc;
      const ranges = await api.querySplit(doc.toString()).catch(() => null);
      if (ranges && this.view.state.doc.eq(doc)) this.view.dispatch({ effects: setStatements.of(ranges) });
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

const theme = EditorView.theme({
  ".cm-current-statement": { backgroundColor: "color-mix(in oklab, var(--color-primary) 9%, transparent)" },
});

export const statementHighlight: Extension = [statements, highlight, splitter, theme];

/** What Run covers: the selection, or the statement under the cursor. */
export function currentScope(view: EditorView): RunScope {
  const { from, to, head } = view.state.selection.main;
  return from === to ? { kind: "cursor", pos: head } : { kind: "selection", from, to };
}
