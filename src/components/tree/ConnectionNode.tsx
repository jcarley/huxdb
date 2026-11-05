import { Pencil, Plug, RefreshCw, Trash2, Unplug } from "lucide-react";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { useExplorer } from "../../stores/explorer";
import { ConnectionIcon } from "../ConnectionIcon";
import { useContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { DatabaseNode } from "./DatabaseNode";
import { QueriesNode } from "./QueriesNode";
import { TreeNode } from "./TreeNode";
import { useTreeNode } from "./useTreeNode";

export function ConnectionNode({ connection }: { connection: ConnectionConfig }) {
  const connectionId = connection.id;
  const node = useTreeNode({ kind: "connection", connectionId });
  const databases = useExplorer((s) => s.databases[node.key]);
  const openMenu = useContextMenu((s) => s.open);
  const { openEditor, requestDelete } = useConnections.getState();
  const isOpen = databases !== undefined;

  const menuItems: MenuItem[] = [
    isOpen
      ? { label: "Close Connection", icon: Unplug, onClick: () => void useExplorer.getState().closeConnection(connectionId) }
      : { label: "Open Connection", icon: Plug, onClick: node.expand },
    ...(isOpen ? [{ label: "Refresh", icon: RefreshCw, onClick: node.refresh }] : []),
    { label: "Edit Connection…", icon: Pencil, onClick: () => openEditor(connection) },
    { label: "Delete Connection", icon: Trash2, onClick: () => requestDelete(connection), danger: true },
  ];

  return (
    <TreeNode
      depth={0}
      icon={
        <span className="relative flex">
          <ConnectionIcon color={connection.color} />
          {isOpen && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-1 ring-base-100" />}
        </span>
      }
      label={connection.name}
      selected={node.selected}
      expanded={node.expanded}
      load={node.load}
      onToggle={node.toggle}
      onClick={node.select}
      onDoubleClick={node.toggle}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, menuItems);
      }}
      onRetry={node.refresh}
    >
      {databases?.map((database) => (
        <DatabaseNode key={database} connectionId={connectionId} database={database} />
      ))}
      <QueriesNode connectionId={connectionId} />
    </TreeNode>
  );
}
