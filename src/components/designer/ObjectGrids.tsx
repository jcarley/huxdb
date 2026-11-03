import { useContext, useState } from "react";
import type { ReactNode } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Ellipsis } from "lucide-react";
import { useColumns, useSchemas, useTables } from "../../lib/catalog";
import type { Lookup } from "../../lib/catalog";
import { FOREIGN_KEY_ACTIONS, INDEX_METHODS } from "../../lib/types";
import type { CheckDesign, ForeignKeyAction, ForeignKeyDesign, IndexColumn, IndexDesign, UniqueDesign } from "../../lib/types";
import { objectErrors, useTableDesigner } from "../../stores/tableDesigner";
import type { ObjectKind, ObjectOf } from "../../stores/tableDesigner";
import { ColumnPickerDialog } from "./ColumnPickerDialog";
import { DesignerId } from "./context";

// ---------------------------------------------------------------------------
// Cell plumbing
// ---------------------------------------------------------------------------

/** One row of a tab, its error for `field` (once errors show), and an updater. */
function useObject<K extends ObjectKind>(kind: K, row: number, field?: string) {
  const id = useContext(DesignerId);
  // Undefined for a moment when the row or tab is removed, before React unmounts the cell.
  const value = useTableDesigner((s) => s.designers[id]?.edited[kind][row]) as ObjectOf[K] | undefined;
  const error = useTableDesigner((s) => {
    const d = s.designers[id];
    return d?.showErrors && field ? objectErrors(d.edited, kind, row)[field] : undefined;
  });
  const update = (patch: Partial<ObjectOf[K]>) => useTableDesigner.getState().updateObject(id, kind, row, patch);
  return { id, value, error, update };
}

/** The table being designed: its tab's location and its fields as edited. */
function useDesign() {
  const id = useContext(DesignerId);
  const tab = useTableDesigner((s) => s.designers[id]?.tab);
  const name = useTableDesigner((s) => s.designers[id]?.edited.name ?? "");
  // Joined to a string so the selector result compares equal across unrelated edits.
  const fieldsKey = useTableDesigner((s) => JSON.stringify(s.designers[id]?.edited.columns.map((c) => c.name) ?? []));
  return { tab: tab ?? { connectionId: "", database: "", schema: "" }, name, fields: JSON.parse(fieldsKey) as string[] };
}

const cellInput = "input input-xs w-full rounded-none border-transparent bg-transparent focus:border-primary";
const cellSelect = "select select-xs w-full rounded-none border-transparent bg-transparent focus:border-primary";

function NameCell({ kind, row }: { kind: ObjectKind; row: number }) {
  const { value, error, update } = useObject(kind, row, "name");
  if (!value) return null;
  return (
    <input
      className={`${cellInput} ${error ? "input-error" : ""}`}
      value={value.name}
      title={error}
      placeholder={value.originalName ? "" : "(automatic)"}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => update({ name: e.target.value })}
    />
  );
}

/** Free text; for nullable fields, blank is stored as null. */
function TextCell<K extends ObjectKind>({ kind, row, field, mono, placeholder }: { kind: K; row: number; field: "comment" | "predicate" | "expression"; mono?: boolean; placeholder?: string }) {
  const { value, error, update } = useObject(kind, row, field);
  if (!value) return null;
  const text = (value as unknown as Record<string, string | null>)[field] ?? "";
  return (
    <input
      className={`${cellInput} ${mono ? "font-mono" : ""} ${error ? "input-error" : ""}`}
      value={text}
      title={error ?? (text || undefined)}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) =>
        update({ [field]: field === "expression" ? e.target.value : e.target.value || null } as Partial<ObjectOf[K]>)
      }
    />
  );
}

function CheckboxCell<K extends "indexes" | "checks">({ kind, row, field }: { kind: K; row: number; field: K extends "indexes" ? "unique" : "noInherit" }) {
  const { value, update } = useObject(kind, row);
  if (!value) return null;
  const checked = (value as unknown as Record<string, boolean>)[field];
  return (
    <div className="flex justify-center">
      <input
        type="checkbox"
        className="checkbox checkbox-xs"
        checked={checked}
        onChange={(e) => update({ [field]: e.target.checked } as Partial<ObjectOf[K]>)}
      />
    </div>
  );
}

/** A field list shown as text, edited in the picker dialog. */
function PickerCell({ text, error, title, open, disabled, children }: { text: string; error?: string; title: string; open: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className={`flex h-6 items-center ${error ? "outline outline-error" : ""}`} title={error ?? (text || undefined)}>
      <span className="min-w-0 flex-1 truncate px-2 text-xs">{text}</span>
      <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={disabled} onClick={open} aria-label={title}>
        <Ellipsis className="size-3.5" />
      </button>
      {children}
    </div>
  );
}

const keysText = (keys: IndexColumn[]) => keys.map((k) => (k.descending ? `${k.column} DESC` : k.column)).join(", ");
const asKeys = (names: string[]): IndexColumn[] => names.map((column) => ({ column, descending: false }));

function IndexFieldsCell({ row }: { row: number }) {
  const { value, error, update } = useObject("indexes", row, "columns");
  const { fields } = useDesign();
  const [open, setOpen] = useState(false);
  if (!value) return null;
  return (
    <PickerCell text={keysText(value.columns)} error={error} title="Choose fields" open={() => setOpen(true)}>
      {open && (
        <ColumnPickerDialog
          title="Index Fields"
          available={fields}
          value={value.columns}
          withOrder
          withExpressions
          onSave={(columns) => update({ columns })}
          onClose={() => setOpen(false)}
        />
      )}
    </PickerCell>
  );
}

function FieldListCell({ kind, row }: { kind: "uniques" | "foreignKeys"; row: number }) {
  const { value, error, update } = useObject(kind, row, "columns");
  const { fields } = useDesign();
  const [open, setOpen] = useState(false);
  if (!value) return null;
  return (
    <PickerCell text={value.columns.join(", ")} error={error} title="Choose fields" open={() => setOpen(true)}>
      {open && (
        <ColumnPickerDialog
          title="Fields"
          available={fields}
          value={asKeys(value.columns)}
          onSave={(keys) => update({ columns: keys.map((k) => k.column) })}
          onClose={() => setOpen(false)}
        />
      )}
    </PickerCell>
  );
}

/** Options for a catalog select: the loaded names, plus the current value if it's missing. */
function catalogOptions(lookup: Lookup, current: string) {
  const names = lookup.status === "loaded" ? lookup.names : [];
  return current && !names.includes(current) ? [current, ...names] : names;
}

function RefSchemaCell({ row }: { row: number }) {
  const { value, update } = useObject("foreignKeys", row);
  const { tab } = useDesign();
  const schemas = useSchemas(tab.connectionId, tab.database);
  if (!value) return null;
  return (
    <select
      className={cellSelect}
      value={value.refSchema}
      onChange={(e) => update({ refSchema: e.target.value, refTable: "", refColumns: [] })}
    >
      {catalogOptions(schemas, value.refSchema).map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function RefTableCell({ row }: { row: number }) {
  const { value, error, update } = useObject("foreignKeys", row, "refTable");
  const { tab } = useDesign();
  const tables = useTables(tab.connectionId, tab.database, value?.refSchema ?? "");
  if (!value) return null;
  return (
    <select
      className={`${cellSelect} ${error ? "select-error" : ""}`}
      value={value.refTable}
      title={error ?? (tables.status === "error" ? tables.error : undefined)}
      onChange={(e) => update({ refTable: e.target.value, refColumns: [] })}
    >
      <option value="">{tables.status === "loading" ? "Loading…" : ""}</option>
      {catalogOptions(tables, value.refTable).map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function RefFieldsCell({ row }: { row: number }) {
  const { value, error, update } = useObject("foreignKeys", row, "refColumns");
  const { tab, name, fields } = useDesign();
  // A self-reference picks from the fields as edited, including unsaved ones.
  const self = name !== "" && value?.refSchema === tab.schema && value?.refTable === name;
  const columns = useColumns(tab.connectionId, tab.database, value?.refSchema ?? "", self || !value ? "" : value.refTable);
  const available = self ? fields : columns.status === "loaded" ? columns.names : [];
  const [open, setOpen] = useState(false);
  if (!value) return null;
  return (
    <PickerCell
      text={value.refColumns.join(", ")}
      error={error ?? (columns.status === "error" ? columns.error : undefined)}
      title="Choose referenced fields"
      disabled={!value.refTable}
      open={() => setOpen(true)}
    >
      {open && (
        <ColumnPickerDialog
          title={`Referenced Fields (${value.refTable})`}
          available={available}
          value={asKeys(value.refColumns)}
          onSave={(keys) => update({ refColumns: keys.map((k) => k.column) })}
          onClose={() => setOpen(false)}
        />
      )}
    </PickerCell>
  );
}

const actionLabel = (a: ForeignKeyAction) => a.replace("-", " ").toUpperCase();

function ActionCell({ row, field }: { row: number; field: "onUpdate" | "onDelete" }) {
  const { value, update } = useObject("foreignKeys", row);
  if (!value) return null;
  return (
    <select className={cellSelect} value={value[field]} onChange={(e) => update({ [field]: e.target.value as ForeignKeyAction })}>
      {FOREIGN_KEY_ACTIONS.map((a) => (
        <option key={a} value={a}>
          {actionLabel(a)}
        </option>
      ))}
    </select>
  );
}

function MethodCell({ row }: { row: number }) {
  const { value, update } = useObject("indexes", row);
  if (!value) return null;
  const methods = INDEX_METHODS.includes(value.method) ? INDEX_METHODS : [value.method, ...INDEX_METHODS];
  return (
    <select className={cellSelect} value={value.method} onChange={(e) => update({ method: e.target.value })}>
      {methods.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

const features = tableFeatures({});

const indexHelper = createColumnHelper<typeof features, IndexDesign>();
const INDEX_COLUMNS = indexHelper.columns([
  indexHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="indexes" row={c.row.index} /> }),
  indexHelper.display({ id: "columns", header: "Fields", cell: (c) => <IndexFieldsCell row={c.row.index} /> }),
  indexHelper.display({ id: "method", header: "Index Method", cell: (c) => <MethodCell row={c.row.index} /> }),
  indexHelper.display({ id: "unique", header: "Unique", cell: (c) => <CheckboxCell kind="indexes" row={c.row.index} field="unique" /> }),
  indexHelper.display({
    id: "predicate",
    header: "Where",
    cell: (c) => <TextCell kind="indexes" row={c.row.index} field="predicate" mono placeholder="(all rows)" />,
  }),
  indexHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="indexes" row={c.row.index} field="comment" /> }),
]);

const fkHelper = createColumnHelper<typeof features, ForeignKeyDesign>();
const FOREIGN_KEY_COLUMNS = fkHelper.columns([
  fkHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="foreignKeys" row={c.row.index} /> }),
  fkHelper.display({ id: "columns", header: "Fields", cell: (c) => <FieldListCell kind="foreignKeys" row={c.row.index} /> }),
  fkHelper.display({ id: "refSchema", header: "Referenced Schema", cell: (c) => <RefSchemaCell row={c.row.index} /> }),
  fkHelper.display({ id: "refTable", header: "Referenced Table", cell: (c) => <RefTableCell row={c.row.index} /> }),
  fkHelper.display({ id: "refColumns", header: "Referenced Fields", cell: (c) => <RefFieldsCell row={c.row.index} /> }),
  fkHelper.display({ id: "onDelete", header: "On Delete", cell: (c) => <ActionCell row={c.row.index} field="onDelete" /> }),
  fkHelper.display({ id: "onUpdate", header: "On Update", cell: (c) => <ActionCell row={c.row.index} field="onUpdate" /> }),
  fkHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="foreignKeys" row={c.row.index} field="comment" /> }),
]);

const uniqueHelper = createColumnHelper<typeof features, UniqueDesign>();
const UNIQUE_COLUMNS = uniqueHelper.columns([
  uniqueHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="uniques" row={c.row.index} /> }),
  uniqueHelper.display({ id: "columns", header: "Fields", cell: (c) => <FieldListCell kind="uniques" row={c.row.index} /> }),
  uniqueHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="uniques" row={c.row.index} field="comment" /> }),
]);

const checkHelper = createColumnHelper<typeof features, CheckDesign>();
const CHECK_COLUMNS = checkHelper.columns([
  checkHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="checks" row={c.row.index} /> }),
  checkHelper.display({
    id: "expression",
    header: "Expression",
    cell: (c) => <TextCell kind="checks" row={c.row.index} field="expression" mono placeholder="e.g. price >= 0" />,
  }),
  checkHelper.display({ id: "noInherit", header: "No Inherit", cell: (c) => <CheckboxCell kind="checks" row={c.row.index} field="noInherit" /> }),
  checkHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="checks" row={c.row.index} field="comment" /> }),
]);

/** Column widths in px, by column id. */
const WIDTHS: Record<string, number> = {
  name: 200,
  columns: 220,
  method: 110,
  unique: 70,
  predicate: 220,
  comment: 200,
  refSchema: 150,
  refTable: 170,
  refColumns: 180,
  onDelete: 120,
  onUpdate: 120,
  expression: 320,
  noInherit: 80,
};

const CENTERED = new Set(["unique", "noInherit"]);

interface ObjectGridProps<T> {
  id: string;
  kind: ObjectKind;
  rows: T[];
  columns: ReturnType<typeof indexHelper.columns>;
  emptyText: string;
}

function ObjectGrid<T>({ id, kind, rows, columns, emptyText }: ObjectGridProps<T>) {
  const selected = useTableDesigner((s) => s.designers[id]?.selectedObjects[kind] ?? null);
  const selectObject = useTableDesigner((s) => s.selectObject);
  const table = useTable({ features, columns, data: rows as unknown as IndexDesign[] });

  return (
    <DesignerId.Provider value={id}>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table table-xs table-pin-rows w-auto table-fixed">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th className="w-6" />
                {group.headers.map((h) => (
                  <th key={h.id} style={{ width: WIDTHS[h.column.id] }} className={CENTERED.has(h.column.id) ? "text-center" : ""}>
                    <table.FlexRender header={h} />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                aria-selected={row.index === selected}
                className={row.index === selected ? "bg-primary/15" : "hover:bg-base-300/40"}
                onFocus={() => selectObject(id, kind, row.index)}
                onMouseDown={() => selectObject(id, kind, row.index)}
              >
                <td className="text-center text-base-content/40">{row.index === selected ? "▸" : ""}</td>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="p-0">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="py-4 text-center text-base-content/50">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DesignerId.Provider>
  );
}

const NO_ROWS: never[] = [];

/** Rows of one index / constraint tab, re-rendered when that list changes. */
function useRows<K extends ObjectKind>(id: string, kind: K) {
  return useTableDesigner((s) => s.designers[id]?.edited[kind] ?? NO_ROWS) as ObjectOf[K][];
}

const asColumns = (columns: unknown) => columns as ReturnType<typeof indexHelper.columns>;

export function IndexesGrid({ id }: { id: string }) {
  return <ObjectGrid id={id} kind="indexes" rows={useRows(id, "indexes")} columns={INDEX_COLUMNS} emptyText="No indexes. Click Add Index to create one." />;
}

export function ForeignKeysGrid({ id }: { id: string }) {
  return (
    <ObjectGrid id={id} kind="foreignKeys" rows={useRows(id, "foreignKeys")} columns={asColumns(FOREIGN_KEY_COLUMNS)} emptyText="No foreign keys. Click Add Foreign Key to create one." />
  );
}

export function UniquesGrid({ id }: { id: string }) {
  return <ObjectGrid id={id} kind="uniques" rows={useRows(id, "uniques")} columns={asColumns(UNIQUE_COLUMNS)} emptyText="No unique constraints. Click Add Unique to create one." />;
}

export function ChecksGrid({ id }: { id: string }) {
  return <ObjectGrid id={id} kind="checks" rows={useRows(id, "checks")} columns={asColumns(CHECK_COLUMNS)} emptyText="No check constraints. Click Add Check to create one." />;
}
