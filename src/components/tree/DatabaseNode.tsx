import { Database, RefreshCw } from "lucide-react";
import { useExplorer } from "../../stores/explorer";
import { useContextMenu } from "./ContextMenu";
import { SchemaNode } from "./SchemaNode";
import { TreeNode } from "./TreeNode";
import { useTreeNode } from "./useTreeNode";

export function DatabaseNode({ connectionId, database }: { connectionId: string; database: string }) {
  const node = useTreeNode({ kind: "database", connectionId, database });
  const schemas = useExplorer((s) => s.schemas[node.key]);
  const openMenu = useContextMenu((s) => s.open);

  return (
    <TreeNode
      depth={1}
      icon={<Database className="size-4 shrink-0 text-base-content/70" strokeWidth={1.75} />}
      label={database}
      selected={node.selected}
      expanded={node.expanded}
      load={node.load}
      onToggle={node.toggle}
      onClick={() => {
        node.select();
        node.expand();
      }}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, [{ label: "Refresh", icon: RefreshCw, onClick: node.refresh }]);
      }}
      onRetry={node.refresh}
    >
      {schemas?.map((schema) => (
        <SchemaNode key={schema} connectionId={connectionId} database={database} schema={schema} />
      ))}
    </TreeNode>
  );
}
