// Turns a diagram's structure and layout into React Flow's nodes and edges. Pure: only types
// come from React Flow, so stores can use this without pulling the library into the main bundle.

import type { Edge, Node } from "@xyflow/react";
import { childEnd, lineKind, parentEnd } from "./diagramCardinality";
import type { ChildEnd, LineKind, ParentEnd } from "./diagramCardinality";
import { columnOffset, DEFAULT_OPTIONS, rowHeight } from "./diagramLayout";
import type { Box, Layout, Point } from "./diagramLayout";
import type { DiagramForeignKey, DiagramOptions, DiagramStructure, DiagramTable } from "./types";

export interface TableHandle {
  id: string;
  /** `self` is where a self-reference comes back in, on the right, as its loop stays on one side. */
  side: "left" | "right" | "self";
  top: number;
}

export interface TableData extends Record<string, unknown> {
  table: DiagramTable;
  /** Only columns in a relationship get one: on every row, WebKit falls from 60 to about 24 fps. */
  handles: TableHandle[];
  foreignKeyColumns: Set<string>;
  options: DiagramOptions;
}

export interface FkData extends Record<string, unknown> {
  /** ELK's bend points. Absent once either table has moved, or for a line that never had any. */
  points?: Point[];
  hub: boolean;
  name: string;
  parentEnd: ParentEnd;
  childEnd: ChildEnd;
  kind: LineKind;
}

export type TableNode = Node<TableData, "table">;
export type FkEdge = Edge<FkData, "fk">;

const childHandle = (fk: DiagramForeignKey) => `right:${fk.childColumns[0]}`;
const parentHandle = (fk: DiagramForeignKey) => (fk.childOid === fk.parentOid ? `self:${fk.childColumns[0]}:${fk.parentColumns[0]}` : `left:${fk.parentColumns[0]}`);

export function toNodes({ tables, foreignKeys }: DiagramStructure, layout: Layout, boxes: Map<number, Box>, options = DEFAULT_OPTIONS): TableNode[] {
  return tables.map((table) => {
    const handles = new Map<string, TableHandle>();
    const foreignKeyColumns = new Set<string>();
    for (const fk of foreignKeys) {
      if (fk.childOid === table.oid) {
        for (const column of fk.childColumns) foreignKeyColumns.add(column);
        handles.set(childHandle(fk), { id: childHandle(fk), side: "right", top: columnOffset(table, fk.childColumns[0], options) });
      }
      if (fk.parentOid === table.oid) {
        const self = fk.childOid === table.oid;
        const top = columnOffset(table, fk.parentColumns[0], options);
        // A column referencing itself, or both ends on a capped table's header, would leave a loop no height.
        const shift = self && top === columnOffset(table, fk.childColumns[0], options) ? rowHeight(options) : 0;
        handles.set(parentHandle(fk), { id: parentHandle(fk), side: self ? "self" : "left", top: top + shift });
      }
    }
    return {
      id: String(table.oid),
      type: "table",
      position: layout.positions.get(table.oid) ?? { x: 0, y: 0 },
      ...boxes.get(table.oid)!,
      data: { table, handles: [...handles.values()], foreignKeyColumns, options },
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
      data: { points: fk.childOid === fk.parentOid ? undefined : layout.routes.get(fk.oid), hub, name: fk.name, parentEnd: parentEnd(fk), childEnd: childEnd(fk), kind: lineKind(fk) },
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

const RULES: Record<string, string> = { a: "No action", r: "Restrict", c: "Cascade", n: "Set null", d: "Set default" };

/** `pg_constraint`'s `confupdtype` and `confdeltype` in words. */
export const foreignKeyRule = (code: string) => RULES[code] ?? code;
export const matchLabel = (code: string) => (code === "f" ? "Full" : code === "p" ? "Partial" : "Simple");

/** Tables in their current places, redrawn for new options. Sizes change, positions don't. */
export function reshapeNodes(nodes: TableNode[], structure: DiagramStructure, boxes: Map<number, Box>, options: DiagramOptions): TableNode[] {
  const positions = new Map(nodes.map((n) => [Number(n.id), n.position]));
  const redrawn = toNodes(structure, { positions, routes: new Map(), hubEdges: new Set() }, boxes, options);
  const selected = new Set(nodes.flatMap((n) => (n.selected ? [n.id] : [])));
  return redrawn.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
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
