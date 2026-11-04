// Column widths measured from text: a column's default fits its header and its
// values within limits; double-clicking a header's edge fits it with a wider cap.

import type { Value } from "../../stores/dataEditor";

/** Narrowest a column can be dragged to. */
export const MIN_WIDTH = 40;
/** Default widths stay at most this wide; long values are cut off with an ellipsis. */
const DEFAULT_MAX = 320;
/** Fitting a column (double-click) can make it this wide. */
const FIT_MAX = 800;
/** Cell padding, borders, and room for the key icon in headers. */
const CELL_EXTRA = 16;
const HEADER_EXTRA = 28;
/** Values measured per column; enough to size a page without stalling on 5000 rows. */
const SAMPLE_ROWS = 500;

let canvas: HTMLCanvasElement | null = null;

const fontFamily = (variable: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;

/** A text measurer for the grid's fonts at `size` px. */
function measurer(size: number) {
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const mono = `${size}px ${fontFamily("--font-mono", "ui-monospace, Menlo, monospace")}`;
  const sans = `600 ${size}px ${fontFamily("--font-sans", "ui-sans-serif, system-ui, sans-serif")}`;
  return {
    value: (text: string) => {
      ctx.font = mono;
      return ctx.measureText(text).width;
    },
    header: (text: string) => {
      ctx.font = sans;
      return ctx.measureText(text).width;
    },
  };
}

function widthOf(measure: ReturnType<typeof measurer>, header: string, rows: Value[][], index: number, max: number) {
  // NULLs show as "(NULL)".
  let widest = measure.header(header) + HEADER_EXTRA;
  for (const row of rows.length > SAMPLE_ROWS ? rows.slice(0, SAMPLE_ROWS) : rows) {
    const text = row[index] ?? "(NULL)";
    // Only the first line shows in a cell.
    widest = Math.max(widest, measure.value(text.split("\n", 1)[0].slice(0, 200)) + CELL_EXTRA);
    if (widest >= max) return max;
  }
  return Math.max(MIN_WIDTH, Math.ceil(widest));
}

/** Default widths: each column fits its header and the page's values, at most DEFAULT_MAX. */
export function defaultWidths(headers: string[], rows: Value[][], fontSize: number) {
  const measure = measurer(fontSize);
  return headers.map((header, i) => widthOf(measure, header, rows, i, DEFAULT_MAX));
}

/** The width that fits one column's header and values, at most FIT_MAX. */
export function fitWidth(header: string, rows: Value[][], index: number, fontSize: number) {
  return widthOf(measurer(fontSize), header, rows, index, FIT_MAX);
}
