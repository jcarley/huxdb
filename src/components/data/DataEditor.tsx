import { useEffect, useState } from "react";
import {
  AArrowDown,
  AArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CirclePlay,
  CircleStop,
  ListFilter,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Undo2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FilterCondition } from "../../lib/types";
import { PAGE_SIZES, filterConditions, pendingCount, specLocked, useDataEditor } from "../../stores/dataEditor";
import { DEFAULT_FONT_SIZE, FONT_SIZES, useDataGridPrefs } from "../../stores/dataGridPrefs";
import type { DataEditor as Editor } from "../../stores/dataEditor";
import { DataGrid } from "./DataGrid";
import { ToolButton } from "../ToolButton";

/** Navicat-style data editor for one tab: a table's rows in an editable grid. */
export function DataEditor({ id }: { id: string }) {
  const editor = useDataEditor((s) => s.editors[id]);
  if (!editor) return null;

  if (!editor.source) {
    return (
      <div className="flex flex-1 flex-col items-center gap-3 p-6 text-sm">
        {editor.error ? (
          <>
            <p className="text-error select-text">{editor.error}</p>
            <button type="button" className="btn btn-sm" onClick={() => void useDataEditor.getState().load(id, 0, true)}>
              <RotateCw className="size-4" /> Retry
            </button>
          </>
        ) : (
          <span className="loading loading-spinner loading-md" />
        )}
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TransactionToolbar id={id} editor={editor} />
      {editor.source.readOnly && (
        <div role="status" className="alert alert-info alert-soft m-2 rounded-md py-1.5 text-sm">
          <Lock className="size-4" />
          <span>Read-only. {editor.source.readOnly}</span>
        </div>
      )}
      <FilterBar id={id} editor={editor} />
      <DataGrid id={id} />
      <Messages id={id} editor={editor} />
      <div className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-200/50 px-2 py-1">
        <ActionBar id={id} editor={editor} />
        <PendingSummary editor={editor} />
        <Pager id={id} editor={editor} />
      </div>
    </section>
  );
}

/** Begin Transaction, which turns into an End Transaction menu (Commit / Rollback) while one is open. */
function TransactionToolbar({ id, editor }: { id: string; editor: Editor }) {
  const store = useDataEditor.getState();
  const busy = editor.busy !== null;
  const end = (commit: boolean) => {
    // Close the focus-driven dropdown.
    (document.activeElement as HTMLElement | null)?.blur();
    void store.endTransaction(id, commit);
  };

  return (
    <div className="flex items-center gap-0.5 border-b border-base-300 bg-base-200/50 px-2 py-1">
      {editor.inTransaction ? (
        <div className="dropdown">
          <button type="button" tabIndex={0} className="btn btn-ghost btn-sm font-normal" disabled={busy}>
            <CirclePlay className="size-4 text-warning" strokeWidth={1.75} />
            End Transaction
            <ChevronDown className="size-3.5" />
          </button>
          <ul tabIndex={0} className="dropdown-content menu menu-sm z-10 w-44 rounded-box border border-base-300 bg-base-100 shadow-lg">
            <li>
              <button type="button" onClick={() => end(true)}>
                <Check className="size-4" /> Commit
              </button>
            </li>
            <li>
              <button type="button" onClick={() => end(false)}>
                <Undo2 className="size-4" /> Rollback
              </button>
            </li>
          </ul>
        </div>
      ) : (
        <ToolButton icon={CirclePlay} label="Begin Transaction" disabled={busy} onClick={() => void store.beginTransaction(id)} />
      )}
      {editor.inTransaction && <span className="badge badge-warning badge-soft badge-sm ml-1">Transaction open</span>}
      {busy && <span className="loading loading-spinner loading-sm ml-2" />}
      <div className="flex-1" />
      <FontSizeControls />
    </div>
  );
}

const describeCondition = ({ column, op, value }: FilterCondition) =>
  op === "is-null" ? `${column} is null` : op === "is-not-null" ? `${column} is not null` : `${column} ${op === "eq" ? "=" : "≠"} ${value}`;

/** The filter and sort in effect: chips for the cell filters, and the typed WHERE
 * and ORDER BY, which keep their text if the server rejects it. */
function FilterBar({ id, editor }: { id: string; editor: Editor }) {
  const store = useDataEditor.getState();
  const { spec } = editor;
  const [whereText, setWhereText] = useState(spec.whereSql ?? "");
  const [orderText, setOrderText] = useState(spec.orderSql ?? "");
  // A header sort clears the typed ORDER BY.
  useEffect(() => setWhereText(spec.whereSql ?? ""), [spec.whereSql]);
  useEffect(() => setOrderText(spec.orderSql ?? ""), [spec.orderSql]);

  const locked = specLocked(editor);
  const hint = pendingCount(editor) > 0 ? "Commit or cancel your changes first" : undefined;
  const conditions = filterConditions(spec);
  const filtered = conditions.length > 0 || spec.whereSql !== null;
  const sorted = spec.sort.length > 0 || spec.orderSql !== null;
  const status = filtered && sorted ? "Filtered, sorted" : filtered ? "Filtered" : sorted ? "Sorted" : null;
  const apply = () => store.applyTyped(id, whereText, orderText);
  const clear = () => {
    setWhereText("");
    setOrderText("");
    store.clearSpec(id);
  };
  const input = (label: string, placeholder: string, value: string, onChange: (text: string) => void) => (
    <label className="input input-xs min-w-40 flex-1 font-mono">
      <span className="font-sans text-base-content/60">{label}</span>
      <input
        className="grow"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
      />
    </label>
  );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-base-300 px-2 py-1 text-xs">
      <ListFilter className={`size-4 shrink-0 ${status ? "text-primary" : "text-base-content/50"}`} strokeWidth={1.75} aria-hidden />
      {status && <span className="badge badge-primary badge-soft badge-xs shrink-0">{status}</span>}
      {conditions.map((condition, i) => (
        <span key={`${i}:${describeCondition(condition)}`} className="badge badge-neutral badge-soft badge-sm max-w-56 gap-0.5 pr-0.5 font-mono" title={describeCondition(condition)}>
          <span className="truncate">{describeCondition(condition)}</span>
          <button type="button" className="btn btn-ghost btn-xs btn-square size-4 min-h-0" aria-label={`Remove filter ${describeCondition(condition)}`} title={hint} disabled={locked} onClick={() => store.removeFilter(id, i)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      {input("WHERE", "price > 10", whereText, setWhereText)}
      {input("ORDER BY", "name DESC", orderText, setOrderText)}
      <button type="button" className="btn btn-xs" title={hint} disabled={locked} onClick={apply}>
        Apply
      </button>
      <button type="button" className="btn btn-ghost btn-xs" title={hint} disabled={locked || !(status || whereText || orderText)} onClick={clear}>
        Clear
      </button>
    </div>
  );
}

/** A− / size / A+ for the grid's font, shared by every data tab (also ⌘− / ⌘0 / ⌘+ in the grid). */
function FontSizeControls() {
  const fontSize = useDataGridPrefs((s) => s.fontSize);
  const zoom = useDataGridPrefs((s) => s.zoom);
  return (
    <div className="join">
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square join-item"
        title="Smaller Text (⌘−)"
        aria-label="Smaller text"
        disabled={fontSize <= FONT_SIZES[0]}
        onClick={() => zoom(-1)}
      >
        <AArrowDown className="size-4" strokeWidth={1.75} />
      </button>
      <button type="button" className="btn btn-ghost btn-sm join-item w-14 font-normal tabular-nums" title="Actual Size (⌘0)" onClick={() => zoom(0)}>
        {Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)}%
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square join-item"
        title="Larger Text (⌘+)"
        aria-label="Larger text"
        disabled={fontSize >= FONT_SIZES[FONT_SIZES.length - 1]}
        onClick={() => zoom(1)}
      >
        <AArrowUp className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** The last error (with its failing statement) or notice. */
function Messages({ id, editor }: { id: string; editor: Editor }) {
  const message = editor.error ?? editor.notice;
  if (!message) return null;
  const isError = editor.error !== null;
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`alert alert-soft mx-2 mb-1 flex items-start rounded-md py-1.5 text-sm ${isError ? "alert-error" : "alert-success"}`}
    >
      <pre className="flex-1 font-sans whitespace-pre-wrap select-text">{message}</pre>
      <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Dismiss" onClick={() => useDataEditor.getState().dismissMessages(id)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function BarButton({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-xs btn-square" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}

/** The buttons under the grid: Add, Remove, Commit, Cancel, Rollback, Refresh, Stop. */
function ActionBar({ id, editor }: { id: string; editor: Editor }) {
  const store = useDataEditor.getState();
  const busy = editor.busy !== null;
  const locked = editor.source?.readOnly != null;
  const pending = pendingCount(editor) > 0;
  // A query is running: loading, committing or counting.
  const stoppable = editor.busy === "load" || editor.busy === "apply" || editor.counting;

  return (
    <div className="flex items-center gap-0.5">
      <BarButton icon={Plus} label="Add Record" disabled={locked || busy} onClick={() => store.addRow(id)} />
      <BarButton icon={Minus} label="Delete Record" disabled={locked || busy || editor.selected.length === 0} onClick={() => store.removeSelected(id)} />
      <BarButton icon={Check} label="Commit Changes" disabled={busy || !pending} onClick={() => void store.commit(id)} />
      <BarButton icon={X} label="Cancel Changes" disabled={busy || !pending} onClick={() => store.cancelEdits(id)} />
      <BarButton icon={Undo2} label="Rollback Transaction" disabled={busy || !editor.inTransaction} onClick={() => void store.endTransaction(id, false)} />
      <BarButton icon={RefreshCw} label={pending ? "Commit or cancel your changes to refresh" : "Refresh"} disabled={busy || pending} onClick={() => void store.load(id, undefined, true)} />
      <BarButton icon={CircleStop} label="Stop" disabled={!stoppable} onClick={() => store.stop(id)} />
    </div>
  );
}

/** What Commit would apply, e.g. "2 modified, 1 added". */
function PendingSummary({ editor }: { editor: Editor }) {
  const parts = [
    [Object.keys(editor.edits).length, "modified"],
    [editor.inserts.length, "added"],
    [Object.keys(editor.deletes).length, "deleted"],
  ].filter(([n]) => n) as [number, string][];
  return (
    <span className="min-w-0 flex-1 truncate px-2 text-xs text-base-content/70">
      {parts.length > 0 && `Pending: ${parts.map(([n, what]) => `${n} ${what}`).join(", ")}`}
    </span>
  );
}

/** First / previous / page number / next / last, the page size, and which rows show. */
function Pager({ id, editor }: { id: string; editor: Editor }) {
  const { page, pageSize, total, rows, counting } = editor;
  const store = useDataEditor.getState();
  const lastPage = total === null ? null : Math.max(0, Math.ceil(total / pageSize) - 1);
  const blocked = editor.busy !== null || pendingCount(editor) > 0;
  const hint = pendingCount(editor) > 0 ? "Commit or cancel your changes first" : undefined;
  const go = (to: number) => void store.load(id, lastPage === null ? to : Math.min(to, lastPage));

  const [text, setText] = useState(String(page + 1));
  useEffect(() => setText(String(page + 1)), [page]);
  const submit = () => {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n) && n >= 1 && n - 1 !== page) go(n - 1);
    else setText(String(page + 1));
  };

  const first = page * pageSize + 1;
  const range = rows.length === 0 ? "No rows" : `Rows ${first.toLocaleString()}–${(first + rows.length - 1).toLocaleString()}`;
  const of = counting ? " of …" : total === null ? "" : ` of ${total.toLocaleString()}`;
  const canNext = lastPage === null ? rows.length === pageSize : page < lastPage;

  return (
    <div className="flex shrink-0 items-center gap-1 text-xs" title={hint}>
      <span className="mr-2 tabular-nums text-base-content/70">
        {range}
        {of}
      </span>
      <BarButton icon={ChevronsLeft} label="First Page" disabled={blocked || page === 0} onClick={() => go(0)} />
      <BarButton icon={ChevronLeft} label="Previous Page" disabled={blocked || page === 0} onClick={() => go(page - 1)} />
      <input
        className="input input-xs w-14 text-center tabular-nums"
        aria-label="Page"
        value={text}
        disabled={blocked}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <BarButton icon={ChevronRight} label="Next Page" disabled={blocked || !canNext} onClick={() => go(page + 1)} />
      <BarButton icon={ChevronsRight} label="Last Page" disabled={blocked || lastPage === null || page >= lastPage} onClick={() => go(lastPage ?? 0)} />
      <select
        className="select select-xs ml-1 w-auto"
        aria-label="Rows per page"
        title="Rows per page"
        value={pageSize}
        disabled={blocked}
        onChange={(e) => store.setPageSize(id, Number(e.target.value))}
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString()} / page
          </option>
        ))}
      </select>
    </div>
  );
}
