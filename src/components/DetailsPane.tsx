import { isGroupSelection, nodeKey, useExplorer } from "../stores/explorer";
import { ConnectionDetails } from "./ConnectionDetails";
import { TablesView } from "./objects/TablesView";
import { ViewsView } from "./objects/ViewsView";

/** Main pane: shows whatever fits the tree selection, falling back to connection details. */
export function DetailsPane() {
  const selected = useExplorer((s) => s.selected);

  const isTables = isGroupSelection(selected, "tables");
  if (isTables || isGroupSelection(selected, "views")) {
    const { connectionId, database, schema } = selected;
    const props = {
      // Keyed by schema so switching schemas starts with fresh state.
      key: nodeKey({ kind: "schema", connectionId, database, schema }),
      connectionId,
      database,
      schema,
      selectedName: selected.kind === "object" ? selected.name : undefined,
    };
    return isTables ? <TablesView {...props} /> : <ViewsView {...props} />;
  }

  return <ConnectionDetails />;
}
