import { create } from "zustand";
import { compareStructure, reportCount, resolveOids, tableKey } from "../lib/diagramDrift";
import type { DriftReport } from "../lib/diagramDrift";
import { captureLayout, layoutSignature, restoreLayout } from "../lib/diagramFile";
import { dropRoutes, reshapeNodes, revealHubLines, toEdges, toNodes } from "../lib/diagramFlow";
import type { FkEdge, TableNode } from "../lib/diagramFlow";
import { defaultOptions, layoutDiagram, tableBox } from "../lib/diagramLayout";
import type { Box, Layout } from "../lib/diagramLayout";
import { fontsReady, measureText, runElk } from "../lib/diagramBrowser";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { DiagramContent, DiagramForeignKey, DiagramLayoutFile, DiagramOptions, DiagramStructure, DiagramViewport, SavedDiagram } from "../lib/types";

/** Where a new diagram's picker was opened from. `schema` only decides what starts ticked. */
export interface DiagramTarget {
  connectionId: string;
  database: string;
  schema: string;
  /** Set when changing an open diagram's tables, rather than making a new one. */
  tabId?: string;
  /** OIDs that start ticked, instead of the schema's tables. */
  ticked?: number[];
}

export interface DiagramSelection {
  nodes: string[];
  /** A foreign key's oid, as an edge id. */
  edge: string | null;
}

const NOTHING_SELECTED: DiagramSelection = { nodes: [], edge: null };

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
  options: DiagramOptions | null;
  selection: DiagramSelection;
  /** The foreign key under the pointer, whose fields are highlighted. */
  hover: DiagramForeignKey | null;
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
  setEdges: (id: string, edges: FkEdge[]) => void;
  /** Follows React Flow's selection. */
  select: (id: string, selection: DiagramSelection) => void;
  /** Selects one table from outside the canvas. */
  selectNode: (id: string, node: string) => void;
  setHover: (id: string, foreignKey: DiagramForeignKey | null) => void;
  /** Changes how tables are drawn. They grow in place, and the banner offers a new layout. */
  setOptions: (id: string, change: Partial<DiagramOptions>) => Promise<void>;
  /** Takes tables off the diagram. The database isn't touched. */
  removeTables: (id: string, nodes: string[]) => void;
  /** Makes these the diagram's tables, keeping the places of those that stay. Rejects with the backend error. */
  setTables: (id: string, oids: number[]) => Promise<void>;
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

const measure = async (structure: DiagramStructure, options: DiagramOptions) => {
  await fontsReady();
  return new Map<number, Box>(structure.tables.map((t) => [t.oid, tableBox(t, measureText, options)]));
};

const candidateKeys = (candidates: { schema: string; name: string }[]) => candidates.map(tableKey);

/** Screen state for a layout. */
const drawn = (structure: DiagramStructure, layout: Layout, boxes: Map<number, Box>, options: DiagramOptions) => ({
  nodes: toNodes(structure, layout, boxes, options),
  edges: toEdges(structure, layout),
  selection: NOTHING_SELECTED,
  hover: null,
});

const isDirty = (nodes: TableNode[], options: DiagramOptions | null, baseline: string | null) => baseline === null || layoutSignature(nodes, options ?? undefined) !== baseline;

/** Changes that move rows inside a table, so a saved route no longer meets its column. */
const movesRows = (change: Partial<DiagramOptions>) => "fontSize" in change || "showObjectComments" in change;

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
    options: null,
    selection: NOTHING_SELECTED,
    hover: null,
    report: null,
    offerLayout: false,
    outOfDate: false,
    baseline: null,
    dirty: true,
    stamp: null,
  });

  /** The layout as it stands, including places kept for tables that have gone. */
  const currentLayout = (d: DiagramEditor) => (d.structure ? captureLayout(d.structure, d.nodes, d.edges, d.layout, d.viewport, d.options ?? undefined) : (d.layout ?? { tables: {}, routes: {}, viewport: d.viewport }));

  async function loadNew(id: string, d: DiagramEditor, request: number) {
    const [candidates, structure] = await Promise.all([api.diagramCandidates(d.connectionId, d.database), api.diagramStructure(d.connectionId, d.database, d.oids)]);
    const options = defaultOptions(structure.tables);
    const boxes = await measure(structure, options);
    const layout = await layoutDiagram(structure.tables, structure.foreignKeys, boxes, runElk, options);
    if (latest.get(id) !== request) return;
    update(id, () => ({ status: "ready", structure, snapshot: structure, known: candidateKeys(candidates), options, outOfDate: false, ...drawn(structure, layout, boxes, options) }));
  }

  async function reconcile(id: string, d: DiagramEditor, snapshot: DiagramStructure, request: number) {
    const layoutFile = currentLayout(d);
    const candidates = await api.diagramCandidates(d.connectionId, d.database);
    const structure = await api.diagramStructure(d.connectionId, d.database, resolveOids(snapshot, candidates));
    const options = d.options ?? defaultOptions(structure.tables);
    const boxes = await measure(structure, options);
    const report = compareStructure(snapshot, d.known, structure, candidates);
    const layout = restoreLayout(layoutFile, structure, boxes, new Set(report.modified.map((m) => m.key)));
    if (latest.get(id) !== request) return;
    const screen = drawn(structure, layout, boxes, options);
    // A saved diagram's first load sets what later changes are measured against.
    update(id, (now) => {
      const baseline = now.nodes.length || now.baseline === null ? now.baseline : layoutSignature(screen.nodes, options);
      return {
        status: "ready",
        structure,
        layout: layoutFile,
        report: reportCount(report) ? report : null,
        options,
        offerLayout: report.modified.length > 0,
        outOfDate: false,
        baseline,
        dirty: isDirty(screen.nodes, options, baseline),
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
        // Older files have none. Filling in from defaults keeps them clean, and they gain options on the next save.
        options: { ...defaultOptions(saved.snapshot.tables), ...saved.layout.options },
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
        dirty: settled ? isDirty(nodes, d.options, d.baseline) : d.dirty,
      })),

    setEdges: (id, edges) => update(id, () => ({ edges })),

    select: (id, selection) => {
      const diagram = get().diagrams[id];
      if (!diagram) return;
      const edges = revealHubLines(diagram.edges, new Set(selection.nodes));
      const same = diagram.selection.edge === selection.edge && diagram.selection.nodes.length === selection.nodes.length && selection.nodes.every((n, i) => n === diagram.selection.nodes[i]);
      if (edges !== diagram.edges || !same) update(id, () => ({ edges, selection }));
    },

    selectNode: (id, node) =>
      update(id, (d) => ({
        nodes: d.nodes.map((n) => {
          const selected = n.id === node;
          return !!n.selected === selected ? n : { ...n, selected };
        }),
        edges: revealHubLines(d.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), new Set([node])),
        selection: { nodes: [node], edge: null },
      })),

    setHover: (id, hover) => update(id, () => ({ hover })),

    setOptions: async (id, change) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure || !diagram.options) return;
      const options = { ...diagram.options, ...change };
      const boxes = await measure(diagram.structure, options);
      update(id, (d) => {
        const nodes = reshapeNodes(d.nodes, diagram.structure!, boxes, options);
        const resized = nodes.some((n, i) => n.width !== d.nodes[i]?.width || n.height !== d.nodes[i]?.height);
        return {
          options,
          nodes,
          edges: movesRows(change) ? dropRoutes(d.edges, new Set(nodes.map((n) => n.id))) : d.edges,
          offerLayout: d.offerLayout || resized,
          dirty: isDirty(nodes, options, d.baseline),
        };
      });
    },

    removeTables: (id, nodes) =>
      update(id, (d) => {
        if (!d.structure || !d.snapshot) return {};
        const gone = new Set(nodes);
        const keep = <T extends { tables: { oid: number }[]; foreignKeys: { childOid: number; parentOid: number }[] }>(s: T, stays: (t: T["tables"][number]) => boolean) => {
          const tables = s.tables.filter(stays);
          const oids = new Set(tables.map((t) => t.oid));
          return { ...s, tables, foreignKeys: s.foreignKeys.filter((fk) => oids.has(fk.childOid) && oids.has(fk.parentOid)) };
        };
        const removed = d.structure.tables.filter((t) => gone.has(String(t.oid)));
        const keys = new Set(removed.map(tableKey));
        const layout = currentLayout(d);
        for (const key of keys) delete layout.tables[key];
        const left = d.nodes.filter((n) => !gone.has(n.id));
        return {
          structure: keep(d.structure, (t) => !gone.has(String(t.oid))),
          snapshot: keep(d.snapshot, (t) => !keys.has(tableKey(t as { schema: string; name: string }))),
          layout,
          nodes: left,
          edges: d.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
          selection: NOTHING_SELECTED,
          hover: null,
          dirty: isDirty(left, d.options, d.baseline),
        };
      }),

    setTables: async (id, oids) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure || !diagram.options) return;
      const { connectionId, database, options } = diagram;
      const [candidates, structure] = await Promise.all([api.diagramCandidates(connectionId, database), api.diagramStructure(connectionId, database, oids)]);
      const boxes = await measure(structure, options);
      const chosen = new Set(oids);
      const layout = currentLayout(diagram);
      for (const table of diagram.structure.tables) if (!chosen.has(table.oid)) delete layout.tables[tableKey(table)];
      const screen = drawn(structure, restoreLayout(layout, structure, boxes, new Set()), boxes, options);
      const arrived = oids.some((oid) => !diagram.structure!.tables.some((t) => t.oid === oid));
      update(id, (d) => ({
        structure,
        snapshot: structure,
        known: candidateKeys(candidates),
        layout,
        offerLayout: d.offerLayout || arrived,
        dirty: isDirty(screen.nodes, options, d.baseline),
        ...screen,
      }));
    },

    setViewport: (id, viewport) => update(id, () => ({ viewport })),

    autoLayout: async (id) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure) return;
      const { structure } = diagram;
      const options = diagram.options ?? defaultOptions(structure.tables);
      const boxes = await measure(structure, options);
      const layout = await layoutDiagram(structure.tables, structure.foreignKeys, boxes, runElk, options);
      const screen = drawn(structure, layout, boxes, options);
      update(id, (d) => ({ ...screen, offerLayout: false, dirty: isDirty(screen.nodes, d.options, d.baseline) }));
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
      const options = diagram.options ?? defaultOptions(structure.tables);
      const boxes = await measure(structure, options);
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
        ...drawn(structure, restored, boxes, options),
      }));
    },

    content: (id) => {
      const diagram = get().diagrams[id];
      if (!diagram?.snapshot) return null;
      return { objects: diagram.snapshot.tables.length, layout: currentLayout(diagram), snapshot: diagram.snapshot, known: diagram.known };
    },

    markSaved: (id, stamp) => update(id, (d) => ({ stamp, layout: currentLayout(d), baseline: layoutSignature(d.nodes, d.options ?? undefined), dirty: false })),

    markUnsaved: (id) => update(id, () => ({ stamp: null, baseline: null, dirty: true })),

    databaseChanged: (connectionId, database) =>
      set((s) => ({
        diagrams: Object.fromEntries(Object.entries(s.diagrams).map(([id, d]) => [id, d.connectionId === connectionId && d.database === database ? { ...d, outOfDate: true } : d])),
      })),
  };
});
