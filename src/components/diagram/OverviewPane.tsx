import { MiniMap, useReactFlow, useStore } from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_ZOOM, MIN_ZOOM, sliderFromZoom, stepZoom, ZOOM_STEPS, zoomFromSlider, zoomLabel } from "../../lib/diagramZoom";

const MINIMAP_HEIGHT = 170;

/**
 * The mini-map and zoom controls. `<MiniMap>` sits outside `<ReactFlow>` here, under the same
 * provider. That works but isn't documented, so check it when upgrading React Flow. Theme
 * variables don't reach it out here, so its colours are set directly. Its width must be a
 * number: it divides by it, so "100%" draws a solid block. This measures the pane instead.
 */
export function OverviewPane() {
  const flow = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const zoomTo = (next: number) => void flow.zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  const pane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!pane.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={pane} className="shrink-0 border-t border-base-300" aria-label="Overview">
      <MiniMap pannable zoomable style={{ position: "static", margin: 0, width: width || 1, height: MINIMAP_HEIGHT }} bgColor="#ffffff" nodeColor="#4a7ab5" maskColor="rgba(120,130,145,0.25)" maskStrokeColor="#2d7dd2" maskStrokeWidth={2} />
      <div className="flex items-center gap-1 border-t border-base-300 px-1 py-1">
        <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Zoom Out" title="Zoom Out (⌘−)" onClick={() => zoomTo(stepZoom(zoom, -1))}>
          <Minus className="size-3.5" />
        </button>
        <input type="range" className="range range-xs min-w-0 flex-1" aria-label="Zoom" min={0} max={100} step={0.5} value={sliderFromZoom(zoom)} onChange={(e) => zoomTo(zoomFromSlider(Number(e.target.value)))} />
        <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Zoom In" title="Zoom In (⌘+)" onClick={() => zoomTo(stepZoom(zoom, 1))}>
          <Plus className="size-3.5" />
        </button>
        <select className="select select-xs w-16 px-1" aria-label="Zoom Level" value="" onChange={(e) => zoomTo(Number(e.target.value))}>
          <option value="" hidden>
            {zoomLabel(zoom)}
          </option>
          {ZOOM_STEPS.map((step) => (
            <option key={step} value={step}>
              {zoomLabel(step)}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label="Fit" title="Fit the Diagram" onClick={() => void flow.fitView({ minZoom: MIN_ZOOM, maxZoom: 1, padding: 0.03 })}>
          <Maximize className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
