import type { ChildEnd, ParentEnd } from "../../lib/diagramCardinality";

export type Tone = "plain" | "hub" | "selected";
type Mark = `child-${ChildEnd}` | `parent-${ParentEnd}`;

const HEIGHT = 14;
const MIDDLE = HEIGHT / 2;

/**
 * Drawn along the line's direction of travel, with `orient="auto"` turning them. Child marks
 * sit at the start of a line, so x = 0 is the table's edge. Parent marks sit at its end, so
 * `ref` is. Either way the bar or foot is by the table and the ring faces the line.
 * A parent's bar is the same distance from the table on both, because lines into one column
 * share an end. `auto-start-reverse` would halve these, but its WebKit support wasn't checked.
 */
const MARKS: Record<Mark, { width: number; ref: number; lines: string; ring?: number }> = {
  "child-zero-or-many": { width: 17, ref: 0, lines: "M0 1L9 7L0 13", ring: 12.5 },
  "child-zero-or-one": { width: 15, ref: 0, lines: "M4 1V13", ring: 10.5 },
  "parent-one": { width: 14, ref: 14, lines: "M10 1V13M5 1V13" },
  "parent-zero-or-one": { width: 15, ref: 15, lines: "M11 1V13", ring: 4.5 },
};

const TONES: Record<Tone, { stroke: string; strokeOpacity: number; strokeWidth: number }> = {
  plain: { stroke: "var(--color-base-content)", strokeOpacity: 0.45, strokeWidth: 1 },
  hub: { stroke: "var(--color-primary)", strokeOpacity: 0.45, strokeWidth: 1 },
  selected: { stroke: "var(--color-primary)", strokeOpacity: 1, strokeWidth: 2 },
};

export const lineStyle = (tone: Tone) => TONES[tone];

/** Per tab: a tab hidden by `display: none`, or in Black and White, can't lend its markers to another. */
export const markerUrl = (tab: string, mark: Mark, tone: Tone) => `url(#fk-${tab}-${mark}-${tone})`;

const RING_RADIUS = 3.5;

/** One marker per mark and colour, because a marker doesn't inherit its line's stroke. */
export function FkMarkers({ tab }: { tab: string }) {
  return (
    <svg className="absolute size-0" aria-hidden>
      <defs>
        {(Object.keys(TONES) as Tone[]).flatMap((tone) =>
          (Object.keys(MARKS) as Mark[]).map((mark) => {
            const { width, ref, lines, ring } = MARKS[mark];
            const { stroke, strokeOpacity, strokeWidth } = TONES[tone];
            // Thinner than a selected line's 2, or the marks clot.
            const style = { stroke, strokeOpacity, strokeWidth: Math.min(strokeWidth, 1.5), fill: "none" };
            return (
              <marker key={`${mark}-${tone}`} id={`fk-${tab}-${mark}-${tone}`} markerUnits="userSpaceOnUse" markerWidth={width} markerHeight={HEIGHT} refX={ref} refY={MIDDLE} orient="auto">
                {/* Filled, or the line would show through the ring. */}
                {ring !== undefined && <circle cx={ring} cy={MIDDLE} r={RING_RADIUS} style={{ ...style, fill: "var(--color-base-100)" }} />}
                <path d={lines} style={style} />
              </marker>
            );
          }),
        )}
      </defs>
    </svg>
  );
}
