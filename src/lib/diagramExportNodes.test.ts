import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Eye, Info, KeyRound, Layers, Link2, SquareFunction, Workflow } from "lucide-react";
import { describe, expect, it } from "vitest";
import { BLACK_AND_WHITE_THEME, ICONS, LIGHT_THEME, xml } from "./diagramExportTheme";
import { BASELINE, drawAnnotation, drawContinuations, drawTable } from "./diagramExportNodes";
import type { Rect } from "./diagramExportNodes";
import { tableKey } from "./diagramDrift";
import type { TableNode } from "./diagramFlow";
import { DEFAULT_OPTIONS, rowSuffix, tableBox } from "./diagramLayout";
import { annotationLines, lineHeight, NOTE_PADDING } from "./diagramAnnotations";
import type { DiagramAnnotation, DiagramColumn, DiagramObjectKind, DiagramTable } from "./types";

const measure = (t: string, _b: boolean, s: number) => t.length * s * 0.6;
const options = DEFAULT_OPTIONS;

const column = (name: string, over: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, dataType: "integer", notNull: false, primaryKey: false, comment: null, ...over });

function node(over: Partial<DiagramTable> = {}, x = 0, y = 0, fks: string[] = []): TableNode {
  const table: DiagramTable = { oid: 1, schema: "public", name: "orders", comment: null, columns: [column("id", { primaryKey: true }), column("name")], ...over };
  const box = tableBox(table, measure, options);
  return { id: String(table.oid), type: "table", position: { x, y }, ...box, data: { table, handles: [], foreignKeyColumns: new Set(fks), options } };
}

const many = (n: number, over: Partial<DiagramTable> = {}) => node({ columns: Array.from({ length: n }, (_, i) => column(`c${i + 1}`)), ...over });

/** Row texts: a `<text>` holding a name, then a tspan with the type. */
const rowTexts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<tspan[^>]*>([^<]*)<\/tspan><\/text>/g)].map((m) => [m[1], m[2]]);
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)(?:<tspan[^>]*>([^<]*)<\/tspan>)?<\/text>/g)].map((m) => m[1] + (m[2] ?? ""));
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const note = (over: Partial<DiagramAnnotation> = {}): DiagramAnnotation => ({ id: "a:1", kind: "note", x: 10, y: 20, width: 200, height: 100, text: "hello", fontSize: 12, bold: false, italic: false, color: null, z: 1, ...over });

describe("xml", () => {
  it("escapes a hostile name", () => {
    const { svg } = drawTable(node({ name: `<x>&"` }), options, null, LIGHT_THEME, measure);
    expect(svg).toContain("&lt;x&gt;&amp;&quot;");
    expect(svg).not.toContain("<x>");
  });

  it("removes characters XML can't hold", () => {
    expect(xml("a\u0000b\u000bc￿d\ud800e\tf\ng")).toBe("abcde\tf\ng");
    expect(xml("😀")).toBe("😀");
  });
});

describe("drawTable", () => {
  it("draws every row of an ordinary table", () => {
    const { svg } = drawTable(many(5), options, null, LIGHT_THEME, measure);
    expect(rowTexts(svg)).toEqual([1, 2, 3, 4, 5].map((i) => [`c${i}`, ": integer"]));
  });

  it("draws no more than 40 rows in the box of a capped table", () => {
    const n = many(120);
    const { svg, box } = drawTable(n, options, null, LIGHT_THEME, measure);
    expect(rowTexts(svg)).toHaveLength(40);
    expect(box).toEqual({ x: 0, y: 0, width: n.width, height: n.height });
    expect(texts(svg)).toContain("120 columns");
  });

  it("marks primary and foreign key rows", () => {
    const n = node({ columns: [column("id", { primaryKey: true }), column("owner_id"), column("plain")] }, 0, 0, ["owner_id"]);
    const { svg } = drawTable(n, options, null, LIGHT_THEME, measure);
    expect(svg.match(/#i-key"/g)).toHaveLength(1);
    expect(svg.match(/#i-link"/g)).toHaveLength(1);
    expect(svg).toContain(`stroke="${LIGHT_THEME.key}"`);
  });

  it("draws a coloured object's outline at full strength, as the canvas does", () => {
    expect(drawTable(node(), options, null, LIGHT_THEME, measure).svg).toContain('stroke-opacity="0.6"');
    const { svg } = drawTable(node(), options, "success", LIGHT_THEME, measure);
    expect(svg).toContain(`stroke="${LIGHT_THEME.colors.success.solid}"`);
    expect(svg).not.toContain('stroke-opacity="0.6"');
  });

  it("draws each kind's outline and header", () => {
    const draw = (kind: DiagramObjectKind) => drawTable(node({ kind }), options, null, LIGHT_THEME, measure).svg;
    const table = draw("table");
    expect(table).toContain(`fill="${LIGHT_THEME.primary.solid}"`);
    expect(table).not.toContain("stroke-dasharray");
    const view = draw("view");
    expect(view).toContain("stroke-dasharray");
    expect(view).toContain(LIGHT_THEME.primary.tint);
    expect(view).toContain("#i-eye");
    const mv = draw("materialized-view");
    expect(mv).toContain('stroke-width="2"');
    expect(mv).toContain("#i-layers");
    const fn = draw("function");
    expect(fn).toContain(LIGHT_THEME.secondary.tint);
    expect(fn).toContain("#i-info");
    expect(fn).toContain("#i-function");
    expect(draw("procedure")).toContain("#i-workflow");
  });

  it("colours a table's header solid and another object's as a tint", () => {
    const t = drawTable(node(), options, "success", LIGHT_THEME, measure).svg;
    expect(t).toContain(`fill="${LIGHT_THEME.colors.success.solid}"`);
    expect(t).toContain(`fill="${LIGHT_THEME.colors.success.content}"`);
    const v = drawTable(node({ kind: "view" }), options, "success", LIGHT_THEME, measure).svg;
    expect(v).toContain(`fill="${LIGHT_THEME.colors.success.tint}"`);
    expect(v).toContain(`stroke="${LIGHT_THEME.colors.success.solid}"`);
  });

  it("uses the fixed theme, never a CSS variable", () => {
    const all = [
      drawTable(node({ kind: "view" }), options, "info", LIGHT_THEME, measure).svg,
      drawTable(many(50), options, "error", BLACK_AND_WHITE_THEME, measure).svg,
      drawAnnotation(note({ color: "warning" }), LIGHT_THEME, measure).svg,
      ...drawContinuations([many(50)], {}, options, LIGHT_THEME, measure, { x: 0, y: 0 }, 800).map((d) => d.svg),
    ].join("");
    expect(all).not.toContain("var(");
    expect(all).not.toContain("color-mix");
  });

  it("shrinks a long title to its box and draws it whole", () => {
    const name = "a_very_long_table_name_".repeat(6);
    const n = node({ name });
    const { svg } = drawTable(n, options, null, LIGHT_THEME, measure);
    const m = svg.match(/<text[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)!.find((t) => t.includes(name))!;
    const size = Number(m.match(/font-size="([\d.]+)"/)![1]);
    expect(size).toBeLessThan(options.fontSize);
    expect(m).toContain(name);
    expect(measure(name, true, size)).toBeLessThanOrEqual(n.width!);
  });

  const opts = { ...options, showFieldComments: true, showObjectComments: true };
  const rightOf = (d: { box: Rect }) => d.box.x + d.box.width;

  it("shrinks a long row to 60% and no further, then moves it to an overflow item holding all its text", () => {
    const comment = "x".repeat(400);
    const n = node({ columns: [column("id", { comment })] }, 0, 0);
    const drawn = drawTable(n, opts, null, LIGHT_THEME, measure);
    expect(drawn.svg).not.toContain(comment);
    expect(drawn.overflow).toHaveLength(1);
    const [o] = drawn.overflow;
    expect(o.svg).toContain(comment);
    expect(o.svg).not.toContain("…");
    expect(Number(o.svg.match(/font-size="([\d.]+)"/)![1])).toBeCloseTo(options.fontSize * 0.6, 5);
    expect(o.svg).toContain(`stroke="${LIGHT_THEME.background}" stroke-width="3" paint-order="stroke"`);
    // The box reaches the text's end, and sits on its row.
    const tail = `: integer${rowSuffix(column("id", { comment }), opts)}`;
    expect(rightOf(o)).toBeCloseTo(o.box.x + measure("id" + tail, false, options.fontSize * 0.6), 5);
    expect(rightOf(o)).toBeGreaterThan(rightOf(drawn));
  });

  it("moves a long object comment to an overflow item with a halo, and keeps short text in the table", () => {
    const long = drawTable(node({ comment: "c".repeat(300) }), opts, null, LIGHT_THEME, measure);
    expect(long.overflow).toHaveLength(1);
    expect(long.overflow[0].svg).toContain("skewX(-12)");
    expect(long.overflow[0].svg).toContain('paint-order="stroke"');
    expect(long.svg).not.toContain("ccc");
    expect(rightOf(long.overflow[0])).toBeGreaterThan(rightOf(long));
    const short = drawTable(node({ comment: "about" }), opts, null, LIGHT_THEME, measure);
    expect(short.overflow).toEqual([]);
    expect(short.svg).toContain("about");
    expect(short.svg).not.toContain("paint-order");
  });

  it("gives a continuation box's overflow too", () => {
    const t = many(50);
    t.data.table.columns[45] = column("wide", { comment: "w".repeat(300) });
    const [b] = drawContinuations([t], {}, opts, LIGHT_THEME, measure, { x: 0, y: 0 }, 800);
    expect(b.overflow).toHaveLength(1);
    expect(b.overflow[0].svg).toContain("wwww");
    expect(rightOf(b.overflow[0])).toBeGreaterThan(rightOf(b));
  });

  it("keeps rows at full size when they fit", () => {
    const { svg } = drawTable(many(2), options, null, LIGHT_THEME, measure);
    expect(svg.match(/<text[^>]*font-size="([\d.]+)"/)![1]).toBe(String(options.fontSize));
  });

  it("draws the object comment skewed, and puts rows at the baseline", () => {
    const n = node({ comment: "about" });
    const { svg } = drawTable(n, { ...options, showObjectComments: true }, null, LIGHT_THEME, measure);
    expect(svg).toContain("skewX(-12)");
    expect(svg).toContain("about");
    const first = rowTexts(drawTable(many(1), options, null, LIGHT_THEME, measure).svg);
    expect(first).toHaveLength(1);
    expect(BASELINE).toBe(0.364);
  });
});

describe("drawContinuations", () => {
  it("shows every column of 120 across the continuations", () => {
    const boxes = drawContinuations([many(120)], {}, options, LIGHT_THEME, measure, { x: 5, y: 7 }, 5000);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].box.x).toBe(5);
    expect(boxes[0].box.y).toBe(7);
    const heads = boxes.map((b) => texts(b.svg).find((t) => t.includes("continued")));
    expect(heads).toEqual(["orders (continued, 41–80 of 120)", "orders (continued, 81–120 of 120)"]);
    const names = boxes.flatMap((b) => rowTexts(b.svg).map((r) => r[0]));
    expect(names).toEqual(Array.from({ length: 80 }, (_, i) => `c${i + 41}`));
  });

  it("makes no box for a table that isn't capped", () => {
    expect(drawContinuations([many(40)], {}, options, LIGHT_THEME, measure, { x: 0, y: 0 }, 500)).toEqual([]);
  });

  it("places continuations without overlap and wraps at wrapWidth", () => {
    const tables = [many(120, { oid: 1, name: "a" }), many(95, { oid: 2, name: "b" }), many(130, { oid: 3, name: "c" })];
    const corner = { x: 100, y: 200 };
    const boxes = drawContinuations(tables, {}, options, LIGHT_THEME, measure, corner, 500);
    expect(boxes.length).toBe(2 + 2 + 3);
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].box.x).toBeGreaterThanOrEqual(corner.x);
      expect(boxes[i].box.y).toBeGreaterThanOrEqual(corner.y);
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i].box, boxes[j].box)).toBe(false);
    }
    // Wrapped: more than one row of boxes, and a box past the first in a line stays inside wrapWidth.
    expect(new Set(boxes.map((b) => b.box.y)).size).toBeGreaterThan(1);
    for (const b of boxes) if (b.box.x > corner.x) expect(b.box.x + b.box.width).toBeLessThanOrEqual(corner.x + 500);
  });

  it("uses the table's colour", () => {
    const t = many(50);
    const [b] = drawContinuations([t], { [tableKey(t.data.table)]: "error" }, options, LIGHT_THEME, measure, { x: 0, y: 0 }, 500);
    expect(b.svg).toContain(LIGHT_THEME.colors.error.solid);
    expect(b.box.width).toBe(t.width);
  });
});

describe("drawAnnotation", () => {
  it("wraps a note as the canvas does", () => {
    const a = note({ text: "one two three four five six seven eight nine ten eleven twelve", width: 120 });
    const { svg } = drawAnnotation(a, LIGHT_THEME, measure);
    const lines = annotationLines(a, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(texts(svg)).toEqual(lines);
  });

  it("starts a note's text inside its 1 px border, and a label's at its corner", () => {
    const at = (svg: string) => svg.match(/<text x="([\d.]+)" y="([\d.]+)"/)!.slice(1).map(Number);
    const a = { text: "hi", fontSize: 12, x: 10, y: 20 };
    const mid = NOTE_PADDING + lineHeight(12) / 2;
    expect(at(drawAnnotation(note(a), LIGHT_THEME, measure).svg)[0]).toBeCloseTo(10 + 1 + NOTE_PADDING);
    expect(at(drawAnnotation(note(a), LIGHT_THEME, measure).svg)[1]).toBeCloseTo(20 + 1 + mid + BASELINE * 12, 1);
    expect(at(drawAnnotation(note({ ...a, kind: "label" }), LIGHT_THEME, measure).svg)[0]).toBeCloseTo(10 + NOTE_PADDING);
  });

  it("draws a label with no box and a note with one", () => {
    expect(drawAnnotation(note({ kind: "label", width: 0, height: 0 }), LIGHT_THEME, measure).svg).not.toContain("<rect");
    const n = drawAnnotation(note(), LIGHT_THEME, measure);
    expect(n.svg).toContain("<rect");
    expect(n.svg).toContain(LIGHT_THEME.noteFill);
    expect(n.box).toMatchObject({ x: 10, y: 20, width: 200 });
    expect(drawAnnotation(note({ color: "info" }), LIGHT_THEME, measure).svg).toContain(LIGHT_THEME.colors.info.tint);
  });

  it("skews italic text, without font-style", () => {
    const { svg } = drawAnnotation(note({ italic: true, bold: true }), LIGHT_THEME, measure);
    expect(svg).toContain("skewX(-12)");
    expect(svg).not.toContain("font-style");
    expect(svg).toContain('font-weight="600"');
  });

  it("keeps a note's leading spaces", () => {
    const { svg } = drawAnnotation(note({ text: "  indented" }), LIGHT_THEME, measure);
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain(">  indented<");
  });

  it("escapes its text", () => {
    expect(drawAnnotation(note({ text: "<b>&" }), LIGHT_THEME, measure).svg).toContain("&lt;b&gt;&amp;");
  });
});

describe("themes", () => {
  it("has the worked-out values", () => {
    expect(LIGHT_THEME.colors.warning).toEqual({ solid: "#fdc700", content: "#000000", tint: "#fff5d8" });
    expect(LIGHT_THEME.primary).toBe(LIGHT_THEME.colors.primary);
    expect(Object.values(BLACK_AND_WHITE_THEME.colors).every((s) => s.solid === "#1f2937" && s.tint === "#d3d4d7")).toBe(true);
    expect(BLACK_AND_WHITE_THEME.key).toBe("#1f2937");
  });
});

describe("ICONS", () => {
  it("has lucide's icon paths", () => {
    const lucide = { key: KeyRound, link: Link2, eye: Eye, layers: Layers, function: SquareFunction, workflow: Workflow, info: Info } as const;
    for (const [name, Icon] of Object.entries(lucide)) {
      const html = renderToStaticMarkup(createElement(Icon));
      const inner = html.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").replace(/><\/(path|circle|line|rect)>/g, "/>").replace(/ fill="currentColor"/g, "");
      expect(ICONS[name as keyof typeof ICONS], name).toBe(inner);
    }
  });
});
