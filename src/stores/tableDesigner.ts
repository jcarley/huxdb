// Edit state of each open table designer, keyed by tab id. It lives outside the
// components so the close prompt can save a tab that isn't showing.

import { create } from "zustand";
import * as api from "../lib/api";
import { newCheck, newColumn, newForeignKey, newIndex, newUnique } from "../lib/types";
import type { CheckDesign, ColumnDesign, ForeignKeyDesign, IndexDesign, TableDesign, UniqueDesign } from "../lib/types";
import { invalidateCatalog } from "../lib/catalog";
import { useExplorer } from "./explorer";
import { useTabs } from "./tabs";
import type { DesignerTab } from "./tabs";

/** The designer tabs listing indexes and constraints, named after their `TableDesign` arrays. */
export type ObjectKind = "indexes" | "foreignKeys" | "uniques" | "checks";

export interface ObjectOf {
  indexes: IndexDesign;
  foreignKeys: ForeignKeyDesign;
  uniques: UniqueDesign;
  checks: CheckDesign;
}

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
  /** Selected row on each index / constraint tab. */
  selectedObjects: Record<ObjectKind, number | null>;
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
  selectObject: (id: string, kind: ObjectKind, row: number | null) => void;
  updateObject: <K extends ObjectKind>(id: string, kind: K, row: number, patch: Partial<ObjectOf[K]>) => void;
  addObject: (id: string, kind: ObjectKind) => void;
  /** Deletes the selected row of a tab. */
  deleteObject: (id: string, kind: ObjectKind) => void;
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
  indexes: [],
  foreignKeys: [],
  uniques: [],
  checks: [],
});

const NO_SELECTION: Record<ObjectKind, number | null> = { indexes: null, foreignKeys: null, uniques: null, checks: null };

const newObject = (kind: ObjectKind, design: TableDesign): ObjectOf[ObjectKind] => {
  switch (kind) {
    case "indexes":
      return newIndex();
    case "foreignKeys":
      return newForeignKey(design.schema);
    case "uniques":
      return newUnique();
    case "checks":
      return newCheck();
  }
};

/** Whether a foreign key points back at the table being designed. */
const isSelfReference = (fk: ForeignKeyDesign, design: TableDesign) =>
  design.name !== "" && fk.refSchema === design.schema && fk.refTable === design.name;

/**
 * Applies a field rename (`to` a string) or deletion (`to` null) to the
 * indexes and constraints that use the field, as Navicat does. Objects left
 * with no fields are removed. The backend matches objects by definition, so
 * a renamed field's objects come out unchanged.
 */
function updateReferences(design: TableDesign, from: string, to: string | null): TableDesign {
  const rename = (names: string[]) =>
    to === null ? names.filter((n) => n !== from) : names.map((n) => (n === from ? to : n));
  return {
    ...design,
    indexes: design.indexes
      .map((x) => ({
        ...x,
        columns:
          to === null
            ? x.columns.filter((c) => c.column !== from)
            : x.columns.map((c) => (c.column === from ? { ...c, column: to } : c)),
      }))
      .filter((x) => x.columns.length > 0),
    uniques: design.uniques.map((x) => ({ ...x, columns: rename(x.columns) })).filter((x) => x.columns.length > 0),
    foreignKeys: design.foreignKeys
      .map((fk) => {
        if (to !== null) {
          return {
            ...fk,
            columns: rename(fk.columns),
            refColumns: isSelfReference(fk, design) ? rename(fk.refColumns) : fk.refColumns,
          };
        }
        // Deleting a field drops it from both sides of the pair it is in.
        const keep = fk.columns.map((c, i) => c !== from && !(isSelfReference(fk, design) && fk.refColumns[i] === from));
        return {
          ...fk,
          columns: fk.columns.filter((_, i) => keep[i]),
          refColumns: fk.refColumns.filter((_, i) => keep[i] ?? true),
        };
      })
      .filter((fk) => fk.columns.length > 0),
  };
}

/** Errors per cell of an index / constraint row, mirroring the backend's checks. */
export function objectErrors(design: TableDesign, kind: ObjectKind, row: number): Record<string, string> {
  const errors: Record<string, string> = {};
  const x = design[kind][row] as ObjectOf[ObjectKind] | undefined;
  if (!x) return errors;
  const name = x.name.trim();
  if (!name && x.originalName) errors.name = "An existing object needs a name.";
  else if (!name && x.comment?.trim()) errors.name = "A name is required to add a comment.";
  else if (name) {
    const names = [design.primaryKeyName, ...(["indexes", "foreignKeys", "uniques", "checks"] as const).flatMap((k) =>
      design[k].filter((o) => o !== x).map((o) => o.name.trim()),
    )];
    if (names.includes(name)) errors.name = "The name is used by another index or constraint.";
  }
  const fields = new Set(design.columns.map((c) => c.name.trim()));
  const missing = (list: string[]) => list.find((c) => !fields.has(c));
  switch (kind) {
    case "indexes":
      if ((x as IndexDesign).columns.length === 0) errors.columns = "Choose at least one field.";
      break;
    case "uniques": {
      const u = x as UniqueDesign;
      if (u.columns.length === 0) errors.columns = "Choose at least one field.";
      else if (missing(u.columns)) errors.columns = `There is no field "${missing(u.columns)}".`;
      break;
    }
    case "foreignKeys": {
      const fk = x as ForeignKeyDesign;
      if (fk.columns.length === 0) errors.columns = "Choose at least one field.";
      else if (missing(fk.columns)) errors.columns = `There is no field "${missing(fk.columns)}".`;
      if (!fk.refSchema || !fk.refTable) errors.refTable = "Choose the referenced table.";
      else if (fk.refColumns.length !== fk.columns.length) errors.refColumns = "Choose one referenced field for each field.";
      break;
    }
    case "checks":
      if (!(x as CheckDesign).expression.trim()) errors.expression = "The expression is required.";
      break;
  }
  return errors;
}

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
  design.columns.some((_, row) => Object.keys(columnErrors(design.columns, row)).length > 0) ||
  (["indexes", "foreignKeys", "uniques", "checks"] as const).some((kind) =>
    design[kind].some((_, row) => Object.keys(objectErrors(design, kind, row)).length > 0),
  );

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
            selectedObjects: NO_SELECTION,
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
      patch(id, (d) => {
        const old = d.edited.columns[row];
        const columns = d.edited.columns.map((c, i) => (i === row ? { ...c, ...change } : c));
        let edited = { ...d.edited, columns };
        // A rename carries over to the objects using the field, unless the old
        // or new name is shared with another field (then it's ambiguous).
        const to = change.name;
        const unique = (name: string) => columns.filter((c) => c.name === name).length === (name === to ? 1 : 0);
        if (old && to !== undefined && to !== old.name && unique(old.name) && unique(to)) {
          edited = updateReferences(edited, old.name, to);
        }
        return { edited };
      }),

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
      patch(id, (d) => {
        const row = d.selectedRow;
        if (row === null) return {};
        const removed = d.edited.columns[row];
        const columns = renumberKeys(d.edited.columns.filter((_, i) => i !== row));
        let edited = { ...d.edited, columns };
        if (!columns.some((c) => c.name === removed.name)) edited = updateReferences(edited, removed.name, null);
        return { edited, selectedRow: columns.length === 0 ? null : Math.min(row, columns.length - 1) };
      }),

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

    selectObject: (id, kind, row) => patch(id, (d) => ({ selectedObjects: { ...d.selectedObjects, [kind]: row } })),

    updateObject: (id, kind, row, change) =>
      patch(id, (d) => ({
        edited: {
          ...d.edited,
          [kind]: (d.edited[kind] as ObjectOf[typeof kind][]).map((x, i) => (i === row ? { ...x, ...change } : x)),
        },
      })),

    addObject: (id, kind) =>
      patch(id, (d) => {
        const list = [...d.edited[kind], newObject(kind, d.edited)];
        return {
          edited: { ...d.edited, [kind]: list },
          selectedObjects: { ...d.selectedObjects, [kind]: list.length - 1 },
        };
      }),

    deleteObject: (id, kind) =>
      patch(id, (d) => {
        const row = d.selectedObjects[kind];
        if (row === null) return {};
        const list = d.edited[kind].filter((_, i) => i !== row);
        return {
          edited: { ...d.edited, [kind]: list },
          selectedObjects: { ...d.selectedObjects, [kind]: list.length === 0 ? null : Math.min(row, list.length - 1) },
        };
      }),

    requestSave: (id) => {
      const d = get().designers[id];
      if (!d || d.saving) return;
      if (hasErrors(d.edited)) {
        patch(id, () => ({ showErrors: true, saveError: "Fix the highlighted cells before saving." }));
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
          // Saved objects come back sorted by name, so row positions change.
          selectedObjects: NO_SELECTION,
          tab: { ...cur.tab, table: saved.name },
        }));
        const tabs = useTabs.getState();
        tabs.setTable(id, saved.name);
        tabs.schemaChanged(d.tab);
        invalidateCatalog(connectionId, database, schema);
        useExplorer.getState().reload({ kind: "schema", connectionId, database, schema });
        return true;
      } catch (err) {
        patch(id, () => ({ saving: false, saveError: api.errorMessage(err) }));
        return false;
      }
    },
  };
});
