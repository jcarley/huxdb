import { useCallback } from "react";
import { Copy, FolderOpen, Network, Pencil, Plus, Trash2 } from "lucide-react";
import type { DiagramInfo } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import { useExplorer } from "../../stores/explorer";
import { useDiagramsVersion, useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import { diagramActions, diagramMenu } from "./diagramMenu";
import { ObjectListView } from "./ObjectListView";
import type { ObjectColumn } from "./ObjectListView";
import type { ObjectAction } from "./ObjectToolbar";

const COLUMNS: ObjectColumn<DiagramInfo>[] = [
  { header: "Database", cell: (d) => d.database },
  { header: "Objects", align: "right", className: "tabular-nums", cell: (d) => d.objects },
  { header: "Modified", className: "tabular-nums", cell: (d) => (d.modifiedMs === null ? "" : new Date(d.modifiedMs).toLocaleString()) },
];

interface DiagramsViewProps {
  connectionId: string;
  /** Diagram selected in the tree; the list highlights it. */
  selectedId?: string;
}

/** A connection's saved diagrams. */
export function DiagramsView({ connectionId, selectedId }: DiagramsViewProps) {
  const selected = useSavedDiagrams((s) => s.lists[connectionId]?.find((d) => d.id === selectedId));
  const version = useDiagramsVersion(connectionId);
  const load = useCallback(() => useSavedDiagrams.getState().load(connectionId), [connectionId]);
  const act = selected && diagramActions(connectionId, selected);

  const actions: ObjectAction[] = [
    { icon: FolderOpen, label: "Open Diagram", needsSelection: true, onClick: act?.open },
    { icon: Plus, label: "New Diagram", onClick: () => useDiagrams.getState().openPicker({ connectionId, database: useTabs.getState().defaultDatabase(connectionId), schema: "" }) },
    { icon: Pencil, label: "Rename", needsSelection: true, onClick: act?.rename },
    { icon: Copy, label: "Duplicate", needsSelection: true, onClick: act?.duplicate },
    { icon: Trash2, label: "Delete Diagram", needsSelection: true, onClick: act?.delete },
  ];

  return (
    <ObjectListView
      icon={Network}
      selectedName={selected?.name}
      load={load}
      reloadKey={version}
      onSelect={(diagram) => useExplorer.getState().select({ kind: "diagram", connectionId, id: diagram.id })}
      columns={COLUMNS}
      actions={actions}
      rowMenu={(diagram) => diagramMenu(connectionId, diagram)}
      onOpen={(diagram) => void useSavedDiagrams.getState().open(connectionId, diagram.id)}
      emptyText="No saved diagrams"
    />
  );
}
