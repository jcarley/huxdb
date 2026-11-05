import { describe, expect, it } from "vitest";
import { applyArrangement, currentArrangement, dropRoutes, foreignKeyRule, matchLabel, reshapeNodes, revealHubLines, selectionArrangement, toEdges, toNodes } from "./diagramFlow";
import { DEFAULT_OPTIONS, headerHeight, MAX_ROWS, rowHeight } from "./diagramLayout";
import type { Box, Layout } from "./diagramLayout";
import type { DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

const table = (oid: number, schema = "public", columns = 3): DiagramTable => ({
  oid,
  schema,
  name: `t${oid}`,
  comment: null,
  columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, dataType: "integer", notNull: false, primaryKey: i === 0, comment: null })),
});
const fk = (oid: number, childOid: number, parentOid: number, childColumns = ["c1"], parentColumns = ["c0"]): DiagramForeignKey => ({
  oid,
  name: `fk${oid}`,
  childOid,
  parentOid,
  childColumns,
  parentColumns,
  childPartition: null,
  parentPartition: null,
  matchType: "s",
  onUpdate: "a",
  onDelete: "a",
  childRequiresParent: false,
  uniqueVia: null,
  validated: true,
  enforced: true,
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
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles.map((h) => h.side)).toEqual(["right", "self"]);
  });

  it("gives a self-reference's loop some height when both ends share a row", () => {
    const own = { tables: [table(1)], foreignKeys: [fk(1, 1, 1, ["c1"], ["c1"])] };
    const [out, back] = toNodes(own, layoutOf(own), boxes(own))[0].data.handles;
    expect(back.top - out.top).toBe(rowHeight(DEFAULT_OPTIONS));

    const capped = { tables: [table(1, "public", MAX_ROWS + 1)], foreignKeys: [fk(1, 1, 1, ["c9"], ["c0"])] };
    const [top, bottom] = toNodes(capped, layoutOf(capped), boxes(capped))[0].data.handles;
    expect(bottom.top).toBeGreaterThan(top.top);
  });

  it("keeps a self-reference's way in apart from a line arriving at that column", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 1), fk(2, 2, 1)] };
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles.map((h) => h.id)).toEqual(["right:c1", "self:c1:c0", "left:c0"]);
  });

  it("puts a capped table's handles on its header", () => {
    const s = { tables: [table(1, "public", MAX_ROWS + 1), table(2)], foreignKeys: [fk(1, 1, 2, ["c30"])] };
    expect(toNodes(s, layoutOf(s), boxes(s))[0].data.handles[0].top).toBe(headerHeight(DEFAULT_OPTIONS) / 2);
  });
});

it("names foreign key rules", () => {
  expect([foreignKeyRule("c"), foreignKeyRule("n"), foreignKeyRule("?")]).toEqual(["Cascade", "Set null", "?"]);
  expect([matchLabel("s"), matchLabel("f")]).toEqual(["Simple", "Full"]);
});

describe("reshapeNodes", () => {
  const s = { tables: [table(1), table(2)], foreignKeys: [fk(1, 1, 2)] };

  it("keeps places and selection, and moves handles for the new sizes", () => {
    const nodes = toNodes(s, layoutOf(s), boxes(s));
    const moved = [{ ...nodes[0], position: { x: 77, y: 5 }, selected: true }, nodes[1]];
    const large = { ...DEFAULT_OPTIONS, fontSize: 16 };
    const next = reshapeNodes(moved, s, new Map([[1, { width: 200, height: 90 }], [2, { width: 200, height: 90 }]]), large);
    expect(next[0]).toMatchObject({ position: { x: 77, y: 5 }, selected: true, width: 200 });
    expect(next[1].selected).toBeUndefined();
    expect(next[0].data.options.fontSize).toBe(16);
    expect(next[0].data.handles[0].top).not.toBe(nodes[0].data.handles[0].top);
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

describe("toEdges' marks", () => {
  it("derives each end and the line from the foreign key", () => {
    const s = { tables: [table(1), table(2)], foreignKeys: [{ ...fk(1, 1, 2), childRequiresParent: true, uniqueVia: "uq", validated: false }] };
    expect(toEdges(s, layoutOf(s))[0].data).toMatchObject({ name: "fk1", parentEnd: "one", childEnd: "zero-or-one", kind: "unchecked" });
  });

  it("gives a self-reference no route, and takes it back in on its own handle", () => {
    const s = { tables: [table(1)], foreignKeys: [fk(1, 1, 1)] };
    const [edge] = toEdges(s, layoutOf(s));
    expect(edge.data?.points).toBeUndefined();
    expect(edge.targetHandle).toBe("self:c1:c0");
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

describe("arrangements", () => {
  const s = { tables: [table(1), table(2), table(3)], foreignKeys: [fk(1, 1, 2), fk(2, 2, 3), fk(3, 3, 1)] };
  const sized = boxes(s);
  const nodes = toNodes(s, layoutOf(s), sized);
  const edges = toEdges(s, layoutOf(s));

  it("puts back what was captured", () => {
    const saved = currentArrangement(nodes, edges);
    const moved = { nodes: nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })), edges: dropRoutes(edges, new Set(["1"])) };
    const back = applyArrangement(moved.nodes, moved.edges, saved);
    expect(back.nodes.map((n) => n.position)).toEqual(nodes.map((n) => n.position));
    expect(back.edges[0].data?.points).toEqual([{ x: 5, y: 5 }]);
  });

  it("changes only what's listed, keeping selection", () => {
    const selected = nodes.map((n) => ({ ...n, selected: true }));
    const { nodes: next, edges: lines } = applyArrangement(selected, edges, { positions: new Map([["1", { x: 9, y: 9 }]]), routes: new Map([["1", undefined]]) });
    expect(next[0]).toMatchObject({ position: { x: 9, y: 9 }, selected: true });
    expect(next[1].position).toEqual(nodes[1].position);
    expect(lines[0].data?.points).toBeUndefined();
    expect(lines[0].data?.name).toBe("fk1");
  });

  it("moves a selection's layout to its corner, routes included, and lets lines leaving it fall back", () => {
    const layout = { positions: new Map([[1, { x: 0, y: 0 }], [2, { x: 500, y: 0 }]]), routes: new Map([[1, [{ x: 250, y: 0 }]]]), hubEdges: new Set<number>() };
    const placed = selectionArrangement(layout, nodes, edges, new Set(["1", "2"]), sized);
    expect(placed.positions.get("1")).toEqual({ x: 10, y: 0 });
    expect(placed.positions.get("2")).toEqual({ x: 510, y: 0 });
    expect(placed.routes.get("1")).toEqual([{ x: 260, y: 0 }]);
    expect(placed.routes.has("2")).toBe(true);
    expect(placed.routes.get("2")).toBeUndefined();
  });

  it("gives no route to a line the whole diagram treats as a hub's", () => {
    const hubbed = toEdges(s, layoutOf(s, [1]));
    const layout = { positions: new Map([[1, { x: 0, y: 0 }], [2, { x: 500, y: 0 }]]), routes: new Map([[1, [{ x: 250, y: 0 }]]]), hubEdges: new Set<number>() };
    expect(selectionArrangement(layout, nodes, hubbed, new Set(["1", "2"]), sized).routes.get("1")).toBeUndefined();
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
