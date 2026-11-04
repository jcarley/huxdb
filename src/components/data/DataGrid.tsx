import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown, ArrowUp, Ban, CircleSlash, Equal, EqualNot, Eraser, KeyRound, ListFilter, Trash2 } from "lucide-react";
import type { DataColumn, FilterOp } from "../../lib/types";
import { specLocked, useDataEditor } from "../../stores/dataEditor";
import type { Value } from "../../stores/dataEditor";
import { tableKey, useDataGridPrefs } from "../../stores/dataGridPrefs";
import { DesignerId } from "../designer/context";
import { useContextMenu } from "../tree/ContextMenu";
import type { MenuItem } from "../tree/ContextMenu";
import { MIN_WIDTH, defaultWidths, fitWidth } from "./columnWidths";

// Rendering: `DataGrid` subscribes only to what changes the set of rows; each
// `DataRow` subscribes to its own pending values, selection and editing state
// and hands them to its cells through `RowState`, so an edit or a click
// re-renders one row's cells, not the grid's. Column widths live in
// `SizedTable`'s <colgroup>, so dragging a column edge re-renders no rows.

/** A grid row: a loaded row (with its values as loaded) or a new one. */
interface GridRow {
  key: string;
  /** Null for a new row. */
  loaded: Value[] | null;
}

/** A row's state that its cells show. */
interface RowStateValue {
  key: string;
  isNew: boolean;
  deleted: boolean;
  /** Pending values by column name (a new row's edited columns). */
  pending: Record<string, Value> | undefined;
  /** The column being edited in this row. */
  editingColumn: string | null;
}

const RowState = createContext<RowStateValue | null>(null);

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, GridRow>();

const NO_ROWS: Value[][] = [];
const NO_KEYS: string[] = [];
const NO_COLUMNS: DataColumn[] = [];

/** Click selects a row; Cmd/Ctrl-click toggles it; Shift-click extends from the last one. */
function selectRow(id: string, key: string, e: MouseEvent) {
  const store = useDataEditor.getState();
  const d = store.editors[id];
  if (!d) return;
  const anchor = d.selected[d.selected.length - 1];
  if (e.shiftKey && anchor) {
    const keys = [...d.rowKeys, ...d.inserts.map((r) => r.key)];
    const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)].sort((x, y) => x - y);
    if (a >= 0) store.select(id, keys.slice(a, b + 1));
  } else if (e.metaKey || e.ctrlKey) {
    store.select(id, d.selected.includes(key) ? d.selected.filter((k) => k !== key) : [...d.selected, key]);
  } else if (d.selected.length !== 1 || d.selected[0] !== key) {
    store.select(id, [key]);
  }
}

/** Text input over a cell. Enter or leaving keeps the text, Escape drops it. */
function CellEditor({ initial, onDone }: { initial: string; onDone: (text: string | undefined) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      className="input input-xs h-[1.6em] w-full rounded-none border-primary px-1 font-mono text-[1em]"
      value={text}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(text);
        else if (e.key === "Escape") finish(undefined);
        e.stopPropagation();
      }}
    />
  );
}

interface CellProps {
  column: DataColumn;
  /** The value as loaded; undefined in a new row. */
  loaded: Value | undefined;
  /** The whole table is read-only. */
  locked: boolean;
}

function DataCell({ column, loaded, locked }: CellProps) {
  const id = useContext(DesignerId);
  const row = useContext(RowState)!;
  const openMenu = useContextMenu((s) => s.open);
  const actions = useDataEditor.getState();

  const changed = !!row.pending && column.name in row.pending;
  const value = changed ? row.pending![column.name] : (loaded ?? null);
  const editing = row.editingColumn === column.name;
  const editable = !locked && !row.deleted && column.readOnly === null;
  const set = (v: Value) => actions.setCell(id, row.key, column.name, v);
  const startEditing = () => editable && actions.setEditing(id, { row: row.key, column: column.name });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEditing();
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    // Read now: this cell may not have re-rendered since the selection changed.
    const editor = useDataEditor.getState().editors[id];
    const selected = editor?.selected ?? [];
    if (!selected.includes(row.key)) actions.select(id, [row.key]);
    const items: MenuItem[] = [];
    if (!row.isNew && !specLocked(editor)) {
      const filter = (op: FilterOp, value: Value = null) => actions.addFilter(id, { column: column.name, op, value });
      if (column.comparable && value !== null) {
        items.push({ label: "Filter by Value", icon: Equal, onClick: () => filter("eq", value) });
        items.push({ label: "Filter Out Value", icon: EqualNot, onClick: () => filter("ne", value) });
      }
      if (column.nullable) {
        items.push({ label: "Filter: Is NULL", icon: CircleSlash, onClick: () => filter("is-null") });
        items.push({ label: "Filter: Is Not NULL", icon: ListFilter, onClick: () => filter("is-not-null") });
      }
    }
    if (editable) {
      if (column.nullable) items.push({ label: "Set to NULL", icon: Ban, onClick: () => set(null) });
      items.push({ label: "Set to Empty String", icon: Eraser, onClick: () => set("") });
    }
    if (!locked) items.push({ label: "Delete Record", icon: Trash2, danger: true, onClick: () => actions.removeSelected(id) });
    if (items.length) openMenu(e, items);
    else e.preventDefault();
  };

  let content;
  if (editing) {
    content = (
      <CellEditor
        initial={value ?? ""}
        onDone={(text) => {
          actions.setEditing(id, null);
          // Confirming the shown text unchanged leaves the value (NULL stays NULL).
          if (text !== undefined && text !== (value ?? "")) set(text);
        }}
      />
    );
  } else if (value === null) {
    const label = row.isNew && !changed && column.hasDefault ? "(Default)" : "(NULL)";
    content = <span className="italic text-base-content/40">{label}</span>;
  } else {
    content = value;
  }

  return (
    <td
      tabIndex={-1}
      title={column.readOnly ?? (value !== null && value.length > 40 ? value : undefined)}
      className={`truncate border-r border-base-200 px-1.5 py-0.5 font-mono outline-none focus:ring-1 focus:ring-primary focus:ring-inset ${
        changed && !row.isNew ? "bg-warning/30" : ""
      } ${column.readOnly ? "text-base-content/60" : ""} ${editing ? "p-0" : ""}`}
      onDoubleClick={startEditing}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {content}
    </td>
  );
}

/** Each column's cells, built once per loaded column list. */
function useColumns(columns: DataColumn[], locked: boolean) {
  return useMemo(
    () =>
      helper.columns(
        columns.map((column, i) =>
          helper.display({
            id: String(i),
            header: column.name,
            cell: (c) => <DataCell column={column} loaded={c.row.original.loaded?.[i]} locked={locked} />,
          }),
        ),
      ),
    [columns, locked],
  );
}

function DataRow({ row, children }: { row: GridRow; children: ReactNode }) {
  const id = useContext(DesignerId);
  const isNew = row.loaded === null;
  const selected = useDataEditor((s) => !!s.editors[id]?.selected.includes(row.key));
  const deleted = useDataEditor((s) => !!s.editors[id]?.deletes[row.key]);
  // Stable references: the same object until this row's values change.
  const pending = useDataEditor((s) => {
    const d = s.editors[id];
    return isNew ? d?.inserts.find((r) => r.key === row.key)?.values : d?.edits[row.key];
  });
  const editingColumn = useDataEditor((s) => {
    const editing = s.editors[id]?.editing;
    return editing?.row === row.key ? editing.column : null;
  });
  const state = useMemo(
    () => ({ key: row.key, isNew, deleted, pending, editingColumn }),
    [row.key, isNew, deleted, pending, editingColumn],
  );
  const ref = useRef<HTMLTableRowElement>(null);

  // A row just added scrolls into view.
  useEffect(() => {
    if (isNew) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isNew]);

  const onMouseDown = (e: MouseEvent) => {
    // Right-clicking a selected row keeps the selection for the menu's Delete Record.
    if (!(e.button === 2 && selected)) selectRow(id, row.key, e);
  };

  const tone = deleted
    ? "bg-error/10 text-base-content/50 line-through"
    : selected
      ? "bg-primary/15"
      : isNew
        ? "bg-success/10"
        : "hover:bg-base-300/40";
  return (
    <tr ref={ref} aria-selected={selected} className={`cursor-default ${tone}`} onMouseDown={onMouseDown}>
      <td className="sticky left-0 z-[1] border-r border-base-300 bg-base-200 px-1 text-center text-[0.85em] text-base-content/50 no-underline">
        {deleted ? "✕" : isNew ? "✱" : selected ? "▸" : ""}
      </td>
      <RowState.Provider value={state}>{children}</RowState.Provider>
    </tr>
  );
}

/** A column's name in its header, which sorts on click (Shift adds to the sort)
 * when the type allows it. This, not the grid, subscribes to the sort. */
function HeaderLabel({ column, isKey, children }: { column: DataColumn; isKey: boolean; children: ReactNode }) {
  const id = useContext(DesignerId);
  const { rank, descending, stacked, locked } = useDataEditor(
    useShallow((s) => {
      const editor = s.editors[id];
      const sort = editor?.spec.sort ?? [];
      const i = sort.findIndex((k) => k.column === column.name);
      return { rank: i + 1, descending: !!sort[i]?.descending, stacked: sort.length > 1, locked: specLocked(editor) };
    }),
  );
  const label = (
    <>
      {isKey && <KeyRound className="size-[0.9em] shrink-0 text-warning" />}
      <span className="truncate">{children}</span>
      {rank > 0 &&
        (descending ? <ArrowDown className="size-[0.9em] shrink-0 text-primary" aria-label="Sorted descending" /> : <ArrowUp className="size-[0.9em] shrink-0 text-primary" aria-label="Sorted ascending" />)}
      {rank > 0 && stacked && <span className="shrink-0 text-[0.8em] text-primary tabular-nums">{rank}</span>}
    </>
  );
  if (!column.comparable) return <span className="flex items-center gap-1 overflow-hidden">{label}</span>;
  return (
    <button
      type="button"
      className="flex w-full cursor-default items-center gap-1 overflow-hidden font-semibold"
      disabled={locked}
      onClick={(e) => useDataEditor.getState().toggleSort(id, column.name, e.shiftKey)}
    >
      {label}
    </button>
  );
}

/** The drag handle on a header's right edge; double-click fits the column. */
function ResizeHandle({ onResize, onFit }: { onResize: (width: number) => void; onFit: () => void }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startWidth = handle.parentElement!.getBoundingClientRect().width;
    const startX = e.clientX;
    handle.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => onResize(Math.max(MIN_WIDTH, startWidth + m.clientX - startX));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize; double-click to fit"
      className="absolute top-0 -right-1 z-[3] h-full w-2 cursor-col-resize hover:bg-primary/40"
      onPointerDown={onPointerDown}
      onDoubleClick={onFit}
    />
  );
}

/** The grid's <table> with its column widths: the user's (saved per table) or
 * `defaults`. Only this re-renders when a width changes; its children don't. */
function SizedTable({ table, columns, defaults, children }: { table: string; columns: DataColumn[]; defaults: number[]; children: ReactNode }) {
  const saved = useDataGridPrefs((s) => s.columnWidths[table]);
  const widths = columns.map((c, i) => saved?.[c.name] ?? defaults[i] ?? FALLBACK_WIDTH);
  const total = widths.reduce((sum, w) => sum + w, 0);
  return (
    <table
      // text-[1em]: daisyUI's .table sets its own font size; follow the grid's zoom instead.
      className="table table-pin-rows table-fixed border-separate border-spacing-0 text-[1em]"
      style={{ width: `calc(${ROW_HEADER_WIDTH} + ${total}px)` }}
    >
      <colgroup>
        <col style={{ width: ROW_HEADER_WIDTH }} />
        {widths.map((w, i) => (
          <col key={columns[i].name} style={{ width: w }} />
        ))}
      </colgroup>
      {children}
    </table>
  );
}

/** Scales with the font size. */
const ROW_HEADER_WIDTH = "2em";
/** Before the default widths are measured. */
const FALLBACK_WIDTH = 120;

/** ⌘/Ctrl with + / − / 0 zooms the grid's font while it has focus. */
function onZoomKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const step = e.key === "+" || e.key === "=" ? 1 : e.key === "-" ? -1 : e.key === "0" ? 0 : null;
  if (step === null) return;
  e.preventDefault();
  useDataGridPrefs.getState().zoom(step);
}

/** The table's rows as an editable grid: loaded rows, then rows added in it. */
export const DataGrid = memo(function DataGrid({ id }: { id: string }) {
  const source = useDataEditor((s) => s.editors[id]?.source ?? null);
  const rows = useDataEditor((s) => s.editors[id]?.rows ?? NO_ROWS);
  const rowKeys = useDataEditor((s) => s.editors[id]?.rowKeys ?? NO_KEYS);
  // New rows matter here only when one is added or removed, not when edited.
  const insertKeys = useDataEditor(useShallow((s) => s.editors[id]?.inserts.map((r) => r.key) ?? NO_KEYS));
  const locked = source?.readOnly != null;
  const columns = useColumns(source?.columns ?? NO_COLUMNS, locked);
  const data = useMemo<GridRow[]>(
    () => [
      ...rows.map((loaded, i) => ({ key: rowKeys[i], loaded })),
      ...insertKeys.map((key) => ({ key, loaded: null })),
    ],
    [rows, rowKeys, insertKeys],
  );
  const keys = useMemo(() => new Set(source?.primaryKey), [source]);
  const tab = useDataEditor((s) => s.editors[id]?.tab);
  const fontSize = useDataGridPrefs((s) => s.fontSize);
  // Default widths fit the first page loaded; other pages keep them so columns don't
  // jump. They're measured again only when the columns or the font size change.
  const fitKey = source ? `${fontSize}\u001f${source.columns.map((c) => `${c.name}:${c.typeName}`).join("\u001f")}` : "";
  const [fitted, setFitted] = useState<{ key: string; widths: number[] } | null>(null);
  if (source && fitted?.key !== fitKey) {
    setFitted({ key: fitKey, widths: defaultWidths(source.columns.map((c) => c.name), rows, fontSize) });
  }
  const table = useTable({ features, columns, data });
  if (!source || !tab) return null;
  const savedKey = tableKey({ ...tab, table: tab.name ?? "" });
  const defaults = fitted?.widths ?? [];
  const { setColumnWidth } = useDataGridPrefs.getState();

  return (
    <DesignerId.Provider value={id}>
      <div className="min-h-0 flex-1 overflow-auto" style={{ fontSize }} onKeyDown={onZoomKey}>
        <SizedTable table={savedKey} columns={source.columns} defaults={defaults}>
          <thead className="text-[1em]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th className="sticky left-0 z-[2] border-r border-b border-base-300 bg-base-200" />
                {group.headers.map((h) => {
                  const index = Number(h.column.id);
                  const column = source.columns[index];
                  return (
                    <th
                      key={h.id}
                      title={`${column.typeName}${column.readOnly ? ` — ${column.readOnly}` : ""}`}
                      className="relative border-r border-b border-base-300 bg-base-200 px-1.5 py-1 font-semibold text-base-content"
                    >
                      <HeaderLabel column={column} isKey={keys.has(column.name)}>
                        <table.FlexRender header={h} />
                      </HeaderLabel>
                      <ResizeHandle
                        onResize={(width) => setColumnWidth(savedKey, column.name, width)}
                        onFit={() => setColumnWidth(savedKey, column.name, fitWidth(column.name, rows, index, fontSize))}
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <DataRow key={row.original.key} row={row.original}>
                {row.getAllCells().map((cell) => (
                  <table.FlexRender key={cell.id} cell={cell} />
                ))}
              </DataRow>
            ))}
          </tbody>
        </SizedTable>
        {data.length === 0 && <p className="p-4 text-center text-sm text-base-content/50">No rows</p>}
      </div>
    </DesignerId.Provider>
  );
});
