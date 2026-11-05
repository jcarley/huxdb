import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { closeCompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { CirclePlay, OctagonX, Play, RefreshCw, Settings2, X } from "lucide-react";
import * as api from "../../lib/api";
import { catalogKey, useCompletionCatalog } from "../../stores/completionCatalog";
import { useQueryEditor } from "../../stores/queryEditor";
import type { QueryEditor as Editor } from "../../stores/queryEditor";
import { useQueryPrefs } from "../../stores/queryPrefs";
import { useTabs } from "../../stores/tabs";
import { SqlEditor } from "../SqlEditor";
import { ToolButton } from "../ToolButton";
import { completionCompartment, completionExtension } from "./completion";
import { QueryResults } from "./QueryResults";
import { currentScope, statementHighlight } from "./statementHighlight";

const MIN_PANEL = 80;

/** Editor extensions for one tab: the highlight, completion, Tab to indent, and Cmd+Return to run. */
function queryExtensions(id: string) {
  const { run } = useQueryEditor.getState();
  return [
    statementHighlight,
    completionCompartment.of(completionExtension(useQueryPrefs.getState())),
    keymap.of([indentWithTab]),
    // Ahead of the default keymap, where Mod-Enter inserts a line.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            closeCompletion(view);
            void run(id, currentScope(view));
            return true;
          },
        },
        {
          key: "Shift-Mod-Enter",
          run: (view) => {
            closeCompletion(view);
            void run(id, { kind: "all" });
            return true;
          },
        },
      ]),
    ),
  ];
}

/** Database and schema selects. The connection is fixed; the two lock during a
 * transaction, since a new database needs a new connection and a rollback would undo a schema. */
function TargetSelects({ id, editor }: { id: string; editor: Editor }) {
  const { connectionId, database, schema } = editor.tab;
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const locked = editor.tx !== "idle" || editor.runId !== null;

  useEffect(() => {
    let current = true;
    api.openConnection(connectionId).then((list) => current && setDatabases(list)).catch(() => {});
    return () => {
      current = false;
    };
  }, [connectionId]);

  useEffect(() => {
    let current = true;
    api.listSchemas(connectionId, database).then((list) => current && setSchemas(list)).catch(() => {});
    return () => {
      current = false;
    };
  }, [connectionId, database]);

  const retarget = (nextDatabase: string, nextSchema: string) => {
    useQueryEditor.getState().setTarget(id, nextDatabase, nextSchema);
    useTabs.getState().setTarget(id, nextDatabase, nextSchema);
  };

  // What's selected shows even before its list loads, or if it fails to.
  const withCurrent = (list: string[], value: string) => (value && !list.includes(value) ? [value, ...list] : list);

  return (
    <>
      <select className="select select-sm w-44" aria-label="Database" title="Database" value={database} disabled={locked} onChange={(e) => retarget(e.target.value, "")}>
        {withCurrent(databases, database).map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <select className="select select-sm w-44" aria-label="Schema" title="Schema" value={schema} disabled={locked} onChange={(e) => retarget(database, e.target.value)}>
        <option value="">Default schema</option>
        {withCurrent(schemas, schema).map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
    </>
  );
}

/** The completion settings, shared by every query tab, and this database's catalog. */
function CompletionMenu({ connectionId, database }: { connectionId: string; database: string }) {
  const completion = useQueryPrefs((s) => s.completion);
  const upperCaseKeywords = useQueryPrefs((s) => s.upperCaseKeywords);
  const { setCompletion, setUpperCaseKeywords } = useQueryPrefs.getState();
  const entry = useCompletionCatalog((s) => s.entries[catalogKey(connectionId, database)]);

  return (
    <div className="dropdown dropdown-end">
      <button type="button" tabIndex={0} className="btn btn-ghost btn-sm btn-square" title="Completion settings" aria-label="Completion settings">
        <Settings2 className="size-4 text-primary" strokeWidth={1.75} />
      </button>
      {/* Above CodeMirror's own layers: the gutters are at 200. */}
      <div tabIndex={0} className="dropdown-content z-300 flex w-52 flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow-lg">
        <label className="label cursor-pointer justify-start gap-2 text-base-content">
          <input type="checkbox" className="checkbox checkbox-xs" checked={completion} onChange={(e) => setCompletion(e.target.checked)} />
          Code completion
        </label>
        <label className="label cursor-pointer justify-start gap-2 text-base-content">
          <input type="checkbox" className="checkbox checkbox-xs" checked={upperCaseKeywords} disabled={!completion} onChange={(e) => setUpperCaseKeywords(e.target.checked)} />
          Upper-case keywords
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm justify-start font-normal"
          title="Reads this database's schemas, tables and columns again"
          disabled={!completion || entry?.loading}
          onClick={() => useCompletionCatalog.getState().refresh(connectionId, database)}
        >
          <RefreshCw className={`size-4 text-primary ${entry?.loading ? "animate-spin" : ""}`} strokeWidth={1.75} />
          Update Code Completion
        </button>
        {entry?.error && <p className="whitespace-pre-wrap text-xs text-error select-text">{entry.error}</p>}
      </div>
    </div>
  );
}

function Toolbar({ id, editor, view }: { id: string; editor: Editor; view: () => EditorView | null }) {
  const { run, stop, setContinueOnError } = useQueryEditor.getState();
  const running = editor.runId !== null;
  const blank = editor.sql.trim() === "";

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-base-300 px-2 py-1">
      <ToolButton
        icon={Play}
        label="Run"
        title="Run the selection, or the current statement (⌘↩)"
        disabled={running || blank}
        onClick={() => {
          const editorView = view();
          if (editorView) void run(id, currentScope(editorView));
        }}
      />
      <ToolButton icon={CirclePlay} label="Run All" title="Run everything (⌘⇧↩)" disabled={running || blank} onClick={() => void run(id, { kind: "all" })} />
      <ToolButton icon={OctagonX} label="Stop" disabled={!running} onClick={() => stop(id)} />
      <label className="label mx-2 cursor-pointer gap-1.5 text-sm text-base-content" title="Keep going after a statement fails">
        <input type="checkbox" className="checkbox checkbox-xs" checked={editor.continueOnError} onChange={(e) => setContinueOnError(id, e.target.checked)} />
        Continue on Error
      </label>
      <TargetSelects id={id} editor={editor} />
      <div className="ml-auto flex items-center gap-2 text-xs">
        <CompletionMenu connectionId={editor.tab.connectionId} database={editor.tab.database} />
        {editor.progress && (
          <span className="text-base-content/70 tabular-nums">
            <span className="loading loading-spinner loading-xs mr-1 align-middle" />
            Statement {editor.progress.index + 1} of {editor.progress.total}
          </span>
        )}
        {editor.tx === "open" && <span className="badge badge-primary badge-soft badge-sm">Transaction open</span>}
        {editor.tx === "aborted" && (
          <span className="badge badge-error badge-soft badge-sm" title="Statements fail until a ROLLBACK">
            Transaction failed
          </span>
        )}
      </div>
    </div>
  );
}

/** Something about the run as a whole, as opposed to one statement. */
function Banner({ id, editor }: { id: string; editor: Editor }) {
  const text = editor.error ?? editor.notice;
  if (!text) return null;
  return (
    <div role={editor.error ? "alert" : "status"} className={`alert alert-soft mx-2 mt-1 flex items-start rounded-md py-1.5 text-sm ${editor.error ? "alert-error" : "alert-warning"}`}>
      <span className="min-w-0 flex-1 whitespace-pre-wrap select-text">{text}</span>
      <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Dismiss" onClick={() => useQueryEditor.getState().dismissMessages(id)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** A query tab: SQL on top, results below. */
export function QueryEditor({ id }: { id: string }) {
  const editor = useQueryEditor((s) => s.editors[id]);
  const setSql = useQueryEditor((s) => s.setSql);
  const [extensions] = useState(() => queryExtensions(id));
  const completion = useQueryPrefs((s) => s.completion);
  const upperCaseKeywords = useQueryPrefs((s) => s.upperCaseKeywords);
  const connectionId = editor?.tab.connectionId ?? "";
  const database = editor?.tab.database ?? "";
  const schema = editor?.tab.schema ?? "";
  const catalog = useCompletionCatalog((s) => s.entries[catalogKey(connectionId, database)]?.catalog);
  const [panelHeight, setPanelHeight] = useState(280);
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    if (completion && connectionId) useCompletionCatalog.getState().ensure(connectionId, database);
  }, [completion, connectionId, database]);

  useEffect(() => {
    view.current?.dispatch({ effects: completionCompartment.reconfigure(completionExtension({ completion, upperCaseKeywords, catalog, schema })) });
  }, [completion, upperCaseKeywords, catalog, schema]);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const onMove = (m: MouseEvent) => setPanelHeight(Math.min(Math.max(box.bottom - m.clientY, MIN_PANEL), box.height - MIN_PANEL));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Moves to a place in the text, which may have changed since the run. */
  const jump = (from: number, to = from) => {
    const target = view.current;
    if (!target) return;
    const end = target.state.doc.length;
    target.dispatch({
      selection: { anchor: Math.min(from, end), head: Math.min(to, end) },
      effects: EditorView.scrollIntoView(Math.min(from, end), { y: "center" }),
    });
    target.focus();
  };

  if (!editor) return null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Toolbar id={id} editor={editor} view={() => view.current} />
      <div ref={container} className="flex min-h-0 flex-1 flex-col">
        <SqlEditor value={editor.sql} onChange={(sql) => setSql(id, sql)} className="min-h-0 flex-1" extensions={extensions} onReady={(v) => (view.current = v)} />
        <div className="h-1.5 shrink-0 cursor-row-resize border-y border-base-300 bg-base-200 hover:bg-primary/30" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
        <div className="flex shrink-0 flex-col" style={{ height: panelHeight }}>
          <Banner id={id} editor={editor} />
          <QueryResults id={id} editor={editor} onJump={jump} />
        </div>
      </div>
    </section>
  );
}
