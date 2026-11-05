import { Copy, FolderOpen, Pencil, Trash2 } from "lucide-react";
import type { SavedQueryInfo } from "../../lib/types";
import { useSavedQueries } from "../../stores/savedQueries";
import type { MenuItem } from "../tree/ContextMenu";

/** Open, Rename, Duplicate and Delete, for the tree, the list's rows and its toolbar. */
export function queryActions(connectionId: string, query: SavedQueryInfo) {
  const { open, duplicate, setPrompt } = useSavedQueries.getState();
  return {
    open: () => void open(connectionId, query.id),
    rename: () => setPrompt({ kind: "rename", connectionId, query }),
    duplicate: () => void duplicate(connectionId, query.id),
    delete: () => setPrompt({ kind: "delete", connectionId, query }),
  };
}

export function queryMenu(connectionId: string, query: SavedQueryInfo): MenuItem[] {
  const actions = queryActions(connectionId, query);
  return [
    { label: "Open Query", icon: FolderOpen, onClick: actions.open },
    { label: "Rename", icon: Pencil, onClick: actions.rename },
    { label: "Duplicate", icon: Copy, onClick: actions.duplicate },
    { label: "Delete Query", icon: Trash2, onClick: actions.delete, danger: true },
  ];
}
