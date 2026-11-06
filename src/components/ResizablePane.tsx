import { useRef } from "react";
import type { MouseEvent, ReactNode } from "react";

interface ResizablePaneProps {
  width: number;
  /** Called with the final width when a drag ends. */
  onWidth: (width: number) => void;
  min: number;
  max: number;
  /** Which edge has the drag handle. */
  handle: "left" | "right";
  /** Hides the pane and its handle but keeps the content mounted. */
  hidden?: boolean;
  /** A CSS limit that depends on the window, on top of `max`. */
  maxWidthCss?: string;
  children: ReactNode;
}

/** A side pane. Dragging sets its width on the element, so nothing re-renders until the drag ends. */
export function ResizablePane({ width, onWidth, min, max, handle, hidden, maxWidthCss, children }: ResizablePaneProps) {
  const pane = useRef<HTMLDivElement>(null);

  const startDrag = (e: MouseEvent) => {
    e.preventDefault();
    const element = pane.current;
    if (!element) return;
    const startX = e.clientX;
    const startWidth = element.offsetWidth;
    const widthAt = (x: number) => Math.min(max, Math.max(min, startWidth + (handle === "right" ? x - startX : startX - x)));
    let moved = false;
    const onMove = (move: globalThis.MouseEvent) => {
      moved = true;
      element.style.width = `${widthAt(move.clientX)}px`;
    };
    const onUp = (up: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // A click isn't a resize: the width on screen may be held back by `maxWidthCss`, and saving it would lose the real one.
      if (moved) onWidth(widthAt(up.clientX));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const separator = <div role="separator" aria-orientation="vertical" className={`w-1.5 shrink-0 cursor-col-resize border-x border-base-300 bg-base-200 hover:bg-primary/30 ${hidden ? "hidden" : ""}`} onMouseDown={startDrag} />;
  return (
    <>
      {handle === "left" && separator}
      <div ref={pane} className={`min-h-0 shrink-0 flex-col ${hidden ? "hidden" : "flex"}`} style={{ width, maxWidth: maxWidthCss }}>
        {children}
      </div>
      {handle === "right" && separator}
    </>
  );
}
