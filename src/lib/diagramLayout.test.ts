import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import { clusterGraph, columnOffset, HEADER, hubLimit, layoutDiagram, MAX_ROWS, partition, ROW, shelves, tableBox } from "./diagramLayout";
import type { Box } from "./diagramLayout";
import type { DiagramForeignKey, DiagramTable } from "./types";

const table = (oid: number, columns = 3): DiagramTable => ({
  oid,
  schema: "public",
  name: `t${oid}`,
  columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, dataType: "integer", notNull: false, primaryKey: i === 0 })),
});
let nextFk = 1000;
const fk = (childOid: number, parentOid: number, child = "c1", parent = "c0"): DiagramForeignKey => ({
  oid: nextFk++,
  name: `fk_${childOid}_${parentOid}`,
  childOid,
  parentOid,
  childColumns: [child],
  parentColumns: [parent],
  rolledUp: false,
});
const sizes = (tables: DiagramTable[]) => new Map<number, Box>(tables.map((t) => [t.oid, { width: 100, height: 80 }]));
const measure = (text: string) => text.length * 6;

/** Stands in for ELK: puts children in a row and gives each edge one bend. */
const fakeElk = async (graph: ElkNode): Promise<ElkNode> => ({
  ...graph,
  width: (graph.children?.length ?? 0) * 200,
  height: 100,
  children: graph.children?.map((c, i) => ({ ...c, x: i * 200, y: 0 })),
  edges: (graph.edges as ElkExtendedEdge[])?.map((e) => ({ ...e, sections: [{ id: "s", startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 }, bendPoints: [{ x: 50, y: 5 }] }] })),
});

describe("tableBox", () => {
  it("fits its widest row", () => {
    const t = table(1);
    expect(tableBox(t, measure).width).toBe(measure("c0: integer") + 44);
    expect(tableBox(t, measure).height).toBe(HEADER + 3 * ROW + 2);
  });

  it("stops growing at the row cap", () => {
    expect(tableBox(table(1, 607), measure).height).toBe(HEADER + MAX_ROWS * ROW + 2);
    expect(tableBox(table(1, MAX_ROWS), measure).height).toBe(HEADER + MAX_ROWS * ROW + 2);
  });

  it("limits a very wide column's width", () => {
    const t = table(1);
    t.columns[0].name = "x".repeat(200);
    expect(tableBox(t, measure).width).toBe(420);
  });
});

describe("columnOffset", () => {
  it("is the middle of the column's row", () => {
    expect(columnOffset(table(1), "c0")).toBe(HEADER + ROW / 2);
    expect(columnOffset(table(1), "c2")).toBe(HEADER + 2 * ROW + ROW / 2);
  });

  it("uses the header in a capped table, where a row can scroll away", () => {
    expect(columnOffset(table(1, MAX_ROWS + 1), "c5")).toBe(HEADER / 2);
    expect(columnOffset(table(1, MAX_ROWS), "c5")).toBe(HEADER + 5 * ROW + ROW / 2);
  });
});

describe("shelves", () => {
  it("never overlaps boxes", () => {
    const boxes = Array.from({ length: 40 }, (_, i) => ({ width: 50 + (i * 37) % 200, height: 40 + (i * 53) % 300 }));
    const { corners } = shelves(boxes, 10);
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const apart =
          corners[a].x + boxes[a].width <= corners[b].x ||
          corners[b].x + boxes[b].width <= corners[a].x ||
          corners[a].y + boxes[a].height <= corners[b].y ||
          corners[b].y + boxes[b].height <= corners[a].y;
        expect(apart).toBe(true);
      }
    }
  });

  it("comes out wider than tall for many boxes", () => {
    const { width, height } = shelves(Array.from({ length: 100 }, () => ({ width: 100, height: 100 })), 10);
    expect(width).toBeGreaterThan(height);
  });

  it("copes with nothing, and with a box wider than the limit", () => {
    expect(shelves([], 10)).toEqual({ corners: [], width: 0, height: 0 });
    expect(shelves([{ width: 5000, height: 10 }], 10).corners).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("partition", () => {
  it("scales the hub limit within bounds", () => {
    expect(hubLimit(10)).toBe(8);
    expect(hubLimit(300)).toBe(24);
    expect(hubLimit(5000)).toBe(30);
  });

  it("sets hubs aside, and clusters what remains", () => {
    const tables = [1, ...Array.from({ length: 12 }, (_, i) => i + 2)].map((oid) => table(oid));
    const fks = [...Array.from({ length: 10 }, (_, i) => fk(i + 2, 1)), fk(2, 3), fk(3, 4), fk(5, 6)];
    const p = partition(tables, fks);
    expect(p.hubs.map((t) => t.oid)).toEqual([1]);
    expect(p.clusters.map((c) => c.map((t) => t.oid).sort((a, b) => a - b))).toEqual([[2, 3, 4], [5, 6]]);
    expect(p.inner).toHaveLength(3);
    expect(p.hubEdges.size).toBe(10);
    // 7 to 11 lean on the hub, and 12 and 13 on nothing.
    expect(p.loners.map((g) => g.map((t) => t.oid))).toEqual([[7, 8, 9, 10, 11], [12, 13]]);
  });

  it("doesn't count a self-reference towards being a hub", () => {
    const fks = Array.from({ length: 12 }, () => fk(1, 1));
    expect(partition([table(1)], fks).hubs).toEqual([]);
  });

  it("keeps a small diagram in one cluster", () => {
    const tables = [table(1), table(2), table(3)];
    const p = partition(tables, [fk(2, 1), fk(3, 1)]);
    expect(p.hubs).toEqual([]);
    expect(p.clusters).toHaveLength(1);
    expect(p.loners).toEqual([]);
  });
});

describe("clusterGraph", () => {
  it("fixes each port to its column, and leaves out keys that leave the cluster", () => {
    const a = table(1);
    const b = table(2);
    const graph = clusterGraph([a, b], [fk(1, 2, "c2", "c0"), fk(1, 99)], sizes([a, b]));
    expect(graph.edges).toHaveLength(1);
    const [child, parent] = graph.children!;
    expect(child.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_POS");
    expect(child.ports?.[0]).toMatchObject({ x: 100, y: columnOffset(a, "c2") });
    expect(parent.ports?.[0]).toMatchObject({ x: 0, y: columnOffset(b, "c0") });
  });

  it("shares a port between two keys on one column", () => {
    const a = table(1);
    const b = table(2);
    const graph = clusterGraph([a, b], [fk(1, 2), fk(1, 2)], sizes([a, b]));
    expect(graph.edges).toHaveLength(2);
    expect(graph.children![0].ports).toHaveLength(1);
  });
});

describe("layoutDiagram", () => {
  it("places every table, without overlap between blocks, and offsets routes with their block", async () => {
    const tables = Array.from({ length: 16 }, (_, i) => table(i + 1));
    const fks = [...Array.from({ length: 10 }, (_, i) => fk(i + 2, 1)), fk(2, 3), fk(14, 15)];
    const { positions, routes, hubEdges } = await layoutDiagram(tables, fks, sizes(tables), fakeElk);
    expect(positions.size).toBe(16);
    expect(hubEdges.size).toBe(10);
    expect(routes.size).toBe(2);
    const seen = new Set([...positions.values()].map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(16);
    const routed = routes.get(fks[10].oid)![0];
    const block = positions.get(2)!.x === 0 ? positions.get(2)! : positions.get(3)!;
    expect(routed.x - block.x).toBe(50);
  });

  it("needs no ELK run for tables with no keys", async () => {
    const tables = [table(1), table(2)];
    const never = () => Promise.reject(new Error("ELK ran"));
    const { positions } = await layoutDiagram(tables, [], sizes(tables), never);
    expect(positions.size).toBe(2);
  });
});
