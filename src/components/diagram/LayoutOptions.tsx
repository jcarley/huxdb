import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { distanceChoices } from "../../lib/diagramLayout";
import type { DiagramLayoutQuality } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";

const QUALITIES: { value: DiagramLayoutQuality; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "normal", label: "Normal" },
];

/** Buttons rather than a `<select>`: a native list takes focus away, and showing every choice saves a click. */
export function Choice<T extends string | number>({ label, value, choices, onChange }: { label: string; value: T; choices: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="mb-3">
      <div className="mb-1">{label}</div>
      <div className="join flex">
        {choices.map((choice) => (
          <button key={choice.value} type="button" className={`btn btn-xs join-item flex-1 font-normal ${choice.value === value ? "btn-primary" : ""}`} aria-pressed={choice.value === value} onClick={() => onChange(choice.value)}>
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What Auto Layout does next, saved with the diagram. Open is state, not CSS focus, so it stays
 * open while options change and a layout runs, until a click outside or Escape.
 */
export function LayoutOptions({ id, runTitle, canRun, onRun }: { id: string; runTitle: string; canRun: boolean; onRun: () => void }) {
  const options = useDiagrams((s) => s.diagrams[id]?.options);
  const { setLayoutOptions } = useDiagrams.getState();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Capture, because React Flow stops the canvas's pointer events from bubbling.
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!options) return null;
  return (
    <div ref={root} className="relative">
      <button type="button" className={`btn btn-ghost btn-sm btn-square ${open ? "btn-active" : ""}`} title="Auto Layout Options" aria-label="Auto Layout Options" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SlidersHorizontal className="size-4 text-primary" strokeWidth={1.75} />
      </button>
      {open && (
        <div role="dialog" aria-label="Auto Layout Options" className="absolute top-full left-0 z-300 mt-1 w-64 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow-lg">
          <Choice label="Object distance" value={options.objectDistance} choices={distanceChoices(options.objectDistance).map((d) => ({ value: d, label: String(d) }))} onChange={(objectDistance) => setLayoutOptions(id, { objectDistance })} />
          <Choice label="Quality" value={options.layoutQuality} choices={QUALITIES} onChange={(layoutQuality) => setLayoutOptions(id, { layoutQuality })} />
          <label className="mb-3 flex items-center gap-2">
            <input type="checkbox" className="checkbox checkbox-xs" checked={options.groupBySchema} onChange={(e) => setLayoutOptions(id, { groupBySchema: e.target.checked })} />
            Group by schema
          </label>
          <button type="button" className="btn btn-primary btn-xs w-full" title={runTitle} disabled={!canRun} onClick={onRun}>
            Run Auto Layout
          </button>
        </div>
      )}
    </div>
  );
}
