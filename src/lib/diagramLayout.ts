// Pure layout for diagrams: box sizes, hubs and clusters, and packing. ELK and text measuring
// are passed in, so this has no browser dependency.
//
// One ELK run over a whole schema doesn't work: nearly every table points at a few hubs, so
// they fall into one layer and 300 tables become a column 48,000 px tall. So hub tables are
// taken out, what's left falls into clusters, ELK lays out each one, and the results are packed.

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { DiagramColumn, DiagramForeignKey, DiagramOptions, DiagramStructure, DiagramTable } from "./types";

export const DEFAULT_OPTIONS: DiagramOptions = { showFieldComments: false, showNotNull: false, showObjectComments: false, showSchemaNames: false, showRelationshipNames: true, fontSize: 11, blackAndWhite: false };

/** More lines than this start with their names off, because they'd crowd the diagram. */
const NAMED_LINES_LIMIT = 60;

/** A diagram of several schemas shows them, because a bare name could mean two tables. */
export const defaultOptions = ({ tables, foreignKeys }: DiagramStructure): DiagramOptions => ({
  ...DEFAULT_OPTIONS,
  showSchemaNames: new Set(tables.map((t) => t.schema)).size > 1,
  showRelationshipNames: foreignKeys.length <= NAMED_LINES_LIMIT,
});

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
const CLUSTER_GAP = 30;
const LAYER_GAP = 70;
/** Room for a name between tables, as a line's marks take the first and last 20 px. */
const NAMED_LAYER_GAP = 160;
const HUB_GAP = 60;
const BLOCK_GAP = 120;

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
  /** Bend points per foreign key, for those ELK routed. */
  routes: Map<number, Point[]>;
  /** Foreign keys touching a hub, which have no route and stay hidden until selected. */
  hubEdges: Set<number>;
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
  let width = measure(title, true, fontSize) + (capped ? 90 * scale : 40);
  for (const c of table.columns) width = Math.max(width, measure(`${c.name}: ${c.dataType}${rowSuffix(c, options)}`, false, fontSize) + 44 * scale);
  return {
    width: Math.ceil(Math.min(width + (capped ? SCROLLBAR : 0), MAX_WIDTH)),
    height: rowsTop(table, options) + Math.min(table.columns.length, MAX_ROWS) * rowHeight(options) + 2,
  };
}

/** Where a column's line meets its table. A row in a capped table can scroll away, so its lines meet the header. */
export function columnOffset(table: DiagramTable, column: string, options = DEFAULT_OPTIONS) {
  if (isCapped(table)) return headerHeight(options) / 2;
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
  inner: DiagramForeignKey[];
  hubEdges: Set<number>;
}

export function partition(tables: DiagramTable[], foreignKeys: DiagramForeignKey[]): Partition {
  const incoming = new Map<number, number>();
  for (const fk of foreignKeys) {
    if (fk.childOid !== fk.parentOid) incoming.set(fk.parentOid, (incoming.get(fk.parentOid) ?? 0) + 1);
  }
  const limit = hubLimit(tables.length);
  const hubOids = new Set([...incoming].filter(([, n]) => n > limit).map(([oid]) => oid));
  const touchesHub = (fk: DiagramForeignKey) => hubOids.has(fk.parentOid) || hubOids.has(fk.childOid);
  const inner = foreignKeys.filter((fk) => !touchesHub(fk));

  const parent = new Map(tables.map((t) => [t.oid, t.oid]));
  const find = (start: number) => {
    let x = start;
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const fk of inner) parent.set(find(fk.childOid), find(fk.parentOid));

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
    const hub = foreignKeys.find((fk) => fk.childOid === group[0].oid && hubOids.has(fk.parentOid))?.parentOid ?? 0;
    leaningOn.set(hub, [...(leaningOn.get(hub) ?? []), group[0]]);
  }
  return {
    hubs: tables.filter((t) => hubOids.has(t.oid)),
    clusters,
    loners: [...leaningOn.values()],
    inner,
    hubEdges: new Set(foreignKeys.filter(touchesHub).map((fk) => fk.oid)),
  };
}

/** ELK's graph for one cluster, with a fixed port where each foreign key meets its column. */
export function clusterGraph(cluster: DiagramTable[], foreignKeys: DiagramForeignKey[], boxes: Map<number, Box>, options = DEFAULT_OPTIONS): ElkNode {
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
  const edges: ElkExtendedEdge[] = foreignKeys
    // A self-reference draws its own loop, which needs no route and survives a drag.
    .filter((fk) => members.has(fk.childOid) && members.has(fk.parentOid) && fk.childOid !== fk.parentOid)
    .map((fk) => ({
      id: String(fk.oid),
      sources: [port(fk.childOid, fk.childColumns[0], "EAST")],
      targets: [port(fk.parentOid, fk.parentColumns[0], "WEST")],
    }));
  return {
    id: "cluster",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.separateConnectedComponents": "false",
      "elk.spacing.nodeNode": String(CLUSTER_GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(options.showRelationshipNames ? NAMED_LAYER_GAP : LAYER_GAP),
      "elk.spacing.edgeNode": "20",
      "elk.spacing.edgeEdge": "8",
    },
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
  routes: { id: number; points: Point[] }[];
}

export async function layoutDiagram(tables: DiagramTable[], foreignKeys: DiagramForeignKey[], boxes: Map<number, Box>, run: RunLayout, options = DEFAULT_OPTIONS): Promise<Layout> {
  const { hubs, clusters, loners, inner, hubEdges } = partition(tables, foreignKeys);
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
        return section ? [{ id: Number(e.id), points: section.bendPoints ?? [] }] : [];
      }),
    });
  }
  for (const group of loners) blocks.push(grid(group, CLUSTER_GAP));
  if (hubs.length) blocks.push(grid(hubs, HUB_GAP));

  const { corners } = shelves(blocks, BLOCK_GAP);
  const positions: Layout["positions"] = new Map();
  const routes: Layout["routes"] = new Map();
  blocks.forEach((block, i) => {
    const corner = corners[i];
    for (const item of block.items) positions.set(item.oid, { x: corner.x + item.x, y: corner.y + item.y });
    for (const route of block.routes) routes.set(route.id, route.points.map((p) => ({ x: p.x + corner.x, y: p.y + corner.y })));
  });
  return { positions, routes, hubEdges };
}
