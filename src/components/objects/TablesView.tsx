import { Import, PencilRuler, Plus, Table, Trash2, Upload } from "lucide-react";
import * as api from "../../lib/api";
import type { TableInfo } from "../../lib/types";
import { useTabs } from "../../stores/tabs";
import { ObjectListView } from "./ObjectListView";
import type { ObjectColumn } from "./ObjectListView";
import type { ObjectAction } from "./ObjectToolbar";

const COLUMNS: ObjectColumn<TableInfo>[] = [
  { header: "Rows", align: "right", className: "tabular-nums", cell: (t) => t.rows?.toLocaleString() ?? "" },
  { header: "OID", align: "right", className: "tabular-nums", cell: (t) => t.oid },
  { header: "Owner", cell: (t) => t.owner },
  { header: "System Table", cell: (t) => (t.systemTable ? "Yes" : "No") },
  { header: "Comment", className: "max-w-xs truncate", cell: (t) => t.comment, title: (t) => t.comment ?? undefined },
];

/** Toolbar actions; Open opens the data editor, Design and New the table designer, the rest are placeholders. */
const actions = ({ connectionId, database, schema, selectedName }: TablesViewProps): ObjectAction[] => {
  const ref = { connectionId, database, schema };
  const { openDataEditor, openTableDesigner } = useTabs.getState();
  return [
  { icon: Table, label: "Open Table", needsSelection: true, onClick: () => selectedName && openDataEditor(ref, selectedName) },
  { icon: PencilRuler, label: "Design Table", needsSelection: true, onClick: () => selectedName && openTableDesigner(ref, selectedName) },
  { icon: Plus, label: "New Table", onClick: () => openTableDesigner(ref, null) },
  { icon: Trash2, label: "Delete Table", needsSelection: true },
  { icon: Import, label: "Import Wizard", needsSelection: true },
  { icon: Upload, label: "Export Wizard", needsSelection: true },
  ];
};

interface TablesViewProps {
  connectionId: string;
  database: string;
  schema: string;
  /** Table selected in the tree; the list highlights it. */
  selectedName?: string;
}

/** A schema's tables list. */
export function TablesView(props: TablesViewProps) {
  return (
    <ObjectListView
      {...props}
      group="tables"
      icon={Table}
      load={api.listTables}
      columns={COLUMNS}
      actions={actions(props)}
      onOpen={(name) => useTabs.getState().openDataEditor(props, name)}
      emptyText="No tables"
    />
  );
}
