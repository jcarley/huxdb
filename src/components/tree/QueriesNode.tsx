import { useEffect } from "react";
import { FileCode, FileInput, Plus } from "lucide-react";
import type { SavedQueryInfo } from "../../lib/types";
import { useSavedQueries } from "../../stores/savedQueries";
import { useTabs } from "../../stores/tabs";
import { queryMenu } from "../objects/queryMenu";
import { useContextMenu } from "./ContextMenu";
import { TreeNode } from "./TreeNode";
import { useTreeNode } from "./useTreeNode";

/** A connection's saved queries. They're local files, so this works with the server down. */
export function QueriesNode({ connectionId }: { connectionId: string }) {
  const node = useTreeNode({ kind: "queries", connectionId });
  const list = useSavedQueries((s) => s.lists[connectionId]);
  const openMenu = useContextMenu((s) => s.open);

  useEffect(() => {
    useSavedQueries.getState().load(connectionId).catch(() => {});
  }, [connectionId]);

  const blankQuery = () => ({ connectionId, database: useTabs.getState().defaultDatabase(connectionId), schema: "" });

  return (
    <TreeNode
      depth={1}
      icon={<FileCode className="size-4 shrink-0 text-primary" strokeWidth={1.75} />}
      label="Queries"
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
          { label: "New Query", icon: Plus, onClick: () => useTabs.getState().openQuery(blankQuery()) },
          { label: "Open External File", icon: FileInput, onClick: () => void useSavedQueries.getState().openExternal(blankQuery()) },
        ]);
      }}
    >
      {list?.map((query) => (
        <QueryNode key={query.id} connectionId={connectionId} query={query} />
      ))}
    </TreeNode>
  );
}

function QueryNode({ connectionId, query }: { connectionId: string; query: SavedQueryInfo }) {
  const node = useTreeNode({ kind: "query", connectionId, id: query.id });
  const openMenu = useContextMenu((s) => s.open);

  return (
    <TreeNode
      depth={2}
      icon={<FileCode className="size-4 shrink-0 text-base-content/60" strokeWidth={1.5} />}
      label={query.name}
      selected={node.selected}
      onClick={node.select}
      onDoubleClick={() => void useSavedQueries.getState().open(connectionId, query.id)}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, queryMenu(connectionId, query));
      }}
    />
  );
}
