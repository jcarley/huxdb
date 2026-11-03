// Edit state of each open table designer, keyed by tab id. It lives outside the
// components so the close prompt can save a tab that isn't showing.

import { create } from "zustand";
import * as api from "../lib/api";
import { newColumn } from "../lib/types";
import type { ColumnDesign, TableDesign } from "../lib/types";
import { useExplorer } from "./explorer";
import { useTabs } from "./tabs";
import type { DesignerTab } from "./tabs";

export interface Designer {
  tab: DesignerTab;
  status: "loading" | "loaded" | "error";
  loadError: string | null;
  /** The table as loaded from the server; null for a table not yet created. */
  original: TableDesign | null;
  edited: TableDesign;
  /** What `edited` started as; edits are unsaved while they differ. */
  baseline: TableDesign;
  selectedRow: number | null;
  saving: boolean;
  saveError: string | null;
  /** Field errors are shown after a save attempt finds some. */
  showErrors: boolean;
  /** The new-table name prompt is open. */
  askingName: boolean;
}

interface TableDesignerState {
  designers: Record<string, Designer>;

  open: (tab: DesignerTab) => void;
  load: (id: string) => Promise<void>;
  dispose: (id: string) => void;
  selectRow: (id: string, row: number | null) => void;
  updateColumn: (id: string, row: number, patch: Partial<ColumnDesign>) => void;
  addColumn: (id: string) => void;
  /** Inserts above the selected field. New tables only. */
  insertColumn: (id: string) => void;
  deleteColumn: (id: string) => void;
  /** Moves the selected field up (-1) or down (1). New tables only. */
  moveColumn: (id: string, by: -1 | 1) => void;
  /** Adds the selected field to the primary key (last), or removes it. */
  toggleKey: (id: string) => void;
  setComment: (id: string, comment: string) => void;
  /** Saves after checking fields; a new table first asks for its name. */
  requestSave: (id: string) => void;
  setAskingName: (id: string, value: boolean) => void;
  /** Runs the save. Resolves to whether it succeeded. */
  save: (id: string, name?: string) => Promise<boolean>;
}

const emptyDesign = (tab: DesignerTab): TableDesign => ({
  schema: tab.schema,
  name: "",
  comment: null,
  primaryKeyName: null,
  columns: [newColumn()],
});

/** Renumbers key positions 1..n, keeping their order. */
function renumberKeys(columns: ColumnDesign[]): ColumnDesign[] {
  const keyed = columns.filter((c) => c.keyOrder !== null).sort((a, b) => a.keyOrder! - b.keyOrder!);
  return columns.map((c) => (c.keyOrder === null ? c : { ...c, keyOrder: keyed.indexOf(c) + 1 }));
}

export type FieldErrors = Partial<Record<"name" | "dataType" | "length" | "scale", string>>;

/** Per-field checks, repeating the backend's `TableDesign::validate` so errors show in the grid. */
export function columnErrors(columns: ColumnDesign[], row: number): FieldErrors {
  const c = columns[row];
  const errors: FieldErrors = {};
  const name = c.name.trim();
  if (!name) errors.name = "Name is required.";
  else if (columns.some((o, i) => i !== row && o.name.trim() === name)) errors.name = "Name is used more than once.";
  if (!c.dataType.trim()) errors.dataType = "Type is required.";
  if (c.length !== null && c.length <= 0) errors.length = "Length must be greater than 0.";
  if (c.scale !== null && c.scale < 0) errors.scale = "Scale can't be negative.";
  else if (c.scale !== null && c.length === null) errors.scale = "Scale needs a length.";
  return errors;
}

const hasErrors = (design: TableDesign) =>
  design.columns.some((_, row) => Object.keys(columnErrors(design.columns, row)).length > 0);

/** Whether a designer has edits that aren't saved. */
export const designerDirty = (d: Designer | undefined) => !!d && JSON.stringify(d.edited) !== JSON.stringify(d.baseline);

export const isDirty = (id: string) => designerDirty(useTableDesigner.getState().designers[id]);

export const useTableDesigner = create<TableDesignerState>((set, get) => {
  const patch = (id: string, change: (d: Designer) => Partial<Designer>) =>
    set((s) => {
      const d = s.designers[id];
      return d ? { designers: { ...s.designers, [id]: { ...d, ...change(d) } } } : s;
    });

  /** Applies `change` to the edited columns and selects `select(d)` afterwards. */
  const editColumns = (
    id: string,
    change: (columns: ColumnDesign[], d: Designer) => ColumnDesign[],
    select?: (d: Designer, columns: ColumnDesign[]) => number | null,
  ) =>
    patch(id, (d) => {
      const columns = change(d.edited.columns, d);
      return { edited: { ...d.edited, columns }, selectedRow: select ? select(d, columns) : d.selectedRow };
    });

  return {
    designers: {},

    open: (tab) => {
      const design = emptyDesign(tab);
      set((s) => ({
        designers: {
          ...s.designers,
          [tab.id]: {
            tab,
            status: tab.table === null ? "loaded" : "loading",
            loadError: null,
            original: null,
            edited: design,
            baseline: design,
            selectedRow: tab.table === null ? 0 : null,
            saving: false,
            saveError: null,
            showErrors: false,
            askingName: false,
          },
        },
      }));
      if (tab.table !== null) void get().load(tab.id);
    },

    load: async (id) => {
      const d = get().designers[id];
      if (!d || d.tab.table === null) return;
      const { connectionId, database, schema, table } = d.tab;
      patch(id, () => ({ status: "loading", loadError: null }));
      try {
        const design = await api.loadTableDesign(connectionId, database, schema, table);
        patch(id, () => ({ status: "loaded", original: design, edited: design, baseline: design, selectedRow: 0 }));
      } catch (err) {
        patch(id, () => ({ status: "error", loadError: api.errorMessage(err) }));
      }
    },

    dispose: (id) =>
      set((s) => {
        const { [id]: _, ...designers } = s.designers;
        return { designers };
      }),

    selectRow: (id, row) => patch(id, () => ({ selectedRow: row })),

    updateColumn: (id, row, change) =>
      editColumns(id, (columns) => columns.map((c, i) => (i === row ? { ...c, ...change } : c))),

    addColumn: (id) => editColumns(id, (columns) => [...columns, newColumn()], (_, columns) => columns.length - 1),

    insertColumn: (id) =>
      editColumns(
        id,
        (columns, d) => {
          const at = d.selectedRow ?? 0;
          return [...columns.slice(0, at), newColumn(), ...columns.slice(at)];
        },
        (d) => d.selectedRow ?? 0,
      ),

    deleteColumn: (id) =>
      editColumns(
        id,
        (columns, d) => (d.selectedRow === null ? columns : renumberKeys(columns.filter((_, i) => i !== d.selectedRow))),
        (d, columns) => (columns.length === 0 ? null : Math.min(d.selectedRow ?? 0, columns.length - 1)),
      ),

    moveColumn: (id, by) =>
      editColumns(
        id,
        (columns, d) => {
          const from = d.selectedRow;
          if (from === null || from + by < 0 || from + by >= columns.length) return columns;
          const next = [...columns];
          [next[from], next[from + by]] = [next[from + by], next[from]];
          return next;
        },
        (d, columns) =>
          d.selectedRow === null ? null : Math.min(Math.max(d.selectedRow + by, 0), columns.length - 1),
      ),

    toggleKey: (id) =>
      editColumns(id, (columns, d) => {
        const row = d.selectedRow;
        if (row === null) return columns;
        const next = Math.max(0, ...columns.map((c) => c.keyOrder ?? 0)) + 1;
        return renumberKeys(
          columns.map((c, i) =>
            i !== row ? c : c.keyOrder === null ? { ...c, keyOrder: next, notNull: true } : { ...c, keyOrder: null },
          ),
        );
      }),

    setComment: (id, comment) => patch(id, (d) => ({ edited: { ...d.edited, comment } })),

    requestSave: (id) => {
      const d = get().designers[id];
      if (!d || d.saving) return;
      if (hasErrors(d.edited)) {
        patch(id, () => ({ showErrors: true, saveError: "Fix the highlighted fields before saving." }));
        return;
      }
      if (d.original === null) patch(id, () => ({ askingName: true }));
      else void get().save(id);
    },

    setAskingName: (id, value) => patch(id, () => ({ askingName: value })),

    save: async (id, name) => {
      const d = get().designers[id];
      if (!d || d.saving) return false;
      const edited = name === undefined ? d.edited : { ...d.edited, name };
      patch(id, () => ({ saving: true, saveError: null, edited }));
      try {
        const { connectionId, database, schema } = d.tab;
        const saved = await api.saveTableDesign(connectionId, database, d.original, edited);
        patch(id, (cur) => ({
          saving: false,
          showErrors: false,
          original: saved,
          edited: saved,
          baseline: saved,
          selectedRow: cur.selectedRow === null ? null : Math.min(cur.selectedRow, saved.columns.length - 1),
          tab: { ...cur.tab, table: saved.name },
        }));
        const tabs = useTabs.getState();
        tabs.setTable(id, saved.name);
        tabs.schemaChanged(d.tab);
        useExplorer.getState().reload({ kind: "schema", connectionId, database, schema });
        return true;
      } catch (err) {
        patch(id, () => ({ saving: false, saveError: api.errorMessage(err) }));
        return false;
      }
    },
  };
});
