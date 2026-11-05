import { describe, expect, it } from "vitest";
import { dependencyKey, foreignKeyKey, tableKey } from "./diagramDrift";
import { captureLayout, layoutSignature, restoreLayout } from "./diagramFile";
import { toEdges, toNodes } from "./diagramFlow";
import { DEFAULT_OPTIONS } from "./diagramLayout";
import type { Box, Layout } from "./diagramLayout";
import type { DiagramForeignKey, DiagramLayoutFile, DiagramStructure, DiagramTable } from "./types";

const table = (oid: number): DiagramTable => ({ oid, schema: "public", name: `t${oid}`, comment: null, columns: [{ name: "id", dataType: "integer", notNull: true, primaryKey: true, comment: null }, { name: "a", dataType: "integer", notNull: false, primaryKey: false, comment: null }] });
const fk = (oid: number, childOid: number, parentOid: number): DiagramForeignKey => ({ oid, name: `fk${oid}`, childOid, parentOid, childColumns: ["a"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true });
const boxesOf = (s: DiagramStructure) => new Map<number, Box>(s.tables.map((t) => [t.oid, { width: 100, height: 50 }]));
const empty: DiagramLayoutFile = { tables: {}, routes: {}, viewport: null };
const onScreen = (s: DiagramStructure, layout: Layout) => ({ nodes: toNodes(s, layout, boxesOf(s)), edges: toEdges(s, layout) });
const keyOf = (t: DiagramTable) => tableKey(t);

describe("layoutSignature", () => {
  const s: DiagramStructure = { tables: [table(1), table(2)], foreignKeys: [] };
  const layout: Layout = { positions: new Map([[1, { x: 0, y: 0 }], [2, { x: 10, y: 0 }]]), routes: new Map(), hubEdges: new Set() };
  const nodes = toNodes(s, layout, boxesOf(s));

  it("ignores the order of nodes", () => {
    expect(layoutSignature(nodes)).toBe(layoutSignature([...nodes].reverse()));
  });

  it("changes when a table moves, or the object set changes", () => {
    expect(layoutSignature(nodes)).not.toBe(layoutSignature([{ ...nodes[0], position: { x: 5, y: 0 } }, nodes[1]]));
    expect(layoutSignature(nodes)).not.toBe(layoutSignature([nodes[0]]));
  });
});

describe("options in the file", () => {
  const s: DiagramStructure = { tables: [table(1)], foreignKeys: [] };
  const layout: Layout = { positions: new Map([[1, { x: 0, y: 0 }]]), routes: new Map(), hubEdges: new Set() };
  const nodes = toNodes(s, layout, boxesOf(s));

  it("make a diagram differ, because they're saved with it", () => {
    expect(layoutSignature(nodes, { ...DEFAULT_OPTIONS, fontSize: 14 })).not.toBe(layoutSignature(nodes, DEFAULT_OPTIONS));
  });

  it("are written with the layout", () => {
    expect(captureLayout(s, nodes, [], null, null, DEFAULT_OPTIONS).options).toEqual(DEFAULT_OPTIONS);
  });
});

describe("captureLayout", () => {
  it("saves positions by name, and routes by constraint", () => {
    const s: DiagramStructure = { tables: [table(1), table(2)], foreignKeys: [fk(5, 1, 2)] };
    const layout: Layout = { positions: new Map([[1, { x: 7, y: 8 }], [2, { x: 300, y: 0 }]]), routes: new Map([["5", [{ x: 50, y: 50 }]]]), hubEdges: new Set() };
    const { nodes, edges } = onScreen(s, layout);
    const file = captureLayout(s, nodes, edges, null, { x: 1, y: 2, zoom: 0.5 });
    expect(file.tables[keyOf(table(1))]).toEqual({ x: 7, y: 8 });
    expect(file.routes[foreignKeyKey(fk(5, 1, 2), table(1))]).toEqual([{ x: 50, y: 50 }]);
    expect(file.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
  });

  it("keeps a removed table's place until the report is accepted", () => {
    const s: DiagramStructure = { tables: [table(1)], foreignKeys: [] };
    const previous = { ...empty, tables: { gone: { x: 9, y: 9 } } };
    expect(captureLayout(s, [], [], previous, null).tables.gone).toEqual({ x: 9, y: 9 });
  });
});

describe("restoreLayout", () => {
  const s: DiagramStructure = { tables: [table(1), table(2)], foreignKeys: [fk(5, 1, 2)] };
  const routed = (): DiagramLayoutFile => ({
    tables: { [keyOf(table(1))]: { x: 10, y: 20 }, [keyOf(table(2))]: { x: 300, y: 20 } },
    routes: { [foreignKeyKey(fk(5, 1, 2), table(1))]: [{ x: 200, y: 40 }] },
    viewport: null,
  });

  it("puts tables where they were saved, whatever their OIDs are now", () => {
    const recreated: DiagramStructure = { tables: [{ ...table(1), oid: 91 }, { ...table(2), oid: 92 }], foreignKeys: [{ ...fk(5, 1, 2), oid: 95, childOid: 91, parentOid: 92 }] };
    const layout = restoreLayout(routed(), recreated, boxesOf(recreated), new Set());
    expect(layout.positions.get(91)).toEqual({ x: 10, y: 20 });
    expect(layout.routes.get("95")).toEqual([{ x: 200, y: 40 }]);
  });

  it("drops a route to a table whose rows moved", () => {
    expect(restoreLayout(routed(), s, boxesOf(s), new Set([keyOf(table(2))])).routes.size).toBe(0);
  });

  it("places a new table below the rest without touching them", () => {
    const more: DiagramStructure = { tables: [table(1), table(2), table(3)], foreignKeys: [fk(5, 1, 2), fk(6, 3, 2)] };
    const layout = restoreLayout(routed(), more, boxesOf(more), new Set());
    expect(layout.positions.get(1)).toEqual({ x: 10, y: 20 });
    expect(layout.positions.get(3)!.y).toBeGreaterThan(20 + 50);
    expect(layout.routes.has("5")).toBe(true);
    expect(layout.routes.has("6")).toBe(false);
  });

  it("copes with every table being new", () => {
    expect(restoreLayout(empty, s, boxesOf(s), new Set()).positions.size).toBe(2);
    for (const p of restoreLayout(empty, s, boxesOf(s), new Set()).positions.values()) expect(Number.isFinite(p.x)).toBe(true);
  });

  it("works out hub lines from today's foreign keys", () => {
    const tables = Array.from({ length: 12 }, (_, i) => table(i + 1));
    const foreignKeys = Array.from({ length: 10 }, (_, i) => fk(100 + i, i + 2, 1));
    const hubby = { tables, foreignKeys };
    expect(restoreLayout(empty, hubby, boxesOf(hubby), new Set()).hubEdges.size).toBe(10);
  });
});

describe("dependencies in the file", () => {
  const s: DiagramStructure = { tables: [table(1), table(2)], foreignKeys: [], dependencies: [{ dependentOid: 1, sourceOid: 2 }] };
  const names = new Map(s.tables.map((t) => [t.oid, t]));

  it("saves a dependency's route under its key and restores it", () => {
    const layout: Layout = { positions: new Map([[1, { x: 0, y: 0 }], [2, { x: 300, y: 0 }]]), routes: new Map([["dep:1:2", [{ x: 150, y: 9 }]]]), hubEdges: new Set() };
    const { nodes, edges } = onScreen(s, layout);
    const file = captureLayout(s, nodes, edges, null, null);
    expect(file.routes[dependencyKey(s.dependencies![0], names)!]).toEqual([{ x: 150, y: 9 }]);
    const again = restoreLayout(file, { ...s, tables: [{ ...table(1), oid: 71 }, { ...table(2), oid: 72 }], dependencies: [{ dependentOid: 71, sourceOid: 72 }] }, boxesOf({ tables: [{ ...table(71) }, { ...table(72) }], foreignKeys: [] }), new Set());
    expect(again.routes.get("dep:71:72")).toEqual([{ x: 150, y: 9 }]);
  });

  it("keeps the place of a table replaced by a view", () => {
    const file: DiagramLayoutFile = { ...empty, tables: { [keyOf(table(1))]: { x: 40, y: 50 } } };
    const view: DiagramStructure = { tables: [{ ...table(9), name: "t1", kind: "view" }], foreignKeys: [] };
    expect(restoreLayout(file, view, boxesOf(view), new Set()).positions.get(9)).toEqual({ x: 40, y: 50 });
  });

  it("restores a file from before this phase, with no dependencies", () => {
    const old: DiagramStructure = { tables: [table(1), table(2)], foreignKeys: [] };
    expect(restoreLayout(empty, old, boxesOf(old), new Set()).routes.size).toBe(0);
  });
});
