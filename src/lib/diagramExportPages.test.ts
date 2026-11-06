import { describe, expect, it } from "vitest";
import type { Scene } from "./diagramExport";
import { sceneSvg } from "./diagramExport";
import type { Rect } from "./diagramExportNodes";
import { LIGHT_THEME } from "./diagramExportTheme";
import { MAX_PAGES_WIDE, PAGE_MARGIN_PT, PAPERS, PX_TO_PT, TILE_OVERLAP_PT, defaultOrientation, defaultPaper, exportSummary, fittedPage, pngCheck, tilePlan, tiledPages } from "./diagramExportPages";

const rect = (width: number, height: number, x = 0, y = 0): Rect => ({ x, y, width, height });
const scene = (bounds: Rect, items: Scene["items"] = []): Scene => ({ items, bounds, theme: LIGHT_THEME });
const item = (name: string, box: Rect) => ({ svg: `<text>${name}</text>`, box, marks: [] });
const union = (rs: Rect[]) => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, right: Math.max(...rs.map((r) => r.x + r.width)), bottom: Math.max(...rs.map((r) => r.y + r.height)) };
};

describe("fittedPage", () => {
  it("fits one page to the diagram at 0.75 pt per px", () => {
    const page = fittedPage(scene(rect(1000, 500)));
    expect([page.widthPt, page.heightPt, page.marginPt]).toEqual([750, 375, 0]);
    expect(page.svg).toContain('width="1000"');
  });
  it("scales a page past 14,400 pt to fit, keeping its shape", () => {
    const page = fittedPage(scene(rect(40000, 10000)));
    expect(page.widthPt).toBeCloseTo(14400);
    expect(page.heightPt).toBeCloseTo(3600);
  });
});

describe("tilePlan", () => {
  const a4 = { w: PAPERS.a4.width - 2 * PAGE_MARGIN_PT, h: PAPERS.a4.height - 2 * PAGE_MARGIN_PT };
  it("gives one page for one page wide, at no more than 100%", () => {
    const plan = tilePlan(rect(100, 100), "a4", "portrait", 1);
    expect([plan.across, plan.down, plan.scale]).toEqual([1, 1, PX_TO_PT]);
    expect(plan.views).toHaveLength(1);
  });
  it("widens across as asked", () => {
    const plan = tilePlan(rect(6000, 1000), "a4", "portrait", 3);
    expect(plan.across).toBe(3);
    expect(plan.scale).toBeCloseTo((3 * a4.w - 2 * TILE_OVERLAP_PT) / 6000);
  });
  it("takes pages down from the height", () => {
    const plan = tilePlan(rect(1000, 3000), "a4", "portrait", 1);
    const scaled = 3000 * plan.scale;
    expect(plan.down).toBe(Math.ceil((scaled - a4.h) / (a4.h - TILE_OVERLAP_PT)) + 1);
    expect(plan.down).toBeGreaterThan(1);
    expect(plan.views).toHaveLength(plan.across * plan.down);
  });
  it("covers the whole diagram, overlapping by 18 pt", () => {
    const bounds = rect(3000, 2500, 40, -60);
    const plan = tilePlan(bounds, "a4", "portrait", 3);
    const u = union(plan.views);
    expect(u.x).toBeLessThanOrEqual(bounds.x);
    expect(u.y).toBeLessThanOrEqual(bounds.y);
    expect(u.right).toBeGreaterThanOrEqual(bounds.x + bounds.width - 1e-6);
    expect(u.bottom).toBeGreaterThanOrEqual(bounds.y + bounds.height - 1e-6);
    const [first, second] = plan.views;
    expect(first.x + first.width - second.x).toBeCloseTo(TILE_OVERLAP_PT / plan.scale);
  });
  it("clamps pages wide and repairs a bad value", () => {
    const wide = (n: number) => tilePlan(rect(50000, 100), "a4", "portrait", n).across;
    expect(wide(0)).toBe(1);
    expect(wide(99)).toBe(MAX_PAGES_WIDE);
    expect(wide(NaN)).toBe(1);
    expect(wide(2.6)).toBe(3);
  });
  it("swaps a paper's sides for landscape", () => {
    const plan = tilePlan(rect(100, 100), "a4", "landscape", 1);
    expect([plan.widthPt, plan.heightPt]).toEqual([PAPERS.a4.height, PAPERS.a4.width]);
  });
});

describe("tiledPages", () => {
  it("draws only what meets each tile", () => {
    const bounds = rect(4000, 200);
    const s = scene(bounds, [item("left", rect(10, 10, 20, 20)), item("right", rect(10, 10, 3900, 20))]);
    const plan = tilePlan(bounds, "a4", "portrait", 2);
    const pages = tiledPages(s, plan);
    expect(pages).toHaveLength(plan.views.length);
    expect(pages[0].svg).toContain("left");
    expect(pages[0].svg).not.toContain("right");
    expect(pages[pages.length - 1].svg).toContain("right");
    expect(pages[pages.length - 1].svg).not.toContain("left");
    expect(pages[0]).toMatchObject({ widthPt: plan.widthPt, heightPt: plan.heightPt, marginPt: PAGE_MARGIN_PT });
    expect(pages[0].svg).toBe(sceneSvg(s, plan.views[0]));
  });
});

describe("defaults", () => {
  it("prefers landscape for a wide diagram", () => {
    expect(defaultOrientation(rect(200, 100))).toBe("landscape");
    expect(defaultOrientation(rect(100, 200))).toBe("portrait");
    expect(defaultOrientation(rect(100, 100))).toBe("portrait");
  });
  it("picks Letter for en-US and en-CA and A4 otherwise", () => {
    expect(defaultPaper("en-US")).toBe("letter");
    expect(defaultPaper("EN-ca")).toBe("letter");
    expect(defaultPaper("en-GB")).toBe("a4");
    expect(defaultPaper("de")).toBe("a4");
  });
});

describe("pngCheck", () => {
  it("rates PNG sizes", () => {
    expect(pngCheck(rect(1000, 1000), 1)).toEqual({ width: 1000, height: 1000, pixels: 1_000_000, level: "ok" });
    expect(pngCheck(rect(20000, 20000), 1).level).toBe("warn");
    expect(pngCheck(rect(80000, 40000), 1).level).toBe("refuse");
    expect(pngCheck(rect(10.2, 10.2), 2)).toMatchObject({ width: 21, height: 21 });
  });
});

describe("exportSummary", () => {
  it("sizes an image in pixels and megapixels, warning as pngCheck rates it", () => {
    expect(exportSummary(rect(2100, 1400), { kind: "image", scale: 2 })).toEqual({ text: "4,200 × 2,800 px, 11.8 megapixels", warnings: [], refuse: false });
    const warn = exportSummary(rect(20000, 20000), { kind: "image", scale: 1 });
    expect(warn.warnings).toEqual(["Some apps can't open an image this large."]);
    expect(warn.refuse).toBe(false);
    const refuse = exportSummary(rect(80000, 40000), { kind: "image", scale: 1 });
    expect(refuse.warnings).toEqual(["Too large to export. Try a smaller scale."]);
    expect(refuse.refuse).toBe(true);
  });
  it("shows an SVG's size with no warning and no refusal, however large", () => {
    expect(exportSummary(rect(36000, 30000), { kind: "vector" })).toEqual({ text: "36,000 × 30,000 px", warnings: [], refuse: false });
    expect(exportSummary(rect(2100, 1400), { kind: "vector" })).toEqual({ text: "2,100 × 1,400 px", warnings: [], refuse: false });
  });
  it("gives a fitted page's size in points", () => {
    expect(exportSummary(rect(4200, 2800), { kind: "fitted" })).toEqual({ text: "1 page, 3,150 × 2,100 pt", warnings: [], refuse: false });
  });
  it("counts the tiles the plan really has, at its own percentage", () => {
    const plan = tilePlan(rect(6000, 1000), "a4", "portrait", 3);
    const s = exportSummary(rect(6000, 1000), { kind: "tiled", plan });
    expect(s.text).toBe(`${plan.across} × ${plan.down} pages at ${Math.round((plan.scale / PX_TO_PT) * 100)}%`);
    expect(s.warnings).toEqual([]);
  });
  it("says one page when the plan is one tile", () => {
    expect(exportSummary(rect(100, 100), { kind: "tiled", plan: tilePlan(rect(100, 100), "a4", "portrait", 1) }).text).toBe("1 page at 100%");
  });
  it("warns when a tiled scale is under 30%", () => {
    const plan = tilePlan(rect(20000, 1000), "a4", "portrait", 1);
    expect(plan.scale / PX_TO_PT).toBeLessThan(0.3);
    expect(exportSummary(rect(20000, 1000), { kind: "tiled", plan }).warnings).toEqual(["Text may be too small to read."]);
  });
});
