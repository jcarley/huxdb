import type { MouseEvent, ReactNode } from "react";
import { ChevronRight, RotateCw } from "lucide-react";
import type { LoadState } from "../../stores/explorer";

interface TreeNodeProps {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  /** Shown dimmed after the label, e.g. a child count. */
  suffix?: ReactNode;
  selected: boolean;
  /** Leaves omit this; expandable nodes pass whether they're open. */
  expanded?: boolean;
  load?: LoadState;
  onToggle?: () => void;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  /** Retries a failed load. */
  onRetry?: () => void;
  children?: ReactNode;
}

const INDENT_PX = 14;

/** One row of the object tree plus (when expanded) its children. */
export function TreeNode({
  depth,
  icon,
  label,
  suffix,
  selected,
  expanded,
  load,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRetry,
  children,
}: TreeNodeProps) {
  const expandable = expanded !== undefined;
  const indent = { paddingLeft: depth * INDENT_PX + 4 };

  return (
    <li role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-selected={selected}>
      <div
        className={`flex h-7 cursor-default items-center gap-1.5 rounded pr-2 text-sm ${
          selected ? "bg-primary/15" : "hover:bg-base-300/60"
        }`}
        style={indent}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex size-4 shrink-0 items-center justify-center text-base-content/60"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        {icon}
        <span className="truncate">{label}</span>
        {suffix && <span className="shrink-0 text-xs text-base-content/50">{suffix}</span>}
        {load?.status === "loading" && <span className="loading loading-spinner loading-xs ml-auto shrink-0" />}
      </div>

      {expanded && load?.status === "error" && (
        <button
          type="button"
          title={load.error}
          className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs text-error hover:underline select-text"
          style={{ paddingLeft: (depth + 1) * INDENT_PX + 4 }}
          onClick={onRetry}
        >
          <RotateCw className="size-3 shrink-0" />
          <span className="line-clamp-2">{load.error}</span>
        </button>
      )}

      {expanded && children && <ul role="group">{children}</ul>}
    </li>
  );
}
