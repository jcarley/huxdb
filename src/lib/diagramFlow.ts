// Turns a diagram's structure and layout into React Flow's nodes and edges. Pure: only types
// come from React Flow, so stores can use this without pulling the library into the main bundle.

import type { Edge, Node } from "@xyflow/react";
import { childEnd, lineKind, parentEnd } from "./diagramCardinality";
import type { ChildEnd, LineKind, ParentEnd } from "./diagramCardinality";
import { bounds, columnOffset, dependencyId, DEFAULT_OPTIONS, HEADER, placedAt, rowHeight } from "./diagramLayout";
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

export interface DependencyData extends Record<string, unknown> {
  /** ELK's bend points, as for a foreign key. */
  points?: Point[];
  hub: boolean;
}

export type TableNode = Node<TableData, "table">;
export type FkEdge = Edge<FkData, "fk">;
export type DependencyEdge = Edge<DependencyData, "dependency">;
export type DiagramEdge = FkEdge | DependencyEdge;

/** A view's line leaves its right side and enters its source's left, both at the header. */
export const DEPENDENCY_OUT = "dep-out";
export const DEPENDENCY_IN = "dep-in";

const childHandle = (fk: DiagramForeignKey) => `right:${fk.childColumns[0]}`;
const parentHandle = (fk: DiagramForeignKey) => (fk.childOid === fk.parentOid ? `self:${fk.childColumns[0]}:${fk.parentColumns[0]}` : `left:${fk.parentColumns[0]}`);

export function toNodes({ tables, foreignKeys, dependencies = [] }: DiagramStructure, layout: Layout, boxes: Map<number, Box>, options = DEFAULT_OPTIONS): TableNode[] {
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
    const headerTop = columnOffset(table, HEADER, options);
    if (dependencies.some((d) => d.dependentOid === table.oid)) handles.set(DEPENDENCY_OUT, { id: DEPENDENCY_OUT, side: "right", top: headerTop });
    if (dependencies.some((d) => d.sourceOid === table.oid)) handles.set(DEPENDENCY_IN, { id: DEPENDENCY_IN, side: "left", top: headerTop });
    return {
      id: String(table.oid),
      type: "table",
      position: layout.positions.get(table.oid) ?? { x: 0, y: 0 },
      ...boxes.get(table.oid)!,
      data: { table, handles: [...handles.values()], foreignKeyColumns, options },
    };
  });
}

export function toEdges({ foreignKeys, dependencies = [] }: DiagramStructure, layout: Layout): DiagramEdge[] {
  const fkEdges = foreignKeys.map((fk): FkEdge => {
    const hub = layout.hubEdges.has(String(fk.oid));
    return {
      id: String(fk.oid),
      type: "fk",
      source: String(fk.childOid),
      target: String(fk.parentOid),
      sourceHandle: childHandle(fk),
      targetHandle: parentHandle(fk),
      hidden: hub,
      data: { points: fk.childOid === fk.parentOid ? undefined : layout.routes.get(String(fk.oid)), hub, name: fk.name, parentEnd: parentEnd(fk), childEnd: childEnd(fk), kind: lineKind(fk) },
    };
  });
  const dependencyEdges = dependencies.map((d): DependencyEdge => {
    const id = dependencyId(d);
    const hub = layout.hubEdges.has(id);
    return { id, type: "dependency", source: String(d.dependentOid), target: String(d.sourceOid), sourceHandle: DEPENDENCY_OUT, targetHandle: DEPENDENCY_IN, hidden: hub, data: { points: layout.routes.get(id), hub } };
  });
  return [...fkEdges, ...dependencyEdges];
}

/** Hub lines show only for a selected table: they're most of a schema's lines, and drawn together they're a haze. */
export function revealHubLines(edges: DiagramEdge[], selected: Set<string>) {
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

/** The cast is because spreading a union's `data` loses which kind it was. */
const withPoints = <E extends DiagramEdge>(edge: E, points: Point[] | undefined): E => ({ ...edge, data: { ...edge.data, points } }) as E;

/** Where tables and lines are, for undo. Only what's listed is changed when it's applied. */
export interface Arrangement {
  positions: Map<string, Point>;
  /** Undefined clears a line's route, so it draws the plain path. */
  routes: Map<string, Point[] | undefined>;
}

export const currentArrangement = (nodes: TableNode[], edges: DiagramEdge[]): Arrangement => ({
  positions: new Map(nodes.map((n) => [n.id, n.position])),
  routes: new Map(edges.map((e) => [e.id, e.data?.points])),
});

export function applyArrangement(nodes: TableNode[], edges: DiagramEdge[], { positions, routes }: Arrangement) {
  return {
    nodes: nodes.map((n) => {
      const position = positions.get(n.id);
      return position ? { ...n, position } : n;
    }),
    edges: edges.map((e) => (e.data && routes.has(e.id) ? withPoints(e, routes.get(e.id)) : e)),
  };
}

/**
 * A layout of the selected tables alone, moved back to where they were. A line leaving the
 * selection loses its route, as it would if its table were dragged.
 */
export function selectionArrangement(layout: Layout, nodes: TableNode[], edges: DiagramEdge[], chosen: Set<string>, boxes: Map<number, Box>): Arrangement {
  const current = nodes.flatMap((n) => (chosen.has(n.id) ? [[Number(n.id), n.position] as [number, Point]] : []));
  const { positions, routes } = placedAt(layout, boxes, bounds(current, boxes));
  return {
    positions: new Map([...positions].map(([oid, point]) => [String(oid), point])),
    routes: new Map(edges.filter((e) => chosen.has(e.source) || chosen.has(e.target)).map((e) => [e.id, e.data?.hub ? undefined : routes.get(e.id)])),
  };
}

/** ELK has no routing-only pass, so a moved table's lines fall back to a plain path rather than keep a stale route. */
export function dropRoutes(edges: DiagramEdge[], moved: Set<string>) {
  let changed = false;
  const next = edges.map((edge) => {
    if (!edge.data?.points || (!moved.has(edge.source) && !moved.has(edge.target))) return edge;
    changed = true;
    return withPoints(edge, undefined);
  });
  return changed ? next : edges;
}
