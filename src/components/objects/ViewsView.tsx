import { Eye, PencilRuler, Plus, Trash2, Upload } from "lucide-react";
import * as api from "../../lib/api";
import type { ViewInfo } from "../../lib/types";
import { useTabs } from "../../stores/tabs";
import { ObjectListView, useSchemaList } from "./ObjectListView";
import type { ObjectColumn } from "./ObjectListView";
import type { ObjectAction } from "./ObjectToolbar";

const COLUMNS: ObjectColumn<ViewInfo>[] = [
  { header: "OID", align: "right", className: "tabular-nums", cell: (v) => v.oid },
  { header: "Owner", cell: (v) => v.owner },
  { header: "System View", cell: (v) => (v.systemView ? "Yes" : "No") },
  { header: "Comment", className: "max-w-xs truncate", cell: (v) => v.comment, title: (v) => v.comment ?? undefined },
];

/** Toolbar actions; Design and New open the view designer, the rest are placeholders. Navicat has no Import Wizard for views. */
const actions = ({ connectionId, database, schema, selectedName }: ViewsViewProps): ObjectAction[] => {
  const ref = { connectionId, database, schema };
  const { openViewDesigner } = useTabs.getState();
  return [
    { icon: Eye, label: "Open View", needsSelection: true },
    { icon: PencilRuler, label: "Design View", needsSelection: true, onClick: () => selectedName && openViewDesigner(ref, selectedName) },
    { icon: Plus, label: "New View", onClick: () => openViewDesigner(ref, null) },
    { icon: Trash2, label: "Delete View", needsSelection: true },
    { icon: Upload, label: "Export Wizard", needsSelection: true },
  ];
};

interface ViewsViewProps {
  connectionId: string;
  database: string;
  schema: string;
  /** View selected in the tree; the list highlights it. */
  selectedName?: string;
}

/** A schema's views list. */
export function ViewsView(props: ViewsViewProps) {
  return (
    <ObjectListView
      {...useSchemaList(props, "views", api.listViews)}
      selectedName={props.selectedName}
      icon={Eye}
      columns={COLUMNS}
      actions={actions(props)}
      emptyText="No views"
    />
  );
}
