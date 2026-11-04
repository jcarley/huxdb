// Edit state of each open view designer, keyed by tab id. Mirrors
// tableDesigner.ts: it lives outside the components so the close prompt can
// save a tab that isn't showing.

import { create } from "zustand";
import * as api from "../lib/api";
import { invalidateCatalog } from "../lib/catalog";
import type { QueryResult, ViewDesign } from "../lib/types";
import { useExplorer } from "./explorer";
import { useTabs } from "./tabs";
import type { DesignerTab } from "./tabs";

/** What the panel under the Definition editor shows after Preview or Explain. */
export type ResultPanel =
  | { kind: "rows"; result: QueryResult }
  | { kind: "plan"; lines: string[] }
  | { kind: "error"; message: string };

export interface ViewDesigner {
  tab: DesignerTab;
  status: "loading" | "loaded" | "error";
  loadError: string | null;
  /** The view as loaded; null for a view not yet created. */
  original: ViewDesign | null;
  edited: ViewDesign;
  /** What `edited` started as; edits are unsaved while they differ. */
  baseline: ViewDesign;
  saving: boolean;
  saveError: string | null;
  /** The last save failed on a column change only a drop and re-create can make. */
  canRecreate: boolean;
  /** The new-view name prompt is open. */
  askingName: boolean;
  result: ResultPanel | null;
  /** Preview or Explain is running. */
  running: boolean;
}

interface ViewDesignerState {
  designers: Record<string, ViewDesigner>;

  open: (tab: DesignerTab) => void;
  load: (id: string) => Promise<void>;
  dispose: (id: string) => void;
  update: (id: string, patch: Partial<ViewDesign>) => void;
  /** Saves; a new view first asks for its name. */
  requestSave: (id: string) => void;
  setAskingName: (id: string, value: boolean) => void;
  /** Runs the save (with `recreate`, drops and re-creates). Resolves to whether it succeeded. */
  save: (id: string, name?: string, recreate?: boolean) => Promise<boolean>;
  preview: (id: string) => Promise<void>;
  explain: (id: string) => Promise<void>;
  /** Reformats the definition; leaves it alone if it can't be parsed. */
  beautify: (id: string) => Promise<void>;
  closeResult: (id: string) => void;
}

const emptyView = (tab: DesignerTab): ViewDesign => ({
  schema: tab.schema,
  name: "",
  definition: "",
  owner: null,
  comment: null,
  checkOption: null,
  securityBarrier: false,
  securityInvoker: false,
  // Unknown until loaded; the server rejects the option if unsupported.
  supportsSecurityInvoker: true,
});

export const viewDirty = (d: ViewDesigner | undefined) => !!d && JSON.stringify(d.edited) !== JSON.stringify(d.baseline);

export const isViewDirty = (id: string) => viewDirty(useViewDesigner.getState().designers[id]);

export const useViewDesigner = create<ViewDesignerState>((set, get) => {
  const patch = (id: string, change: (d: ViewDesigner) => Partial<ViewDesigner>) =>
    set((s) => {
      const d = s.designers[id];
      return d ? { designers: { ...s.designers, [id]: { ...d, ...change(d) } } } : s;
    });

  /** Runs Preview or Explain against the current (unsaved) definition. */
  const run = async (id: string, query: (d: ViewDesigner) => Promise<ResultPanel>) => {
    const d = get().designers[id];
    if (!d || d.running) return;
    if (!d.edited.definition.trim()) {
      patch(id, () => ({ result: { kind: "error", message: "Type a SELECT statement first." } }));
      return;
    }
    patch(id, () => ({ running: true }));
    try {
      const result = await query(d);
      patch(id, () => ({ running: false, result }));
    } catch (err) {
      patch(id, () => ({ running: false, result: { kind: "error", message: api.errorMessage(err) } }));
    }
  };

  return {
    designers: {},

    open: (tab) => {
      const view = emptyView(tab);
      set((s) => ({
        designers: {
          ...s.designers,
          [tab.id]: {
            tab,
            status: tab.name === null ? "loaded" : "loading",
            loadError: null,
            original: null,
            edited: view,
            baseline: view,
            saving: false,
            saveError: null,
            canRecreate: false,
            askingName: false,
            result: null,
            running: false,
          },
        },
      }));
      if (tab.name !== null) void get().load(tab.id);
    },

    load: async (id) => {
      const d = get().designers[id];
      if (!d || d.tab.name === null) return;
      const { connectionId, database, schema, name } = d.tab;
      patch(id, () => ({ status: "loading", loadError: null }));
      try {
        const view = await api.loadViewDesign(connectionId, database, schema, name);
        patch(id, () => ({ status: "loaded", original: view, edited: view, baseline: view }));
      } catch (err) {
        patch(id, () => ({ status: "error", loadError: api.errorMessage(err) }));
      }
    },

    dispose: (id) =>
      set((s) => {
        const { [id]: _, ...designers } = s.designers;
        return { designers };
      }),

    update: (id, change) => patch(id, (d) => ({ edited: { ...d.edited, ...change } })),

    requestSave: (id) => {
      const d = get().designers[id];
      if (!d || d.saving) return;
      if (!d.edited.definition.trim()) {
        patch(id, () => ({ saveError: "The view definition is required.", canRecreate: false }));
        return;
      }
      if (d.original === null) patch(id, () => ({ askingName: true }));
      else void get().save(id);
    },

    setAskingName: (id, value) => patch(id, () => ({ askingName: value })),

    save: async (id, name, recreate = false) => {
      const d = get().designers[id];
      if (!d || d.saving) return false;
      const edited = name === undefined ? d.edited : { ...d.edited, name };
      patch(id, () => ({ saving: true, saveError: null, canRecreate: false, edited }));
      try {
        const { connectionId, database, schema } = d.tab;
        const saved = await api.saveViewDesign(connectionId, database, d.original, edited, recreate);
        patch(id, (cur) => ({
          saving: false,
          original: saved,
          edited: saved,
          baseline: saved,
          tab: { ...cur.tab, name: saved.name },
        }));
        const tabs = useTabs.getState();
        tabs.setName(id, saved.name);
        tabs.schemaChanged(d.tab);
        invalidateCatalog(connectionId, database, schema);
        useExplorer.getState().reload({ kind: "schema", connectionId, database, schema });
        return true;
      } catch (err) {
        const message = api.errorMessage(err);
        const canRecreate = message.startsWith(api.RECREATE_MARKER);
        patch(id, () => ({
          saving: false,
          canRecreate,
          saveError: canRecreate ? message.slice(api.RECREATE_MARKER.length) : message,
        }));
        return false;
      }
    },

    preview: (id) =>
      run(id, async (d) => ({
        kind: "rows",
        result: await api.previewViewRows(d.tab.connectionId, d.tab.database, d.edited.definition),
      })),

    explain: (id) =>
      run(id, async (d) => ({
        kind: "plan",
        lines: await api.explainView(d.tab.connectionId, d.tab.database, d.edited.definition),
      })),

    beautify: async (id) => {
      // Loaded on first use: the formatter is large and rarely needed.
      const { format } = await import("sql-formatter");
      patch(id, (d) => {
        try {
          const definition = format(d.edited.definition, { language: "postgresql", keywordCase: "upper" });
          return { edited: { ...d.edited, definition } };
        } catch {
          return {};
        }
      });
    },

    closeResult: (id) => patch(id, () => ({ result: null })),
  };
});
