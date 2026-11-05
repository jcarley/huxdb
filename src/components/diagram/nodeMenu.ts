import { CopyPlus, PencilRuler, Table, Unlink } from "lucide-react";
import * as api from "../../lib/api";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import type { MenuItem } from "../tree/ContextMenu";

export function designTable(tabId: string, node: string) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  const table = diagram?.structure?.tables.find((t) => String(t.oid) === node);
  if (table) useTabs.getState().openTableDesigner({ connectionId: diagram.connectionId, database: diagram.database, schema: table.schema }, table.name);
}

/** The picker with this diagram's tables ticked, plus `extra`. */
export function openTablePicker(tabId: string, extra: number[] = []) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  if (!diagram?.structure) return;
  const { connectionId, database } = diagram;
  useDiagrams.getState().openPicker({ connectionId, database, schema: "", tabId, ticked: [...diagram.structure.tables.map((t) => t.oid), ...extra] });
}

/** Offers related tables in the picker rather than adding them, because a hub can have hundreds. */
async function addRelated(tabId: string, nodes: string[]) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  if (!diagram) return;
  try {
    openTablePicker(tabId, await api.diagramRelated(diagram.connectionId, diagram.database, nodes.map(Number)));
  } catch (err) {
    useSavedDiagrams.setState({ error: api.errorMessage(err) });
  }
}

/** Acts on the whole selection when the menu opens on a selected table. */
export function nodeMenu(tabId: string, node: string): MenuItem[] {
  const diagram = useDiagrams.getState().diagrams[tabId];
  const table = diagram?.structure?.tables.find((t) => String(t.oid) === node);
  if (!diagram || !table) return [];
  const { selection, report, connectionId, database } = diagram;
  const nodes = selection.nodes.includes(node) ? selection.nodes : [node];
  return [
    { label: "Open Table", icon: Table, onClick: () => useTabs.getState().openDataEditor({ connectionId, database, schema: table.schema }, table.name) },
    { label: "Design Table", icon: PencilRuler, onClick: () => designTable(tabId, node) },
    // A pending report describes the diagram as it is, so its tables can't change under it.
    ...(report ? [] : [{ label: "Add Related Tables…", icon: CopyPlus, onClick: () => void addRelated(tabId, nodes) }]),
    { label: `Remove from Diagram (${nodes.length === 1 ? "the table stays in the database" : `${nodes.length} tables stay in the database`})`, icon: Unlink, onClick: () => useDiagrams.getState().removeTables(tabId, nodes) },
  ];
}
