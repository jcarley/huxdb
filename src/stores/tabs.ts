// Main-pane tabs: the permanent Objects tab (activeId null) plus one tab per open
// designer, data editor or query.

import { create } from "zustand";
import { useCompletionCatalog } from "./completionCatalog";
import { useConnections } from "./connections";
import { nodeKey } from "./explorer";
import { sameSource } from "../lib/queryFiles";
import type { QuerySource } from "../lib/queryFiles";
import { isDataDirty, useDataEditor } from "./dataEditor";
import { isQueryDirty, useQueryEditor } from "./queryEditor";
import { isDirty as isTableDirty, useTableDesigner } from "./tableDesigner";
import { isViewDirty, useViewDesigner } from "./viewDesigner";

/** Where a designer's object lives. */
export interface SchemaRef {
  connectionId: string;
  database: string;
  /** Empty on a query tab means the server's default search_path. */
  schema: string;
}

/** A table or view designer, a table's data editor, or a query. */
export type DesignerKind = "table" | "view" | "data" | "query";

export interface DesignerTab extends SchemaRef {
  id: string;
  kind: DesignerKind;
  /** Table or view being designed (or edited); null until a new one is first saved. */
  name: string | null;
  /** A query tab's saved query or external file. */
  source?: QuerySource;
}

interface TabsState {
  tabs: DesignerTab[];
  /** Active designer tab; null shows the Objects tab. */
  activeId: string | null;
  /** Dirty tab awaiting the Save / Discard / Cancel prompt. */
  pendingClose: string | null;
  /** The app's close button was pressed while designers had unsaved edits. */
  quitRequested: boolean;
  /** Bumped per schema key when a save changes its objects, so object lists reload. */
  schemaVersions: Record<string, number>;

  /** Opens (or focuses) the designer for the named table or view, or a new one when `name` is null. */
  openDesigner: (kind: DesignerKind, ref: SchemaRef, name: string | null) => void;
  openTableDesigner: (ref: SchemaRef, table: string | null) => void;
  openViewDesigner: (ref: SchemaRef, view: string | null) => void;
  openDataEditor: (ref: SchemaRef, table: string) => void;
  /** Opens a new query tab. */
  openQuery: (ref: SchemaRef) => void;
  /** Opens a saved query or an external file, or focuses its tab. */
  openQuerySource: (ref: SchemaRef, name: string, source: QuerySource, sql: string, stamp: number | null) => void;
  /** Focuses the tab of a saved query or external file; false if none is open. */
  focusSource: (connectionId: string, source: QuerySource) => boolean;
  /** The database a query tab starts in when nothing else says. */
  defaultDatabase: (connectionId: string) => string;
  activate: (id: string | null) => void;
  /** Closes a clean tab; a dirty one prompts first. */
  requestClose: (id: string) => void;
  cancelClose: () => void;
  /** Closes a tab, discarding its edits. */
  close: (id: string) => void;
  /** Points a tab at the object it now designs (after a new one's first save). */
  setName: (id: string, name: string) => void;
  /** What a query tab saves to, and its name, after a Save As or a delete. */
  setSource: (id: string, source: QuerySource | undefined, name: string) => void;
  /** A query tab changed database or schema. */
  setTarget: (id: string, database: string, schema: string) => void;
  /** Closes every tab of a connection (it was edited or deleted). */
  forgetConnection: (connectionId: string) => void;
  schemaChanged: (ref: SchemaRef) => void;
  setQuitRequested: (value: boolean) => void;
}

const schemaKey = ({ connectionId, database, schema }: SchemaRef) =>
  nodeKey({ kind: "schema", connectionId, database, schema });

const KIND_LABELS: Record<DesignerKind, string> = { table: "Table", view: "View", data: "Data", query: "Query" };

export const tabTitle = (tab: DesignerTab) => {
  const where = tab.schema ? `${tab.database}.${tab.schema}` : tab.database;
  return tab.kind === "query" ? `${tab.name} @${where}` : `${tab.name ?? "Untitled"} @${where} (${KIND_LABELS[tab.kind]})`;
};

/** Numbers query tabs, which have no object to be named after. */
let queryCount = 0;

/** Whether a tab has unsaved edits (or an open transaction), asking the store for its kind. */
export const isTabDirty = (tab: DesignerTab) => {
  switch (tab.kind) {
    case "table":
      return isTableDirty(tab.id);
    case "view":
      return isViewDirty(tab.id);
    case "data":
      return isDataDirty(tab.id);
    case "query":
      return isQueryDirty(tab.id);
  }
};

/** The store holding a kind's per-tab state. */
const storeFor = (kind: DesignerKind): { open: (tab: DesignerTab) => void; dispose: (id: string) => void } => {
  switch (kind) {
    case "table":
      return useTableDesigner.getState();
    case "view":
      return useViewDesigner.getState();
    case "data":
      return useDataEditor.getState();
    case "query":
      return useQueryEditor.getState();
  }
};

export const hasUnsavedTabs = () => useTabs.getState().tabs.some(isTabDirty);

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  pendingClose: null,
  quitRequested: false,
  schemaVersions: {},

  openDesigner: (kind, ref, name) => {
    const { connectionId, database, schema } = ref;
    const existing =
      name !== null &&
      get().tabs.find(
        (t) =>
          t.kind === kind && t.connectionId === connectionId && t.database === database && t.schema === schema && t.name === name,
      );
    if (existing) {
      set({ activeId: existing.id });
      return;
    }
    const tab: DesignerTab = { id: crypto.randomUUID(), kind, connectionId, database, schema, name };
    storeFor(kind).open(tab);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  openTableDesigner: (ref, table) => get().openDesigner("table", ref, table),
  openViewDesigner: (ref, view) => get().openDesigner("view", ref, view),
  openDataEditor: (ref, table) => get().openDesigner("data", ref, table),

  // Not `openDesigner`: a query's name doesn't identify it, so a new tab must not
  // focus a saved query that happens to be called "Query 3".
  openQuery: ({ connectionId, database, schema }) => {
    const tab: DesignerTab = { id: crypto.randomUUID(), kind: "query", connectionId, database, schema, name: `Query ${++queryCount}` };
    useQueryEditor.getState().open(tab);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  openQuerySource: ({ connectionId, database, schema }, name, source, sql, stamp) => {
    if (get().focusSource(connectionId, source)) return;
    const tab: DesignerTab = { id: crypto.randomUUID(), kind: "query", connectionId, database, schema, name, source };
    useQueryEditor.getState().open(tab, sql, stamp);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  focusSource: (connectionId, source) => {
    // An external file is the same file from any connection.
    const tab = get().tabs.find((t) => sameSource(t.source, source) && (source.kind === "file" || t.connectionId === connectionId));
    if (tab) set({ activeId: tab.id });
    return !!tab;
  },

  defaultDatabase: (connectionId) =>
    useConnections.getState().connections.find((c) => c.id === connectionId)?.database || "postgres",


  activate: (id) => set({ activeId: id }),

  requestClose: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && isTabDirty(tab)) set({ pendingClose: id, activeId: id });
    else get().close(id);
  },

  cancelClose: () => set({ pendingClose: null }),

  close: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab) storeFor(tab.kind).dispose(id);
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Closing the active tab activates its left neighbor; left of the first designer is Objects.
      const activeId = s.activeId === id ? (tabs[index - 1]?.id ?? null) : s.activeId;
      return { tabs, activeId, pendingClose: s.pendingClose === id ? null : s.pendingClose };
    });
  },

  setName: (id, name) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) })),
  setSource: (id, source, name) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, source, name } : t)) })),
  setTarget: (id, database, schema) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, database, schema } : t)) })),

  forgetConnection: (connectionId) => {
    for (const t of get().tabs) if (t.connectionId === connectionId) get().close(t.id);
    useCompletionCatalog.getState().forget(connectionId);
  },

  schemaChanged: (ref) => {
    const key = schemaKey(ref);
    set((s) => ({ schemaVersions: { ...s.schemaVersions, [key]: (s.schemaVersions[key] ?? 0) + 1 } }));
    useCompletionCatalog.getState().refresh(ref.connectionId, ref.database);
  },

  setQuitRequested: (value) => set({ quitRequested: value }),
}));

/** Reload counter for a schema's object lists. */
export const useSchemaVersion = (ref: SchemaRef) => useTabs((s) => s.schemaVersions[schemaKey(ref)] ?? 0);
