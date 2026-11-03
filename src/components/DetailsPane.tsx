import { isTablesSelection, nodeKey, useExplorer } from "../stores/explorer";
import { ConnectionDetails } from "./ConnectionDetails";
import { TablesView } from "./tables/TablesView";

/** Main pane: shows whatever fits the tree selection, falling back to connection details. */
export function DetailsPane() {
  const selected = useExplorer((s) => s.selected);

  if (isTablesSelection(selected)) {
    const { connectionId, database, schema } = selected;
    return (
      // Keyed by schema so switching schemas starts with fresh state.
      <TablesView
        key={nodeKey({ kind: "schema", connectionId, database, schema })}
        connectionId={connectionId}
        database={database}
        schema={schema}
        selectedName={selected.kind === "object" ? selected.name : undefined}
      />
    );
  }

  return <ConnectionDetails />;
}
