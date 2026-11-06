import { DIAGRAM_COLORS } from "../../lib/diagramAnnotations";
import { MARK_HEIGHT, MARKS, RING_RADIUS } from "../../lib/diagramLines";
import type { Mark } from "../../lib/diagramLines";
import type { DiagramColor } from "../../lib/types";
import { colorVar } from "./colorStyles";

export type Tone = "plain" | "hub" | "selected" | DiagramColor;
type Stroke = { stroke: string; strokeOpacity: number; strokeWidth: number };

/** A colour's stroke is a theme variable, so Black and White overrides it with the rest. */
const COLORED = Object.fromEntries(DIAGRAM_COLORS.map((c) => [c, { stroke: colorVar(c), strokeOpacity: 0.85, strokeWidth: 1 }])) as Record<DiagramColor, Stroke>;

const TONES: Record<Tone, Stroke> = {
  ...COLORED,
  plain: { stroke: "var(--color-base-content)", strokeOpacity: 0.45, strokeWidth: 1 },
  hub: { stroke: "var(--color-primary)", strokeOpacity: 0.45, strokeWidth: 1 },
  selected: { stroke: "var(--color-primary)", strokeOpacity: 1, strokeWidth: 2 },
};

export const lineStyle = (tone: Tone) => TONES[tone];

/** Per tab: a tab hidden by `display: none`, or in Black and White, can't lend its markers to another. */
export const markerUrl = (tab: string, mark: Mark, tone: Tone) => `url(#fk-${tab}-${mark}-${tone})`;

const MIDDLE = MARK_HEIGHT / 2;

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
              <marker key={`${mark}-${tone}`} id={`fk-${tab}-${mark}-${tone}`} markerUnits="userSpaceOnUse" markerWidth={width} markerHeight={MARK_HEIGHT} refX={ref} refY={MIDDLE} orient="auto">
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
