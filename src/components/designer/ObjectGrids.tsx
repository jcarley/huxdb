import { useContext, useState } from "react";
import type { ReactNode } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Ellipsis, Lock } from "lucide-react";
import { useColumns, useSchemas, useTables, useTriggerFunctions } from "../../lib/catalog";
import type { Lookup } from "../../lib/catalog";
import { FOREIGN_KEY_ACTIONS, INDEX_METHODS, TRIGGER_ENABLED } from "../../lib/types";
import type {
  CheckDesign,
  ExcludeDesign,
  ForeignKeyAction,
  ForeignKeyDesign,
  IndexColumn,
  IndexDesign,
  TriggerDesign,
  TriggerEnabled,
  TriggerTiming,
  UniqueDesign,
} from "../../lib/types";
import { objectErrors, useTableDesigner } from "../../stores/tableDesigner";
import type { ObjectKind, ObjectOf } from "../../stores/tableDesigner";
import { ColumnPickerDialog } from "./ColumnPickerDialog";
import type { PickedKey } from "./ColumnPickerDialog";
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
  // Constraint triggers and triggers with transition tables can't be edited.
  const readOnly = kind === "triggers" && (value as TriggerDesign | undefined)?.definition != null;
  return { id, value, error, update, readOnly };
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
  const { value, error, update, readOnly } = useObject(kind, row, "name");
  if (!value) return null;
  const definition = readOnly ? (value as TriggerDesign).definition! : undefined;
  return (
    <div className="flex items-center">
      {readOnly && <Lock className="ml-1.5 size-3 shrink-0 text-base-content/50" aria-label="Read-only definition" />}
      <input
      className={`${cellInput} ${error ? "input-error" : ""}`}
      value={value.name}
      title={error ?? definition}
      // Constraints and indexes may be left for PostgreSQL to name; triggers can't.
      placeholder={value.originalName || kind === "triggers" ? "" : "(automatic)"}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => update({ name: e.target.value })}
      />
    </div>
  );
}

/** Free text; for nullable fields, blank is stored as null. */
function TextCell<K extends ObjectKind>({ kind, row, field, mono, placeholder }: { kind: K; row: number; field: "comment" | "predicate" | "expression" | "when" | "arguments"; mono?: boolean; placeholder?: string }) {
  const { value, error, update, readOnly } = useObject(kind, row, field);
  if (!value) return null;
  const text = (value as unknown as Record<string, string | null>)[field] ?? "";
  const required = field === "expression" || field === "arguments";
  return (
    <input
      className={`${cellInput} ${mono ? "font-mono" : ""} ${error ? "input-error" : ""}`}
      value={text}
      disabled={readOnly && field !== "comment"}
      title={error ?? (text || undefined)}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) =>
        update({ [field]: required ? e.target.value : e.target.value || null } as Partial<ObjectOf[K]>)
      }
    />
  );
}

/** A boolean field. `errorField` names the error it shows (e.g. the trigger's events). */
function CheckboxCell<K extends ObjectKind>({ kind, row, field, errorField }: { kind: K; row: number; field: string; errorField?: string }) {
  const { value, error, update, readOnly } = useObject(kind, row, errorField);
  if (!value) return null;
  const checked = (value as unknown as Record<string, boolean>)[field];
  return (
    <div className="flex justify-center" title={error}>
      <input
        type="checkbox"
        className={`checkbox checkbox-xs ${error ? "checkbox-error" : ""}`}
        checked={checked}
        disabled={readOnly}
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
          onSave={(keys) => update({ columns: keys.map((k) => ({ column: k.column, descending: !!k.descending })) })}
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

function MethodCell({ kind, row }: { kind: "indexes" | "excludes"; row: number }) {
  const { value, update } = useObject(kind, row);
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

function ExcludeElementsCell({ row }: { row: number }) {
  const { value, error, update } = useObject("excludes", row, "elements");
  const { fields } = useDesign();
  const [open, setOpen] = useState(false);
  if (!value) return null;
  const text = value.elements.map((e) => `${e.column} WITH ${e.operator}`).join(", ");
  return (
    <PickerCell text={text} error={error} title="Choose elements" open={() => setOpen(true)}>
      {open && (
        <ColumnPickerDialog
          title="Exclude Elements"
          available={fields}
          value={value.elements}
          withOperator
          withExpressions
          onSave={(keys: PickedKey[]) => update({ elements: keys.map((k) => ({ column: k.column, operator: k.operator ?? "" })) })}
          onClose={() => setOpen(false)}
        />
      )}
    </PickerCell>
  );
}

function TimingCell({ row }: { row: number }) {
  const { value, update, readOnly } = useObject("triggers", row);
  if (!value) return null;
  return (
    <select className={cellSelect} value={value.timing} disabled={readOnly} onChange={(e) => update({ timing: e.target.value as TriggerTiming })}>
      <option value="before">BEFORE</option>
      <option value="after">AFTER</option>
    </select>
  );
}

function UpdateOfCell({ row }: { row: number }) {
  const { value, error, update, readOnly } = useObject("triggers", row, "updateColumns");
  const { fields } = useDesign();
  const [open, setOpen] = useState(false);
  if (!value) return null;
  return (
    <PickerCell
      text={value.onUpdate ? value.updateColumns.join(", ") : ""}
      error={error}
      title="Choose the fields whose update fires the trigger"
      disabled={readOnly || !value.onUpdate}
      open={() => setOpen(true)}
    >
      {open && (
        <ColumnPickerDialog
          title="Update Of Fields"
          available={fields}
          value={asKeys(value.updateColumns)}
          onSave={(keys) => update({ updateColumns: keys.map((k) => k.column) })}
          onClose={() => setOpen(false)}
        />
      )}
    </PickerCell>
  );
}

const SEP = "\u001f";

function TriggerFunctionCell({ row }: { row: number }) {
  const { value, error, update, readOnly } = useObject("triggers", row, "function");
  const { tab } = useDesign();
  const functions = useTriggerFunctions(tab.connectionId, tab.database);
  if (!value) return null;
  const current = value.functionName ? `${value.functionSchema}${SEP}${value.functionName}` : "";
  const options = functions.status === "loaded" ? functions.names.map((f) => `${f.schema}${SEP}${f.name}`) : [];
  if (current && !options.includes(current)) options.unshift(current);
  return (
    <select
      className={`${cellSelect} ${error ? "select-error" : ""}`}
      value={current}
      disabled={readOnly}
      title={error ?? (functions.status === "error" ? functions.error : undefined)}
      onChange={(e) => {
        const [functionSchema = "", functionName = ""] = e.target.value.split(SEP);
        update({ functionSchema, functionName });
      }}
    >
      <option value="">{functions.status === "loading" ? "Loading…" : ""}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replace(SEP, ".")}
        </option>
      ))}
    </select>
  );
}

const ENABLED_LABELS: Record<TriggerEnabled, string> = {
  origin: "Enabled",
  disabled: "Disabled",
  replica: "Replica",
  always: "Always",
};

function EnabledCell({ row }: { row: number }) {
  const { value, update } = useObject("triggers", row);
  if (!value) return null;
  return (
    <select className={cellSelect} value={value.enabled} onChange={(e) => update({ enabled: e.target.value as TriggerEnabled })}>
      {TRIGGER_ENABLED.map((state) => (
        <option key={state} value={state}>
          {ENABLED_LABELS[state]}
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
  indexHelper.display({ id: "method", header: "Index Method", cell: (c) => <MethodCell kind="indexes" row={c.row.index} /> }),
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

const excludeHelper = createColumnHelper<typeof features, ExcludeDesign>();
const EXCLUDE_COLUMNS = excludeHelper.columns([
  excludeHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="excludes" row={c.row.index} /> }),
  excludeHelper.display({ id: "elements", header: "Elements", cell: (c) => <ExcludeElementsCell row={c.row.index} /> }),
  excludeHelper.display({ id: "method", header: "Index Method", cell: (c) => <MethodCell kind="excludes" row={c.row.index} /> }),
  excludeHelper.display({
    id: "predicate",
    header: "Where",
    cell: (c) => <TextCell kind="excludes" row={c.row.index} field="predicate" mono placeholder="(all rows)" />,
  }),
  excludeHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="excludes" row={c.row.index} field="comment" /> }),
]);

const triggerHelper = createColumnHelper<typeof features, TriggerDesign>();
const event = (field: "onInsert" | "onUpdate" | "onDelete" | "onTruncate", header: string) =>
  triggerHelper.display({
    // Not the field name: the foreign key grid's onUpdate / onDelete ids are taken.
    id: `event${header}`,
    header,
    cell: (c) => <CheckboxCell kind="triggers" row={c.row.index} field={field} errorField="events" />,
  });
const TRIGGER_COLUMNS = triggerHelper.columns([
  triggerHelper.display({ id: "name", header: "Name", cell: (c) => <NameCell kind="triggers" row={c.row.index} /> }),
  triggerHelper.display({ id: "forEachRow", header: "Row", cell: (c) => <CheckboxCell kind="triggers" row={c.row.index} field="forEachRow" errorField="events" /> }),
  triggerHelper.display({ id: "timing", header: "Fires", cell: (c) => <TimingCell row={c.row.index} /> }),
  event("onInsert", "Insert"),
  event("onUpdate", "Update"),
  event("onDelete", "Delete"),
  event("onTruncate", "Truncate"),
  triggerHelper.display({ id: "updateColumns", header: "Update Of", cell: (c) => <UpdateOfCell row={c.row.index} /> }),
  triggerHelper.display({
    id: "when",
    header: "When",
    cell: (c) => <TextCell kind="triggers" row={c.row.index} field="when" mono placeholder="e.g. new.price <> old.price" />,
  }),
  triggerHelper.display({ id: "function", header: "Function", cell: (c) => <TriggerFunctionCell row={c.row.index} /> }),
  triggerHelper.display({
    id: "arguments",
    header: "Arguments",
    cell: (c) => <TextCell kind="triggers" row={c.row.index} field="arguments" mono placeholder="'a', 42" />,
  }),
  triggerHelper.display({ id: "enabled", header: "Enabled", cell: (c) => <EnabledCell row={c.row.index} /> }),
  triggerHelper.display({ id: "comment", header: "Comment", cell: (c) => <TextCell kind="triggers" row={c.row.index} field="comment" /> }),
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
  elements: 260,
  forEachRow: 50,
  timing: 90,
  eventInsert: 55,
  eventUpdate: 60,
  eventDelete: 55,
  eventTruncate: 70,
  updateColumns: 150,
  when: 220,
  function: 200,
  arguments: 130,
  enabled: 100,
};

const CENTERED = new Set(["unique", "noInherit", "forEachRow", "eventInsert", "eventUpdate", "eventDelete", "eventTruncate"]);

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

export function ExcludesGrid({ id }: { id: string }) {
  return <ObjectGrid id={id} kind="excludes" rows={useRows(id, "excludes")} columns={asColumns(EXCLUDE_COLUMNS)} emptyText="No exclusion constraints. Click Add Exclude to create one." />;
}

export function TriggersGrid({ id }: { id: string }) {
  return <ObjectGrid id={id} kind="triggers" rows={useRows(id, "triggers")} columns={asColumns(TRIGGER_COLUMNS)} emptyText="No triggers. Click Add Trigger to create one." />;
}
