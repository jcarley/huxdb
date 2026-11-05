// Turns a diagram's structure and layout into React Flow's nodes and edges. Pure: only types
// come from React Flow, so stores can use this without pulling the library into the main bundle.

import type { Edge, Node } from "@xyflow/react";
import { columnOffset } from "./diagramLayout";
import type { Box, Layout, Point } from "./diagramLayout";
import type { DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

export interface TableHandle {
  id: string;
  side: "left" | "right";
  top: number;
}

export interface TableData extends Record<string, unknown> {
  table: DiagramTable;
  /** Only columns in a relationship get one: on every row, WebKit falls from 60 to about 24 fps. */
  handles: TableHandle[];
  foreignKeyColumns: Set<string>;
  /** Several schemas are on the diagram, so a bare name could mean two tables. */
  showSchema: boolean;
}

export interface FkData extends Record<string, unknown> {
  /** ELK's bend points. Absent once either table has moved, or for a line that never had any. */
  points?: Point[];
  hub: boolean;
  rolledUp: boolean;
}

export type TableNode = Node<TableData, "table">;
export type FkEdge = Edge<FkData, "fk">;

const childHandle = (fk: DiagramForeignKey) => `right:${fk.childColumns[0]}`;
const parentHandle = (fk: DiagramForeignKey) => `left:${fk.parentColumns[0]}`;

export function toNodes({ tables, foreignKeys }: DiagramStructure, layout: Layout, boxes: Map<number, Box>): TableNode[] {
  const showSchema = new Set(tables.map((t) => t.schema)).size > 1;
  return tables.map((table) => {
    const handles = new Map<string, TableHandle>();
    const foreignKeyColumns = new Set<string>();
    for (const fk of foreignKeys) {
      if (fk.childOid === table.oid) {
        for (const column of fk.childColumns) foreignKeyColumns.add(column);
        handles.set(childHandle(fk), { id: childHandle(fk), side: "right", top: columnOffset(table, fk.childColumns[0]) });
      }
      if (fk.parentOid === table.oid) {
        handles.set(parentHandle(fk), { id: parentHandle(fk), side: "left", top: columnOffset(table, fk.parentColumns[0]) });
      }
    }
    return {
      id: String(table.oid),
      type: "table",
      position: layout.positions.get(table.oid) ?? { x: 0, y: 0 },
      ...boxes.get(table.oid)!,
      data: { table, handles: [...handles.values()], foreignKeyColumns, showSchema },
    };
  });
}

export function toEdges({ foreignKeys }: DiagramStructure, layout: Layout): FkEdge[] {
  return foreignKeys.map((fk) => {
    const hub = layout.hubEdges.has(fk.oid);
    return {
      id: String(fk.oid),
      type: "fk",
      source: String(fk.childOid),
      target: String(fk.parentOid),
      sourceHandle: childHandle(fk),
      targetHandle: parentHandle(fk),
      hidden: hub,
      data: { points: layout.routes.get(fk.oid), hub, rolledUp: fk.rolledUp },
    };
  });
}

/** Hub lines show only for a selected table: they're most of a schema's lines, and drawn together they're a haze. */
export function revealHubLines(edges: FkEdge[], selected: Set<string>) {
  let changed = false;
  const next = edges.map((edge) => {
    if (!edge.data?.hub) return edge;
    const hidden = !selected.has(edge.source) && !selected.has(edge.target);
    if (hidden === edge.hidden) return edge;
    changed = true;
    return { ...edge, hidden };
  });
  return changed ? next : edges;
}

/** ELK has no routing-only pass, so a moved table's lines fall back to a plain path rather than keep a stale route. */
export function dropRoutes(edges: FkEdge[], moved: Set<string>) {
  let changed = false;
  const next = edges.map((edge) => {
    if (!edge.data?.points || (!moved.has(edge.source) && !moved.has(edge.target))) return edge;
    changed = true;
    return { ...edge, data: { ...edge.data, points: undefined } };
  });
  return changed ? next : edges;
}
