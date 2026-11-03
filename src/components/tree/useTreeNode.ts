import { nodeKey, useExplorer } from "../../stores/explorer";
import type { TreeNodeRef } from "../../stores/explorer";

/** Per-node view of the explorer store, plus bound actions. */
export function useTreeNode(node: TreeNodeRef) {
  const key = nodeKey(node);
  const expanded = useExplorer((s) => s.expanded[key] === true);
  const load = useExplorer((s) => s.loads[key]);
  const selected = useExplorer((s) => s.selectedKey === key);
  const { expand, toggle, refresh, select } = useExplorer.getState();

  return {
    key,
    expanded,
    load,
    selected,
    expand: () => expand(node),
    toggle: () => toggle(node),
    refresh: () => refresh(node),
    select: () => select(node),
  };
}
