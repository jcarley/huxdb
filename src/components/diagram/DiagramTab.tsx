import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import { applyEdgeChanges, applyNodeChanges, Background, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStoreApi, useUpdateNodeInternals } from "@xyflow/react";
import type { EdgeChange, EdgeMouseHandler, NodeChange, NodeMouseHandler, OnSelectionChangeParams, Viewport } from "@xyflow/react";
import { Download, ListPlus, Network, Printer, RefreshCw, Save, SaveAll, StickyNote, Type, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { fitNote, isAnnotationId, objectNodes, PASTE_OFFSET } from "../../lib/diagramAnnotations";
import { measureText } from "../../lib/diagramBrowser";
import { annotationKeyAction } from "../../lib/diagramKeys";
import { reportCount } from "../../lib/diagramDrift";
import type { DriftReport } from "../../lib/diagramDrift";
import type { DiagramEdge, DiagramNode } from "../../lib/diagramFlow";
import { MAX_ZOOM, MIN_ZOOM, stepZoom } from "../../lib/diagramZoom";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { ToolButton } from "../ToolButton";
import { useContextMenu } from "../tree/ContextMenu";
import { AnnotationBox } from "./AnnotationBox";
import { DependencyLine } from "./DependencyLine";
import { DiagramId } from "./DiagramId";
import { ExportDialog } from "./ExportDialog";
import { FkLine } from "./FkLine";
import { FkMarkers } from "./FkMarkers";
import { LayoutOptions } from "./LayoutOptions";
import { designObject, nodeMenu, openTablePicker } from "./nodeMenu";
import { ObjectPane } from "./ObjectPane";
import { OverviewPane } from "./OverviewPane";
import { Pane } from "./Pane";
import { PropertiesPane } from "./PropertiesPane";
import { TableBox } from "./TableBox";

/** A layout quicker than this isn't worth a flash of progress. */
const PROGRESS_AFTER_MS = 1000;

const FIT = { minZoom: MIN_ZOOM, maxZoom: 1, padding: 0.03 };

const nodeTypes = { table: TableBox, label: AnnotationBox, note: AnnotationBox };
const edgeTypes = { fk: FkLine, dependency: DependencyLine };

/** Theme colours everything already reads, so nothing has to re-render to change them. */
const BLACK_AND_WHITE = { "--color-primary": "#1f2937", "--color-primary-content": "#ffffff", "--color-secondary": "#1f2937", "--color-warning": "#1f2937", "--color-accent": "#1f2937", "--color-info": "#1f2937", "--color-success": "#1f2937", "--color-error": "#1f2937", "--color-accent-content": "#ffffff", "--color-info-content": "#ffffff", "--color-success-content": "#ffffff", "--color-error-content": "#ffffff", "--color-secondary-content": "#ffffff", "--color-warning-content": "#ffffff" } as CSSProperties;

function Canvas({ id }: { id: string }) {
  const nodes = useDiagrams((s) => s.diagrams[id]?.nodes);
  const edges = useDiagrams((s) => s.diagrams[id]?.edges);
  const options = useDiagrams((s) => s.diagrams[id]?.options);
  const structure = useDiagrams((s) => s.diagrams[id]?.structure);
  const layoutsDone = useDiagrams((s) => s.diagrams[id]?.layoutsDone);
  const active = useTabs((s) => s.activeId === id);
  const openMenu = useContextMenu((s) => s.open);
  const flow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const measured = useNodesInitialized();
  const placed = useRef(false);

  // A tab that loads while hidden has no size to fit into, so this waits until it's showing.
  useEffect(() => {
    if (!active || !measured || placed.current) return;
    placed.current = true;
    const saved = useDiagrams.getState().diagrams[id]?.viewport;
    if (saved) void flow.setViewport(saved);
    else void flow.fitView(FIT);
  }, [active, flow, id, measured]);

  // A layout can send everything out of view, leaving only the mini-map to say where it went.
  useEffect(() => {
    if (layoutsDone) void flow.fitView(FIT);
  }, [flow, layoutsDone]);

  // Options and new foreign keys change handles without always resizing a node, which React Flow wouldn't notice.
  useEffect(() => {
    if (placed.current) updateNodeInternals(useDiagrams.getState().diagrams[id]?.nodes.map((n) => n.id) ?? []);
  }, [id, options, structure, updateNodeInternals]);

  const onNodesChange = useCallback(
    (changes: NodeChange<DiagramNode>[]) => {
      const { diagrams, setNodes } = useDiagrams.getState();
      // The resizer knows only the pointer: a note narrowed to wrap onto more lines must grow, not clip.
      changes = changes.map((c) => {
        const a = c.type === "dimensions" && c.resizing !== undefined && c.dimensions ? diagrams[id].annotations.find((x) => x.id === c.id) : undefined;
        return a && c.type === "dimensions" && c.dimensions ? { ...c, dimensions: fitNote(a, c.dimensions, measureText) } : c;
      });
      const moved = new Set(changes.flatMap((c) => (c.type === "position" && c.dragging ? [c.id] : [])));
      // A note's resize ends with a dimensions change, as a drag ends with a position one.
      const settled = changes.some((c) => (c.type === "position" && c.dragging === false) || (c.type === "dimensions" && c.resizing === false));
      // Only the resizer sets `resizing`; a measuring change doesn't, and isn't the user's size.
      const resized = new Set(changes.flatMap((c) => (c.type === "dimensions" && c.resizing !== undefined ? [c.id] : [])));
      setNodes(id, applyNodeChanges(changes, diagrams[id].nodes), moved, settled, resized);
    },
    [id],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<DiagramEdge>[]) => {
      const { diagrams, setEdges } = useDiagrams.getState();
      setEdges(id, applyEdgeChanges(changes, diagrams[id].edges));
    },
    [id],
  );
  const onSelectionChange = useCallback(
    ({ nodes, edges }: OnSelectionChangeParams) => useDiagrams.getState().select(id, { nodes: nodes.map((n) => n.id), edge: edges[0]?.id ?? null }),
    [id],
  );
  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => useDiagrams.getState().setViewport(id, viewport), [id]);
  const onNodeDoubleClick = useCallback<NodeMouseHandler<DiagramNode>>((_, node) => designObject(id, node.id), [id]);
  const onNodeContextMenu = useCallback<NodeMouseHandler<DiagramNode>>((e, node) => openMenu(e, nodeMenu(id, node.id)), [id, openMenu]);
  const onEdgeMouseEnter = useCallback<EdgeMouseHandler<DiagramEdge>>(
    (_, edge) => {
      const { diagrams, setHover } = useDiagrams.getState();
      setHover(id, diagrams[id]?.structure?.foreignKeys.find((fk) => String(fk.oid) === edge.id) ?? null);
    },
    [id],
  );
  const onEdgeMouseLeave = useCallback(() => useDiagrams.getState().setHover(id, null), [id]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onSelectionChange={onSelectionChange}
      onMoveEnd={onMoveEnd}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeMouseEnter={onEdgeMouseEnter}
      onEdgeMouseLeave={onEdgeMouseLeave}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      // The wheel pans, and ⌘-wheel (Ctrl elsewhere) zooms: that key is React Flow's default.
      panOnScroll
      zoomOnDoubleClick={false}
      nodesConnectable={false}
      edgesFocusable={false}
      elevateEdgesOnSelect
      elevateNodesOnSelect={false}
      deleteKeyCode={null}
    >
      <Background gap={20} />
      <FkMarkers tab={id} />
    </ReactFlow>
  );
}

const summary = ({ added, removed, modified, foreignKeys }: DriftReport) =>
  [added.length && `${added.length} added`, removed.length && `${removed.length} removed`, modified.length + foreignKeys.length && `${modified.length + foreignKeys.length} modified`].filter(Boolean).join(", ");

function Banner({ id }: { id: string }) {
  const report = useDiagrams((s) => s.diagrams[id]?.report);
  const outOfDate = useDiagrams((s) => s.diagrams[id]?.outOfDate);
  const offerLayout = useDiagrams((s) => s.diagrams[id]?.offerLayout);
  const layoutError = useDiagrams((s) => s.diagrams[id]?.layoutError);
  const { load, autoLayout } = useDiagrams.getState();
  if (!outOfDate && !offerLayout && !layoutError && !(report && reportCount(report))) return null;

  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-200 px-3 py-1.5 text-sm">
      {layoutError && <span className="text-error select-text">Auto Layout failed: {layoutError}</span>}
      {outOfDate ? <span>This database changed since the diagram loaded.</span> : report ? <span>{summary(report)} since this diagram was saved.</span> : offerLayout ? <span>The layout no longer fits what this diagram shows.</span> : null}
      {outOfDate && (
        <button type="button" className="btn btn-xs" onClick={() => void load(id)}>
          Refresh
        </button>
      )}
      {report && (
        <button type="button" className="btn btn-xs" onClick={() => useSavedDiagrams.getState().setPrompt({ kind: "report", tabId: id })}>
          Review
        </button>
      )}
      {offerLayout && (
        <button type="button" className="btn btn-xs" onClick={() => void autoLayout(id)}>
          Auto Layout
        </button>
      )}
    </div>
  );
}

/** Stays quiet for a quick layout, and offers a way out of a slow one. */
function LayoutProgress({ id }: { id: string }) {
  const running = useDiagrams((s) => s.diagrams[id]?.layingOut);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setSlow(true), PROGRESS_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [running]);
  if (!running || !slow) return null;
  return (
    <span role="status" className="flex items-center gap-2 text-xs text-base-content/70">
      <span className="loading loading-spinner loading-xs" /> Laying out…
      <button type="button" className="btn btn-xs" onClick={() => useDiagrams.getState().cancelLayout(id)}>
        Cancel
      </button>
    </span>
  );
}

/** Acts on the selection, or on everything when nothing's selected. One table has nothing to be arranged against. */
function LayoutButtons({ id }: { id: string }) {
  const selected = useDiagrams((s) => s.diagrams[id]?.selection.nodes);
  const canUndo = useDiagrams((s) => !!s.diagrams[id]?.undo.length);
  const objects = useMemo(() => objectNodes(selected ?? []), [selected]);
  const count = objects.length;
  const title = count === 1 ? "Select more objects, or none for the whole diagram" : count ? `Auto Layout the ${count} selected objects` : "Auto Layout the whole diagram";
  const run = () => void useDiagrams.getState().autoLayout(id, objects);
  return (
    <>
      <ToolButton icon={Network} label="Auto Layout" title={title} iconOnly disabled={count === 1} onClick={run} />
      <LayoutOptions id={id} runTitle={title} canRun={count !== 1} onRun={run} />
      <ToolButton icon={Undo2} label="Undo Layout" title="Undo Auto Layout (⌘Z)" iconOnly disabled={!canUndo} onClick={() => useDiagrams.getState().undoLayout(id)} />
      <LayoutProgress id={id} />
    </>
  );
}

/** Needs something to draw. */
function ExportButtons({ id, onOpen }: { id: string; onOpen: (mode: "export" | "print") => void }) {
  const empty = useDiagrams((s) => !s.diagrams[id]?.nodes.length);
  return (
    <>
      <ToolButton icon={Download} label="Export" title="Export the Diagram" iconOnly disabled={empty} onClick={() => onOpen("export")} />
      <ToolButton icon={Printer} label="Print" title="Print the Diagram" iconOnly disabled={empty} onClick={() => onOpen("print")} />
    </>
  );
}

/** Adds at the canvas's centre, stepped so a second click doesn't land on the first. */
function AnnotationButtons({ id }: { id: string }) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const add = (kind: "label" | "note") => {
    const { x, y, zoom } = flow.getViewport();
    const { width, height } = store.getState();
    const step = PASTE_OFFSET * ((useDiagrams.getState().diagrams[id]?.annotations.length ?? 0) % 10);
    useDiagrams.getState().addAnnotation(id, kind, { x: (width / 2 - x) / zoom + step, y: (height / 2 - y) / zoom + step });
  };
  return (
    <>
      <ToolButton icon={Type} label="Label" title="Add a Label" iconOnly onClick={() => add("label")} />
      <ToolButton icon={StickyNote} label="Note" title="Add a Note" iconOnly onClick={() => add("note")} />
    </>
  );
}

/** ⌘ on macOS, Ctrl elsewhere. Only the tab that's showing listens, and an open dialog owns the keyboard. */
function useKeys(id: string) {
  const active = useTabs((s) => s.activeId === id);
  const flow = useReactFlow();

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || document.querySelector("dialog[open]")) return;
      const state = useDiagrams.getState();
      const meta = e.metaKey || e.ctrlKey;
      const field = !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
      const diagram = state.diagrams[id];
      const selected = diagram?.selection.nodes ?? [];
      const note = annotationKeyAction({ key: e.key, meta, inField: field, textSelected: !!window.getSelection()?.toString() }, selected, !!diagram?.clipboard.length);
      if (note) {
        // WebKit goes back a page on Backspace unless it's prevented.
        e.preventDefault();
        if (note === "delete") state.deleteAnnotations(id, selected.filter(isAnnotationId));
        else if (note === "copy") state.copyAnnotations(id, selected.filter(isAnnotationId));
        else state.pasteAnnotations(id);
        return;
      }
      // WebKit goes back a page on Backspace outside a field, even when nothing here uses it.
      if (e.key === "Backspace" && !field) e.preventDefault();
      if (!meta) return;
      const saved = useSavedDiagrams.getState();
      const zoom = flow.getZoom();
      const actions: Record<string, () => void> = {
        s: () => (e.shiftKey ? saved.setPrompt({ kind: "save-as", tabId: id }) : void saved.save(id)),
        "0": () => void flow.zoomTo(1),
        "=": () => void flow.zoomTo(stepZoom(zoom, 1)),
        "+": () => void flow.zoomTo(stepZoom(zoom, 1)),
        "-": () => void flow.zoomTo(stepZoom(zoom, -1)),
        z: () => state.undoLayout(id),
      };
      const key = e.key.toLowerCase();
      const action = actions[key];
      if (!action) return;
      // A text field has its own undo.
      if (key === "z" && (e.shiftKey || field)) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, flow, id]);
}

function StatusBar({ id }: { id: string }) {
  const count = useDiagrams((s) => s.diagrams[id]?.structure?.tables.length ?? 0);
  const selected = useDiagrams((s) => s.diagrams[id]?.selection.nodes.length ?? 0);
  return (
    <div role="contentinfo" className="flex justify-center gap-3 border-t border-base-300 bg-base-200/50 py-0.5 text-xs text-base-content/70">
      <span>{count === 1 ? "1 object" : `${count} objects`}</span>
      {selected > 0 && <span>{selected} selected</span>}
    </div>
  );
}

function Workspace({ id }: { id: string }) {
  const pendingReport = useDiagrams((s) => !!s.diagrams[id]?.report);
  const blackAndWhite = useDiagrams((s) => s.diagrams[id]?.options?.blackAndWhite);
  const [exporting, setExporting] = useState<"export" | "print" | null>(null);
  useKeys(id);

  return (
    <DiagramId.Provider value={id}>
      {exporting && <ExportDialog id={id} mode={exporting} onClose={() => setExporting(null)} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-base-300 px-1 py-0.5">
          <ToolButton icon={Save} label="Save" title="Save (⌘S)" iconOnly onClick={() => void useSavedDiagrams.getState().save(id)} />
          <ToolButton icon={SaveAll} label="Save As" title="Save As (⌘⇧S)" iconOnly onClick={() => useSavedDiagrams.getState().setPrompt({ kind: "save-as", tabId: id })} />
          <ToolButton icon={RefreshCw} label="Refresh" title="Reload from the database" iconOnly onClick={() => void useDiagrams.getState().load(id)} />
          <ToolButton icon={ListPlus} label="Objects" title={pendingReport ? "Review the changes in the database first" : "Choose the Objects on This Diagram"} iconOnly disabled={pendingReport} onClick={() => openTablePicker(id)} />
          <AnnotationButtons id={id} />
          <LayoutButtons id={id} />
          <ExportButtons id={id} onOpen={setExporting} />
        </div>
        <Banner id={id} />
        <div className="flex min-h-0 flex-1">
          <Pane width="objectsWidth" handle="right">
            <ObjectPane id={id} />
          </Pane>
          <div className="min-h-0 min-w-0 flex-1" style={blackAndWhite ? BLACK_AND_WHITE : undefined}>
            <Canvas id={id} />
          </div>
          <Pane width="sideWidth" handle="left">
            <PropertiesPane id={id} />
            <OverviewPane />
          </Pane>
        </div>
        <StatusBar id={id} />
      </div>
    </DiagramId.Provider>
  );
}

export default function DiagramTab({ id }: { id: string }) {
  const status = useDiagrams((s) => s.diagrams[id]?.status);
  const error = useDiagrams((s) => s.diagrams[id]?.error);

  if (status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-lg whitespace-pre-wrap text-error select-text">{error}</p>
        <button type="button" className="btn btn-sm" onClick={() => void useDiagrams.getState().load(id)}>
          Retry
        </button>
      </div>
    );
  }
  if (status !== "ready") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-base-content/60">
        <span className="loading loading-spinner loading-sm" /> Reading the database…
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Workspace id={id} />
    </ReactFlowProvider>
  );
}
