// Between a diagram on screen and its saved layout. Pure.

import { dependencyKey, foreignKeyKey, tableKey } from "./diagramDrift";
import { isAnnotationId } from "./diagramAnnotations";
import type { DiagramEdge, DiagramNode } from "./diagramFlow";
import { dependencyId, layoutEdges, partition, shelves } from "./diagramLayout";
import type { Box, Layout, Point } from "./diagramLayout";
import type { DiagramAnnotation, DiagramColor, DiagramColors, DiagramLayoutFile, DiagramOptions, DiagramStructure, DiagramViewport } from "./types";

const NEW_TABLE_GAP = 60;

export const EMPTY_COLORS: DiagramColors = { objects: {}, lines: {} };
/** Colours whose object or line is still in `structure`. */
export function pruneColors(colors: DiagramColors, structure: DiagramStructure): DiagramColors {
  const tables = new Map(structure.tables.map((t) => [t.oid, t]));
  const objects = new Set(structure.tables.map(tableKey));
  const lines = new Set(structure.foreignKeys.flatMap((fk) => (tables.has(fk.childOid) ? [foreignKeyKey(fk, tables.get(fk.childOid)!)] : [])));
  const keep = (map: Record<string, DiagramColor>, alive: Set<string>) => Object.fromEntries(Object.entries(map).filter(([key]) => alive.has(key)));
  return { objects: keep(colors.objects, objects), lines: keep(colors.lines, lines) };
}

/** Moves an object's colour, and its foreign keys' line colours, to a renamed table's keys. */
export function renameColors(colors: DiagramColors, from: string, to: { schema: string; name: string }): DiagramColors {
  const lines = Object.fromEntries(
    Object.entries(colors.lines).map(([key, color]) => {
      const [schema, name, fk] = JSON.parse(key) as string[];
      return JSON.stringify([schema, name]) === from ? [JSON.stringify([to.schema, to.name, fk]), color] : [key, color];
    }),
  );
  const { [from]: own, ...rest } = colors.objects;
  return { objects: own ? { ...rest, [tableKey(to)]: own } : colors.objects, lines };
}

const sorted = (map: Record<string, string>) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What makes a diagram differ from its last save. Pan and zoom are saved but aren't in it.
 * Annotations come from their own list, whose places are synced from the nodes, so nodes of theirs are skipped.
 */
export const layoutSignature = (nodes: DiagramNode[], options?: DiagramOptions, colors: DiagramColors = EMPTY_COLORS, annotations: DiagramAnnotation[] = []) =>
  `${JSON.stringify(options)}|${nodes
    .filter((n) => !isAnnotationId(n.id))
    .map((n) => `${n.id}:${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .sort()
    .join(";")}|${JSON.stringify([sorted(colors.objects), sorted(colors.lines)])}|${JSON.stringify(annotations.map((a) => ({ ...a, x: Math.round(a.x), y: Math.round(a.y) })))}`;

/**
 * The layout to save. Positions in `previous` stay, so a table that's gone from the database
 * keeps its place until the report is accepted, in case it comes back.
 */
export function captureLayout(structure: DiagramStructure, nodes: DiagramNode[], edges: DiagramEdge[], previous: DiagramLayoutFile | null, viewport: DiagramViewport | null, options?: DiagramOptions): DiagramLayoutFile {
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
  for (const d of structure.dependencies ?? []) {
    const route = points.get(dependencyId(d));
    const key = route && dependencyKey(d, tables);
    if (route && key) routes[key] = route;
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

  const { hubEdges } = partition(structure.tables, layoutEdges(structure));
  const tables = new Map(structure.tables.map((t) => [t.oid, t]));
  const fresh = new Set(unplaced.map((u) => u.oid));
  const routes: Layout["routes"] = new Map();
  for (const fk of structure.foreignKeys) {
    const child = tables.get(fk.childOid);
    const parent = tables.get(fk.parentOid);
    if (!child || !parent || hubEdges.has(String(fk.oid))) continue;
    if (fresh.has(fk.childOid) || fresh.has(fk.parentOid) || changed.has(tableKey(child)) || changed.has(tableKey(parent))) continue;
    const route = file.routes[foreignKeyKey(fk, child)];
    if (route) routes.set(String(fk.oid), route);
  }
  for (const d of structure.dependencies ?? []) {
    const key = dependencyKey(d, tables);
    if (!key || hubEdges.has(dependencyId(d))) continue;
    const child = tables.get(d.dependentOid)!;
    const parent = tables.get(d.sourceOid)!;
    if (fresh.has(d.dependentOid) || fresh.has(d.sourceOid) || changed.has(tableKey(child)) || changed.has(tableKey(parent))) continue;
    const route = file.routes[key];
    if (route) routes.set(dependencyId(d), route);
  }
  return { positions, routes, hubEdges };
}
