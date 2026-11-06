import type { CSSProperties } from "react";
import type { DiagramColor, DiagramObjectKind } from "../../lib/types";

/** Theme variables, so Black and White overrides them on the canvas's wrapper. */
export const colorVar = (color: DiagramColor) => `var(--color-${color})`;
export const contentVar = (color: DiagramColor) => `var(--color-${color}-content)`;

/** A note's fill is a tint, so its text stays readable in every theme. */
export function noteStyle(color: DiagramColor | null): CSSProperties {
  if (!color) return { background: "var(--color-base-200)", border: "1px solid var(--color-base-300)", color: "var(--color-base-content)" };
  return {
    background: `color-mix(in oklab, ${colorVar(color)} 20%, var(--color-base-100))`,
    border: `1px solid ${colorVar(color)}`,
    color: "var(--color-base-content)",
  };
}

/** A table's header is the solid colour; any other object's is a tint, like a note's, so the dashed kinds stay light. */
export function objectStyle(color: DiagramColor | null, kind: DiagramObjectKind): { outline: CSSProperties; header: CSSProperties } {
  if (!color) return { outline: {}, header: {} };
  // Only the colour: the kind's classes keep its dashes and width.
  const outline = { borderColor: colorVar(color) };
  if (kind === "table") return { outline, header: { background: colorVar(color), color: contentVar(color) } };
  return { outline, header: { background: `color-mix(in oklab, ${colorVar(color)} 20%, var(--color-base-100))`, color: "var(--color-base-content)" } };
}

/** What a selection's colours amount to: one shared colour, none, or a mix. */
export function sharedColor(colors: (DiagramColor | null)[]): DiagramColor | null | "mixed" {
  const first = colors[0] ?? null;
  return colors.every((c) => c === first) ? first : "mixed";
}
