// Saved queries: each connection's list, and everything that moves a query tab's
// text to or from a file. Rust owns the files; a tab only knows its `source`.

import { create } from "zustand";
import * as api from "../lib/api";
import { withoutSqlExtension } from "../lib/queryFiles";
import type { SavedQueryInfo } from "../lib/types";
import { useQueryEditor } from "./queryEditor";
import { useTabs } from "./tabs";
import type { SchemaRef } from "./tabs";

/** The dialog open for a saved query, rendered by `SavedQueryDialogs`. */
export type QueryPrompt =
  | { kind: "save-as"; tabId: string }
  | { kind: "rename"; connectionId: string; query: SavedQueryInfo }
  | { kind: "delete"; connectionId: string; query: SavedQueryInfo }
  | { kind: "overwrite"; tabId: string; message: string };

interface SavedQueriesState {
  /** By connection id. Absent until first loaded. */
  lists: Record<string, SavedQueryInfo[]>;
  /** Bumped per connection when its queries change, so the open list reloads. */
  versions: Record<string, number>;
  prompt: QueryPrompt | null;
  /** A failure with no tab to show it in. */
  error: string | null;

  /** Rejects with the backend error. */
  load: (connectionId: string) => Promise<SavedQueryInfo[]>;
  /** Opens the query, or focuses its tab. */
  open: (connectionId: string, id: string) => Promise<void>;
  /** Open External File, in a new tab on `ref`. */
  openExternal: (ref: SchemaRef) => Promise<void>;
  /** Save: a tab with no source asks for a name, and a file changed elsewhere asks
   * whether to overwrite it, unless `overwrite`. Both resolve to false. */
  save: (tabId: string, overwrite?: boolean) => Promise<boolean>;
  /** Saves the tab as a new query, which it then belongs to. Rejects with the backend error. */
  saveAs: (tabId: string, name: string) => Promise<void>;
  /** Save As External File; the tab belongs to the file afterwards. */
  saveAsExternal: (tabId: string) => Promise<void>;
  duplicate: (connectionId: string, id: string) => Promise<void>;
  /** Renames the prompt's query. Rejects with the backend error. */
  rename: (name: string) => Promise<void>;
  /** Deletes the prompt's query. Rejects with the backend error. */
  confirmDelete: () => Promise<void>;
  setPrompt: (prompt: QueryPrompt | null) => void;
  dismissError: () => void;
}

const queryTab = (tabId: string) => {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  const editor = useQueryEditor.getState().editors[tabId];
  return tab && editor ? { tab, sql: editor.sql } : null;
};

/** The open tab of a saved query. */
const tabOf = (connectionId: string, id: string) =>
  useTabs.getState().tabs.find((t) => t.connectionId === connectionId && t.source?.kind === "saved" && t.source.id === id);

export const useSavedQueries = create<SavedQueriesState>((set, get) => {
  const changed = (connectionId: string) => {
    set((s) => ({ versions: { ...s.versions, [connectionId]: (s.versions[connectionId] ?? 0) + 1 } }));
    get().load(connectionId).catch(() => {});
  };

  const fail = (err: unknown) => set({ error: api.errorMessage(err) });

  return {
    lists: {},
    versions: {},
    prompt: null,
    error: null,

    load: async (connectionId) => {
      const list = await api.listSavedQueries(connectionId);
      set((s) => ({ lists: { ...s.lists, [connectionId]: list } }));
      return list;
    },

    open: async (connectionId, id) => {
      const source = { kind: "saved", id } as const;
      if (useTabs.getState().focusSource(connectionId, source)) return;
      try {
        const query = await api.loadSavedQuery(connectionId, id);
        const database = query.database || useTabs.getState().defaultDatabase(connectionId);
        useTabs.getState().openQuerySource({ connectionId, database, schema: query.schema }, query.name, source, query.sql, query.modifiedMs);
      } catch (err) {
        fail(err);
      }
    },

    openExternal: async (ref) => {
      try {
        const file = await api.openExternalSql();
        if (file) useTabs.getState().openQuerySource(ref, file.name, { kind: "file", path: file.path }, file.sql, file.modifiedMs);
      } catch (err) {
        fail(err);
      }
    },

    save: async (tabId, overwrite = false) => {
      const found = queryTab(tabId);
      if (!found) return false;
      const { tab, sql } = found;
      const { source } = tab;
      if (!source) {
        set({ prompt: { kind: "save-as", tabId } });
        return false;
      }
      const editor = useQueryEditor.getState();
      const expected = overwrite ? null : (editor.editors[tabId]?.savedStamp ?? null);
      try {
        if (source.kind === "saved") {
          const info = await api.updateSavedQuery(tab.connectionId, source.id, tab.database, tab.schema, sql, expected);
          changed(tab.connectionId);
          editor.markSaved(tabId, sql, info.modifiedMs);
        } else {
          editor.markSaved(tabId, sql, await api.writeExternalSql(source.path, sql, expected));
        }
        return true;
      } catch (err) {
        const message = api.errorMessage(err);
        if (message.startsWith(api.CHANGED_MARKER)) set({ prompt: { kind: "overwrite", tabId, message: message.slice(api.CHANGED_MARKER.length) } });
        else editor.setError(tabId, message);
        return false;
      }
    },

    saveAs: async (tabId, name) => {
      const found = queryTab(tabId);
      if (!found) return;
      const { tab, sql } = found;
      const info = await api.createSavedQuery(tab.connectionId, name, tab.database, tab.schema, sql);
      useTabs.getState().setSource(tabId, { kind: "saved", id: info.id }, info.name);
      useQueryEditor.getState().markSaved(tabId, sql, info.modifiedMs);
      changed(tab.connectionId);
      set({ prompt: null });
    },

    saveAsExternal: async (tabId) => {
      const found = queryTab(tabId);
      if (!found) return;
      const { tab, sql } = found;
      const editor = useQueryEditor.getState();
      try {
        const file = await api.saveExternalSqlAs(withoutSqlExtension(tab.name ?? "query"), sql);
        if (!file) return;
        useTabs.getState().setSource(tabId, { kind: "file", path: file.path }, file.name);
        editor.markSaved(tabId, sql, file.modifiedMs);
      } catch (err) {
        editor.setError(tabId, api.errorMessage(err));
      }
    },

    duplicate: async (connectionId, id) => {
      try {
        await api.duplicateSavedQuery(connectionId, id);
        changed(connectionId);
      } catch (err) {
        fail(err);
      }
    },

    rename: async (name) => {
      const prompt = get().prompt;
      if (prompt?.kind !== "rename") return;
      const { connectionId, query } = prompt;
      const info = await api.renameSavedQuery(connectionId, query.id, name);
      const tab = tabOf(connectionId, query.id);
      if (tab) useTabs.getState().setName(tab.id, info.name);
      changed(connectionId);
      set({ prompt: null });
    },

    confirmDelete: async () => {
      const prompt = get().prompt;
      if (prompt?.kind !== "delete") return;
      const { connectionId, query } = prompt;
      await api.deleteSavedQuery(connectionId, query.id);
      // Its open tab keeps the text, now unsaved, so nothing is lost by accident.
      const tab = tabOf(connectionId, query.id);
      if (tab) {
        useTabs.getState().setSource(tab.id, undefined, tab.name ?? query.name);
        useQueryEditor.getState().markSaved(tab.id, "", null);
      }
      changed(connectionId);
      set({ prompt: null });
    },

    setPrompt: (prompt) => set({ prompt }),
    dismissError: () => set({ error: null }),
  };
});

/** Reload counter for a connection's query list. */
export const useQueriesVersion = (connectionId: string) => useSavedQueries((s) => s.versions[connectionId] ?? 0);
