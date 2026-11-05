// What code completion knows about each database, shared by the query tabs on it.
// Separate from lib/catalog.ts, which caches per schema and by another shape.
//
// A refresh keeps serving the old catalog until the new one arrives, so the list
// never blanks. Entries are per database, so a tab that changes database simply
// reads another one, and a late answer can't reach it.

import { create } from "zustand";
import * as api from "../lib/api";
import type { CompletionCatalog } from "../lib/types";

const SEP = "\u001f";

export interface CatalogEntry {
  catalog: CompletionCatalog | null;
  loading: boolean;
  error: string | null;
}

interface CompletionCatalogState {
  entries: Record<string, CatalogEntry>;

  /** Loads the catalog unless there is one. */
  ensure: (connectionId: string, database: string) => void;
  /** Loads it again, if anything has asked for this database. */
  refresh: (connectionId: string, database: string) => void;
  forget: (connectionId: string) => void;
}

const EMPTY: CatalogEntry = { catalog: null, loading: false, error: null };

export const catalogKey = (connectionId: string, database: string) => [connectionId, database].join(SEP);

/** Only the newest request per database may answer. */
const latest = new Map<string, number>();
let lastRequest = 0;

export const useCompletionCatalog = create<CompletionCatalogState>((set, get) => {
  const update = (key: string, change: Partial<CatalogEntry>) =>
    set((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY), ...change } } }));

  const load = async (connectionId: string, database: string) => {
    const key = catalogKey(connectionId, database);
    const request = ++lastRequest;
    latest.set(key, request);
    update(key, { loading: true });
    try {
      const catalog = await api.completionCatalog(connectionId, database);
      if (latest.get(key) === request) update(key, { catalog, loading: false, error: null });
    } catch (err) {
      if (latest.get(key) === request) update(key, { loading: false, error: api.errorMessage(err) });
    }
  };

  return {
    entries: {},

    ensure: (connectionId, database) => {
      const entry = get().entries[catalogKey(connectionId, database)];
      if (!entry?.catalog && !entry?.loading) void load(connectionId, database);
    },

    refresh: (connectionId, database) => {
      if (get().entries[catalogKey(connectionId, database)]) void load(connectionId, database);
    },

    forget: (connectionId) => {
      const prefix = connectionId + SEP;
      for (const key of latest.keys()) if (key.startsWith(prefix)) latest.delete(key);
      set((s) => ({ entries: Object.fromEntries(Object.entries(s.entries).filter(([key]) => !key.startsWith(prefix))) }));
    },
  };
});
