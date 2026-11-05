import { useCallback } from "react";
import { Copy, FileCode, FileInput, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { formatSize } from "../../lib/queryFiles";
import type { SavedQueryInfo } from "../../lib/types";
import { useExplorer } from "../../stores/explorer";
import { useQueriesVersion, useSavedQueries } from "../../stores/savedQueries";
import { useTabs } from "../../stores/tabs";
import { ObjectListView } from "./ObjectListView";
import type { ObjectColumn } from "./ObjectListView";
import type { ObjectAction } from "./ObjectToolbar";
import { queryActions, queryMenu } from "./queryMenu";

const COLUMNS: ObjectColumn<SavedQueryInfo>[] = [
  { header: "Database", cell: (q) => q.database },
  { header: "Schema", cell: (q) => q.schema },
  { header: "Modified", className: "tabular-nums", cell: (q) => (q.modifiedMs === null ? "" : new Date(q.modifiedMs).toLocaleString()) },
  { header: "Size", align: "right", className: "tabular-nums", cell: (q) => formatSize(q.size) },
];

interface QueriesViewProps {
  connectionId: string;
  /** Query selected in the tree; the list highlights it. */
  selectedId?: string;
}

/** A connection's saved queries. */
export function QueriesView({ connectionId, selectedId }: QueriesViewProps) {
  const selected = useSavedQueries((s) => s.lists[connectionId]?.find((q) => q.id === selectedId));
  const version = useQueriesVersion(connectionId);
  const load = useCallback(() => useSavedQueries.getState().load(connectionId), [connectionId]);
  const blankQuery = () => ({ connectionId, database: useTabs.getState().defaultDatabase(connectionId), schema: "" });
  const act = selected && queryActions(connectionId, selected);

  const actions: ObjectAction[] = [
    { icon: FolderOpen, label: "Open Query", needsSelection: true, onClick: act?.open },
    { icon: Plus, label: "New Query", onClick: () => useTabs.getState().openQuery(blankQuery()) },
    { icon: Pencil, label: "Rename", needsSelection: true, onClick: act?.rename },
    { icon: Copy, label: "Duplicate", needsSelection: true, onClick: act?.duplicate },
    { icon: Trash2, label: "Delete Query", needsSelection: true, onClick: act?.delete },
    { icon: FileInput, label: "Open External File", onClick: () => void useSavedQueries.getState().openExternal(blankQuery()) },
  ];

  return (
    <ObjectListView
      icon={FileCode}
      selectedName={selected?.name}
      load={load}
      reloadKey={version}
      onSelect={(query) => useExplorer.getState().select({ kind: "query", connectionId, id: query.id })}
      columns={COLUMNS}
      actions={actions}
      rowMenu={(query) => queryMenu(connectionId, query)}
      onOpen={(query) => void useSavedQueries.getState().open(connectionId, query.id)}
      emptyText="No saved queries"
    />
  );
}
