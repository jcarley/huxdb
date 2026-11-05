import { useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useDiagramPrefs } from "../../stores/diagramPrefs";

const MIN_WIDTH = 140;
const MAX_WIDTH = 480;

interface PaneProps {
  /** Which preference holds its width. */
  width: "objectsWidth" | "sideWidth";
  /** Which edge has the drag handle, next to the canvas. */
  handle: "left" | "right";
  children: ReactNode;
}

/** A side pane. Dragging sets its width on the element, so nothing re-renders until the drag ends. */
export function Pane({ width, handle, children }: PaneProps) {
  const initial = useDiagramPrefs((s) => s[width]);
  const pane = useRef<HTMLDivElement>(null);

  const startDrag = (e: MouseEvent) => {
    e.preventDefault();
    const element = pane.current;
    if (!element) return;
    const startX = e.clientX;
    const startWidth = element.offsetWidth;
    const widthAt = (x: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (handle === "right" ? x - startX : startX - x)));
    const onMove = (move: globalThis.MouseEvent) => {
      element.style.width = `${widthAt(move.clientX)}px`;
    };
    const onUp = (up: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      useDiagramPrefs.getState().setWidth(width, widthAt(up.clientX));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const separator = <div role="separator" aria-orientation="vertical" className="w-1.5 shrink-0 cursor-col-resize border-x border-base-300 bg-base-200 hover:bg-primary/30" onMouseDown={startDrag} />;
  return (
    <>
      {handle === "left" && separator}
      <div ref={pane} className="flex min-h-0 shrink-0 flex-col" style={{ width: initial }}>
        {children}
      </div>
      {handle === "right" && separator}
    </>
  );
}
