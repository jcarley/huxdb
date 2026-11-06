// The geometry of a foreign key's line. Pure.

import type { ChildEnd, LineKind, ParentEnd } from "./diagramCardinality";
import type { Point } from "./diagramLayout";

export type Mark = `child-${ChildEnd}` | `parent-${ParentEnd}` | "reads";

export const MARK_HEIGHT = 14;
export const RING_RADIUS = 3.5;

/**
 * Drawn along the line's direction of travel, with `orient="auto"` turning them. Child marks
 * sit at the start of a line, so x = 0 is the table's edge. Parent marks sit at its end, so
 * `ref` is. Either way the bar or foot is by the table and the ring faces the line.
 * A parent's bar is the same distance from the table on both, because lines into one column
 * share an end. `auto-start-reverse` would halve these, but its WebKit support wasn't checked.
 */
export const MARKS: Record<Mark, { width: number; ref: number; lines: string; ring?: number }> = {
  "child-zero-or-many": { width: 17, ref: 0, lines: "M0 1L9 7L0 13", ring: 12.5 },
  "child-zero-or-one": { width: 15, ref: 0, lines: "M4 1V13", ring: 10.5 },
  "parent-one": { width: 14, ref: 14, lines: "M10 1V13M5 1V13" },
  "parent-zero-or-one": { width: 15, ref: 15, lines: "M11 1V13", ring: 4.5 },
  // An open arrowhead at a dependency's end, which is the source's edge.
  reads: { width: 12, ref: 11, lines: "M2 2L11 7L2 12" },
};

/** Above the line, because a line drawn after this one would strike through it. */
export const NAME_LIFT = 3;

export const FK_DASHES: Record<LineKind, string | undefined> = { plain: undefined, unchecked: "6 4", partition: "1.5 3" };
/** Not a foreign key's `6 4` or `1.5 3`, so the three kinds of line differ by more than colour. */
export const DEPENDENCY_DASHES = "8 5";

/** How far a line runs straight out of a table: past its mark, whichever way it turns next. */
export const STUB = 26;
const LOOP_WIDTH = 26;
const LOOP_MAX_EXTRA = 34;
const LOOP_NAME_GAP = 4;
const NAME_OFFSET = 21;
const NAME_LIMIT = 28;

/** Where a line's name starts. */
export interface NamePlace {
  x: number;
  y: number;
}

/** After its child mark. Lines into one column share their last stretch, but rarely a child column, so names there can't stack. */
export const namePlace = (sourceX: number, sourceY: number): NamePlace => ({ x: sourceX + NAME_OFFSET, y: sourceY });

export const routePath = (points: Point[]) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

const loopWidth = (sourceY: number, targetY: number) => LOOP_WIDTH + Math.min(Math.abs(targetY - sourceY) / 4, LOOP_MAX_EXTRA);

/** Out of a table's right side and back in. Wider for columns further apart, so loops on one table nest. */
export function selfLoop(x: number, sourceY: number, targetY: number) {
  const right = x + loopWidth(sourceY, targetY);
  return routePath([
    { x, y: sourceY },
    { x: right, y: sourceY },
    { x: right, y: targetY },
    { x, y: targetY },
  ]);
}

/** Past the loop, which would otherwise run through the name. */
export const selfLoopNamePlace = (x: number, sourceY: number, targetY: number): NamePlace => ({ x: x + loopWidth(sourceY, targetY) + LOOP_NAME_GAP, y: sourceY });

/** A long name stays whole in its tooltip. */
export const shortName = (name: string) => (name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1)}…` : name);
