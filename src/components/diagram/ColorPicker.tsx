import { DIAGRAM_COLORS } from "../../lib/diagramAnnotations";
import type { DiagramColor } from "../../lib/types";
import { colorVar } from "./colorStyles";

/** Swatches of the fixed palette. Buttons rather than a menu, so a click never moves focus off the canvas's selection. */
export function ColorPicker({ value, onChange, allowNone, mixed }: { value: DiagramColor | null; mixed?: boolean; onChange: (color: DiagramColor | null) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Colour">
      {allowNone && (
        <button type="button" className={`btn btn-xs ${value === null && !mixed ? "btn-active" : ""}`} aria-pressed={value === null && !mixed} onClick={() => onChange(null)}>
          None
        </button>
      )}
      {DIAGRAM_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={!mixed && value === color}
          title={color}
          className={`size-5 rounded-full border border-base-content/30 ${!mixed && value === color ? "ring-2 ring-base-content ring-offset-1 ring-offset-base-100" : ""}`}
          style={{ background: colorVar(color) }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
