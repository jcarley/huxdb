import { useContext } from "react";
import type { KeyboardEvent } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { KeyRound } from "lucide-react";
import { PG_TYPES } from "../../lib/pgTypes";
import type { ColumnDesign, Identity } from "../../lib/types";
import { columnErrors, useTableDesigner } from "../../stores/tableDesigner";
import type { Designer } from "../../stores/tableDesigner";
import { DesignerId } from "./context";

const TYPES_LIST_ID = "huxdb-pg-types";


/** Arrow Up/Down moves to the same cell in the row above/below, like Navicat's grid. */
function moveFocus(e: KeyboardEvent<HTMLElement>, row: number, column: string) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const target = document.querySelector<HTMLElement>(`[data-cell="${row + (e.key === "ArrowUp" ? -1 : 1)}:${column}"]`);
  if (!target) return;
  e.preventDefault();
  target.focus();
}

/** Digits to a number; anything else (blank) to null. */
const toNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** The cell's field, and its error once the designer shows errors. */
function useCell<K extends keyof ColumnDesign>(row: number, field: K) {
  const id = useContext(DesignerId);
  const value = useTableDesigner((s) => s.designers[id]?.edited.columns[row]?.[field]) as ColumnDesign[K];
  const error = useTableDesigner((s) => {
    const d = s.designers[id];
    if (!d?.showErrors || !d.edited.columns[row]) return undefined;
    return (columnErrors(d.edited.columns, row) as Record<string, string | undefined>)[field];
  });
  const update = (patch: Partial<ColumnDesign>) => useTableDesigner.getState().updateColumn(id, row, patch);
  return { id, value, error, update };
}

const cellInput = "input input-xs w-full rounded-none border-transparent bg-transparent focus:border-primary";

function TextCell({ row, field }: { row: number; field: "name" | "dataType" }) {
  const { value, error, update } = useCell(row, field);
  const isType = field === "dataType";
  return (
    <input
      className={`${cellInput} ${error ? "input-error" : ""}`}
      data-cell={`${row}:${field}`}
      list={isType ? TYPES_LIST_ID : undefined}
      value={value}
      title={error}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => update({ [field]: e.target.value })}
      // Arrow keys belong to the suggestion list in the Type cell.
      onKeyDown={isType ? undefined : (e) => moveFocus(e, row, field)}
    />
  );
}

function NumberCell({ row, field }: { row: number; field: "length" | "scale" }) {
  const { value, error, update } = useCell(row, field);
  return (
    <input
      className={`${cellInput} text-right tabular-nums ${error ? "input-error" : ""}`}
      data-cell={`${row}:${field}`}
      inputMode="numeric"
      value={value ?? ""}
      title={error}
      onChange={(e) => update({ [field]: toNumber(e.target.value) })}
      onKeyDown={(e) => moveFocus(e, row, field)}
    />
  );
}

function NotNullCell({ row }: { row: number }) {
  const { value, update } = useCell(row, "notNull");
  const forced = useCell(row, "keyOrder").value !== null || useCell(row, "identity").value !== null;
  return (
    <div className="flex justify-center">
      <input
        type="checkbox"
        className="checkbox checkbox-xs"
        data-cell={`${row}:notNull`}
        checked={value || forced}
        disabled={forced}
        title={forced ? "Primary key and identity fields are always Not Null." : undefined}
        onChange={(e) => update({ notNull: e.target.checked })}
        onKeyDown={(e) => moveFocus(e, row, "notNull")}
      />
    </div>
  );
}

function KeyCell({ row }: { row: number }) {
  const { id, value: order } = useCell(row, "keyOrder");
  return (
    <button
      type="button"
      className="flex h-6 w-full items-center justify-center gap-0.5 text-warning"
      title={order === null ? "Add to primary key" : "Remove from primary key"}
      onClick={() => {
        const store = useTableDesigner.getState();
        store.selectRow(id, row);
        store.toggleKey(id);
      }}
    >
      {order !== null && (
        <>
          <KeyRound className="size-3.5" strokeWidth={2} />
          <span className="text-xs tabular-nums">{order}</span>
        </>
      )}
    </button>
  );
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, ColumnDesign>();
const COLUMNS = helper.columns([
  helper.accessor("name", { header: "Name", cell: (c) => <TextCell row={c.row.index} field="name" /> }),
  helper.accessor("dataType", { header: "Type", cell: (c) => <TextCell row={c.row.index} field="dataType" /> }),
  helper.accessor("length", { header: "Length", cell: (c) => <NumberCell row={c.row.index} field="length" /> }),
  helper.accessor("scale", { header: "Scale", cell: (c) => <NumberCell row={c.row.index} field="scale" /> }),
  helper.accessor("notNull", { header: "Not Null", cell: (c) => <NotNullCell row={c.row.index} /> }),
  helper.accessor("keyOrder", { header: "Key", cell: (c) => <KeyCell row={c.row.index} /> }),
]);

/** Column widths in px, by column id. */
const WIDTHS: Record<string, number> = { name: 220, dataType: 220, length: 80, scale: 80, notNull: 80, keyOrder: 60 };

/** The Fields tab: one editable row per column, with the selected field's properties below. */
export function FieldsGrid({ id, designer }: { id: string; designer: Designer }) {
  const { edited, selectedRow } = designer;
  const selectRow = useTableDesigner((s) => s.selectRow);
  const table = useTable({ features, columns: COLUMNS, data: edited.columns });

  const selected = selectedRow === null ? undefined : edited.columns[selectedRow];

  return (
    <DesignerId.Provider value={id}>
    <div className="flex min-h-0 flex-1 flex-col">
      <datalist id={TYPES_LIST_ID}>
        {PG_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table table-xs table-pin-rows w-auto table-fixed">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th className="w-6" />
                {group.headers.map((h) => (
                  <th key={h.id} style={{ width: WIDTHS[h.column.id] }} className={h.column.id === "name" || h.column.id === "dataType" ? "" : "text-center"}>
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
                aria-selected={row.index === selectedRow}
                className={row.index === selectedRow ? "bg-primary/15" : "hover:bg-base-300/40"}
                onFocus={() => selectRow(id, row.index)}
                onMouseDown={() => selectRow(id, row.index)}
              >
                <td className="text-center text-base-content/40">{row.index === selectedRow ? "▸" : ""}</td>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="p-0">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && selectedRow !== null && <FieldProperties id={id} row={selectedRow} column={selected} />}
    </div>
    </DesignerId.Provider>
  );
}

/** The selected field's details under the grid, like Navicat's lower panel. */
function FieldProperties({ id, row, column }: { id: string; row: number; column: ColumnDesign }) {
  const updateColumn = useTableDesigner((s) => s.updateColumn);
  const isGenerated = column.generated !== null;

  return (
    <div className="grid grid-cols-[auto_minmax(0,28rem)] items-center gap-x-3 gap-y-2 border-t border-base-300 bg-base-200/40 p-3 text-sm">
      {isGenerated ? (
        <>
          <label className="text-base-content/70">Generated</label>
          <input className="input input-sm w-full font-mono" value={column.generated ?? ""} readOnly title="Editing generated expressions comes later." />
        </>
      ) : (
        <>
          <label className="text-base-content/70" htmlFor="field-default">
            Default
          </label>
          <input
            id="field-default"
            className="input input-sm w-full font-mono"
            value={column.default ?? ""}
            placeholder={column.identity ? "(identity)" : "SQL expression, e.g. 0, now(), 'text'"}
            disabled={column.identity !== null}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => updateColumn(id, row, { default: e.target.value || null })}
          />
          <label className="text-base-content/70" htmlFor="field-identity">
            Identity
          </label>
          <select
            id="field-identity"
            className="select select-sm w-48"
            value={column.identity ?? ""}
            onChange={(e) => {
              const identity = (e.target.value || null) as Identity | null;
              // An identity replaces any default and makes the field NOT NULL.
              updateColumn(id, row, identity ? { identity, default: null, notNull: true } : { identity });
            }}
          >
            <option value="">None</option>
            <option value="always">Always</option>
            <option value="by-default">By Default</option>
          </select>
        </>
      )}
      <label className="self-start pt-1 text-base-content/70" htmlFor="field-comment">
        Comment
      </label>
      <textarea
        id="field-comment"
        className="textarea textarea-sm w-full"
        rows={2}
        value={column.comment ?? ""}
        onChange={(e) => updateColumn(id, row, { comment: e.target.value || null })}
      />
    </div>
  );
}
