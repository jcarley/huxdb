import { create } from "zustand";
import { compareStructure, foreignKeyKey, objectKind, reportCount, resolveOids, tableKey } from "../lib/diagramDrift";
import type { DriftReport } from "../lib/diagramDrift";
import { annotationLines, bottomZ, DIAGRAM_COLORS, isAnnotationId, newAnnotation, newAnnotationId, PASTE_OFFSET, topZ } from "../lib/diagramAnnotations";
import { captureLayout, EMPTY_COLORS, layoutSignature, pruneColors, renameColors, restoreLayout } from "../lib/diagramFile";
import { applyArrangement, currentArrangement, dropRoutes, reshapeNodes, revealHubLines, selectionArrangement, syncAnnotations, toAnnotationNodes, toEdges, toNodes } from "../lib/diagramFlow";
import type { AnnotationNode, Arrangement, DiagramEdge, DiagramNode } from "../lib/diagramFlow";
import { defaultOptions, keysWithin, layoutDiagram, layoutEdges, tableBox } from "../lib/diagramLayout";
import type { Box, Layout, Point } from "../lib/diagramLayout";
import { fontsReady, measureText, runElk, startLayout } from "../lib/diagramBrowser";
import type { LayoutJob } from "../lib/diagramBrowser";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { ViewColumnSource, DiagramAnnotation, DiagramColor, DiagramColors, DiagramContent, DiagramForeignKey, DiagramLayoutFile, DiagramOptions, DiagramStructure, DiagramViewport, SavedDiagram } from "../lib/types";

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
  /** That foreign key, so tables needn't search for it to highlight their columns. */
  foreignKey: DiagramForeignKey | null;
}

/** A view's column sources: loading, read, or failed. */
export type ViewTrace = { status: "loading" } | { status: "ready"; columns: ViewColumnSource[] } | { status: "error"; error: string };

const NOTHING_SELECTED: DiagramSelection = { nodes: [], edge: null, foreignKey: null };

export interface DiagramEditor {
  connectionId: string;
  database: string;
  /** A new diagram's chosen tables. Afterwards the snapshot says what's on it. */
  oids: number[];
  status: "loading" | "ready" | "error";
  error: string | null;
  nodes: DiagramNode[];
  /** Labels and notes, with places synced from their nodes. */
  annotations: DiagramAnnotation[];
  colors: DiagramColors;
  /** The annotation whose text is being typed. */
  editing: string | null;
  /** Copied annotations, placed where the next paste lands. */
  clipboard: DiagramAnnotation[];
  edges: DiagramEdge[];
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
  /** Each selected view's column sources by oid. Cleared whenever the tables are drawn again. */
  traces: Record<number, ViewTrace>;
  /** The foreign key under the pointer, whose fields are highlighted. */
  hover: DiagramForeignKey | null;
  /** What changed since `snapshot`; null when nothing did. */
  report: DriftReport | null;
  /** Tables changed size or arrived, or names need room, so the banner offers a new layout. */
  offerLayout: boolean;
  /** Auto Layout is working. */
  layingOut: boolean;
  layoutError: string | null;
  /** Counts whole-diagram layouts, each of which brings the result into view. */
  layoutsDone: number;
  /** What each Auto Layout replaced, newest last. */
  undo: LayoutUndo[];
  /** A designer saved something in this database since it loaded. */
  outOfDate: boolean;
  /** `layoutSignature` at the last save. Null means never saved, or a change only Save can settle. */
  baseline: string | null;
  dirty: boolean;
  /** The file's modification time, to notice it changing behind this tab. */
  stamp: number | null;
}

/** How far back Undo reaches. */
const UNDO_LIMIT = 20;

interface LayoutUndo extends Arrangement {
  offerLayout: boolean;
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
  setNodes: (id: string, nodes: DiagramNode[], moved: Set<string>, settled: boolean, resized?: Set<string>) => void;
  setEdges: (id: string, edges: DiagramEdge[]) => void;
  /** Follows React Flow's selection. */
  select: (id: string, selection: Omit<DiagramSelection, "foreignKey">) => void;
  /** Selects one table from outside the canvas. */
  selectNode: (id: string, node: string) => void;
  /** Reads where a view's columns come from. A running or finished trace is kept, and a failed one runs again. */
  traceView: (id: string, oid: number) => Promise<void>;
  setHover: (id: string, foreignKey: DiagramForeignKey | null) => void;
  /** Changes how tables are drawn. They grow in place, and the banner offers a new layout. */
  setOptions: (id: string, change: Partial<DiagramOptions>) => Promise<void>;
  /** Adds a label or note on top of the others, selected and ready to type in. */
  addAnnotation: (id: string, kind: "label" | "note", at: Point) => void;
  updateAnnotation: (id: string, annotationId: string, change: Partial<Pick<DiagramAnnotation, "text" | "fontSize" | "bold" | "italic" | "color">>) => void;
  startEditing: (id: string, annotationId: string) => void;
  /** Ends typing. An annotation left blank is removed. */
  stopEditing: (id: string) => void;
  deleteAnnotations: (id: string, ids: string[]) => void;
  bringToFront: (id: string, ids: string[]) => void;
  sendToBack: (id: string, ids: string[]) => void;
  copyAnnotations: (id: string, ids: string[]) => void;
  pasteAnnotations: (id: string) => void;
  /** Colours tables by node id; annotation ids are ignored. Null removes the colour. */
  setObjectColor: (id: string, nodes: string[], color: DiagramColor | null) => void;
  /** Colours a foreign key's line, by its edge id. */
  setLineColor: (id: string, foreignKeyId: string, color: DiagramColor | null) => void;
  /** Takes tables off the diagram. The database isn't touched. */
  removeTables: (id: string, nodes: string[]) => void;
  /** Makes these the diagram's tables, keeping the places of those that stay. Rejects with the backend error. */
  setTables: (id: string, oids: number[]) => Promise<void>;
  setViewport: (id: string, viewport: DiagramViewport) => void;
  /** Changes how Auto Layout works next, which moves nothing yet. */
  setLayoutOptions: (id: string, change: Partial<Pick<DiagramOptions, "objectDistance" | "layoutQuality" | "groupBySchema">>) => void;
  /** A fresh layout of these tables, or the whole diagram without any. A second call replaces a first still running. */
  autoLayout: (id: string, nodes?: string[]) => Promise<void>;
  cancelLayout: (id: string) => void;
  /** Puts tables and lines back as they were before the last Auto Layout. */
  undoLayout: (id: string) => void;
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

/** A name from a hand-edited or newer file that isn't in the palette would be drawn as an invalid CSS value. */
const isColor = (c: unknown): c is DiagramColor => DIAGRAM_COLORS.includes(c as DiagramColor);
const knownColor = (a: DiagramAnnotation): DiagramAnnotation => (a.color == null || isColor(a.color) ? a : { ...a, color: null });
const knownColors = (c: DiagramColors | undefined): DiagramColors => {
  if (!c) return EMPTY_COLORS;
  const only = (m: Record<string, DiagramColor>) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => isColor(v)));
  return { objects: only(c.objects), lines: only(c.lines) };
};

const candidateKeys = (candidates: { schema: string; name: string }[]) => candidates.map(tableKey);

/** Screen state for a layout. */
const drawn = (structure: DiagramStructure, layout: Layout, boxes: Map<number, Box>, options: DiagramOptions, annotations: DiagramAnnotation[]) => ({
  nodes: [...toNodes(structure, layout, boxes, options), ...toAnnotationNodes(annotations, measureText)],
  edges: toEdges(structure, layout),
  selection: NOTHING_SELECTED,
  traces: {},
  hover: null,
  undo: [],
});

type Signed = Pick<DiagramEditor, "nodes" | "options" | "annotations" | "colors" | "baseline">;
const signature = (d: Pick<Signed, "nodes" | "options" | "annotations" | "colors">) => layoutSignature(d.nodes, d.options ?? undefined, d.colors, d.annotations);
const isDirty = (d: Signed) => d.baseline === null || signature(d) !== d.baseline;

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
  /** A selected view shows where its columns come from. */
  const traceIfView = (id: string, node: string) => {
    const table = get().diagrams[id]?.structure?.tables.find((t) => String(t.oid) === node);
    if (table && (objectKind(table) === "view" || objectKind(table) === "materialized-view")) void get().traceView(id, table.oid);
  };
  /** Selecting only these nodes, and no line. */
  const selectOnly = (d: DiagramEditor, nodes: DiagramNode[], ids: string[]) => {
    const chosen = new Set(ids);
    return {
      nodes: nodes.map((n) => (!!n.selected === chosen.has(n.id) ? n : { ...n, selected: chosen.has(n.id) })),
      edges: revealHubLines(d.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), chosen),
      selection: { nodes: ids, edge: null, foreignKey: null },
    };
  };
  /** Swaps in changed annotations and redraws only their nodes, which keep their selection and place. */
  const replaceAnnotations = (d: DiagramEditor, changed: Map<string, DiagramAnnotation>) => {
    const annotations = d.annotations.map((a) => changed.get(a.id) ?? a);
    const fresh = new Map(toAnnotationNodes([...changed.values()], measureText).map((n) => [n.id, n]));
    const nodes = d.nodes.map((n) => {
      const f = fresh.get(n.id);
      return f ? ({ ...n, zIndex: f.zIndex, width: f.width, height: f.height, data: f.data } as AnnotationNode) : n;
    });
    return { annotations, nodes, dirty: isDirty({ ...d, annotations, nodes }) };
  };
  const withoutAnnotations = (d: DiagramEditor, gone: Set<string>) => {
    const annotations = d.annotations.filter((a) => !gone.has(a.id));
    const nodes = d.nodes.filter((n) => !gone.has(n.id));
    const kept = d.selection.nodes.filter((n) => !gone.has(n));
    return {
      annotations,
      nodes,
      selection: kept.length === d.selection.nodes.length ? d.selection : { ...d.selection, nodes: kept },
      editing: d.editing && gone.has(d.editing) ? null : d.editing,
      dirty: isDirty({ ...d, annotations, nodes }),
    };
  };
  /** Each load gets a number, so a retry or a closed tab can't be overwritten by a late answer. */
  const latest = new Map<string, number>();
  /** The running layout per tab. Replacing or removing one is what makes its late result drop. */
  const layouts = new Map<string, LayoutJob>();

  /** Anything that changes the tables stops a layout that was measured before it. */
  const stopLayout = (id: string) => {
    const job = layouts.get(id);
    if (!job) return;
    layouts.delete(id);
    job.cancel();
    update(id, () => ({ layingOut: false }));
  };

  const blank = (connectionId: string, database: string, oids: number[]): DiagramEditor => ({
    connectionId,
    database,
    oids,
    status: "loading",
    error: null,
    nodes: [],
    annotations: [],
    colors: EMPTY_COLORS,
    editing: null,
    clipboard: [],
    edges: [],
    structure: null,
    snapshot: null,
    known: [],
    layout: null,
    viewport: null,
    options: null,
    selection: NOTHING_SELECTED,
    traces: {},
    hover: null,
    report: null,
    offerLayout: false,
    layingOut: false,
    layoutError: null,
    layoutsDone: 0,
    undo: [],
    outOfDate: false,
    baseline: null,
    dirty: true,
    stamp: null,
  });

  /** The layout as it stands, including places kept for tables that have gone. */
  const currentLayout = (d: DiagramEditor): DiagramLayoutFile => ({
    ...(d.structure ? captureLayout(d.structure, d.nodes, d.edges, d.layout, d.viewport, d.options ?? undefined) : (d.layout ?? { tables: {}, routes: {}, viewport: d.viewport })),
    annotations: d.annotations,
    colors: d.colors,
  });

  async function loadNew(id: string, d: DiagramEditor, request: number) {
    const [candidates, structure] = await Promise.all([api.diagramCandidates(d.connectionId, d.database), api.diagramStructure(d.connectionId, d.database, d.oids)]);
    const options = defaultOptions(structure);
    const boxes = await measure(structure, options);
    const layout = await layoutDiagram(structure.tables, layoutEdges(structure), boxes, runElk, options);
    if (latest.get(id) !== request) return;
    // Annotations are read here, not before the awaits, so one edited meanwhile isn't drawn stale.
    update(id, (now) => ({ status: "ready", structure, snapshot: structure, known: candidateKeys(candidates), options, outOfDate: false, ...drawn(structure, layout, boxes, options, now.annotations) }));
  }

  async function reconcile(id: string, d: DiagramEditor, snapshot: DiagramStructure, request: number) {
    const layoutFile = currentLayout(d);
    const candidates = await api.diagramCandidates(d.connectionId, d.database);
    const structure = await api.diagramStructure(d.connectionId, d.database, resolveOids(snapshot, candidates));
    const options = d.options ?? defaultOptions(structure);
    const boxes = await measure(structure, options);
    const report = compareStructure(snapshot, d.known, structure, candidates);
    const layout = restoreLayout(layoutFile, structure, boxes, new Set(report.modified.map((m) => m.key)));
    if (latest.get(id) !== request) return;
    // A saved diagram's first load sets what later changes are measured against.
    update(id, (now) => {
      const screen = drawn(structure, layout, boxes, options, now.annotations);
      const baseline = now.nodes.length || now.baseline === null ? now.baseline : signature({ ...screen, options, colors: now.colors, annotations: now.annotations });
      return {
        status: "ready",
        structure,
        layout: layoutFile,
        report: reportCount(report) ? report : null,
        options,
        offerLayout: report.modified.length > 0,
        outOfDate: false,
        baseline,
        dirty: isDirty({ ...screen, options, baseline, colors: now.colors, annotations: now.annotations }),
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
        annotations: (saved.layout.annotations ?? []).map(knownColor),
        colors: knownColors(saved.layout.colors),
        viewport: saved.layout.viewport,
        // Older files have none. Filling in from defaults keeps them clean, and they gain options on the next save.
        options: { ...defaultOptions(saved.snapshot), ...saved.layout.options },
        baseline: "",
        dirty: false,
        stamp: saved.modifiedMs,
      };
      set((s) => ({ diagrams: { ...s.diagrams, [id]: diagram } }));
      void get().load(id);
    },

    dispose: (id) => {
      stopLayout(id);
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
      stopLayout(id);
      // A refresh keeps the diagram on screen.
      update(id, (d) => ({ status: d.nodes.length ? "ready" : "loading", error: null }));
      try {
        if (diagram.snapshot) await reconcile(id, diagram, diagram.snapshot, request);
        else await loadNew(id, diagram, request);
      } catch (err) {
        if (latest.get(id) === request) update(id, () => ({ status: "error", error: errorMessage(err) }));
      }
    },

    setNodes: (id, nodes, moved, settled, resized = new Set()) => {
      // Dragging says where a table goes, which a layout finishing later shouldn't undo.
      if (moved.size) stopLayout(id);
      update(id, (d) => {
        const annotations = d.annotations.length ? syncAnnotations(d.annotations, nodes, resized) : d.annotations;
        // A resized note wraps differently now, and its lines are what a later export draws.
        const shown = !resized.size
          ? nodes
          : nodes.map((n) => {
              const a = resized.has(n.id) ? annotations.find((x) => x.id === n.id) : undefined;
              return a && isAnnotationId(n.id) && (n as AnnotationNode).data.annotation !== a ? ({ ...n, data: { annotation: a, lines: annotationLines(a, measureText) } } as AnnotationNode) : n;
            });
        return {
          nodes: shown,
          annotations,
          edges: moved.size ? dropRoutes(d.edges, moved) : d.edges,
          // Only when a drag ends: comparing every table on every frame would slow the drag.
          dirty: settled ? isDirty({ ...d, nodes: shown, annotations }) : d.dirty,
        };
      });
    },

    setEdges: (id, edges) => update(id, () => ({ edges })),

    select: (id, selection) => {
      const diagram = get().diagrams[id];
      if (!diagram) return;
      const edges = revealHubLines(diagram.edges, new Set(selection.nodes));
      const same = diagram.selection.edge === selection.edge && diagram.selection.nodes.length === selection.nodes.length && selection.nodes.every((n, i) => n === diagram.selection.nodes[i]);
      const foreignKey = selection.edge ? (diagram.structure?.foreignKeys.find((fk) => String(fk.oid) === selection.edge) ?? null) : null;
      if (edges !== diagram.edges || !same) update(id, () => ({ edges, selection: { ...selection, foreignKey } }));
      if (selection.nodes.length === 1) traceIfView(id, selection.nodes[0]);
    },

    selectNode: (id, node) => {
      update(id, (d) => ({
        nodes: d.nodes.map((n) => {
          const selected = n.id === node;
          return !!n.selected === selected ? n : { ...n, selected };
        }),
        edges: revealHubLines(d.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), new Set([node])),
        selection: { nodes: [node], edge: null, foreignKey: null },
      }));
      traceIfView(id, node);
    },

    traceView: async (id, oid) => {
      const diagram = get().diagrams[id];
      if (!diagram || (diagram.traces[oid] && diagram.traces[oid].status !== "error")) return;
      // Identity, not a counter: drawing again replaces `traces`, which drops this answer.
      const pending: ViewTrace = { status: "loading" };
      update(id, (d) => ({ traces: { ...d.traces, [oid]: pending } }));
      const settle = (trace: ViewTrace) => update(id, (d) => (d.traces[oid] === pending ? { traces: { ...d.traces, [oid]: trace } } : {}));
      try {
        settle({ status: "ready", columns: await api.diagramViewSources(diagram.connectionId, diagram.database, oid) });
      } catch (e) {
        settle({ status: "error", error: errorMessage(e) });
      }
    },

    setHover: (id, hover) => update(id, () => ({ hover })),

    setOptions: async (id, change) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure || !diagram.options) return;
      const options = { ...diagram.options, ...change };
      const boxes = await measure(diagram.structure, options);
      stopLayout(id);
      update(id, (d) => {
        const nodes = reshapeNodes(d.nodes, diagram.structure!, boxes, options);
        const resized = nodes.some((n, i) => n.width !== d.nodes[i]?.width || n.height !== d.nodes[i]?.height);
        return {
          options,
          nodes,
          edges: movesRows(change) ? dropRoutes(d.edges, new Set(nodes.map((n) => n.id))) : d.edges,
          // Lines laid out without names have no room for them.
          offerLayout: d.offerLayout || resized || change.showRelationshipNames === true,
          // Saved routes wouldn't meet rows that moved.
          undo: movesRows(change) ? [] : d.undo,
          dirty: isDirty({ ...d, nodes, options }),
        };
      });
    },

    addAnnotation: (id, kind, at) =>
      update(id, (d) => {
        const added = newAnnotation(kind, at, topZ(d.annotations));
        const annotations = [...d.annotations, added];
        const nodes = [...d.nodes, ...toAnnotationNodes([added], measureText)];
        return { annotations, ...selectOnly(d, nodes, [added.id]), editing: added.id, dirty: isDirty({ ...d, annotations, nodes }) };
      }),

    updateAnnotation: (id, annotationId, change) =>
      update(id, (d) => {
        const a = d.annotations.find((x) => x.id === annotationId);
        return a ? replaceAnnotations(d, new Map([[annotationId, { ...a, ...change }]])) : {};
      }),

    startEditing: (id, annotationId) => update(id, (d) => (d.annotations.some((a) => a.id === annotationId) ? { editing: annotationId } : {})),

    stopEditing: (id) =>
      update(id, (d) => {
        if (!d.editing) return {};
        const a = d.annotations.find((x) => x.id === d.editing);
        return a && a.text.trim() === "" ? withoutAnnotations(d, new Set([a.id])) : { editing: null };
      }),

    deleteAnnotations: (id, ids) =>
      update(id, (d) => {
        const gone = new Set(ids.filter((n) => d.annotations.some((a) => a.id === n)));
        return gone.size ? withoutAnnotations(d, gone) : {};
      }),

    bringToFront: (id, ids) =>
      update(id, (d) => {
        const chosen = d.annotations.filter((a) => ids.includes(a.id)).sort((a, b) => a.z - b.z);
        const top = topZ(d.annotations);
        return chosen.length ? replaceAnnotations(d, new Map(chosen.map((a, i) => [a.id, { ...a, z: top + i }]))) : {};
      }),

    sendToBack: (id, ids) =>
      update(id, (d) => {
        const chosen = d.annotations.filter((a) => ids.includes(a.id)).sort((a, b) => a.z - b.z);
        // Tables sit at zIndex 0, so "back" means below it.
        const base = Math.min(bottomZ(d.annotations), -1);
        return chosen.length ? replaceAnnotations(d, new Map(chosen.map((a, i) => [a.id, { ...a, z: base - (chosen.length - 1 - i) }]))) : {};
      }),

    copyAnnotations: (id, ids) =>
      update(id, (d) => {
        const clipboard = d.annotations.filter((a) => ids.includes(a.id)).map((a) => ({ ...a }));
        return clipboard.length ? { clipboard } : {};
      }),

    pasteAnnotations: (id) =>
      update(id, (d) => {
        if (!d.clipboard.length) return {};
        const moved = d.clipboard.map((a) => ({ ...a, x: a.x + PASTE_OFFSET, y: a.y + PASTE_OFFSET }));
        const top = topZ(d.annotations);
        const pasted = [...moved].sort((a, b) => a.z - b.z).map((a, i) => ({ ...a, id: newAnnotationId(), z: top + i }));
        const annotations = [...d.annotations, ...pasted];
        const nodes = [...d.nodes, ...toAnnotationNodes(pasted, measureText)];
        return { annotations, clipboard: moved, ...selectOnly(d, nodes, pasted.map((a) => a.id)), dirty: isDirty({ ...d, annotations, nodes }) };
      }),

    setObjectColor: (id, nodes, color) =>
      update(id, (d) => {
        if (!d.structure) return {};
        const keys = d.structure.tables.filter((t) => nodes.includes(String(t.oid))).map(tableKey);
        const objects = { ...d.colors.objects };
        for (const key of keys) {
          if (color) objects[key] = color;
          else delete objects[key];
        }
        const colors = { ...d.colors, objects };
        return { colors, dirty: isDirty({ ...d, colors }) };
      }),

    setLineColor: (id, foreignKeyId, color) =>
      update(id, (d) => {
        const fk = d.structure?.foreignKeys.find((f) => String(f.oid) === foreignKeyId);
        const child = fk && d.structure?.tables.find((t) => t.oid === fk.childOid);
        if (!fk || !child) return {};
        const lines = { ...d.colors.lines };
        if (color) lines[foreignKeyKey(fk, child)] = color;
        else delete lines[foreignKeyKey(fk, child)];
        const colors = { ...d.colors, lines };
        return { colors, dirty: isDirty({ ...d, colors }) };
      }),

    removeTables: (id, nodes) => {
      stopLayout(id);
      update(id, (d) => {
        if (!d.structure || !d.snapshot) return {};
        // Annotations aren't tables: removing one is deleteAnnotations' job, or its entry would come back.
        const gone = new Set(nodes.filter((n) => !isAnnotationId(n)));
        const keep = <T extends { tables: { oid: number }[]; foreignKeys: { childOid: number; parentOid: number }[]; dependencies?: { dependentOid: number; sourceOid: number }[] }>(s: T, stays: (t: T["tables"][number]) => boolean) => {
          const tables = s.tables.filter(stays);
          const oids = new Set(tables.map((t) => t.oid));
          return { ...s, tables, foreignKeys: s.foreignKeys.filter((fk) => oids.has(fk.childOid) && oids.has(fk.parentOid)), ...(s.dependencies && { dependencies: s.dependencies.filter((d) => oids.has(d.dependentOid) && oids.has(d.sourceOid)) }) };
        };
        const removed = d.structure.tables.filter((t) => gone.has(String(t.oid)));
        const keys = new Set(removed.map(tableKey));
        const layout = currentLayout(d);
        for (const key of keys) delete layout.tables[key];
        // The selection is cleared below, so no node may stay marked.
        const left = d.nodes.filter((n) => !gone.has(n.id)).map((n) => (n.selected ? { ...n, selected: false } : n));
        const structure = keep(d.structure, (t) => !gone.has(String(t.oid)));
        const snapshot = keep(d.snapshot, (t) => !keys.has(tableKey(t as { schema: string; name: string })));
        // Against the snapshot: a table the report says is gone keeps its colour until that's accepted.
        const colors = pruneColors(d.colors, snapshot);
        return {
          structure,
          snapshot,
          colors,
          layout: { ...layout, colors },
          nodes: left,
          edges: d.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
          selection: NOTHING_SELECTED,
          hover: null,
          undo: [],
          dirty: isDirty({ ...d, nodes: left, colors }),
        };
      });
    },

    setTables: async (id, oids) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure || !diagram.options) return;
      stopLayout(id);
      const { connectionId, database, options } = diagram;
      const [candidates, structure] = await Promise.all([api.diagramCandidates(connectionId, database), api.diagramStructure(connectionId, database, oids)]);
      const boxes = await measure(structure, options);
      const chosen = new Set(oids);
      const layout = currentLayout(diagram);
      for (const table of diagram.structure.tables) if (!chosen.has(table.oid)) delete layout.tables[tableKey(table)];
      const restored = restoreLayout(layout, structure, boxes, new Set());
      const arrived = oids.some((oid) => !diagram.structure!.tables.some((t) => t.oid === oid));
      update(id, (d) => {
        const screen = drawn(structure, restored, boxes, options, d.annotations);
        const colors = pruneColors(d.colors, structure);
        return {
          structure,
          snapshot: structure,
          known: candidateKeys(candidates),
          colors,
          layout: { ...layout, colors },
          offerLayout: d.offerLayout || arrived,
          dirty: isDirty({ ...d, nodes: screen.nodes, options, colors }),
          ...screen,
        };
      });
    },

    setViewport: (id, viewport) => update(id, () => ({ viewport })),

    setLayoutOptions: (id, change) =>
      update(id, (d) => {
        const options = d.options && { ...d.options, ...change };
        return { options, dirty: isDirty({ ...d, options }) };
      }),

    autoLayout: async (id, nodes = []) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure) return;
      stopLayout(id);
      const job = startLayout();
      layouts.set(id, job);
      update(id, () => ({ layingOut: true, layoutError: null }));
      const { structure } = diagram;
      const options = diagram.options ?? defaultOptions(structure);
      const chosen = new Set(nodes.filter((n) => !isAnnotationId(n)));
      const tables = chosen.size ? structure.tables.filter((t) => chosen.has(String(t.oid))) : structure.tables;
      try {
        const boxes = await measure(structure, options);
        const layout = await layoutDiagram(tables, keysWithin(tables, layoutEdges(structure)), boxes, job.run, options);
        if (layouts.get(id) !== job) return;
        update(id, (d) => {
          const undo = [...d.undo, { ...currentArrangement(d.nodes, d.edges), offerLayout: d.offerLayout }].slice(-UNDO_LIMIT);
          const screen = chosen.size ? applyArrangement(d.nodes, d.edges, selectionArrangement(layout, d.nodes, d.edges, chosen, boxes)) : drawn(structure, layout, boxes, options, d.annotations);
          return { ...screen, undo, offerLayout: chosen.size ? d.offerLayout : false, layoutsDone: d.layoutsDone + (chosen.size ? 0 : 1), dirty: isDirty({ ...d, nodes: screen.nodes }) };
        });
      } catch (err) {
        if (layouts.get(id) === job) update(id, () => ({ layoutError: errorMessage(err) }));
      } finally {
        job.finish();
        if (layouts.get(id) === job) {
          layouts.delete(id);
          update(id, () => ({ layingOut: false }));
        }
      }
    },

    cancelLayout: stopLayout,

    undoLayout: (id) =>
      update(id, (d) => {
        const last = d.undo[d.undo.length - 1];
        if (!last) return {};
        const screen = applyArrangement(d.nodes, d.edges, last);
        return { ...screen, undo: d.undo.slice(0, -1), offerLayout: last.offerLayout, dirty: isDirty({ ...d, nodes: screen.nodes }) };
      }),

    acceptReport: async (id, { add, renames }) => {
      const diagram = get().diagrams[id];
      if (!diagram?.structure) return;
      stopLayout(id);
      const { connectionId, database, report } = diagram;
      const layout = currentLayout(diagram);
      const renamed: number[] = [];
      const pairs: { from: string; to: { schema: string; name: string } }[] = [];
      for (const removed of report?.removed ?? []) {
        const place = layout.tables[removed.key];
        delete layout.tables[removed.key];
        if (removed.renamedTo && renames.includes(removed.key)) {
          renamed.push(removed.renamedTo.oid);
          if (place) layout.tables[tableKey(removed.renamedTo)] = place;
          pairs.push({ from: removed.key, to: removed.renamedTo });
        }
      }
      const oids = [...diagram.structure.tables.map((t) => t.oid), ...renamed, ...add];
      const [candidates, structure] = await Promise.all([api.diagramCandidates(connectionId, database), api.diagramStructure(connectionId, database, oids)]);
      const options = diagram.options ?? defaultOptions(structure);
      const boxes = await measure(structure, options);
      const restored = restoreLayout(layout, structure, boxes, new Set(report?.modified.map((m) => m.key)));
      update(id, (d) => {
        // From the state now, so a colour set during the awaits isn't lost.
        const colors = pruneColors(pairs.reduce((c, p) => renameColors(c, p.from, p.to), d.colors), structure);
        return {
          structure,
          snapshot: structure,
          known: candidateKeys(candidates),
          colors,
          layout: { ...layout, colors },
          report: null,
          offerLayout: d.offerLayout || add.length > 0,
          // The snapshot changed, which only Save can settle.
          baseline: null,
          dirty: true,
          ...drawn(structure, restored, boxes, options, d.annotations),
        };
      });
    },

    content: (id) => {
      const diagram = get().diagrams[id];
      if (!diagram?.snapshot) return null;
      return { objects: diagram.snapshot.tables.length, layout: currentLayout(diagram), snapshot: diagram.snapshot, known: diagram.known };
    },

    markSaved: (id, stamp) => update(id, (d) => ({ stamp, layout: currentLayout(d), baseline: signature(d), dirty: false })),

    markUnsaved: (id) => update(id, () => ({ stamp: null, baseline: null, dirty: true })),

    databaseChanged: (connectionId, database) =>
      set((s) => ({
        diagrams: Object.fromEntries(Object.entries(s.diagrams).map(([id, d]) => [id, d.connectionId === connectionId && d.database === database ? { ...d, outOfDate: true } : d])),
      })),
  };
});
