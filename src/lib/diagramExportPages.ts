// Page and image sizes for the diagram export: a fitted PDF page, tiled pages, and PNG size checks. Pure.
import type { Scene } from "./diagramExport";
import { sceneSvg } from "./diagramExport";
import type { Rect } from "./diagramExportNodes";
import type { PdfPage } from "./types";

export type PaperName = "a4" | "a3" | "letter" | "legal" | "tabloid";
export type Orientation = "portrait" | "landscape";

/** Portrait sizes in points. */
export const PAPERS: Record<PaperName, { label: string; width: number; height: number }> = {
  a4: { label: "A4", width: 595, height: 842 },
  a3: { label: "A3", width: 842, height: 1191 },
  letter: { label: "Letter", width: 612, height: 792 },
  legal: { label: "Legal", width: 612, height: 1008 },
  tabloid: { label: "Tabloid", width: 792, height: 1224 },
};

export const PX_TO_PT = 0.75;
// Same as MAX_PAGE_PT in src-tauri/src/diagram/export.rs, which refuses a larger page.
export const MAX_PAGE_PT = 14400;
export const PAGE_MARGIN_PT = 18;
export const TILE_OVERLAP_PT = 18;
export const PNG_WARN_PIXELS = 268_435_456;
// Same as MAX_PNG_PIXELS in src-tauri/src/diagram/export.rs, which refuses a larger image.
export const PNG_MAX_PIXELS = 1_000_000_000;
export const PNG_SCALES = [1, 2, 3, 4];
export const MAX_PAGES_WIDE = 20;

export interface TilePlan {
  across: number;
  down: number;
  /** Points per px, at most PX_TO_PT; the UI's percentage is `scale / PX_TO_PT`. */
  scale: number;
  widthPt: number;
  heightPt: number;
  /** Each tile's printable area in diagram px, row by row. The last row and column can run past the diagram. */
  views: Rect[];
}

export const defaultOrientation = (bounds: Rect): Orientation => (bounds.width > bounds.height ? "landscape" : "portrait");

export const defaultPaper = (language: string): PaperName => {
  const tag = language.toLowerCase();
  return tag === "en-us" || tag === "en-ca" ? "letter" : "a4";
};

function fittedSize({ width, height }: Rect) {
  const k = Math.min(PX_TO_PT, MAX_PAGE_PT / Math.max(width, height));
  return { widthPt: width * k, heightPt: height * k };
}

export function fittedPage(scene: Scene): PdfPage {
  return { svg: sceneSvg(scene), ...fittedSize(scene.bounds), marginPt: 0 };
}

export function tilePlan(bounds: Rect, paper: PaperName, orientation: Orientation, pagesWide: number): TilePlan {
  const wide = Number.isNaN(pagesWide) ? 1 : Math.min(MAX_PAGES_WIDE, Math.max(1, Math.round(pagesWide)));
  const sides = [PAPERS[paper].width, PAPERS[paper].height];
  if (orientation === "landscape") sides.reverse();
  const [widthPt, heightPt] = sides;
  const printW = widthPt - 2 * PAGE_MARGIN_PT;
  const printH = heightPt - 2 * PAGE_MARGIN_PT;
  const scale = Math.min(PX_TO_PT, (wide * printW - (wide - 1) * TILE_OVERLAP_PT) / bounds.width);
  // Tiles needed along one side: the first covers `print`, each further one adds `print - overlap`.
  const count = (extent: number, print: number) => Math.max(1, Math.ceil((extent * scale - print) / (print - TILE_OVERLAP_PT) - 1e-9) + 1);
  const across = count(bounds.width, printW);
  const down = count(bounds.height, printH);
  const tile = { width: printW / scale, height: printH / scale };
  const step = { x: (printW - TILE_OVERLAP_PT) / scale, y: (printH - TILE_OVERLAP_PT) / scale };
  const views: Rect[] = [];
  for (let r = 0; r < down; r++) {
    for (let c = 0; c < across; c++) views.push({ x: bounds.x + c * step.x, y: bounds.y + r * step.y, ...tile });
  }
  return { across, down, scale, widthPt, heightPt, views };
}

export const tiledPages = (scene: Scene, plan: TilePlan): PdfPage[] =>
  plan.views.map((view) => ({ svg: sceneSvg(scene, view), widthPt: plan.widthPt, heightPt: plan.heightPt, marginPt: PAGE_MARGIN_PT }));

/** Rounds up each side, as Rust's `png_size` does, so the two agree. */
export function pngCheck(bounds: Rect, scale: number) {
  const width = Math.ceil(bounds.width * scale);
  const height = Math.ceil(bounds.height * scale);
  const pixels = width * height;
  const level = pixels > PNG_MAX_PIXELS ? "refuse" : pixels > PNG_WARN_PIXELS ? "warn" : "ok";
  return { width, height, pixels, level } as { width: number; height: number; pixels: number; level: "ok" | "warn" | "refuse" };
}

/** `vector` is an SVG: no scale and no pixel limit. */
export type SummaryTarget = { kind: "vector" } | { kind: "image"; scale: number } | { kind: "fitted" } | { kind: "tiled"; plan: TilePlan };

const TOO_SMALL_PERCENT = 0.3;
const count = (n: number) => n.toLocaleString("en-US");

/** The dialog's size line and what's wrong with it; `refuse` blocks the button. */
export function exportSummary(bounds: Rect, target: SummaryTarget): { text: string; warnings: string[]; refuse: boolean } {
  if (target.kind === "vector") {
    return { text: `${count(Math.ceil(bounds.width))} × ${count(Math.ceil(bounds.height))} px`, warnings: [], refuse: false };
  }
  if (target.kind === "image") {
    const { width, height, pixels, level } = pngCheck(bounds, target.scale);
    const warnings = level === "warn" ? ["Some apps can't open an image this large."] : level === "refuse" ? ["Too large to export. Try a smaller scale."] : [];
    return { text: `${count(width)} × ${count(height)} px, ${(pixels / 1e6).toFixed(1)} megapixels`, warnings, refuse: level === "refuse" };
  }
  if (target.kind === "fitted") {
    const { widthPt, heightPt } = fittedSize(bounds);
    return { text: `1 page, ${count(Math.round(widthPt))} × ${count(Math.round(heightPt))} pt`, warnings: [], refuse: false };
  }
  const { across, down, scale } = target.plan;
  const percent = `${Math.round((scale / PX_TO_PT) * 100)}%`;
  return {
    text: across === 1 && down === 1 ? `1 page at ${percent}` : `${across} × ${down} pages at ${percent}`,
    warnings: scale / PX_TO_PT < TOO_SMALL_PERCENT ? ["Text may be too small to read."] : [],
    refuse: false,
  };
}
