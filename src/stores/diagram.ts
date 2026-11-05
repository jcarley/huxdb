import { create } from "zustand";
import { compareStructure, reportCount, resolveOids, tableKey } from "../lib/diagramDrift";
import type { DriftReport } from "../lib/diagramDrift";
import { captureLayout, layoutSignature, restoreLayout } from "../lib/diagramFile";
import { dropRoutes, revealHubLines, toEdges, toNodes } from "../lib/diagramFlow";
import type { FkEdge, TableNode } from "../lib/diagramFlow";
import { layoutDiagram, tableBox } from "../lib/diagramLayout";
import type { Box, Layout } from "../lib/diagramLayout";
import { fontsReady, measureText, runElk } from "../lib/diagramBrowser";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { DiagramContent, DiagramLayoutFile, DiagramStructure, DiagramViewport, SavedDiagram } from "../lib/types";

/** Where a new diagram's picker was opened from. `schema` only decides what starts ticked. */
export interface DiagramTarget {
  connectionId: string;
  database: string;
  schema: string;
}

export interface DiagramEditor {
  connectionId: string;
  database: string;
  /** A new diagram's chosen tables. Afterwards the snapshot says what's on it. */
  oids: number[];
  status: "loading" | "ready" | "error";
  error: string | null;
  nodes: TableNode[];
  edges: FkEdge[];
  /** Today's structure, from the database. */
  structure: DiagramStructure | null;
  /** The structure as last accepted, which drift is compared against. */
  snapshot: DiagramStructure | null;
  /** `tableKey` of every table the database had at that point. */
  known: string[];
  layout: DiagramLayoutFile | null;
  viewport: DiagramViewport | null;
  /** What changed since `snapshot`; null when nothing did. */
  report: DriftReport | null;
  /** Tables changed size or arrived, so the banner offers a new layout. */
  offerLayout: boolean;
  /** A designer saved something in this database since it loaded. */
  outOfDate: boolean;
  /** `layoutSignature` at the last save. Null means never saved, or a change only Save can settle. */
  baseline: string | null;
  dirty: boolean;
  /** The file's modification time, to notice it changing behind this tab. */
  stamp: number | null;
}

/** What a choice in the report adds. */
export interface ReportChoices {
  /** OIDs of new tables to put on the diagram. */
  add: number[];
  /** Keys of removed tables confirmed as renamed. */
  renames: string[];
}

interface DiagramsState {
  /** Per tab id, here rather than in the component so a hidden tab keeps its state. */
  diagrams: Record<string, DiagramEditor>;
  /** The New Diagram picker, when it's open. */
  picker: DiagramTarget | null;
  openPicker: (target: DiagramTarget) => void;
  closePicker: () => void;
  open: (tab: { id: string; connectionId: string; database: string }, oids: number[]) => void;
  openSaved: (tab: { id: string; connectionId: string; database: string }, saved: SavedDiagram) => void;
  dispose: (id: string) => void;
  /** Reads the database. A new diagram gets a layout, and a saved one is compared with its snapshot. */
  load: (id: string) => Promise<void>;
  /** React Flow's next nodes. `moved` are tables being dragged, and `settled` means a drag just ended. */
  setNodes: (id: string, nodes: TableNode[], moved: Set<string>, settled: boolean) => void;
  select: (id: string, selected: Set<string>) => void;
  setViewport: (id: string, viewport: DiagramViewport) => void;
  /** A fresh layout of the whole diagram. */
  autoLayout: (id: string) => Promise<void>;
  /** Applies the report's choices and makes today's structure the snapshot. Rejects with the backend error. */
  acceptReport: (id: string, choices: ReportChoices) => Promise<void>;
  /** What Save writes. */
  content: (id: string) => DiagramContent | null;
  markSaved: (id: string, stamp: number | null) => void;
  /** Its file is gone, so only a new save can settle it. */
  markUnsaved: (id: string) => void;
  /** A designer saved in this database. */
  databaseChanged: (connectionId: string, database: string) => void;
}

const measure = async (structure: DiagramStructure) => {
  await fontsReady();
  return new Map<number, Box>(structure.tables.map((t) => [t.oid, tableBox(t, measureText)]));
};

const candidateKeys = (candidates: { schema: string; name: string }[]) => candidates.map(tableKey);

/** Screen state for a layout. */
const drawn = (structure: DiagramStructure, layout: Layout, boxes: Map<number, Box>) => ({ nodes: toNodes(structure, layout, boxes), edges: toEdges(structure, layout) });

const isDirty = (nodes: TableNode[], baseline: string | null) => baseline === null || layoutSignature(nodes) !== baseline;

export const diagramDirty = (diagram: DiagramEditor | undefined) => !!diagram?.dirty;
export const isDiagramDirty = (id: string) => diagramDirty(useDiagrams.getState().diagrams[id]);

export const useDiagrams = create<DiagramsState>((set, get) => {
  const update = (id: string, change: (d: DiagramEditor) => Partial<DiagramEditor>) =>
    set((s) => {
      const diagram = s.diagrams[id];
      return diagram ? { diagrams: { ...s.diagrams, [id]: { ...diagram, ...change(diagram) } } } : s;
    });
  /** Each load gets a number, so a retry or a closed tab can't be overwritten by a late answer. */
  const latest = new Map<string, number>();

  const blank = (connectionId: string, database: string, oids: number[]): DiagramEditor => ({
    connectionId,
    database,
    oids,
    status: "loading",
    error: null,
    nodes: [],
    edges: [],
    structure: null,
    snapshot: null,
    known: [],
    layout: null,
    viewport: null,
    report: null,
    offerLayout: false,
    outOfDate: false,
    baseline: null,
    dirty: true,
    stamp: null,
  });

  /** The layout as it stands, including places kept for tables that have gone. */
  const currentLayout = (d: DiagramEditor) => (d.structure ? captureLayout(d.structure, d.nodes, d.edges, d.layout, d.viewport) : (d.layout ?? { tables: {}, routes: {}, viewport: d.viewport }));

  async function loadNew(id: string, d: DiagramEditor, request: number) {
    const [candidates, structure] = await Promise.all([api.diagramCandidates(d.connectionId, d.database), api.diagramStructure(d.connectionId, d.database, d.oids)]);
    const boxes = await measure(structure);
    const layout = await layoutDiagram(structure.tables, structure.foreignKeys, boxes, runElk);
    if (latest.get(id) !== request) return;
    update(id, () => ({ status: "ready", structure, snapshot: structure, known: candidateKeys(candidates), outOfDate: false, ...drawn(structure, layout, boxes) }));
  }

  async function reconcile(id: string, d: DiagramEditor, snapshot: DiagramStructure, request: number) {
    const layoutFile = currentLayout(d);
    const candidates = await api.diagramCandidates(d.connectionId, d.database);
    const structure = await api.diagramStructure(d.connectionId, d.database, resolveOids(snapshot, candidates));
    const boxes = await measure(structure);
    const report = compareStructure(snapshot, d.known, structure, candidates);
    const layout = restoreLayout(layoutFile, structure, boxes, new Set(report.modified.map((m) => m.key)));
    if (latest.get(id) !== request) return;
    const screen = drawn(structure, layout, boxes);
    // A saved diagram's first load sets what later changes are measured against.
    update(id, (now) => {
      const baseline = now.nodes.length || now.baseline === null ? now.baseline : layoutSignature(screen.nodes);
      return {
        status: "ready",
        structure,
        layout: layoutFile,
        report: reportCount(report) ? report : null,
        offerLayout: report.modified.length > 0,
        outOfDate: false,
        baseline,
        dirty: isDirty(screen.nodes, baseline),
        ...screen,
      };
    });
  }

  return {
    diagrams: {},
    picker: null,
    openPicker: (picker) => set({ picker }),
    closePicker: () => set({ picker: null }),

    open: ({ id, connectionId, database }, oids) => {
      set((s) => ({ diagrams: { ...s.diagrams, [id]: blank(connectionId, database, oids) } }));
      void get().load(id);
    },

    openSaved: ({ id, connectionId, database }, saved) => {
      const diagram: DiagramEditor = {
        ...blank(connectionId, database, []),
        snapshot: saved.snapshot,
        known: saved.known,
        layout: saved.layout,
        viewport: saved.layout.viewport,
        baseline: "",
        dirty: false,
        stamp: saved.modifiedMs,
      };
      set((s) => ({ diagrams: { ...s.diagrams, [id]: diagram } }));
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
      // A refresh keeps the diagram on screen.
      update(id, (d) => ({ status: d.nodes.length ? "ready" : "loading", error: null }));
      try {
        if (diagram.snapshot) await reconcile(id, diagram, diagram.snapshot, request);
        else await loadNew(id, diagram, request);
      } catch (err) {
        if (latest.get(id) === request) update(id, () => ({ status: "error", error: errorMessage(err) }));
      }
    },

    setNodes: (id, nodes, moved, settled) =>
      update(id, (d) => ({
        nodes,
        edges: moved.size ? dropRoutes(d.edges, moved) : d.edges,
        // Only when a drag ends: comparing every table on every frame would slow the drag.
        dirty: settled ? isDirty(nodes, d.baseline) : d.dirty,
      })),

    select: (id, selected) => {
      const diagram = get().diagrams[id];
      if (!diagram) return;
      const edges = revealHubLines(diagram.edges, selected);
      if (edges !== diagram.edges) update(id, () => ({ edges }));
    },

    setViewport: (id, viewport) => update(id, () => ({ viewport })),

    autoLayout: async (id) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure) return;
      const { structure } = diagram;
      const boxes = await measure(structure);
      const layout = await layoutDiagram(structure.tables, structure.foreignKeys, boxes, runElk);
      const screen = drawn(structure, layout, boxes);
      update(id, (d) => ({ ...screen, offerLayout: false, dirty: isDirty(screen.nodes, d.baseline) }));
    },

    acceptReport: async (id, { add, renames }) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure) return;
      const { connectionId, database, report } = diagram;
      const layout = currentLayout(diagram);
      const renamed: number[] = [];
      for (const removed of report?.removed ?? []) {
        const place = layout.tables[removed.key];
        delete layout.tables[removed.key];
        if (removed.renamedTo && renames.includes(removed.key)) {
          renamed.push(removed.renamedTo.oid);
          if (place) layout.tables[tableKey(removed.renamedTo)] = place;
        }
      }
      const oids = [...diagram.structure.tables.map((t) => t.oid), ...renamed, ...add];
      const [candidates, structure] = await Promise.all([api.diagramCandidates(connectionId, database), api.diagramStructure(connectionId, database, oids)]);
      const boxes = await measure(structure);
      const restored = restoreLayout(layout, structure, boxes, new Set(report?.modified.map((m) => m.key)));
      update(id, (d) => ({
        structure,
        snapshot: structure,
        known: candidateKeys(candidates),
        layout,
        report: null,
        offerLayout: d.offerLayout || add.length > 0,
        // The snapshot changed, which only Save can settle.
        baseline: null,
        dirty: true,
        ...drawn(structure, restored, boxes),
      }));
    },

    content: (id) => {
      const diagram = get().diagrams[id];
      if (!diagram?.snapshot) return null;
      return { objects: diagram.snapshot.tables.length, layout: currentLayout(diagram), snapshot: diagram.snapshot, known: diagram.known };
    },

    markSaved: (id, stamp) => update(id, (d) => ({ stamp, layout: currentLayout(d), baseline: layoutSignature(d.nodes), dirty: false })),

    markUnsaved: (id) => update(id, () => ({ stamp: null, baseline: null, dirty: true })),

    databaseChanged: (connectionId, database) =>
      set((s) => ({
        diagrams: Object.fromEntries(Object.entries(s.diagrams).map(([id, d]) => [id, d.connectionId === connectionId && d.database === database ? { ...d, outOfDate: true } : d])),
      })),
  };
});
