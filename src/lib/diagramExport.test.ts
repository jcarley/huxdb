import { getSmoothStepPath, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { buildScene, hasHubLines, sceneSvg } from "./diagramExport";
import type { ExportChoices, ExportInput } from "./diagramExport";
import { drawLine, markerDefs } from "./diagramExportLines";
import { LIGHT_THEME } from "./diagramExportTheme";
import type { DiagramEdge, TableNode } from "./diagramFlow";
import { toEdges, toNodes } from "./diagramFlow";
import { DEFAULT_OPTIONS, tableBox } from "./diagramLayout";
import type { Layout } from "./diagramLayout";
import { STUB } from "./diagramLines";
import type { DiagramAnnotation, DiagramColumn, DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

const measure = (t: string, _b: boolean, s: number) => t.length * s * 0.6;
const options = DEFAULT_OPTIONS;
const choices: ExportChoices = { blackAndWhite: false, hubLines: true };

const column = (name: string, over: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, dataType: "integer", notNull: false, primaryKey: false, comment: null, ...over });
const table = (oid: number, name: string, over: Partial<DiagramTable> = {}): DiagramTable => ({ oid, schema: "public", name, comment: null, columns: [column("id", { primaryKey: true }), column("parent_id")], ...over });
const fk = (over: Partial<DiagramForeignKey> = {}): DiagramForeignKey => ({
  oid: 100,
  name: "orders_customer_id_fkey",
  childOid: 2,
  parentOid: 1,
  childColumns: ["parent_id"],
  parentColumns: ["id"],
  childPartition: null,
  parentPartition: null,
  matchType: "s",
  onUpdate: "a",
  onDelete: "a",
  childRequiresParent: false,
  uniqueVia: null,
  validated: true,
  enforced: true,
  ...over,
});

interface Setup {
  tables?: DiagramTable[];
  foreignKeys?: DiagramForeignKey[];
  dependencies?: DiagramStructure["dependencies"];
  at?: Record<number, { x: number; y: number }>;
  routes?: Record<string, { x: number; y: number }[]>;
  hubs?: string[];
  options?: typeof options;
}

function build({ tables = [table(1, "customers"), table(2, "orders"), table(3, "v", { kind: "view" })], foreignKeys = [fk()], dependencies = [{ dependentOid: 3, sourceOid: 1 }], at = {}, routes = {}, hubs = [], options: o = options }: Setup = {}) {
  const structure: DiagramStructure = { tables, foreignKeys, dependencies };
  const layout: Layout = {
    positions: new Map(tables.map((t, i) => [t.oid, at[t.oid] ?? { x: i * 400, y: 0 }])),
    routes: new Map(Object.entries(routes)),
    hubEdges: new Set(hubs),
  };
  const boxes = new Map(tables.map((t) => [t.oid, tableBox(t, measure, o)]));
  const nodes = toNodes(structure, layout, boxes, o);
  const edges = toEdges(structure, layout);
  const input: ExportInput = { nodes, edges, annotations: [], colors: { objects: {}, lines: {} }, options: o };
  return { nodes, edges, input };
}

const note = (over: Partial<DiagramAnnotation> = {}): DiagramAnnotation => ({ id: "a:1", kind: "note", x: 10, y: 20, width: 200, height: 100, text: "hello", fontSize: 12, bold: false, italic: false, color: null, z: 1, ...over });
const byId = (nodes: TableNode[]) => new Map(nodes.map((n) => [n.id, n]));
const svgOf = (input: ExportInput, c = choices) => sceneSvg(buildScene(input, c, measure)!);
/** A line's path: the only one carrying markers. */
const dOf = (svg: string) => [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="[^"]*" stroke-opacity="[^"]*" stroke-width="1"(?: stroke-dasharray="[^"]*")? marker-/g)].map((m) => m[1]);

describe("bounds", () => {
  it("crops to the content with a margin of 24", () => {
    const { input } = build({ tables: [table(1, "a")], foreignKeys: [], dependencies: [], at: { 1: { x: 500, y: 300 } } });
    const scene = buildScene(input, choices, measure)!;
    expect(scene.bounds.x).toBe(476);
    expect(scene.bounds.y).toBe(276);
    expect(sceneSvg(scene)).toContain(`viewBox="476 276 ${scene.bounds.width} ${scene.bounds.height}"`);
  });

  it("rounds outward to whole pixels", () => {
    const { input } = build({ tables: [table(1, "a")], foreignKeys: [], dependencies: [], at: { 1: { x: 500.4, y: 300.6 } } });
    const { bounds } = buildScene(input, choices, measure)!;
    for (const v of Object.values(bounds)) expect(Number.isInteger(v)).toBe(true);
    expect(bounds.x).toBe(476);
    expect(bounds.y).toBe(276);
    const t = input.nodes[0] as TableNode;
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(500.4 + t.width! + 24);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(300.6 + t.height! + 24);
  });

  it("counts a line's route and a line's name in the crop", () => {
    const base = build({ foreignKeys: [fk()], dependencies: [] });
    const plain = buildScene(base.input, choices, measure)!.bounds;
    const routed = build({ foreignKeys: [fk()], dependencies: [], routes: { "100": [{ x: 700, y: -500 }, { x: 700, y: 900 }] } });
    const wide = buildScene(routed.input, choices, measure)!.bounds;
    expect(wide.y).toBeLessThan(plain.y);
    expect(wide.y + wide.height).toBeGreaterThan(plain.y + plain.height);

    const off = build({ options: { ...options, showRelationshipNames: false }, tables: [table(1, "a"), table(2, "b")], dependencies: [], at: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 0 } }, foreignKeys: [fk({ childOid: 1, parentOid: 1, childColumns: ["parent_id"], parentColumns: ["id"], name: "x".repeat(28) })] });
    const loopOnly = buildScene(off.input, { ...choices }, measure)!.bounds;
    const named = buildScene({ ...off.input, options: { ...options, showRelationshipNames: true } }, choices, measure)!.bounds;
    expect(named.width).toBeGreaterThan(loopOnly.width);
  });

  it("returns null with nothing to draw", () => {
    expect(buildScene({ nodes: [], edges: [], annotations: [], colors: { objects: {}, lines: {} }, options }, choices, measure)).toBeNull();
    expect(buildScene({ nodes: [], edges: [], annotations: [note({ text: " " })], colors: { objects: {}, lines: {} }, options }, choices, measure)).toBeNull();
  });
});

describe("order", () => {
  it("draws annotations below 0, then lines, then objects, then annotations above", () => {
    const { input } = build();
    const svg = svgOf({ ...input, annotations: [note({ id: "a:1", text: "TOP", z: 5 }), note({ id: "a:2", text: "UNDER", z: -1 }), note({ id: "a:3", text: "MID", z: 0 })] });
    const at = (s: string) => svg.indexOf(s);
    const line = at("marker-start");
    expect(at("UNDER")).toBeLessThan(line);
    expect(line).toBeLessThan(at(">customers<"));
    expect(at(">customers<")).toBeLessThan(at("MID"));
    expect(at("MID")).toBeLessThan(at("TOP"));
  });

  it("leaves out a blank annotation", () => {
    const { input } = build();
    const svg = svgOf({ ...input, annotations: [note({ text: "  \n" })] });
    expect(svg).not.toContain("<rect x=\"10.5\"");
  });

  it("puts continuations below the content, inside bounds", () => {
    const wide = table(1, "wide", { columns: Array.from({ length: 100 }, (_, i) => column(`c${i}`)) });
    const { input } = build({ tables: [wide], foreignKeys: [], dependencies: [] });
    const scene = buildScene(input, choices, measure)!;
    const [first, ...rest] = scene.items;
    expect(rest.length).toBe(2);
    for (const c of rest) {
      expect(c.box.y).toBeGreaterThanOrEqual(first.box.y + first.box.height + 40);
      expect(c.box.y + c.box.height).toBeLessThanOrEqual(scene.bounds.y + scene.bounds.height);
    }
    expect(scene.items.map((i) => i.svg).join("")).toContain("wide (continued, 41–80 of 100)");
  });
});

describe("drawLine", () => {
  it("draws a line along its route, from handle to handle", () => {
    const { nodes, edges } = build({ foreignKeys: [fk()], dependencies: [], routes: { "100": [{ x: 700, y: 50 }] } });
    const child = nodes[1];
    const parent = nodes[0];
    const line = drawLine({ edge: edges[0], color: null }, byId(nodes), options, LIGHT_THEME, measure)!;
    const top = child.data.handles.find((h) => h.id === "right:parent_id")!.top;
    const parentTop = parent.data.handles.find((h) => h.id === "left:id")!.top;
    expect(dOf(line.svg)[0]).toBe(`M${child.position.x + child.width!} ${child.position.y + top} L700 50 L${parent.position.x} ${parent.position.y + parentTop}`);
  });

  it("draws the plain path for a line with no route", () => {
    const { nodes, edges } = build({ foreignKeys: [fk()], dependencies: [] });
    const child = nodes[1];
    const parent = nodes[0];
    const sy = child.position.y + child.data.handles.find((h) => h.id === "right:parent_id")!.top;
    const ty = parent.position.y + parent.data.handles.find((h) => h.id === "left:id")!.top;
    const expected = getSmoothStepPath({ sourceX: child.position.x + child.width!, sourceY: sy, targetX: parent.position.x, targetY: ty, sourcePosition: Position.Right, targetPosition: Position.Left, borderRadius: 0, offset: STUB })[0];
    const line = drawLine({ edge: edges[0], color: null }, byId(nodes), options, LIGHT_THEME, measure)!;
    expect(dOf(line.svg)[0]).toBe(expected);
  });

  it("draws a self-reference as the canvas's loop", () => {
    const { nodes, edges } = build({ tables: [table(1, "t")], dependencies: [], foreignKeys: [fk({ childOid: 1, parentOid: 1 })] });
    const t = nodes[0];
    const line = drawLine({ edge: edges[0], color: null }, byId(nodes), options, LIGHT_THEME, measure)!;
    const x = t.position.x + t.width!;
    const d = dOf(line.svg)[0];
    expect(d.startsWith(`M${x} `)).toBe(true);
    expect(d.split("L")).toHaveLength(4);
    expect(d.split("L")[3].startsWith(`${x} `)).toBe(true);
  });

  it("uses each line kind's dashes and marks", () => {
    const kinds = [
      [fk({ validated: false }), "6 4"],
      [fk({ childPartition: "p" }), "1.5 3"],
    ] as const;
    for (const [key, dashes] of kinds) {
      const { nodes, edges } = build({ foreignKeys: [key], dependencies: [] });
      const line = drawLine({ edge: edges[0], color: null }, byId(nodes), options, LIGHT_THEME, measure)!;
      expect(line.svg).toContain(`stroke-dasharray="${dashes}"`);
    }
    const plain = build({ foreignKeys: [fk({ childRequiresParent: true, uniqueVia: "u" })], dependencies: [] });
    const p = drawLine({ edge: plain.edges[0], color: null }, byId(plain.nodes), options, LIGHT_THEME, measure)!;
    expect(p.svg).not.toContain("stroke-dasharray");
    expect(p.marks).toEqual(["m-child-zero-or-one-plain", "m-parent-one-plain"]);
    const dep = build({ foreignKeys: [] });
    const d = drawLine({ edge: dep.edges[0], color: null }, byId(dep.nodes), options, LIGHT_THEME, measure)!;
    expect(d.svg).toContain('stroke-dasharray="8 5"');
    expect(d.svg).not.toContain("marker-start");
    expect(d.marks).toEqual(["m-reads-plain"]);
  });

  it("names a line only with the option on, in shortName", () => {
    const long = "a_very_long_constraint_name_that_is_cut_short";
    const { nodes, edges } = build({ foreignKeys: [fk({ name: long })], dependencies: [] });
    const off = drawLine({ edge: edges[0], color: null }, byId(nodes), { ...options, showRelationshipNames: false }, LIGHT_THEME, measure)!;
    expect(off.svg).not.toContain("<text");
    const on = drawLine({ edge: edges[0], color: null }, byId(nodes), { ...options, showRelationshipNames: true }, LIGHT_THEME, measure)!;
    expect(on.svg).toContain(`>${long.slice(0, 27)}…</text>`);
    expect(on.svg).not.toContain(long);
  });

  it("colours a line and its markers", () => {
    const { nodes, edges } = build({ foreignKeys: [fk()], dependencies: [] });
    const line = drawLine({ edge: edges[0], color: "error" }, byId(nodes), options, LIGHT_THEME, measure)!;
    expect(line.svg).toContain(`stroke="${LIGHT_THEME.colors.error.solid}"`);
    expect(line.marks.every((m) => m.endsWith("-error"))).toBe(true);
    expect(markerDefs(line.marks, LIGHT_THEME)).toContain(`stroke="${LIGHT_THEME.colors.error.solid}"`);
  });

  it("takes a dependency's colour from nowhere", () => {
    const { nodes, edges } = build({ foreignKeys: [] });
    const line = drawLine({ edge: edges[0], color: "error" }, byId(nodes), options, LIGHT_THEME, measure)!;
    expect(line.marks).toEqual(["m-reads-plain"]);
  });

  it("writes only the markers used", () => {
    const defs = markerDefs(["m-reads-plain", "m-reads-plain", "m-parent-one-hub"], LIGHT_THEME);
    expect(defs.match(/<marker /g)).toHaveLength(2);
    expect(defs).toContain('markerUnits="userSpaceOnUse"');
    expect(defs).not.toContain("style=");
  });
});

describe("scene", () => {
  it("includes hub lines when chosen, whatever edge.hidden says", () => {
    const { input, edges } = build({ hubs: ["100"], dependencies: [] });
    expect(edges[0].hidden).toBe(true);
    expect(hasHubLines(edges)).toBe(true);
    const scene = buildScene(input, { ...choices, hubLines: true }, measure)!;
    expect(scene.items.some((i) => i.marks.length > 0)).toBe(true);
    expect(dOf(sceneSvg(scene))).toHaveLength(1);
  });

  it("leaves hub lines out when not chosen", () => {
    const { input } = build({ hubs: ["100"], dependencies: [] });
    const scene = buildScene(input, { ...choices, hubLines: false }, measure)!;
    expect(scene.items.some((i) => i.marks.length > 0)).toBe(false);
    expect(hasHubLines(build({ dependencies: [] }).edges)).toBe(false);
  });

  it("ignores selection and hover", () => {
    const { input } = build();
    const picked = { ...input, nodes: input.nodes.map((n) => ({ ...n, selected: true })), edges: input.edges.map((e) => ({ ...e, selected: true })) };
    expect(svgOf(picked)).toBe(svgOf(input));
  });

  it("gives a document with no var(, foreignObject, overflow or ellipsis", () => {
    const { input } = build();
    const svg = svgOf({ ...input, options: { ...options, showRelationshipNames: true }, annotations: [note()] });
    for (const bad of ["var(", "foreignObject", "overflow", "…"]) expect(svg).not.toContain(bad);
  });

  it("draws only items meeting a view", () => {
    const { input } = build({ tables: [table(1, "near"), table(2, "far"), table(3, "far2")], foreignKeys: [fk({ childOid: 3, parentOid: 2 })], dependencies: [], at: { 1: { x: 0, y: 0 }, 2: { x: 5000, y: 0 }, 3: { x: 5600, y: 0 } } });
    const scene = buildScene(input, choices, measure)!;
    const t = input.nodes[0] as TableNode;
    // The line joins the two far tables, so it's out too, and so are its markers.
    const svg = sceneSvg(scene, { x: 0, y: 0, width: t.width!, height: t.height! });
    expect(svg).toContain(">near<");
    expect(svg).not.toContain(">far<");
    expect(svg).not.toContain(">far2<");
    expect(svg).not.toContain("<marker");
    expect(svg).toContain('viewBox="0 0 ');
    const whole = sceneSvg(scene);
    expect(whole).toContain("<marker");
  });

  describe("text that runs past its table", () => {
    const longRow = (name: string) => table(1, name, { columns: [column("id", { comment: "m".repeat(200) })] });
    const withComments = { ...options, showFieldComments: true };
    const setup = () => {
      // A left table whose comment reaches over its right neighbour, which sits 300 px on.
      const { input } = build({ tables: [longRow("left"), table(2, "right")], foreignKeys: [], dependencies: [], at: { 1: { x: 0, y: 0 }, 2: { x: 300, y: 0 } }, options: withComments });
      return { ...input, annotations: [note({ z: 0, x: 0, y: 400 })] };
    };

    it("puts the overflow after every object and before annotations above", () => {
      const scene = buildScene(setup(), choices, measure)!;
      const svg = sceneSvg(scene);
      const text = svg.indexOf("mmmm");
      expect(text).toBeGreaterThan(svg.indexOf(">right<"));
      expect(text).toBeLessThan(svg.indexOf(">hello<"));
    });

    it("counts the text in the bounds, to its last glyph", () => {
      const input = setup();
      const scene = buildScene(input, choices, measure)!;
      const item = scene.items.find((i) => i.svg.includes("mmmm"))!;
      expect(scene.bounds.x + scene.bounds.width).toBeGreaterThanOrEqual(item.box.x + item.box.width);
      const tables = input.nodes.filter((n) => n.type === "table") as TableNode[];
      expect(item.box.x + item.box.width).toBeGreaterThan(Math.max(...tables.map((t) => t.position.x + t.width!)));
    });

    it("includes it in a tile the table's own box doesn't reach", () => {
      const scene = buildScene(setup(), choices, measure)!;
      const item = scene.items.find((i) => i.svg.includes("mmmm"))!;
      const left = (scene.items.find((i) => i.svg.includes(">left<")))!;
      const view = { x: left.box.x + left.box.width + 1, y: 0, width: item.box.x + item.box.width - (left.box.x + left.box.width) + 50, height: 100 };
      expect(view.x).toBeGreaterThan(left.box.x + left.box.width);
      const svg = sceneSvg(scene, view);
      expect(svg).toContain("mmmm");
      expect(svg).not.toContain(">left<");
    });
  });

  it("has a background and the font", () => {
    const svg = svgOf(build().input);
    expect(svg).toContain('font-family="Inter, sans-serif"');
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(svg).toMatch(/<defs>.*<\/defs><rect [^>]*fill="#ffffff"\/>/);
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf(">customers<"));
  });

  it("defines the icons its items use", () => {
    const svg = svgOf(build().input);
    expect(svg).toContain('<g id="i-key">');
    expect(svg).toContain('<g id="i-eye">');
    expect(svg).not.toContain('<g id="i-layers">');
  });

  it("matches the snapshot of a small diagram", () => {
    const { input } = build();
    expect(sceneSvg(buildScene({ ...input, annotations: [note()] }, choices, measure)!)).toMatchSnapshot();
  });
});

describe("types", () => {
  it("keeps the edge types", () => {
    const e: DiagramEdge[] = build().edges;
    expect(e).toHaveLength(2);
  });
});
