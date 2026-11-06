import { ArrowDownToLine, ArrowUpToLine, Copy, CopyPlus, Eye, PencilLine, PencilRuler, Table, Trash2, Unlink } from "lucide-react";
import * as api from "../../lib/api";
import { isAnnotationId, objectNodes } from "../../lib/diagramAnnotations";
import { objectKind } from "../../lib/diagramDrift";
import { useDiagrams } from "../../stores/diagram";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import { useTabs } from "../../stores/tabs";
import type { MenuItem } from "../tree/ContextMenu";

/** Tables and views have designers; a function or procedure has none yet. */
export function designObject(tabId: string, node: string) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  const object = diagram?.structure?.tables.find((t) => String(t.oid) === node);
  if (!object) return;
  const ref = { connectionId: diagram.connectionId, database: diagram.database, schema: object.schema };
  const kind = objectKind(object);
  if (kind === "table") useTabs.getState().openTableDesigner(ref, object.name);
  else if (kind === "view") useTabs.getState().openViewDesigner(ref, object.name);
}

/** The picker with this diagram's objects ticked, plus `extra`. */
export function openTablePicker(tabId: string, extra: number[] = []) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  if (!diagram?.structure) return;
  const { connectionId, database } = diagram;
  useDiagrams.getState().openPicker({ connectionId, database, schema: "", tabId, ticked: [...diagram.structure.tables.map((t) => t.oid), ...extra] });
}

/** Offers related objects in the picker rather than adding them, because a hub can have hundreds. */
async function addRelated(tabId: string, nodes: string[]) {
  const diagram = useDiagrams.getState().diagrams[tabId];
  if (!diagram) return;
  try {
    openTablePicker(tabId, await api.diagramRelated(diagram.connectionId, diagram.database, nodes.map(Number)));
  } catch (err) {
    useSavedDiagrams.setState({ error: api.errorMessage(err) });
  }
}

/** Notes and labels: Edit Text is for the one the menu opened on, the rest act on every selected annotation when it opens on one of them. */
export function annotationMenu(tabId: string, node: string): MenuItem[] {
  const diagram = useDiagrams.getState().diagrams[tabId];
  if (!diagram?.annotations.some((a) => a.id === node)) return [];
  const ids = diagram.selection.nodes.includes(node) ? diagram.selection.nodes.filter(isAnnotationId) : [node];
  const store = useDiagrams.getState();
  return [
    { label: "Edit Text", icon: PencilLine, onClick: () => store.startEditing(tabId, node) },
    { label: "Bring to Front", icon: ArrowUpToLine, onClick: () => store.bringToFront(tabId, ids) },
    { label: "Send to Back", icon: ArrowDownToLine, onClick: () => store.sendToBack(tabId, ids) },
    { label: "Copy", icon: Copy, onClick: () => store.copyAnnotations(tabId, ids) },
    { label: "Delete", icon: Trash2, onClick: () => store.deleteAnnotations(tabId, ids) },
  ];
}

/** Items follow the object the menu opened on. Add Related and Remove act on the whole selection when it opens on a selected object. */
export function nodeMenu(tabId: string, node: string): MenuItem[] {
  if (isAnnotationId(node)) return annotationMenu(tabId, node);
  const diagram = useDiagrams.getState().diagrams[tabId];
  const table = diagram?.structure?.tables.find((t) => String(t.oid) === node);
  if (!diagram || !table) return [];
  const { selection, report, connectionId, database } = diagram;
  const nodes = selection.nodes.includes(node) ? objectNodes(selection.nodes) : [node];
  const kind = objectKind(table);
  return [
    ...(kind === "table"
      ? [
          { label: "Open Table", icon: Table, onClick: () => useTabs.getState().openDataEditor({ connectionId, database, schema: table.schema }, table.name) },
          { label: "Design Table", icon: PencilRuler, onClick: () => designObject(tabId, node) },
        ]
      : []),
    ...(kind === "view" ? [{ label: "Design View", icon: Eye, onClick: () => designObject(tabId, node) }] : []),
    // A pending report describes the diagram as it is, so its objects can't change under it.
    ...(report ? [] : [{ label: "Add Related Objects…", icon: CopyPlus, onClick: () => void addRelated(tabId, nodes) }]),
    { label: `Remove from Diagram (${nodes.length === 1 ? "the object stays in the database" : `${nodes.length} objects stay in the database`})`, icon: Unlink, onClick: () => useDiagrams.getState().removeTables(tabId, nodes) },
  ];
}
