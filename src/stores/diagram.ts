import { create } from "zustand";
import { dropRoutes, revealHubLines, toEdges, toNodes } from "../lib/diagramFlow";
import type { FkEdge, TableNode } from "../lib/diagramFlow";
import { layoutDiagram, tableBox } from "../lib/diagramLayout";
import { fontsReady, measureText, runElk } from "../lib/diagramBrowser";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";

/** Where a new diagram's picker was opened from. `schema` only decides what starts ticked. */
export interface DiagramTarget {
  connectionId: string;
  database: string;
  schema: string;
}

export interface DiagramEditor {
  connectionId: string;
  database: string;
  oids: number[];
  status: "loading" | "ready" | "error";
  error: string | null;
  nodes: TableNode[];
  edges: FkEdge[];
}

interface DiagramsState {
  /** Per tab id, here rather than in the component so a hidden tab keeps its state. */
  diagrams: Record<string, DiagramEditor>;
  /** The New Diagram picker, when it's open. */
  picker: DiagramTarget | null;
  openPicker: (target: DiagramTarget) => void;
  closePicker: () => void;
  open: (tab: { id: string; connectionId: string; database: string }, oids: number[]) => void;
  dispose: (id: string) => void;
  load: (id: string) => Promise<void>;
  /** React Flow's next nodes. `moved` are tables the user is dragging. */
  setNodes: (id: string, nodes: TableNode[], moved: Set<string>) => void;
  select: (id: string, selected: Set<string>) => void;
}

export const useDiagrams = create<DiagramsState>((set, get) => {
  const update = (id: string, change: (d: DiagramEditor) => Partial<DiagramEditor>) =>
    set((s) => {
      const diagram = s.diagrams[id];
      return diagram ? { diagrams: { ...s.diagrams, [id]: { ...diagram, ...change(diagram) } } } : s;
    });
  /** Each load gets a number, so a retry or a closed tab can't be overwritten by a late answer. */
  const latest = new Map<string, number>();

  return {
    diagrams: {},
    picker: null,
    openPicker: (picker) => set({ picker }),
    closePicker: () => set({ picker: null }),

    open: ({ id, connectionId, database }, oids) => {
      set((s) => ({ diagrams: { ...s.diagrams, [id]: { connectionId, database, oids, status: "loading", error: null, nodes: [], edges: [] } } }));
      void get().load(id);
    },

    dispose: (id) => {
      latest.delete(id);
      set((s) => {
        const { [id]: _, ...diagrams } = s.diagrams;
        return { diagrams };
      });
    },

    load: async (id) => {
      const diagram = get().diagrams[id];
      if (!diagram) return;
      const request = (latest.get(id) ?? 0) + 1;
      latest.set(id, request);
      update(id, () => ({ status: "loading", error: null }));
      try {
        const structure = await api.diagramStructure(diagram.connectionId, diagram.database, diagram.oids);
        await fontsReady();
        const boxes = new Map(structure.tables.map((t) => [t.oid, tableBox(t, measureText)]));
        const layout = await layoutDiagram(structure.tables, structure.foreignKeys, boxes, runElk);
        if (latest.get(id) !== request) return;
        update(id, () => ({ status: "ready", nodes: toNodes(structure, layout, boxes), edges: toEdges(structure, layout) }));
      } catch (err) {
        if (latest.get(id) === request) update(id, () => ({ status: "error", error: errorMessage(err) }));
      }
    },

    setNodes: (id, nodes, moved) => update(id, (d) => ({ nodes, edges: moved.size ? dropRoutes(d.edges, moved) : d.edges })),

    select: (id, selected) => {
      const diagram = get().diagrams[id];
      if (!diagram) return;
      const edges = revealHubLines(diagram.edges, selected);
      if (edges !== diagram.edges) update(id, () => ({ edges }));
    },
  };
});
