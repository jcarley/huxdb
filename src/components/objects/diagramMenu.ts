import { Copy, FolderOpen, Pencil, Trash2 } from "lucide-react";
import type { DiagramInfo } from "../../lib/types";
import { useSavedDiagrams } from "../../stores/savedDiagrams";
import type { MenuItem } from "../tree/ContextMenu";

/** Open, Rename, Duplicate and Delete, for the tree, the list's rows and its toolbar. */
export function diagramActions(connectionId: string, diagram: DiagramInfo) {
  const { open, duplicate, setPrompt } = useSavedDiagrams.getState();
  return {
    open: () => void open(connectionId, diagram.id),
    rename: () => setPrompt({ kind: "rename", connectionId, diagram }),
    duplicate: () => void duplicate(connectionId, diagram.id),
    delete: () => setPrompt({ kind: "delete", connectionId, diagram }),
  };
}

export function diagramMenu(connectionId: string, diagram: DiagramInfo): MenuItem[] {
  const actions = diagramActions(connectionId, diagram);
  return [
    { label: "Open Diagram", icon: FolderOpen, onClick: actions.open },
    { label: "Rename", icon: Pencil, onClick: actions.rename },
    { label: "Duplicate", icon: Copy, onClick: actions.duplicate },
    { label: "Delete Diagram", icon: Trash2, onClick: actions.delete, danger: true },
  ];
}
