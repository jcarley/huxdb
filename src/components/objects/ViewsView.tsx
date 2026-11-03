import { Eye, PencilRuler, Plus, Trash2, Upload } from "lucide-react";
import * as api from "../../lib/api";
import type { ViewInfo } from "../../lib/types";
import { ObjectListView } from "./ObjectListView";
import type { ObjectColumn } from "./ObjectListView";
import type { ObjectAction } from "./ObjectToolbar";

const COLUMNS: ObjectColumn<ViewInfo>[] = [
  { header: "OID", align: "right", className: "tabular-nums", cell: (v) => v.oid },
  { header: "Owner", cell: (v) => v.owner },
  { header: "System View", cell: (v) => (v.systemView ? "Yes" : "No") },
  { header: "Comment", className: "max-w-xs truncate", cell: (v) => v.comment, title: (v) => v.comment ?? undefined },
];

// Navicat has no Import Wizard for views.
const ACTIONS: ObjectAction[] = [
  { icon: Eye, label: "Open View", needsSelection: true },
  { icon: PencilRuler, label: "Design View", needsSelection: true },
  { icon: Plus, label: "New View" },
  { icon: Trash2, label: "Delete View", needsSelection: true },
  { icon: Upload, label: "Export Wizard", needsSelection: true },
];

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
      {...props}
      group="views"
      icon={Eye}
      load={api.listViews}
      columns={COLUMNS}
      actions={ACTIONS}
      emptyText="No views"
    />
  );
}
