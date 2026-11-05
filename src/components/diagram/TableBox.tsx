import { Handle, Position, useStore } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { KeyRound, Link2 } from "lucide-react";
import { memo } from "react";
import { DIAGRAM_FONT } from "../../lib/diagramBrowser";
import type { TableNode } from "../../lib/diagramFlow";
import { headerHeight, isCapped, MAX_ROWS, rowHeight, rowSuffix } from "../../lib/diagramLayout";
import { useDiagrams } from "../../stores/diagram";
import { useDiagramId } from "./DiagramId";

/** Below this zoom a row can't be read, and drawing them halves the frame rate at 300 tables. */
const ROWS_FROM_ZOOM = 0.35;

const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0 };

/** One string per table, so hovering or selecting a line re-renders only the two tables it joins. */
function useHighlighted(oid: number) {
  const id = useDiagramId();
  return useDiagrams((s) => {
    const diagram = s.diagrams[id];
    if (!diagram) return "";
    let columns = "\u0000";
    for (const fk of [diagram.hover, diagram.selection.foreignKey]) {
      if (fk?.childOid === oid) columns += `${fk.childColumns.join("\u0000")}\u0000`;
      if (fk?.parentOid === oid) columns += `${fk.parentColumns.join("\u0000")}\u0000`;
    }
    return columns;
  });
}

export const TableBox = memo(function TableBox({ data, width, height }: NodeProps<TableNode>) {
  const { table, handles, foreignKeyColumns, options } = data;
  const showRows = useStore((s) => s.transform[2] >= ROWS_FROM_ZOOM);
  const highlighted = useHighlighted(table.oid);
  const capped = isCapped(table);
  const title = options.showSchemaNames ? `${table.schema}.${table.name}` : table.name;
  const row = rowHeight(options);
  const header = headerHeight(options);
  const icon = { width: options.fontSize, height: options.fontSize };

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-primary/60 bg-base-100 leading-none text-base-content shadow-sm in-[.selected]:border-primary in-[.selected]:ring-2 in-[.selected]:ring-primary/40"
      style={{ width, height, fontSize: options.fontSize, fontFamily: `${DIAGRAM_FONT}, system-ui, sans-serif` }}
    >
      <div className="flex shrink-0 items-center justify-center gap-1.5 bg-primary px-2 font-semibold text-primary-content" style={{ height: header }}>
        <span className="truncate" title={title}>
          {title}
        </span>
        {capped && <span className="shrink-0 font-normal opacity-75">{table.columns.length} columns</span>}
      </div>
      {options.showObjectComments && table.comment && (
        <div className="flex shrink-0 items-center truncate border-b border-base-300 px-2 text-base-content/70 italic" style={{ height: row }} title={table.comment}>
          <span className="truncate">{table.comment}</span>
        </div>
      )}
      {showRows && (
        // A capped table scrolls here, so the wheel has to reach it instead of the canvas.
        <div className={capped ? "nodrag nowheel overflow-y-auto" : ""} style={capped ? { height: MAX_ROWS * row } : undefined}>
          {table.columns.map((column) => {
            const suffix = rowSuffix(column, options);
            return (
              <div
                key={column.name}
                className={`flex items-center gap-1 px-2 whitespace-nowrap ${highlighted.includes(`\u0000${column.name}\u0000`) ? "bg-primary/20" : ""}`}
                style={{ height: row }}
                title={`${column.name}: ${column.dataType}${suffix}`}
              >
                {column.primaryKey ? <KeyRound className="shrink-0 text-warning" style={icon} /> : foreignKeyColumns.has(column.name) ? <Link2 className="shrink-0 text-base-content/40" style={icon} /> : <span className="shrink-0" style={{ width: options.fontSize }} />}
                <span className="truncate">
                  {column.name}
                  <span className="text-base-content/50">
                    : {column.dataType}
                    {suffix}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {/* Placed from the node, not a row, so hiding rows can't move a line's end. */}
      {handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.side === "right" ? "source" : "target"}
          position={handle.side === "left" ? Position.Left : Position.Right}
          isConnectable={false}
          style={{ ...HANDLE_STYLE, top: handle.top }}
        />
      ))}
    </div>
  );
});
