import { Handle, Position, useStore } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { KeyRound, Link2 } from "lucide-react";
import { memo } from "react";
import { DIAGRAM_FONT } from "../../lib/diagramBrowser";
import type { TableNode } from "../../lib/diagramFlow";
import { HEADER, isCapped, MAX_ROWS, ROW } from "../../lib/diagramLayout";

/** Below this zoom a row can't be read, and drawing them halves the frame rate at 300 tables. */
const ROWS_FROM_ZOOM = 0.35;

const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0 };

export const TableBox = memo(function TableBox({ data, width, height }: NodeProps<TableNode>) {
  const { table, handles, foreignKeyColumns, showSchema } = data;
  const showRows = useStore((s) => s.transform[2] >= ROWS_FROM_ZOOM);
  const capped = isCapped(table);
  const title = showSchema ? `${table.schema}.${table.name}` : table.name;

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-primary/60 bg-base-100 text-[11px] leading-none text-base-content shadow-sm in-[.selected]:border-primary in-[.selected]:ring-2 in-[.selected]:ring-primary/40"
      style={{ width, height, fontFamily: `${DIAGRAM_FONT}, system-ui, sans-serif` }}
    >
      <div className="flex shrink-0 items-center justify-center gap-1.5 bg-primary px-2 font-semibold text-primary-content" style={{ height: HEADER }}>
        <span className="truncate" title={title}>
          {title}
        </span>
        {capped && <span className="shrink-0 font-normal opacity-75">{table.columns.length} columns</span>}
      </div>
      {showRows && (
        // A capped table scrolls here, so the wheel has to reach it instead of zooming the canvas.
        <div className={capped ? "nodrag nowheel overflow-y-auto" : ""} style={capped ? { height: MAX_ROWS * ROW } : undefined}>
          {table.columns.map((column) => (
            <div key={column.name} className="flex items-center gap-1 px-2 whitespace-nowrap" style={{ height: ROW }} title={`${column.name}: ${column.dataType}`}>
              {column.primaryKey ? (
                <KeyRound className="size-3 shrink-0 text-warning" />
              ) : foreignKeyColumns.has(column.name) ? (
                <Link2 className="size-3 shrink-0 text-base-content/40" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className="truncate">
                {column.name}
                <span className="text-base-content/50">: {column.dataType}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {/* Placed from the node, not a row, so hiding rows can't move a line's end. */}
      {handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.side === "right" ? "source" : "target"}
          position={handle.side === "right" ? Position.Right : Position.Left}
          isConnectable={false}
          style={{ ...HANDLE_STYLE, top: handle.top }}
        />
      ))}
    </div>
  );
});
