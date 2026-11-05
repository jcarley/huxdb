// Between a diagram on screen and its saved layout. Pure.

import { foreignKeyKey, tableKey } from "./diagramDrift";
import type { FkEdge, TableNode } from "./diagramFlow";
import { partition, shelves } from "./diagramLayout";
import type { Box, Layout, Point } from "./diagramLayout";
import type { DiagramLayoutFile, DiagramOptions, DiagramStructure, DiagramViewport } from "./types";

const NEW_TABLE_GAP = 60;

/** What makes a diagram differ from its last save. Pan and zoom are saved but aren't in it. */
export const layoutSignature = (nodes: TableNode[], options?: DiagramOptions) =>
  `${JSON.stringify(options)}|${nodes
    .map((n) => `${n.id}:${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .sort()
    .join(";")}`;

/**
 * The layout to save. Positions in `previous` stay, so a table that's gone from the database
 * keeps its place until the report is accepted, in case it comes back.
 */
export function captureLayout(structure: DiagramStructure, nodes: TableNode[], edges: FkEdge[], previous: DiagramLayoutFile | null, viewport: DiagramViewport | null, options?: DiagramOptions): DiagramLayoutFile {
  const tables = new Map(structure.tables.map((t) => [t.oid, t]));
  const positions = { ...previous?.tables };
  for (const node of nodes) {
    const table = tables.get(Number(node.id));
    if (table) positions[tableKey(table)] = { x: node.position.x, y: node.position.y };
  }
  const routes: DiagramLayoutFile["routes"] = {};
  const points = new Map(edges.map((e) => [e.id, e.data?.points]));
  for (const fk of structure.foreignKeys) {
    const route = points.get(String(fk.oid));
    const child = tables.get(fk.childOid);
    if (route && child) routes[foreignKeyKey(fk, child)] = route;
  }
  return { tables: positions, routes, viewport, options };
}

/**
 * A saved layout on today's structure. `changed` are tables whose rows moved, so a saved route
 * to one would no longer fit; tables with no saved place go in a row below the rest.
 */
export function restoreLayout(file: DiagramLayoutFile, structure: DiagramStructure, boxes: Map<number, Box>, changed: Set<string>): Layout {
  const positions = new Map<number, Point>();
  const unplaced: { oid: number; box: Box }[] = [];
  let bottom = 0;
  let left = Infinity;
  for (const table of structure.tables) {
    const saved = file.tables[tableKey(table)];
    const box = boxes.get(table.oid)!;
    if (saved) {
      positions.set(table.oid, saved);
      bottom = Math.max(bottom, saved.y + box.height);
      left = Math.min(left, saved.x);
    } else {
      unplaced.push({ oid: table.oid, box });
    }
  }
  const { corners } = shelves(unplaced.map((u) => u.box), NEW_TABLE_GAP);
  const top = positions.size ? bottom + NEW_TABLE_GAP * 2 : 0;
  unplaced.forEach((u, i) => positions.set(u.oid, { x: (positions.size > i ? left : 0) + corners[i].x, y: top + corners[i].y }));

  const { hubEdges } = partition(structure.tables, structure.foreignKeys);
  const tables = new Map(structure.tables.map((t) => [t.oid, t]));
  const fresh = new Set(unplaced.map((u) => u.oid));
  const routes: Layout["routes"] = new Map();
  for (const fk of structure.foreignKeys) {
    const child = tables.get(fk.childOid);
    const parent = tables.get(fk.parentOid);
    if (!child || !parent || hubEdges.has(fk.oid)) continue;
    if (fresh.has(fk.childOid) || fresh.has(fk.parentOid) || changed.has(tableKey(child)) || changed.has(tableKey(parent))) continue;
    const route = file.routes[foreignKeyKey(fk, child)];
    if (route) routes.set(fk.oid, route);
  }
  return { positions, routes, hubEdges };
}
