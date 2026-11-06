// Tables and annotations as SVG text, for the diagram export. Pure: measuring is passed in, and every
// string from a database or a note goes through `xml()`. Text uses attributes only, never CSS.
import { annotationBox, annotationLines, lineHeight, NOTE_PADDING } from "./diagramAnnotations";
import { objectKind, tableKey } from "./diagramDrift";
import { ICONS, xml } from "./diagramExportTheme";
import type { ExportTheme, Swatch } from "./diagramExportTheme";
import type { TableNode } from "./diagramFlow";
import { headerHeight, isCapped, MAX_ROWS, rowHeight, rowSuffix, rowsTop, tableBox } from "./diagramLayout";
import type { Measure, Point } from "./diagramLayout";
import type { DiagramAnnotation, DiagramColor, DiagramColumn, DiagramObjectKind, DiagramOptions, DiagramTable } from "./types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Drawn {
  svg: string;
  box: Rect;
}
/** A table's item, and the texts that run past its box. Those are separate items, drawn after every object, so no neighbour covers them. */
export interface DrawnObject extends Drawn {
  overflow: Drawn[];
}

/** Added to a row's middle to get the text's baseline, as a fraction of the font size (Inter's metrics). */
export const BASELINE = 0.364;

const SKEW = "skewX(-12)";
const TABLE_RADIUS = 8;
const NOTE_RADIUS = 6;
/** The canvas's px-2 and gap-1.5 / gap-1. */
const PAD = 8;
const HEADER_GAP = 6;
const ROW_GAP = 4;
const GAP_BETWEEN_BOXES = 24;
const DASHES = "4 3";

const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * The size a text is drawn at: its own when it fits `room`, else shrunk to fit but never below `floor` of it.
 * A title uses floor 0, as white text past a header can't be read. A row uses 0.6, and then runs past the box.
 */
export function fitSize(textWidth: number, fontSize: number, room: number, floor: number): number {
  if (textWidth <= room) return fontSize;
  return fontSize * Math.max(floor, Math.max(room, 1) / textWidth);
}

interface Text {
  x: number;
  mid: number;
  size: number;
  fill: string;
  bold?: boolean;
  italic?: boolean;
  opacity?: number;
  /** A background colour to outline the glyphs with, so text over a neighbour stays readable, as line names do. */
  halo?: string;
  /** Already escaped. */
  body: string;
}

function text({ x, mid, size, fill, bold, italic, opacity, halo, body }: Text): string {
  const y = mid + BASELINE * size;
  const at = italic ? `transform="translate(${n(x)} ${n(y)}) ${SKEW}"` : `x="${n(x)}" y="${n(y)}"`;
  const outline = halo ? ` stroke="${halo}" stroke-width="3" paint-order="stroke"` : "";
  return `<text ${at} font-size="${n(size)}"${bold ? ' font-weight="600"' : ""} fill="${fill}"${opacity === undefined ? "" : ` fill-opacity="${opacity}"`}${outline} xml:space="preserve">${body}</text>`;
}

function icon(name: keyof typeof ICONS, x: number, y: number, size: number, stroke: string, opacity?: number): string {
  return `<use xlink:href="#i-${name}" transform="translate(${n(x)} ${n(y)}) scale(${n(size / 24)})" fill="none" stroke="${stroke}"${opacity === undefined ? "" : ` stroke-opacity="${opacity}"`} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const KIND_ICON: Partial<Record<DiagramObjectKind, keyof typeof ICONS>> = { view: "eye", "materialized-view": "layers", function: "function", procedure: "workflow" };

const swatchOf = (theme: ExportTheme, color: DiagramColor | null, kind: DiagramObjectKind): Swatch =>
  color ? theme.colors[color] : kind === "function" || kind === "procedure" ? theme.secondary : theme.primary;

interface BoxSpec {
  table: DiagramTable;
  columns: DiagramColumn[];
  foreignKeyColumns: Set<string>;
  title: string;
  /** The first box shows the object's comment and a capped table's column count. */
  first: boolean;
  at: Point;
  width: number;
  color: DiagramColor | null;
}

function drawBox(spec: BoxSpec, options: DiagramOptions, theme: ExportTheme, measure: Measure): DrawnObject {
  const { table, columns, foreignKeyColumns, first, at, width, color } = spec;
  const kind = objectKind(table);
  const swatch = swatchOf(theme, color, kind);
  const { fontSize } = options;
  const row = rowHeight(options);
  const header = headerHeight(options);
  const border = kind === "materialized-view" ? 2 : 1;
  const comment = first && options.showObjectComments && table.comment ? table.comment : null;
  const top = first ? rowsTop(table, options) : header;
  const height = top + columns.length * row + border * 2;
  const x = at.x + border;
  const inner = width - 2 * border;
  const out: string[] = [];
  const overflow: Drawn[] = [];
  const edge = x + inner;

  // The border sits inside the box, as CSS draws it, so the stroke is inset by half its width.
  out.push(
    `<rect x="${n(at.x + border / 2)}" y="${n(at.y + border / 2)}" width="${n(width - border)}" height="${n(height - border)}" rx="${TABLE_RADIUS - border / 2}" fill="${theme.background}" stroke="${swatch.solid}"${color ? "" : ' stroke-opacity="0.6"'} stroke-width="${border}"${kind === "table" || kind === "function" || kind === "procedure" ? "" : ` stroke-dasharray="${DASHES}"`}/>`,
  );
  // A table's header is the solid colour; any other object's a tint, like the canvas.
  const solid = kind === "table";
  const r = TABLE_RADIUS - border;
  const y0 = at.y + border;
  out.push(`<path d="M${n(x)} ${n(y0 + header)}V${n(y0 + r)}A${r} ${r} 0 0 1 ${n(x + r)} ${n(y0)}H${n(x + inner - r)}A${r} ${r} 0 0 1 ${n(x + inner)} ${n(y0 + r)}V${n(y0 + header)}Z" fill="${solid ? swatch.solid : swatch.tint}"/>`);
  const headText = solid ? swatch.content : theme.text;
  const mid = y0 + header / 2;

  // Header: [kind icon] title [info icon] [N columns], centred as a unit.
  const symbol = KIND_ICON[kind];
  const routine = kind === "function" || kind === "procedure";
  const count = first && isCapped(table) ? `${table.columns.length} columns` : null;
  const countWidth = count ? measure(count, false, fontSize) : 0;
  const extras = (symbol ? fontSize : 0) + (routine ? fontSize : 0) + countWidth;
  const parts = 1 + (symbol ? 1 : 0) + (routine ? 1 : 0) + (count ? 1 : 0);
  const room = inner - 2 * PAD - extras - (parts - 1) * HEADER_GAP;
  const titleWidth = measure(spec.title, true, fontSize);
  const titleSize = fitSize(titleWidth, fontSize, room, 0);
  const shownWidth = (titleWidth * titleSize) / fontSize;
  const total = extras + shownWidth + (parts - 1) * HEADER_GAP;
  let cx = x + PAD + Math.max(0, (inner - 2 * PAD - total) / 2);
  if (symbol) {
    out.push(icon(symbol, cx, mid - fontSize / 2, fontSize, headText));
    cx += fontSize + HEADER_GAP;
  }
  out.push(text({ x: cx, mid, size: titleSize, fill: headText, bold: true, body: xml(spec.title) }));
  cx += shownWidth + HEADER_GAP;
  if (routine) {
    out.push(icon("info", cx, mid - fontSize / 2, fontSize, headText, 0.6));
    cx += fontSize + HEADER_GAP;
  }
  if (count) out.push(text({ x: cx, mid, size: fontSize, fill: headText, opacity: 0.75, body: xml(count) }));

  let y = y0 + header;
  if (comment !== null) {
    const body = comment;
    const bodyWidth = measure(body, false, fontSize);
    const size = fitSize(bodyWidth, fontSize, inner - 2 * PAD, 0.6);
    out.push(`<line x1="${n(x)}" x2="${n(x + inner)}" y1="${n(y + row)}" y2="${n(y + row)}" stroke="${theme.border}"/>`);
    const spec = { x: x + PAD, mid: y + row / 2, size, fill: theme.text, italic: true, opacity: 0.7, body: xml(body) };
    const shown = (bodyWidth * size) / fontSize;
    if (spec.x + shown > edge) overflow.push({ svg: text({ ...spec, halo: theme.background }), box: { x: spec.x, y, width: shown, height: row } });
    else out.push(text(spec));
    y += row;
  }

  const textX = x + PAD + fontSize + ROW_GAP;
  const rowRoom = inner - PAD - (textX - x);
  columns.forEach((c, i) => {
    const rowMid = y + i * row + row / 2;
    if (c.primaryKey) out.push(icon("key", x + PAD, rowMid - fontSize / 2, fontSize, theme.key));
    else if (foreignKeyColumns.has(c.name)) out.push(icon("link", x + PAD, rowMid - fontSize / 2, fontSize, theme.text, 0.4));
    const tail = `: ${c.dataType}${rowSuffix(c, options)}`;
    const rowWidth = measure(c.name + tail, false, fontSize);
    const size = fitSize(rowWidth, fontSize, rowRoom, 0.6);
    const yy = rowMid + BASELINE * size;
    const shown = (rowWidth * size) / fontSize;
    const past = textX + shown > edge;
    const halo = past ? ` stroke="${theme.background}" stroke-width="3" paint-order="stroke"` : "";
    const svg = `<text x="${n(textX)}" y="${n(yy)}" font-size="${n(size)}" fill="${theme.text}"${halo} xml:space="preserve">${xml(c.name)}<tspan fill-opacity="0.5">${xml(tail)}</tspan></text>`;
    if (past) overflow.push({ svg, box: { x: textX, y: rowMid - row / 2, width: shown, height: row } });
    else out.push(svg);
  });

  return { svg: out.join(""), box: { x: at.x, y: at.y, width, height }, overflow };
}

export function drawTable(node: TableNode, options: DiagramOptions, color: DiagramColor | null, theme: ExportTheme, measure: Measure): DrawnObject {
  const { table, foreignKeyColumns } = node.data;
  const width = node.width ?? tableBox(table, measure, options).width;
  const title = options.showSchemaNames ? `${table.schema}.${table.name}` : table.name;
  const drawn = drawBox({ table, columns: table.columns.slice(0, MAX_ROWS), foreignKeyColumns, title, first: true, at: node.position, width, color }, options, theme, measure);
  // The node's own height is what the diagram laid out, so the box reports it.
  return { ...drawn, box: { ...drawn.box, height: node.height ?? drawn.box.height } };
}

/** Boxes for rows 41 onward. They don't overlap each other, and start at `corner`. */
export function drawContinuations(tables: TableNode[], colors: Record<string, DiagramColor>, options: DiagramOptions, theme: ExportTheme, measure: Measure, corner: Point, wrapWidth: number): DrawnObject[] {
  const out: DrawnObject[] = [];
  let x = corner.x;
  let y = corner.y;
  let lineHeight = 0;
  for (const node of tables) {
    const { table, foreignKeyColumns } = node.data;
    if (!isCapped(table)) continue;
    const width = node.width ?? tableBox(table, measure, options).width;
    const color = colors[tableKey(table)] ?? null;
    const base = options.showSchemaNames ? `${table.schema}.${table.name}` : table.name;
    for (let from = MAX_ROWS; from < table.columns.length; from += MAX_ROWS) {
      const to = Math.min(from + MAX_ROWS, table.columns.length);
      // Wrap before a box that would pass the edge, unless it's the first of its line.
      if (x > corner.x && x + width > corner.x + wrapWidth) {
        x = corner.x;
        y += lineHeight + GAP_BETWEEN_BOXES;
        lineHeight = 0;
      }
      const title = `${base} (continued, ${from + 1}–${to} of ${table.columns.length})`;
      const drawn = drawBox({ table, columns: table.columns.slice(from, to), foreignKeyColumns, title, first: false, at: { x, y }, width, color }, options, theme, measure);
      out.push(drawn);
      x += width + GAP_BETWEEN_BOXES;
      lineHeight = Math.max(lineHeight, drawn.box.height);
    }
  }
  return out;
}

export function drawAnnotation(a: DiagramAnnotation, theme: ExportTheme, measure: Measure): Drawn {
  const { width, height } = annotationBox(a, measure);
  const isNote = a.kind === "note";
  const out: string[] = [];
  if (isNote) {
    const swatch = a.color ? theme.colors[a.color] : null;
    out.push(`<rect x="${n(a.x + 0.5)}" y="${n(a.y + 0.5)}" width="${n(width - 1)}" height="${n(height - 1)}" rx="${NOTE_RADIUS}" fill="${swatch ? swatch.tint : theme.noteFill}" stroke="${swatch ? swatch.solid : theme.noteBorder}"/>`);
  }
  const line = lineHeight(a.fontSize);
  // CSS's padding starts inside a note's 1 px border; a label has none.
  const inset = (isNote ? 1 : 0) + NOTE_PADDING;
  annotationLines(a, measure).forEach((l, i) => {
    out.push(text({ x: a.x + inset, mid: a.y + inset + i * line + line / 2, size: a.fontSize, fill: theme.text, bold: a.bold, italic: a.italic, body: xml(l) }));
  });
  return { svg: out.join(""), box: { x: a.x, y: a.y, width, height } };
}
