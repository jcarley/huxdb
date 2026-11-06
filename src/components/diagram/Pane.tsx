import type { ReactNode } from "react";
import { useDiagramPrefs } from "../../stores/diagramPrefs";
import { ResizablePane } from "../ResizablePane";

const MIN_WIDTH = 140;
const MAX_WIDTH = 480;

interface PaneProps {
  /** Which preference holds its width. */
  width: "objectsWidth" | "sideWidth";
  /** Which edge has the drag handle, next to the canvas. */
  handle: "left" | "right";
  children: ReactNode;
}

/** A diagram side pane, with its width kept in the diagram's preferences. */
export function Pane({ width, handle, children }: PaneProps) {
  const initial = useDiagramPrefs((s) => s[width]);
  return (
    <ResizablePane width={initial} onWidth={(next) => useDiagramPrefs.getState().setWidth(width, next)} min={MIN_WIDTH} max={MAX_WIDTH} handle={handle}>
      {children}
    </ResizablePane>
  );
}
