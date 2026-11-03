// Main-pane tabs: the permanent Objects tab (activeId null) plus one tab per open designer.

import { create } from "zustand";
import { nodeKey } from "./explorer";
import { isDirty, useTableDesigner } from "./tableDesigner";

/** Where a designer's object lives. */
export interface SchemaRef {
  connectionId: string;
  database: string;
  schema: string;
}

export interface DesignerTab extends SchemaRef {
  id: string;
  kind: "table";
  /** Table being designed; null until a new table is first saved. */
  table: string | null;
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

  /** Opens (or focuses) the designer for `table`, or a new-table designer when null. */
  openTableDesigner: (ref: SchemaRef, table: string | null) => void;
  activate: (id: string | null) => void;
  /** Closes a clean tab; a dirty one prompts first. */
  requestClose: (id: string) => void;
  cancelClose: () => void;
  /** Closes a tab, discarding its edits. */
  close: (id: string) => void;
  /** Points a tab at the table it now designs (after a new table's first save). */
  setTable: (id: string, table: string) => void;
  /** Closes every tab of a connection (it was edited or deleted). */
  forgetConnection: (connectionId: string) => void;
  schemaChanged: (ref: SchemaRef) => void;
  setQuitRequested: (value: boolean) => void;
}

const schemaKey = ({ connectionId, database, schema }: SchemaRef) =>
  nodeKey({ kind: "schema", connectionId, database, schema });

export const tabTitle = (tab: DesignerTab) => `${tab.table ?? "Untitled"} @${tab.database}.${tab.schema} (Table)`;

export const hasUnsavedTabs = () => useTabs.getState().tabs.some((t) => isDirty(t.id));

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  pendingClose: null,
  quitRequested: false,
  schemaVersions: {},

  openTableDesigner: (ref, table) => {
    const { connectionId, database, schema } = ref;
    const existing =
      table !== null &&
      get().tabs.find(
        (t) => t.connectionId === connectionId && t.database === database && t.schema === schema && t.table === table,
      );
    if (existing) {
      set({ activeId: existing.id });
      return;
    }
    const tab: DesignerTab = { id: crypto.randomUUID(), kind: "table", connectionId, database, schema, table };
    useTableDesigner.getState().open(tab);
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  activate: (id) => set({ activeId: id }),

  requestClose: (id) => {
    if (isDirty(id)) set({ pendingClose: id, activeId: id });
    else get().close(id);
  },

  cancelClose: () => set({ pendingClose: null }),

  close: (id) => {
    useTableDesigner.getState().dispose(id);
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Closing the active tab activates its left neighbor; left of the first designer is Objects.
      const activeId = s.activeId === id ? (tabs[index - 1]?.id ?? null) : s.activeId;
      return { tabs, activeId, pendingClose: s.pendingClose === id ? null : s.pendingClose };
    });
  },

  setTable: (id, table) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, table } : t)) })),

  forgetConnection: (connectionId) => {
    for (const t of get().tabs) if (t.connectionId === connectionId) get().close(t.id);
  },

  schemaChanged: (ref) => {
    const key = schemaKey(ref);
    set((s) => ({ schemaVersions: { ...s.schemaVersions, [key]: (s.schemaVersions[key] ?? 0) + 1 } }));
  },

  setQuitRequested: (value) => set({ quitRequested: value }),
}));

/** Reload counter for a schema's object lists. */
export const useSchemaVersion = (ref: SchemaRef) => useTabs((s) => s.schemaVersions[schemaKey(ref)] ?? 0);
