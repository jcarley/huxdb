// The diagram as a scene (drawn items in paint order, with their bounds) and as a standalone SVG document.
// Pure but for the line helper's React Flow import, so it's reached only from the lazy diagram chunk.
import { tableKey } from "./diagramDrift";
import { drawLine, markerDefs } from "./diagramExportLines";
import { drawAnnotation, drawContinuations, drawTable } from "./diagramExportNodes";
import type { Drawn, Rect } from "./diagramExportNodes";
import { BLACK_AND_WHITE_THEME, ICONS, LIGHT_THEME } from "./diagramExportTheme";
import type { ExportTheme } from "./diagramExportTheme";
import type { DiagramEdge, DiagramNode, TableNode } from "./diagramFlow";
import { isAnnotationNode } from "./diagramFlow";
import type { Measure } from "./diagramLayout";
import type { DiagramAnnotation, DiagramColors, DiagramOptions } from "./types";

export interface ExportInput {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  annotations: DiagramAnnotation[];
  colors: DiagramColors;
  options: DiagramOptions;
}
export interface ExportChoices {
  blackAndWhite: boolean;
  hubLines: boolean;
}
export interface SceneItem extends Drawn {
  marks: string[];
}
export interface Scene {
  items: SceneItem[];
  bounds: Rect;
  theme: ExportTheme;
}

const MARGIN = 24;
const CONTINUATION_GAP = 40;
const MIN_WRAP = 1200;
const FONT = "Inter, sans-serif";

export const hasHubLines = (edges: DiagramEdge[]) => edges.some((e) => e.data?.hub);

const n = (v: number) => String(Math.round(v * 100) / 100);

function union(boxes: Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** Null for a diagram with nothing to draw. */
export function buildScene(input: ExportInput, choices: ExportChoices, measure: Measure): Scene | null {
  const { edges, colors, options } = input;
  const theme = choices.blackAndWhite ? BLACK_AND_WHITE_THEME : LIGHT_THEME;
  const tables = input.nodes.filter((node): node is TableNode => !isAnnotationNode(node));
  const byId = new Map(tables.map((t) => [t.id, t]));

  // `annotations` holds the text and place; a node's copy can lag a keystroke.
  const annotations = input.annotations.filter((a) => a.text.trim() !== "");
  const annotationItem = (a: DiagramAnnotation): SceneItem => ({ ...drawAnnotation(a, theme, measure), marks: [] });
  const below = annotations.filter((a) => a.z < 0).sort((a, b) => a.z - b.z);
  const above = annotations.filter((a) => a.z >= 0).sort((a, b) => a.z - b.z);

  const lines: SceneItem[] = [];
  for (const edge of edges) {
    if (edge.data?.hub && !choices.hubLines) continue;
    const color = edge.type === "fk" ? colors.lines[edge.data?.key ?? ""] ?? null : null;
    const line = drawLine({ edge, color }, byId, options, theme, measure);
    if (line) lines.push(line);
  }
  const drawnTables = tables.map((t) => drawTable(t, options, colors.objects[tableKey(t.data.table)] ?? null, theme, measure));
  const asItem = (d: Drawn): SceneItem => ({ svg: d.svg, box: d.box, marks: [] });
  // Text that runs past its table goes after every object, so no neighbour covers it.
  const items = [...below.map(annotationItem), ...lines, ...drawnTables.map(asItem), ...drawnTables.flatMap((d) => d.overflow.map(asItem)), ...above.map(annotationItem)];
  if (items.length === 0) return null;

  // Continuations sit below everything else, at its left, so they're placed once that's known.
  const content = union(items.map((i) => i.box));
  const continuations = drawContinuations(tables, colors.objects, options, theme, measure, { x: content.x, y: content.y + content.height + CONTINUATION_GAP }, Math.max(content.width, MIN_WRAP));
  // After the annotations too, where a continuation's own overflow is also last.
  items.push(...continuations.map(asItem), ...continuations.flatMap((c) => c.overflow.map(asItem)));

  const all = union(items.map((i) => i.box));
  // Whole pixels outward: a fractional edge would leave a partly covered last row and column in a PNG.
  const x = Math.floor(all.x - MARGIN);
  const y = Math.floor(all.y - MARGIN);
  const right = Math.ceil(all.x + all.width + MARGIN);
  const bottom = Math.ceil(all.y + all.height + MARGIN);
  return { items, bounds: { x, y, width: right - x, height: bottom - y }, theme };
}

const meets = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The standalone document, holding only what meets `view`. */
export function sceneSvg(scene: Scene, view: Rect = scene.bounds): string {
  const shown = scene.items.filter((i) => meets(i.box, view));
  const icons = new Set<string>();
  const markers = new Set<string>();
  for (const item of shown) {
    for (const m of item.svg.matchAll(/#i-([a-z]+)/g)) icons.add(m[1]);
    for (const id of item.marks) markers.add(id);
  }
  const defs = [...icons].filter((k): k is keyof typeof ICONS => k in ICONS).map((k) => `<g id="i-${k}">${ICONS[k]}</g>`).join("") + markerDefs(markers, scene.theme);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(view.width)}" height="${n(view.height)}" viewBox="${n(view.x)} ${n(view.y)} ${n(view.width)} ${n(view.height)}" font-family="${FONT}">` +
    `<defs>${defs}</defs>` +
    `<rect x="${n(view.x)}" y="${n(view.y)}" width="${n(view.width)}" height="${n(view.height)}" fill="${scene.theme.background}"/>` +
    shown.map((i) => i.svg).join("") +
    `</svg>`
  );
}
