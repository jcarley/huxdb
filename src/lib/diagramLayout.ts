// Pure layout for diagrams: box sizes, hubs and clusters, and packing. ELK and text measuring
// are passed in, so this has no browser dependency.
//
// One ELK run over a whole schema doesn't work: nearly every table points at a few hubs, so
// they fall into one layer and 300 tables become a column 48,000 px tall. So hub tables are
// taken out, what's left falls into clusters, ELK lays out each one, and the results are packed.

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { DiagramColumn, DiagramDependency, DiagramOptions, DiagramStructure, DiagramTable } from "./types";

export const DEFAULT_OPTIONS: DiagramOptions = { showFieldComments: false, showNotNull: false, showObjectComments: false, showSchemaNames: false, showRelationshipNames: true, fontSize: 11, blackAndWhite: false, objectDistance: 40, layoutQuality: "normal", groupBySchema: false };

/** More lines than this start with their names off, because they'd crowd the diagram. */
const NAMED_LINES_LIMIT = 60;

/** A diagram of several schemas shows them, because a bare name could mean two tables. */
export const defaultOptions = ({ tables, foreignKeys }: DiagramStructure): DiagramOptions => ({
  ...DEFAULT_OPTIONS,
  showSchemaNames: new Set(tables.map((t) => t.schema)).size > 1,
  showRelationshipNames: foreignKeys.length <= NAMED_LINES_LIMIT,
});

/** The column a view or function line meets: the header, since a name can't be empty in PostgreSQL. */
export const HEADER = "";

/** What the layout needs of a line, whether a foreign key or a view's dependency. */
export interface LayoutEdge {
  id: string;
  childOid: number;
  parentOid: number;
  childColumn: string;
  parentColumn: string;
}

export const dependencyId = ({ dependentOid, sourceOid }: DiagramDependency) => `dep:${dependentOid}:${sourceOid}`;

/** Foreign keys, then dependencies. A file from before views has no dependencies. */
export const layoutEdges = ({ foreignKeys, dependencies = [] }: DiagramStructure): LayoutEdge[] => [
  ...foreignKeys.map((fk) => ({ id: String(fk.oid), childOid: fk.childOid, parentOid: fk.parentOid, childColumn: fk.childColumns[0], parentColumn: fk.parentColumns[0] })),
  ...dependencies.map((d) => ({ id: dependencyId(d), childOid: d.dependentOid, parentOid: d.sourceOid, childColumn: HEADER, parentColumn: HEADER })),
];

export const headerHeight = ({ fontSize }: DiagramOptions) => Math.round(fontSize * 2.4);
export const rowHeight = ({ fontSize }: DiagramOptions) => Math.round(fontSize * 1.65);

const showsComment = (table: DiagramTable, options: DiagramOptions) => options.showObjectComments && !!table.comment;

/** Where a table's rows start: under its header, and its comment line if it shows one. */
export const rowsTop = (table: DiagramTable, options: DiagramOptions) => headerHeight(options) + (showsComment(table, options) ? rowHeight(options) : 0);

/** What follows a column's type in its row. */
export function rowSuffix(column: DiagramColumn, options: DiagramOptions) {
  const notNull = options.showNotNull && column.notNull ? " NOT NULL" : "";
  const comment = options.showFieldComments && column.comment ? `  ${column.comment}` : "";
  return `${notNull}${comment}`;
}

/** A longer table scrolls inside its node. One table of 607 columns would otherwise set the height of the whole diagram. */
export const MAX_ROWS = 40;
const MAX_WIDTH = 420;
const SCROLLBAR = 12;
/** Room for a line's two marks, whatever Object Distance says. */
const MIN_LAYER_GAP = 50;
/** Room for a name between tables, as a line's marks take the first and last 20 px. */
const NAMED_LAYER_GAP = 160;

export interface Box {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Layout {
  positions: Map<number, Point>;
  /** Bend points per line, for those ELK routed. */
  routes: Map<string, Point[]>;
  /** Lines touching a hub, which have no route and stay hidden until selected. */
  hubEdges: Set<string>;
}

export type Measure = (text: string, bold: boolean, fontSize: number) => number;
export type RunLayout = (graph: ElkNode) => Promise<ElkNode>;

export const isCapped = (table: DiagramTable) => table.columns.length > MAX_ROWS;

export function tableBox(table: DiagramTable, measure: Measure, options = DEFAULT_OPTIONS): Box {
  const capped = isCapped(table);
  const { fontSize } = options;
  const scale = fontSize / DEFAULT_OPTIONS.fontSize;
  const title = options.showSchemaNames ? `${table.schema}.${table.name}` : table.name;
  // Header: name, then the column count a capped table shows.
  // A view has an icon before its name, and a function or procedure also has an info icon, each an icon and a gap wide.
  const icons = table.kind === "function" || table.kind === "procedure" ? 3 : table.kind && table.kind !== "table" ? 1.5 : 0;
  let width = measure(title, true, fontSize) + (capped ? 90 * scale : 40) + fontSize * icons;
  for (const c of table.columns) width = Math.max(width, measure(`${c.name}: ${c.dataType}${rowSuffix(c, options)}`, false, fontSize) + 44 * scale);
  return {
    width: Math.ceil(Math.min(width + (capped ? SCROLLBAR : 0), MAX_WIDTH)),
    // The border: 1px a side, 2px for a materialized view.
    height: rowsTop(table, options) + Math.min(table.columns.length, MAX_ROWS) * rowHeight(options) + (table.kind === "materialized-view" ? 4 : 2),
  };
}

/** Where a column's line meets its table. The header takes the lines of a view or function, and a row in a capped table can scroll away, so its lines meet the header. */
export function columnOffset(table: DiagramTable, column: string, options = DEFAULT_OPTIONS) {
  if (column === HEADER || isCapped(table)) return headerHeight(options) / 2;
  const row = rowHeight(options);
  return rowsTop(table, options) + Math.max(0, table.columns.findIndex((c) => c.name === column)) * row + row / 2;
}

/** Packs boxes into shelves near a 1.6 ratio, tallest first. Corners are returned by index. */
export function shelves(boxes: Box[], gap: number) {
  const area = boxes.reduce((sum, b) => sum + (b.width + gap) * (b.height + gap), 0);
  const limit = Math.max(Math.sqrt(area * 1.6), ...boxes.map((b) => b.width), 0);
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].height - boxes[a].height);
  const corners: Point[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  for (const i of order) {
    if (x > 0 && x + boxes[i].width > limit) {
      x = 0;
      y += shelf + gap;
      shelf = 0;
    }
    corners[i] = { x, y };
    x += boxes[i].width + gap;
    width = Math.max(width, x - gap);
    shelf = Math.max(shelf, boxes[i].height);
  }
  return { corners, width, height: y + shelf };
}

/** Tables with more incoming foreign keys than this, for a diagram of `count` tables, are hubs. */
export const hubLimit = (count: number) => Math.max(8, Math.min(30, count * 0.08));

export interface Partition {
  hubs: DiagramTable[];
  /** Tables joined by foreign keys that don't touch a hub, each with two or more tables. */
  clusters: DiagramTable[][];
  /** Tables with no such key, grouped by the hub they lean on. */
  loners: DiagramTable[][];
  inner: LayoutEdge[];
  hubEdges: Set<string>;
}

export function partition(tables: DiagramTable[], edges: LayoutEdge[]): Partition {
  const incoming = new Map<number, number>();
  for (const e of edges) {
    if (e.childOid !== e.parentOid) incoming.set(e.parentOid, (incoming.get(e.parentOid) ?? 0) + 1);
  }
  const limit = hubLimit(tables.length);
  const hubOids = new Set([...incoming].filter(([, n]) => n > limit).map(([oid]) => oid));
  const touchesHub = (e: LayoutEdge) => hubOids.has(e.parentOid) || hubOids.has(e.childOid);
  const inner = edges.filter((e) => !touchesHub(e));

  const parent = new Map(tables.map((t) => [t.oid, t.oid]));
  const find = (start: number) => {
    let x = start;
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const e of inner) parent.set(find(e.childOid), find(e.parentOid));

  const groups = new Map<number, DiagramTable[]>();
  for (const t of tables) {
    if (hubOids.has(t.oid)) continue;
    const root = find(t.oid);
    groups.set(root, [...(groups.get(root) ?? []), t]);
  }
  const leaningOn = new Map<number, DiagramTable[]>();
  const clusters: DiagramTable[][] = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      clusters.push(group);
      continue;
    }
    const hub = edges.find((e) => e.childOid === group[0].oid && hubOids.has(e.parentOid))?.parentOid ?? 0;
    leaningOn.set(hub, [...(leaningOn.get(hub) ?? []), group[0]]);
  }
  return {
    hubs: tables.filter((t) => hubOids.has(t.oid)),
    clusters,
    loners: [...leaningOn.values()],
    inner,
    hubEdges: new Set(edges.filter(touchesHub).map((e) => e.id)),
  };
}

const DISTANCES = [20, 30, 40, 60, 80, 120];

/** The Object Distance values to offer, keeping a saved one that isn't among them. */
export const distanceChoices = (current: number) => [...new Set([...DISTANCES, current])].sort((x, y) => x - y);

/** Every gap comes from Object Distance, so tables, clusters and blocks stay in proportion. */
export const layoutGaps = ({ objectDistance: d, showRelationshipNames }: DiagramOptions) => ({
  node: d,
  layer: Math.max(1.5 * d, showRelationshipNames ? NAMED_LAYER_GAP : MIN_LAYER_GAP),
  hub: 1.5 * d,
  block: 3 * d,
  edge: d / 4,
});

/**
 * Object Distance and Quality as ELK's options. `thoroughness` buys time, not quality, so a third
 * level would only be a longer wait. Every graph here is one connected cluster, so component
 * spacing and compaction would have nothing to act on.
 */
export function elkOptions(options: DiagramOptions): Record<string, string> {
  const gaps = layoutGaps(options);
  const normal = options.layoutQuality === "normal";
  return {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.separateConnectedComponents": "false",
    "elk.layered.thoroughness": normal ? "7" : "1",
    ...(normal ? { "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" } : {}),
    "elk.spacing.nodeNode": String(gaps.node),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(gaps.layer),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(gaps.edge),
    "elk.layered.spacing.edgeEdgeBetweenLayers": String(gaps.edge),
  };
}

/** ELK's graph for one cluster, with a fixed port where each line meets its column. All of a table's lines to its header on one side share a port. */
export function clusterGraph(cluster: DiagramTable[], lines: LayoutEdge[], boxes: Map<number, Box>, options = DEFAULT_OPTIONS): ElkNode {
  const members = new Map(cluster.map((t) => [t.oid, t]));
  const ports = new Map<number, Map<string, NonNullable<ElkNode["ports"]>[number]>>(cluster.map((t) => [t.oid, new Map()]));
  const port = (oid: number, column: string, side: "EAST" | "WEST") => {
    const id = `${oid}:${side}:${column}`;
    ports.get(oid)!.set(id, {
      id,
      x: side === "EAST" ? boxes.get(oid)!.width : 0,
      y: columnOffset(members.get(oid)!, column, options),
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": side },
    });
    return id;
  };
  const edges: ElkExtendedEdge[] = lines
    // A self-reference draws its own loop, which needs no route and survives a drag.
    .filter((e) => members.has(e.childOid) && members.has(e.parentOid) && e.childOid !== e.parentOid)
    .map((e) => ({
      id: e.id,
      sources: [port(e.childOid, e.childColumn, "EAST")],
      targets: [port(e.parentOid, e.parentColumn, "WEST")],
    }));
  return {
    id: "cluster",
    layoutOptions: elkOptions(options),
    children: cluster.map((t) => ({
      id: String(t.oid),
      ...boxes.get(t.oid)!,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [...ports.get(t.oid)!.values()],
    })),
    edges,
  };
}

interface Block extends Box {
  items: { oid: number; x: number; y: number }[];
  routes: { id: string; points: Point[] }[];
}

/** The lines with both ends among these tables, which is all `partition` can take. */
export const keysWithin = (tables: DiagramTable[], edges: LayoutEdge[]) => {
  const oids = new Set(tables.map((t) => t.oid));
  return edges.filter((e) => oids.has(e.childOid) && oids.has(e.parentOid));
};

/** The corner and size of what's placed. */
export function bounds(positions: Iterable<[number, Point]>, boxes: Map<number, Box>) {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [oid, { x, y }] of positions) {
    const box = boxes.get(oid)!;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + box.width);
    bottom = Math.max(bottom, y + box.height);
  }
  return left === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: left, y: top, width: right - left, height: bottom - top };
}

const moved = (points: Point[], dx: number, dy: number) => points.map((p) => ({ x: p.x + dx, y: p.y + dy }));

/** A layout with its corner at `corner`, routes included. */
export function placedAt({ positions, routes, hubEdges }: Layout, boxes: Map<number, Box>, corner: Point): Layout {
  const { x, y } = bounds(positions, boxes);
  const [dx, dy] = [corner.x - x, corner.y - y];
  return {
    positions: new Map([...positions].map(([oid, p]) => [oid, { x: p.x + dx, y: p.y + dy }])),
    routes: new Map([...routes].map(([id, points]) => [id, moved(points, dx, dy)])),
    hubEdges,
  };
}

/** Each schema laid out alone, then packed. A line between schemas has no route, so it draws the plain path. */
async function layoutBySchema(tables: DiagramTable[], edges: LayoutEdge[], boxes: Map<number, Box>, run: RunLayout, options: DiagramOptions): Promise<Layout> {
  const schemas = new Map<string, DiagramTable[]>();
  for (const table of tables) schemas.set(table.schema, [...(schemas.get(table.schema) ?? []), table]);

  const parts: Layout[] = [];
  for (const group of schemas.values()) parts.push(await layoutTables(group, keysWithin(group, edges), boxes, run, options));
  const { corners } = shelves(parts.map((part) => bounds(part.positions, boxes)), layoutGaps(options).block * 2);

  // Hubs are the whole diagram's, as they are after a save, whatever each schema made of them.
  const { hubEdges } = partition(tables, edges);
  const positions: Layout["positions"] = new Map();
  const routes: Layout["routes"] = new Map();
  parts.forEach((part, i) => {
    const placed = placedAt(part, boxes, corners[i]);
    for (const [oid, point] of placed.positions) positions.set(oid, point);
    for (const [id, points] of placed.routes) if (!hubEdges.has(id)) routes.set(id, points);
  });
  return { positions, routes, hubEdges };
}

export const layoutDiagram = (tables: DiagramTable[], edges: LayoutEdge[], boxes: Map<number, Box>, run: RunLayout, options = DEFAULT_OPTIONS): Promise<Layout> =>
  (options.groupBySchema ? layoutBySchema : layoutTables)(tables, edges, boxes, run, options);

async function layoutTables(tables: DiagramTable[], edges: LayoutEdge[], boxes: Map<number, Box>, run: RunLayout, options: DiagramOptions): Promise<Layout> {
  const { hubs, clusters, loners, inner, hubEdges } = partition(tables, edges);
  const gaps = layoutGaps(options);
  const grid = (group: DiagramTable[], gap: number): Block => {
    const packed = shelves(group.map((t) => boxes.get(t.oid)!), gap);
    return { width: packed.width, height: packed.height, items: group.map((t, i) => ({ oid: t.oid, ...packed.corners[i] })), routes: [] };
  };

  const blocks: Block[] = [];
  for (const cluster of clusters) {
    const out = await run(clusterGraph(cluster, inner, boxes, options));
    blocks.push({
      width: out.width ?? 0,
      height: out.height ?? 0,
      items: (out.children ?? []).map((c) => ({ oid: Number(c.id), x: c.x ?? 0, y: c.y ?? 0 })),
      routes: ((out.edges ?? []) as ElkExtendedEdge[]).flatMap((e) => {
        const section = e.sections?.[0];
        return section ? [{ id: e.id, points: section.bendPoints ?? [] }] : [];
      }),
    });
  }
  for (const group of loners) blocks.push(grid(group, gaps.node));
  if (hubs.length) blocks.push(grid(hubs, gaps.hub));

  const { corners } = shelves(blocks, gaps.block);
  const positions: Layout["positions"] = new Map();
  const routes: Layout["routes"] = new Map();
  blocks.forEach((block, i) => {
    const corner = corners[i];
    for (const item of block.items) positions.set(item.oid, { x: corner.x + item.x, y: corner.y + item.y });
    for (const route of block.routes) routes.set(route.id, route.points.map((p) => ({ x: p.x + corner.x, y: p.y + corner.y })));
  });
  return { positions, routes, hubEdges };
}
