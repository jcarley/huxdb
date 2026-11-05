import { create } from "zustand";
import * as api from "../lib/api";
import type { ConnectionConfig } from "../lib/types";
import { useExplorer } from "./explorer";
import { useTabs } from "./tabs";

interface ConnectionsState {
  connections: ConnectionConfig[];
  selectedId: string | null;
  loadError: string | null;
  /** Connection being created or edited in the dialog; null when closed. */
  editing: ConnectionConfig | null;
  /** Connection awaiting delete confirmation; null when no prompt is open. */
  pendingDelete: ConnectionConfig | null;

  load: () => Promise<void>;
  select: (id: string | null) => void;
  openEditor: (config: ConnectionConfig) => void;
  closeEditor: () => void;
  /** Persists the connection, selects it, and closes the editor. Throws the backend error. */
  save: (config: ConnectionConfig) => Promise<void>;
  requestDelete: (config: ConnectionConfig) => void;
  cancelDelete: () => void;
  /** Deletes `pendingDelete`, and its saved queries if asked. Throws the backend error. */
  confirmDelete: (deleteFiles: boolean) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  selectedId: null,
  loadError: null,
  editing: null,
  pendingDelete: null,

  load: async () => {
    try {
      set({ connections: await api.listConnections(), loadError: null });
    } catch (err) {
      set({ loadError: api.errorMessage(err) });
    }
  },

  select: (id) => set({ selectedId: id }),
  openEditor: (config) => set({ editing: config }),
  closeEditor: () => set({ editing: null }),

  save: async (config) => {
    const saved = await api.saveConnection(config);
    // The backend closed this connection's pools; drop its now-stale tree.
    const explorer = useExplorer.getState();
    explorer.forget(saved.id);
    useTabs.getState().forgetConnection(saved.id);
    explorer.select({ kind: "connection", connectionId: saved.id });
    const { connections } = get();
    const exists = connections.some((c) => c.id === saved.id);
    set({
      connections: exists
        ? connections.map((c) => (c.id === saved.id ? saved : c))
        : [...connections, saved],
      selectedId: saved.id,
      editing: null,
    });
  },

  requestDelete: (config) => set({ pendingDelete: config }),
  cancelDelete: () => set({ pendingDelete: null }),

  confirmDelete: async (deleteFiles) => {
    const target = get().pendingDelete;
    if (!target) return;
    await api.deleteConnection(target.id, deleteFiles);
    useExplorer.getState().forget(target.id);
    useTabs.getState().forgetConnection(target.id);
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== target.id),
      selectedId: s.selectedId === target.id ? null : s.selectedId,
      pendingDelete: null,
    }));
  },
}));

export const useSelectedConnection = () =>
  useConnections((s) => s.connections.find((c) => c.id === s.selectedId) ?? null);
