// The geometry of a foreign key's line. Pure.

import type { Point } from "./diagramLayout";

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
