import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import { applyNodeChanges, Background, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from "@xyflow/react";
import type { NodeChange, OnSelectionChangeParams, Viewport } from "@xyflow/react";
import { RefreshCw, Save, SaveAll } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { reportCount } from "../../lib/diagramDrift";
import type { DriftReport } from "../../lib/diagramDrift";
import type { TableNode } from "../../lib/diagramFlow";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { ToolButton } from "../ToolButton";
import { FkLine } from "./FkLine";
import { TableBox } from "./TableBox";

const nodeTypes = { table: TableBox };
const edgeTypes = { fk: FkLine };
/** React Flow's default of 0.5 can't fit a large diagram. */
const MIN_ZOOM = 0.01;

function Canvas({ id }: { id: string }) {
  const nodes = useDiagrams((s) => s.diagrams[id]?.nodes);
  const edges = useDiagrams((s) => s.diagrams[id]?.edges);
  const active = useTabs((s) => s.activeId === id);
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const placed = useRef(false);

  // A tab that loads while hidden has no size to fit into, so this waits until it's showing.
  useEffect(() => {
    if (!active || !measured || placed.current) return;
    placed.current = true;
    const saved = useDiagrams.getState().diagrams[id]?.viewport;
    if (saved) void flow.setViewport(saved);
    else void flow.fitView({ minZoom: MIN_ZOOM, maxZoom: 1, padding: 0.03 });
  }, [active, flow, id, measured]);

  const onNodesChange = useCallback(
    (changes: NodeChange<TableNode>[]) => {
      const { diagrams, setNodes } = useDiagrams.getState();
      const moved = new Set(changes.flatMap((c) => (c.type === "position" && c.dragging ? [c.id] : [])));
      const settled = changes.some((c) => c.type === "position" && c.dragging === false);
      setNodes(id, applyNodeChanges(changes, diagrams[id].nodes), moved, settled);
    },
    [id],
  );
  const onSelectionChange = useCallback(
    ({ nodes }: OnSelectionChangeParams) => useDiagrams.getState().select(id, new Set(nodes.map((n) => n.id))),
    [id],
  );
  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => useDiagrams.getState().setViewport(id, viewport), [id]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onSelectionChange={onSelectionChange}
      onMoveEnd={onMoveEnd}
      minZoom={MIN_ZOOM}
      maxZoom={2}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
    >
      <Background gap={20} />
    </ReactFlow>
  );
}

const summary = ({ added, removed, modified, foreignKeys }: DriftReport) =>
  [added.length && `${added.length} added`, removed.length && `${removed.length} removed`, modified.length + foreignKeys.length && `${modified.length + foreignKeys.length} modified`].filter(Boolean).join(", ");

function Banner({ id }: { id: string }) {
  const report = useDiagrams((s) => s.diagrams[id]?.report);
  const outOfDate = useDiagrams((s) => s.diagrams[id]?.outOfDate);
  const offerLayout = useDiagrams((s) => s.diagrams[id]?.offerLayout);
  const { load, autoLayout } = useDiagrams.getState();
  if (!outOfDate && !offerLayout && !(report && reportCount(report))) return null;

  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-200 px-3 py-1.5 text-sm">
      {outOfDate ? <span>This database changed since the diagram loaded.</span> : report ? <span>{summary(report)} since this diagram was saved.</span> : <span>Some tables changed size or arrived.</span>}
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

export default function DiagramTab({ id }: { id: string }) {
  const status = useDiagrams((s) => s.diagrams[id]?.status);
  const error = useDiagrams((s) => s.diagrams[id]?.error);
  const active = useTabs((s) => s.activeId === id);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      // An open dialog owns the keyboard.
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      const saved = useSavedDiagrams.getState();
      if (e.shiftKey) saved.setPrompt({ kind: "save-as", tabId: id });
      else void saved.save(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, id]);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-base-300 px-1 py-0.5">
        <ToolButton icon={Save} label="Save" title="Save (⌘S)" iconOnly onClick={() => void useSavedDiagrams.getState().save(id)} />
        <ToolButton icon={SaveAll} label="Save As" title="Save As (⌘⇧S)" iconOnly onClick={() => useSavedDiagrams.getState().setPrompt({ kind: "save-as", tabId: id })} />
        <ToolButton icon={RefreshCw} label="Refresh" title="Reload from the database" iconOnly onClick={() => void useDiagrams.getState().load(id)} />
      </div>
      <Banner id={id} />
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <Canvas id={id} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
