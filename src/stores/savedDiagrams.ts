// Saved diagrams: each connection's list, and everything that moves a diagram between a tab
// and its file. Rust owns the files; a tab only knows its `source`.

import { create } from "zustand";
import * as api from "../lib/api";
import type { DiagramInfo } from "../lib/types";
import { useDiagrams } from "./diagram";
import { useTabs } from "./tabs";

/** The dialog open for a saved diagram, rendered by `DiagramDialogs`. */
export type DiagramPrompt =
  | { kind: "save-as"; tabId: string }
  | { kind: "rename"; connectionId: string; diagram: DiagramInfo }
  | { kind: "delete"; connectionId: string; diagram: DiagramInfo }
  | { kind: "overwrite"; tabId: string; message: string }
  | { kind: "report"; tabId: string };

interface SavedDiagramsState {
  /** By connection id. Absent until first loaded. */
  lists: Record<string, DiagramInfo[]>;
  /** Bumped per connection when its diagrams change, so the open list reloads. */
  versions: Record<string, number>;
  prompt: DiagramPrompt | null;
  /** A failure with no better place to show it. */
  error: string | null;

  /** Rejects with the backend error. */
  load: (connectionId: string) => Promise<DiagramInfo[]>;
  /** Opens the diagram, or focuses its tab. */
  open: (connectionId: string, id: string) => Promise<void>;
  /** Save: a tab with no source asks for a name, and a file changed elsewhere asks whether
   * to overwrite it, unless `overwrite`. Both resolve to false. */
  save: (tabId: string, overwrite?: boolean) => Promise<boolean>;
  /** Saves the tab as a new diagram, which it then belongs to. Rejects with the backend error. */
  saveAs: (tabId: string, name: string) => Promise<void>;
  duplicate: (connectionId: string, id: string) => Promise<void>;
  /** Renames the prompt's diagram. Rejects with the backend error. */
  rename: (name: string) => Promise<void>;
  /** Deletes the prompt's diagram. Rejects with the backend error. */
  confirmDelete: () => Promise<void>;
  setPrompt: (prompt: DiagramPrompt | null) => void;
  dismissError: () => void;
}

const tabById = (tabId: string) => useTabs.getState().tabs.find((t) => t.id === tabId);

/** The open tab of a saved diagram. */
const tabOf = (connectionId: string, id: string) =>
  useTabs.getState().tabs.find((t) => t.kind === "diagram" && t.connectionId === connectionId && t.source?.kind === "saved" && t.source.id === id);

export const useSavedDiagrams = create<SavedDiagramsState>((set, get) => {
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
      const list = await api.listDiagrams(connectionId);
      set((s) => ({ lists: { ...s.lists, [connectionId]: list } }));
      return list;
    },

    open: async (connectionId, id) => {
      const source = { kind: "saved", id } as const;
      if (useTabs.getState().focusSource(connectionId, source)) return;
      try {
        useTabs.getState().openSavedDiagram(connectionId, await api.loadDiagram(connectionId, id));
      } catch (err) {
        fail(err);
      }
    },

    save: async (tabId, overwrite = false) => {
      const tab = tabById(tabId);
      const diagrams = useDiagrams.getState();
      const content = diagrams.content(tabId);
      if (!tab || !content) return false;
      if (tab.source?.kind !== "saved") {
        set({ prompt: { kind: "save-as", tabId } });
        return false;
      }
      try {
        const info = await api.updateDiagram(tab.connectionId, tab.source.id, content, overwrite ? null : (diagrams.diagrams[tabId]?.stamp ?? null));
        diagrams.markSaved(tabId, info.modifiedMs);
        changed(tab.connectionId);
        return true;
      } catch (err) {
        const message = api.errorMessage(err);
        if (message.startsWith(api.CHANGED_MARKER)) set({ prompt: { kind: "overwrite", tabId, message: message.slice(api.CHANGED_MARKER.length) } });
        else fail(err);
        return false;
      }
    },

    saveAs: async (tabId, name) => {
      const tab = tabById(tabId);
      const diagrams = useDiagrams.getState();
      const content = diagrams.content(tabId);
      if (!tab || !content) return;
      const info = await api.createDiagram(tab.connectionId, name, tab.database, content);
      useTabs.getState().setSource(tabId, { kind: "saved", id: info.id }, info.name);
      diagrams.markSaved(tabId, info.modifiedMs);
      changed(tab.connectionId);
      set({ prompt: null });
    },

    duplicate: async (connectionId, id) => {
      try {
        await api.duplicateDiagram(connectionId, id);
        changed(connectionId);
      } catch (err) {
        fail(err);
      }
    },

    rename: async (name) => {
      const prompt = get().prompt;
      if (prompt?.kind !== "rename") return;
      const { connectionId, diagram } = prompt;
      const info = await api.renameDiagram(connectionId, diagram.id, name);
      const tab = tabOf(connectionId, diagram.id);
      if (tab) {
        useTabs.getState().setName(tab.id, info.name);
        // A rename rewrites the file, so the tab's stamp must follow or its next Save looks like a clash.
        useDiagrams.setState((s) => ({ diagrams: { ...s.diagrams, [tab.id]: { ...s.diagrams[tab.id], stamp: info.modifiedMs } } }));
      }
      changed(connectionId);
      set({ prompt: null });
    },

    confirmDelete: async () => {
      const prompt = get().prompt;
      if (prompt?.kind !== "delete") return;
      const { connectionId, diagram } = prompt;
      await api.deleteDiagram(connectionId, diagram.id);
      // Its open tab keeps the diagram, now unsaved, so nothing is lost by accident.
      const tab = tabOf(connectionId, diagram.id);
      if (tab) {
        useTabs.getState().setSource(tab.id, undefined, tab.name ?? diagram.name);
        useDiagrams.getState().markUnsaved(tab.id);
      }
      changed(connectionId);
      set({ prompt: null });
    },

    setPrompt: (prompt) => set({ prompt }),
    dismissError: () => set({ error: null }),
  };
});

/** Reload counter for a connection's diagram list. */
export const useDiagramsVersion = (connectionId: string) => useSavedDiagrams((s) => s.versions[connectionId] ?? 0);
