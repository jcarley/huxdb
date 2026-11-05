import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import { applyNodeChanges, Background, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from "@xyflow/react";
import type { NodeChange, OnSelectionChangeParams } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import type { TableNode } from "../../lib/diagramFlow";
import { useDiagrams } from "../../stores/diagram";
import { useTabs } from "../../stores/tabs";
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
  const fitted = useRef(false);

  // A tab that loads while hidden has no size to fit into, so this waits until it's showing.
  useEffect(() => {
    if (!active || !measured || fitted.current) return;
    fitted.current = true;
    void flow.fitView({ minZoom: MIN_ZOOM, maxZoom: 1, padding: 0.03 });
  }, [active, flow, measured]);

  const onNodesChange = useCallback(
    (changes: NodeChange<TableNode>[]) => {
      const { diagrams, setNodes } = useDiagrams.getState();
      const moved = new Set(changes.flatMap((c) => (c.type === "position" && c.dragging ? [c.id] : [])));
      setNodes(id, applyNodeChanges(changes, diagrams[id].nodes), moved);
    },
    [id],
  );
  const onSelectionChange = useCallback(
    ({ nodes }: OnSelectionChangeParams) => useDiagrams.getState().select(id, new Set(nodes.map((n) => n.id))),
    [id],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onSelectionChange={onSelectionChange}
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
    <div className="min-h-0 min-w-0 flex-1">
      <ReactFlowProvider>
        <Canvas id={id} />
      </ReactFlowProvider>
    </div>
  );
}
