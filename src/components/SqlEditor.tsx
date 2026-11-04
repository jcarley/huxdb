import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";

interface SqlEditorProps {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  className?: string;
  /** Added to the editor's own; fixed per mount. */
  extensions?: Extension[];
  /** The editor, for callers that move its cursor or read its selection. */
  onReady?: (view: EditorView) => void;
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--color-base-300)" },
});

/** CodeMirror 6 with PostgreSQL highlighting. Uncontrolled inside; `value` changes replace the text. */
export function SqlEditor({ value, readOnly = false, onChange, className = "", extensions = [], onReady }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...extensions,
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    onReady?.(editor);
    return () => editor.destroy();
    // Built once; `value` is synced below; the rest is fixed per mount.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={`min-h-0 overflow-hidden ${className}`} />;
}
