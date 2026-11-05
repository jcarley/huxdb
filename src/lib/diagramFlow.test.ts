import { describe, expect, it } from "vitest";
import { dropRoutes, revealHubLines, toEdges, toNodes } from "./diagramFlow";
import { HEADER, MAX_ROWS } from "./diagramLayout";
import type { Box, Layout } from "./diagramLayout";
import type { DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

const table = (oid: number, schema = "public", columns = 3): DiagramTable => ({
  oid,
  schema,
  name: `t${oid}`,
  columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, dataType: "integer", primaryKey: i === 0 })),
});
const fk = (oid: number, childOid: number, parentOid: number, childColumns = ["c1"], parentColumns = ["c0"]): DiagramForeignKey => ({
  oid,
  name: `fk${oid}`,
  childOid,
  parentOid,
  childColumns,
  parentColumns,
  rolledUp: false,
});
const layoutOf = (structure: DiagramStructure, hubs: number[] = []): Layout => ({
  positions: new Map(structure.tables.map((t) => [t.oid, { x: t.oid * 10, y: 0 }])),
  routes: new Map([[1, [{ x: 5, y: 5 }]]]),
  hubEdges: new Set(hubs),
});
const boxes = (structure: DiagramStructure) => new Map<number, Box>(structure.tables.map((t) => [t.oid, { width: 100, height: 80 }]));

describe("toNodes", () => {
  it("gives a handle only to columns in a relationship", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2)] };
    const [child, parent] = toNodes(s, layoutOf(s), boxes(s));
    expect(child.data.handles.map((h) => h.id)).toEqual(["right:c1"]);
    expect(parent.data.handles.map((h) => h.id)).toEqual(["left:c0"]);
    expect(child.position).toEqual({ x: 10, y: 0 });
    expect(child.width).toBe(100);
  });

  it("marks every column of a composite key, and draws its line from the first", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2, ["c1", "c2"], ["c0", "c1"])] };
    const [child] = toNodes(s, layoutOf(s), boxes(s));
    expect([...child.data.foreignKeyColumns]).toEqual(["c1", "c2"]);
    expect(child.data.handles).toHaveLength(1);
  });

  it("shares a handle between two keys on one column", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2), fk(2, 1, 2)] };
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles).toHaveLength(1);
  });

  it("gives a self-reference both sides", () => {
    const s = { tables: [table(1)], foreignKeys: [fk(1, 1, 1)] };
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles.map((h) => h.side)).toEqual(["right", "left"]);
  });

  it("puts a capped table's handles on its header", () => {
    const s = { tables: [table(1, "public", MAX_ROWS + 1), table(2)], foreignKeys: [fk(1, 1, 2, ["c30"])] };
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles[0].top).toBe(HEADER / 2);
  });

  it("shows schemas only when there's more than one", () => {
    const one = { tables: [table(1), table(2)], foreignKeys: [] };
    expect(toNodes(one, layoutOf(one), boxes(one))[0].data.showSchema).toBe(false);
    const two = { tables: [table(1), table(2, "other")], foreignKeys: [] };
    expect(toNodes(two, layoutOf(two), boxes(two))[0].data.showSchema).toBe(true);
  });
});

describe("toEdges", () => {
  it("identifies a line by its constraint, so two keys between a pair stay two lines", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2), fk(2, 1, 2)] };
    expect(toEdges(s, layoutOf(s)).map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("hides hub lines, and gives routed lines their points", () => {
    const s = { tables: [table(1), table(2), table(3)], foreignKeys: [fk(1, 1, 2), fk(2, 1, 3)] };
    const [routed, hub] = toEdges(s, layoutOf(s, [2]));
    expect(routed).toMatchObject({ hidden: false, data: { points: [{ x: 5, y: 5 }], hub: false } });
    expect(hub).toMatchObject({ hidden: true, data: { hub: true } });
  });
});

describe("revealHubLines", () => {
  const s = { tables: [table(1), table(2), table(3)], foreignKeys: [fk(1, 1, 2), fk(2, 3, 2)] };
  const edges = toEdges(s, layoutOf(s, [1, 2]));

  it("shows the lines of a selected table, at either end, and hides them again", () => {
    const shown = revealHubLines(edges, new Set(["2"]));
    expect(shown.map((e) => e.hidden)).toEqual([false, false]);
    expect(revealHubLines(shown, new Set(["1"])).map((e) => e.hidden)).toEqual([false, true]);
    expect(revealHubLines(shown, new Set()).map((e) => e.hidden)).toEqual([true, true]);
  });

  it("returns the same array when nothing changes, so nothing re-renders", () => {
    expect(revealHubLines(edges, new Set())).toBe(edges);
  });

  it("leaves other lines alone", () => {
    const t = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2)] };
    const plain = toEdges(t, layoutOf(t));
    expect(revealHubLines(plain, new Set())).toBe(plain);
  });
});

describe("dropRoutes", () => {
  const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2)] };
  const edges = toEdges(s, layoutOf(s));

  it("drops a line's route when either table moves", () => {
    expect(dropRoutes(edges, new Set(["1"]))[0].data?.points).toBeUndefined();
    expect(dropRoutes(edges, new Set(["2"]))[0].data?.points).toBeUndefined();
  });

  it("returns the same array when nothing changes", () => {
    expect(dropRoutes(edges, new Set(["9"]))).toBe(edges);
    const dropped = dropRoutes(edges, new Set(["1"]));
    expect(dropRoutes(dropped, new Set(["1"]))).toBe(dropped);
  });
});
