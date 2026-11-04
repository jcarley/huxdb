// State of each open data editor (a table's rows in a grid), keyed by tab id.
// Like the designers' stores it lives outside the components, so the close
// prompt can commit a tab that isn't showing.
//
// Edits are pending until Commit: changed cells by row, new rows, and rows
// marked deleted. Commit sends them as one batch; without an open transaction
// the backend commits it at once, inside one it runs in a savepoint.
//
// `spec` is the filter and sort the page was loaded with. It lasts as long as
// the tab, and changes only when a page loads with the new one, so a bad typed
// WHERE leaves the last good spec, rows and paging in place. The filter builder
// edits `filterDraft`, a copy of the filter that takes effect on Apply.

import { create } from "zustand";
import * as api from "../lib/api";
import { andWith, conditionNode, isComplete, newGroup, removeNode, sameFilter } from "../lib/filterTree";
import type { DataSource, DataSpec, DataTarget, EditBatch, FilterGroup } from "../lib/types";
import type { DesignerTab } from "./tabs";

export type Value = string | null;

/** A row added in the grid, with only the columns that were edited. */
export interface NewRow {
  key: string;
  values: Record<string, Value>;
}

export const PAGE_SIZES = [100, 500, 1000, 5000];

export interface DataEditor {
  tab: DesignerTab;
  /** Columns and primary key; null until the first page loads. */
  source: DataSource | null;
  /** The current page as loaded, values in column order. */
  rows: Value[][];
  /** Each loaded row's key (see `rowKeys`), computed once per page. */
  rowKeys: string[];
  /** The filter and sort in effect. */
  spec: DataSpec;
  /** The filter builder is showing. */
  filterOpen: boolean;
  /** The filter builder's tree. Unapplied changes don't make the tab dirty. */
  filterDraft: FilterGroup;
  /** Zero-based. */
  page: number;
  pageSize: number;
  /** Rows the spec selects; null while counting or when counting took too long. */
  total: number | null;
  counting: boolean;
  /** What the tab is waiting for (Stop cancels it). */
  busy: "load" | "apply" | "transaction" | null;
  error: string | null;
  /** A passing message: rows changed, cancelled, transaction ended. */
  notice: string | null;
  /** Begin Transaction was used and the transaction is still open. */
  inTransaction: boolean;
  /** Changed cells: row key → column name → new value. */
  edits: Record<string, Record<string, Value>>;
  /** Row keys marked deleted. */
  deletes: Record<string, true>;
  inserts: NewRow[];
  /** Selected row keys, in selection order. */
  selected: string[];
  /** The cell being edited. */
  editing: { row: string; column: string } | null;
}

type DraftChange = (draft: FilterGroup) => FilterGroup;

interface DataEditorState {
  editors: Record<string, DataEditor>;

  open: (tab: DesignerTab) => void;
  dispose: (id: string) => void;
  /** Loads a page (the current one by default) and, with `recount`, the row
   * count. A `spec`, and a `draft` change made along with it, take effect if the page loads. */
  load: (id: string, page?: number, recount?: boolean, spec?: DataSpec, draft?: DraftChange) => Promise<void>;
  setPageSize: (id: string, size: number) => void;
  /** Header click: ascending, descending, off. `additive` (Shift) keeps the other sorted columns. */
  toggleSort: (id: string, column: string, additive: boolean) => void;
  /** From the cell menu: ANDed with the filter, and with the draft so it isn't lost. */
  addFilter: (id: string, condition: Parameters<typeof conditionNode>[0]) => void;
  /** Removes a node (a chip) from the filter and the draft. */
  removeFilter: (id: string, nodeId: string) => void;
  toggleFilterPane: (id: string) => void;
  setDraft: (id: string, change: DraftChange) => void;
  /** Applies the draft, if it's complete. A rejected one stays for fixing. */
  applyDraft: (id: string) => void;
  /** Applies the filter bar's text. A typed ORDER BY replaces the header sort. */
  applyTyped: (id: string, whereSql: string, orderSql: string) => void;
  clearSpec: (id: string) => void;
  select: (id: string, rows: string[]) => void;
  setEditing: (id: string, cell: { row: string; column: string } | null) => void;
  setCell: (id: string, row: string, column: string, value: Value) => void;
  addRow: (id: string) => void;
  removeSelected: (id: string) => void;
  /** Drops the pending edits. */
  cancelEdits: (id: string) => void;
  /** Applies the pending edits. Resolves to whether it succeeded. */
  commit: (id: string) => Promise<boolean>;
  beginTransaction: (id: string) => Promise<void>;
  /** Ends the transaction. Committing applies pending edits first; rolling back drops them. */
  endTransaction: (id: string, commit: boolean) => Promise<boolean>;
  /** For the close prompt: applies pending edits and commits the open transaction. */
  save: (id: string) => Promise<boolean>;
  stop: (id: string) => void;
  dismissMessages: (id: string) => void;
}

const NEW_ROW = "new:";
const isNewRow = (key: string) => key.startsWith(NEW_ROW);

/** The loaded rows' keys: each row's primary key values as JSON (its position without a key). */
const rowKeys = (source: DataSource, rows: Value[][]) => {
  const keyIndexes = source.primaryKey.map((k) => source.columns.findIndex((c) => c.name === k));
  return rows.map((row, i) => (keyIndexes.length === 0 ? `#${i}` : JSON.stringify(keyIndexes.map((k) => row[k]))));
};

export const pendingCount = (d: DataEditor) =>
  Object.keys(d.edits).length + Object.keys(d.deletes).length + d.inserts.length;

/** Filter, sort and paging changes wait for the running operation and pending edits. */
export const specLocked = (d: DataEditor | undefined) => !d || d.busy !== null || pendingCount(d) > 0;

const EMPTY_SPEC: DataSpec = { filter: null, sort: [], whereSql: null, orderSql: null };

/** An empty tree is no filter. */
const asFilter = (root: FilterGroup) => (root.children.length ? root : null);

/** Unsaved: pending edits or an open transaction. */
export const dataDirty = (d: DataEditor | undefined) => !!d && (d.inTransaction || pendingCount(d) > 0);

export const isDataDirty = (id: string) => dataDirty(useDataEditor.getState().editors[id]);

const target = ({ tab }: DataEditor): DataTarget => ({
  connectionId: tab.connectionId,
  database: tab.database,
  schema: tab.schema,
  table: tab.name ?? "",
});

/** The pending edits as the backend's batch. */
function toBatch(d: DataEditor): EditBatch {
  const cells = (values: Record<string, Value>) => Object.entries(values).map(([column, value]) => ({ column, value }));
  const key = (k: string) => JSON.parse(k) as string[];
  return {
    deletes: Object.keys(d.deletes).map(key),
    updates: Object.entries(d.edits).map(([k, values]) => ({ key: key(k), values: cells(values) })),
    inserts: d.inserts.map((r) => cells(r.values)),
  };
}

const noPending = { edits: {}, deletes: {}, inserts: [], selected: [], editing: null };

let newRowCounter = 0;
/** Per tab, so a slow response can't overwrite a newer one. */
const loadTokens: Record<string, number> = {};
const countTokens: Record<string, number> = {};

export const useDataEditor = create<DataEditorState>((set, get) => {
  const patch = (id: string, change: (d: DataEditor) => Partial<DataEditor>) =>
    set((s) => {
      const d = s.editors[id];
      return d ? { editors: { ...s.editors, [id]: { ...d, ...change(d) } } } : s;
    });

  /** A failure to show; Stop's cancellation is a notice, not an error. */
  const failure = (err: unknown): Partial<DataEditor> => {
    const message = api.errorMessage(err);
    return message === api.CANCELLED ? { notice: "Cancelled." } : { error: message };
  };
  /** Ends the operation in progress with a failure. */
  const fail = (id: string, err: unknown, extra: Partial<DataEditor> = {}) =>
    patch(id, () => ({ ...extra, busy: null, ...failure(err) }));

  const count = async (id: string) => {
    const d = get().editors[id];
    if (!d) return;
    const token = (countTokens[id] = (countTokens[id] ?? 0) + 1);
    patch(id, () => ({ counting: true, total: null }));
    try {
      const total = await api.countRows(id, target(d), d.spec);
      if (countTokens[id] === token) patch(id, () => ({ counting: false, total }));
    } catch (err) {
      // Counting runs beside other operations, so it leaves `busy` alone.
      if (countTokens[id] === token) patch(id, () => ({ counting: false, ...failure(err) }));
    }
  };

  /** Goes to the first page with a changed spec. A sort keeps the count. */
  const respec = (id: string, recount: boolean, change: (spec: DataSpec) => DataSpec, draft?: DraftChange) => {
    const d = get().editors[id];
    if (d && !specLocked(d)) void get().load(id, 0, recount, change(d.spec), draft);
  };

  return {
    editors: {},

    open: (tab) => {
      set((s) => ({
        editors: {
          ...s.editors,
          [tab.id]: {
            tab,
            source: null,
            rows: [],
            rowKeys: [],
            spec: EMPTY_SPEC,
            filterOpen: false,
            filterDraft: newGroup("and"),
            page: 0,
            pageSize: 1000,
            total: null,
            counting: false,
            busy: null,
            error: null,
            notice: null,
            inTransaction: false,
            ...noPending,
          },
        },
      }));
      void get().load(tab.id, 0, true);
    },

    dispose: (id) => {
      // Rolls back an open transaction; nothing to report if that fails.
      api.sessionClose(id).catch(() => {});
      delete loadTokens[id];
      delete countTokens[id];
      set((s) => {
        const { [id]: _, ...editors } = s.editors;
        return { editors };
      });
    },

    load: async (id, page, recount = false, nextSpec, draft) => {
      const d = get().editors[id];
      if (!d) return;
      const wanted = Math.max(0, page ?? d.page);
      const spec = nextSpec ?? d.spec;
      const token = (loadTokens[id] = (loadTokens[id] ?? 0) + 1);
      patch(id, () => ({ busy: "load", error: null }));
      try {
        const result = await api.fetchDataPage(id, target(d), spec, wanted * d.pageSize, d.pageSize);
        if (loadTokens[id] !== token) return;
        patch(id, (e) => ({
          busy: null,
          filterDraft: draft ? draft(e.filterDraft) : e.filterDraft,
          source: result.source,
          rows: result.rows,
          rowKeys: rowKeys(result.source, result.rows),
          spec,
          page: wanted,
          ...noPending,
        }));
      } catch (err) {
        if (loadTokens[id] === token) fail(id, err);
        return;
      }
      if (recount) await count(id);
    },

    setPageSize: (id, size) => {
      patch(id, () => ({ pageSize: size }));
      void get().load(id, 0);
    },

    toggleSort: (id, column, additive) =>
      respec(id, false, (spec) => {
        const current = spec.sort.find((k) => k.column === column);
        // Ascending, descending, then off.
        const next = current?.descending ? null : { column, descending: !!current };
        const others = additive ? spec.sort : [];
        const sort = current && additive
          ? others.flatMap((k) => (k.column !== column ? [k] : next ? [next] : []))
          : [...others, ...(next ? [next] : [])];
        return { ...spec, sort, orderSql: null };
      }),

    addFilter: (id, condition) => {
      const d = get().editors[id];
      if (!d || specLocked(d)) return;
      const node = conditionNode(condition);
      const same = (c: (typeof d.filterDraft.children)[number]) =>
        c.kind === "condition" && !c.disabled && c.column === node.column && c.op === node.op && c.value === node.value && c.negated === node.negated;
      if (d.spec.filter?.op === "and" && d.spec.filter.children.some(same)) return;
      respec(id, true, (spec) => ({ ...spec, filter: andWith(spec.filter, node) }), (draft) => andWith(draft, node));
    },

    removeFilter: (id, nodeId) => {
      respec(id, true, (spec) => ({ ...spec, filter: spec.filter && asFilter(removeNode(spec.filter, nodeId)) }), (draft) => removeNode(draft, nodeId));
    },

    toggleFilterPane: (id) => patch(id, (d) => ({ filterOpen: !d.filterOpen })),

    setDraft: (id, change) => patch(id, (d) => ({ filterDraft: change(d.filterDraft) })),

    applyDraft: (id) => {
      const d = get().editors[id];
      if (d && isComplete(d.filterDraft) && !sameFilter(d.filterDraft, d.spec.filter)) respec(id, true, (spec) => ({ ...spec, filter: asFilter(d.filterDraft) }));
    },

    applyTyped: (id, whereSql, orderSql) =>
      respec(id, true, (spec) => ({
        ...spec,
        whereSql: whereSql.trim() || null,
        orderSql: orderSql.trim() || null,
        sort: orderSql.trim() ? [] : spec.sort,
      })),

    clearSpec: (id) => {
      respec(id, true, () => EMPTY_SPEC, () => newGroup("and"));
    },

    select: (id, rows) => patch(id, () => ({ selected: rows })),

    setEditing: (id, cell) => patch(id, () => ({ editing: cell })),

    setCell: (id, row, column, value) =>
      patch(id, (d) => {
        if (isNewRow(row)) {
          return { inserts: d.inserts.map((r) => (r.key === row ? { ...r, values: { ...r.values, [column]: value } } : r)) };
        }
        if (!d.source || d.deletes[row]) return {};
        const original = d.rows[d.rowKeys.indexOf(row)]?.[d.source.columns.findIndex((c) => c.name === column)];
        const { [column]: _, ...others } = d.edits[row] ?? {};
        // Typing the original value back undoes the edit.
        const cells = value === original ? others : { ...others, [column]: value };
        const { [row]: __, ...edits } = d.edits;
        return { edits: Object.keys(cells).length ? { ...edits, [row]: cells } : edits };
      }),

    addRow: (id) => {
      const key = `${NEW_ROW}${++newRowCounter}`;
      patch(id, (d) => ({ inserts: [...d.inserts, { key, values: {} }], selected: [key], notice: null }));
    },

    removeSelected: (id) =>
      patch(id, (d) => {
        const chosen = new Set(d.selected);
        const edits = { ...d.edits };
        const deletes = { ...d.deletes };
        for (const key of chosen) {
          if (isNewRow(key)) continue;
          delete edits[key];
          deletes[key] = true;
        }
        return { edits, deletes, inserts: d.inserts.filter((r) => !chosen.has(r.key)), selected: [], editing: null };
      }),

    cancelEdits: (id) => patch(id, () => ({ ...noPending, error: null })),

    commit: async (id) => {
      const d = get().editors[id];
      if (!d || d.busy) return false;
      if (pendingCount(d) === 0) return true;
      patch(id, () => ({ busy: "apply", error: null, notice: null, editing: null }));
      try {
        const changed = await api.applyEdits(id, target(d), toBatch(d));
        patch(id, () => ({
          busy: null,
          ...noPending,
          notice: `${changed} ${changed === 1 ? "row" : "rows"} changed${d.inTransaction ? " (not committed until the transaction ends)" : ""}.`,
        }));
      } catch (err) {
        // The edits stay pending so they can be fixed and committed again.
        fail(id, err);
        return false;
      }
      await get().load(id, undefined, true);
      return true;
    },

    beginTransaction: async (id) => {
      const d = get().editors[id];
      if (!d || d.busy || d.inTransaction) return;
      patch(id, () => ({ busy: "transaction", error: null, notice: null }));
      try {
        await api.sessionBegin(id, d.tab.connectionId, d.tab.database);
        patch(id, () => ({ busy: null, inTransaction: true, notice: "Transaction started." }));
      } catch (err) {
        fail(id, err);
      }
    },

    endTransaction: async (id, commit) => {
      if (commit && !(await get().commit(id))) return false;
      const d = get().editors[id];
      if (!d || d.busy || !d.inTransaction) return !!d;
      patch(id, () => ({ busy: "transaction", error: null, notice: null, ...(commit ? {} : noPending) }));
      try {
        await api.sessionEnd(id, commit);
      } catch (err) {
        // The backend forgets the transaction even when ending it fails.
        fail(id, err, { inTransaction: false });
        return false;
      }
      patch(id, () => ({ busy: null, inTransaction: false, notice: commit ? "Transaction committed." : "Transaction rolled back." }));
      void get().load(id, undefined, true);
      return true;
    },

    save: async (id) => {
      const d = get().editors[id];
      if (!d) return false;
      return d.inTransaction ? get().endTransaction(id, true) : get().commit(id);
    },

    stop: (id) => {
      const d = get().editors[id];
      if (!d) return;
      api.sessionCancel(id, d.tab.connectionId, d.tab.database).catch((err) => fail(id, err));
    },

    dismissMessages: (id) => patch(id, () => ({ error: null, notice: null })),
  };
});
