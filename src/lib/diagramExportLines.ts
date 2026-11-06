// Foreign key and dependency lines as SVG, for the diagram export. Pure but for React Flow's path helper,
// which is why nothing in a store imports this. Attributes only, never CSS; names go through `xml()`.
import { getSmoothStepPath, Position } from "@xyflow/react";
import type { Drawn, Rect } from "./diagramExportNodes";
import { xml } from "./diagramExportTheme";
import type { ExportTheme } from "./diagramExportTheme";
import type { DiagramEdge, TableNode } from "./diagramFlow";
import { tableBox } from "./diagramLayout";
import type { Measure } from "./diagramLayout";
import { DEPENDENCY_DASHES, FK_DASHES, MARK_HEIGHT, MARKS, NAME_LIFT, namePlace, RING_RADIUS, routePath, selfLoop, selfLoopNamePlace, shortName, STUB } from "./diagramLines";
import type { Mark } from "./diagramLines";
import type { DiagramColor, DiagramOptions } from "./types";

export interface LineInput {
  edge: DiagramEdge;
  color: DiagramColor | null;
}
export interface DrawnLine extends Drawn {
  /** Marker ids, `m-<mark>-<tone>`. */
  marks: string[];
}

type Tone = "plain" | "hub" | DiagramColor;

/** A mark and its marker's room around the line's end, which the line's box grows by. */
const MARK_ROOM = MARK_HEIGHT / 2;

const n = (v: number) => String(Math.round(v * 100) / 100);

/** FkMarkers' tones, without `selected`. Black and White needs no case here: its theme's colours are all grey. */
function stroke(tone: Tone, theme: ExportTheme): { color: string; opacity: number } {
  if (tone === "plain") return { color: theme.text, opacity: 0.45 };
  if (tone === "hub") return { color: theme.primary.solid, opacity: 0.45 };
  return { color: theme.colors[tone].solid, opacity: 0.85 };
}

const markId = (mark: Mark, tone: Tone) => `m-${mark}-${tone}`;

/** The point a handle sits at: the node's edge, level with the column. */
function handlePoint(node: TableNode, handleId: string | null | undefined, options: DiagramOptions, measure: Measure) {
  const handle = node.data.handles.find((h) => h.id === handleId);
  if (!handle) return null;
  const width = node.width ?? tableBox(node.data.table, measure, options).width;
  return { x: handle.side === "left" ? node.position.x : node.position.x + width, y: node.position.y + handle.top };
}

/** Every coordinate of a path of M, L and Q commands, as pairs. */
function pathPoints(d: string): { x: number; y: number }[] {
  const values = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) out.push({ x: values[i], y: values[i + 1] });
  return out;
}

export function drawLine({ edge, color }: LineInput, nodes: Map<string, TableNode>, options: DiagramOptions, theme: ExportTheme, measure: Measure): DrawnLine | null {
  const data = edge.data;
  const sourceNode = nodes.get(edge.source);
  const targetNode = nodes.get(edge.target);
  if (!data || !sourceNode || !targetNode) return null;
  const from = handlePoint(sourceNode, edge.sourceHandle, options, measure);
  const to = handlePoint(targetNode, edge.targetHandle, options, measure);
  if (!from || !to) return null;

  const fk = edge.type === "fk" ? edge.data : undefined;
  const self = edge.source === edge.target;
  let d: string;
  if (self) d = selfLoop(from.x, from.y, to.y);
  else if (data.points) d = routePath([from, ...data.points, to]);
  // Square corners and the same stub as the canvas, so the file's line is the screen's.
  else d = getSmoothStepPath({ sourceX: from.x, sourceY: from.y, targetX: to.x, targetY: to.y, sourcePosition: Position.Right, targetPosition: Position.Left, borderRadius: 0, offset: STUB })[0];

  // A dependency takes no colour.
  const tone: Tone = fk && color ? color : data.hub ? "hub" : "plain";
  const { color: ink, opacity } = stroke(tone, theme);
  const marks = fk ? [markId(`child-${fk.childEnd}`, tone), markId(`parent-${fk.parentEnd}`, tone)] : [markId("reads", tone)];
  const dashes = fk ? FK_DASHES[fk.kind] : DEPENDENCY_DASHES;
  const out = [
    `<path d="${d}" fill="none" stroke="${ink}" stroke-opacity="${opacity}" stroke-width="1"${dashes ? ` stroke-dasharray="${dashes}"` : ""}${fk ? ` marker-start="url(#${marks[0]})" marker-end="url(#${marks[1]})"` : ` marker-end="url(#${marks[0]})"`}/>`,
  ];

  const points = pathPoints(d);
  let minX = Math.min(...points.map((p) => p.x)) - MARK_ROOM;
  let minY = Math.min(...points.map((p) => p.y)) - MARK_ROOM;
  let maxX = Math.max(...points.map((p) => p.x)) + MARK_ROOM;
  let maxY = Math.max(...points.map((p) => p.y)) + MARK_ROOM;

  if (fk && options.showRelationshipNames) {
    const size = options.fontSize - 1;
    const shown = shortName(fk.name);
    const place = self ? selfLoopNamePlace(from.x, from.y, to.y) : namePlace(from.x, from.y);
    const y = place.y - NAME_LIFT;
    // The halo is what keeps a name readable over a line.
    out.push(`<text x="${n(place.x)}" y="${n(y)}" font-size="${n(size)}" fill="${theme.text}" stroke="${theme.background}" stroke-width="3" paint-order="stroke" xml:space="preserve">${xml(shown)}</text>`);
    const width = measure(shown, false, size);
    minX = Math.min(minX, place.x - 1.5);
    maxX = Math.max(maxX, place.x + width + 1.5);
    minY = Math.min(minY, y - size - 1.5);
    maxY = Math.max(maxY, y + size * 0.3 + 1.5);
  }

  const box: Rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return { svg: out.join(""), box, marks };
}

/** One marker per id. They're attributes, not styles, and `userSpaceOnUse` like the canvas's. */
export function markerDefs(ids: Iterable<string>, theme: ExportTheme): string {
  const out: string[] = [];
  for (const id of new Set(ids)) {
    const rest = id.slice(2);
    const mark = (Object.keys(MARKS) as Mark[]).find((m) => rest.startsWith(`${m}-`));
    if (!mark) continue;
    const tone = rest.slice(mark.length + 1) as Tone;
    const { width, ref, lines, ring } = MARKS[mark];
    const { color, opacity } = stroke(tone, theme);
    const ink = `stroke="${color}" stroke-opacity="${opacity}" stroke-width="1"`;
    out.push(
      `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="${width}" markerHeight="${MARK_HEIGHT}" refX="${ref}" refY="${MARK_HEIGHT / 2}" orient="auto">` +
        // Filled, or the line would show through the ring.
        (ring === undefined ? "" : `<circle cx="${ring}" cy="${MARK_HEIGHT / 2}" r="${RING_RADIUS}" fill="${theme.background}" ${ink}/>`) +
        `<path d="${lines}" fill="none" ${ink}/></marker>`,
    );
  }
  return out.join("");
}
