import { useEffect } from "react";
import { Network, Plus } from "lucide-react";
import type { DiagramInfo } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { diagramMenu } from "../objects/diagramMenu";
import { useContextMenu } from "./ContextMenu";
import { TreeNode } from "./TreeNode";
import { useTreeNode } from "./useTreeNode";

/** A connection's saved diagrams. The list is local files, though opening one needs the database. */
export function DiagramsNode({ connectionId }: { connectionId: string }) {
  const node = useTreeNode({ kind: "diagrams", connectionId });
  const list = useSavedDiagrams((s) => s.lists[connectionId]);
  const openMenu = useContextMenu((s) => s.open);

  useEffect(() => {
    useSavedDiagrams.getState().load(connectionId).catch(() => {});
  }, [connectionId]);

  return (
    <TreeNode
      depth={1}
      icon={<Network className="size-4 shrink-0 text-primary" strokeWidth={1.75} />}
      label="Diagrams"
      suffix={list && `(${list.length})`}
      selected={node.selected}
      expanded={node.expanded}
      onToggle={node.toggle}
      onClick={() => {
        node.select();
        node.expand();
      }}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, [
          {
            label: "New Diagram",
            icon: Plus,
            onClick: () => useDiagrams.getState().openPicker({ connectionId, database: useTabs.getState().defaultDatabase(connectionId), schema: "" }),
          },
        ]);
      }}
    >
      {list?.map((diagram) => (
        <DiagramNode key={diagram.id} connectionId={connectionId} diagram={diagram} />
      ))}
    </TreeNode>
  );
}

function DiagramNode({ connectionId, diagram }: { connectionId: string; diagram: DiagramInfo }) {
  const node = useTreeNode({ kind: "diagram", connectionId, id: diagram.id });
  const openMenu = useContextMenu((s) => s.open);

  return (
    <TreeNode
      depth={2}
      icon={<Network className="size-4 shrink-0 text-base-content/60" strokeWidth={1.5} />}
      label={diagram.name}
      selected={node.selected}
      onClick={node.select}
      onDoubleClick={() => void useSavedDiagrams.getState().open(connectionId, diagram.id)}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, diagramMenu(connectionId, diagram));
      }}
    />
  );
}
