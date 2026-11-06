import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useMemo } from "react";
import type { DependencyEdge } from "../../lib/diagramFlow";
import { DEPENDENCY_DASHES, routePath, STUB } from "../../lib/diagramLines";
import { useDiagramId } from "./DiagramId";
import { lineStyle, markerUrl } from "./FkMarkers";
import type { Tone } from "./FkMarkers";

/** A view or routine reading an object. From the reader's right side to the source's left, with an arrowhead at the source. */
export function DependencyLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<DependencyEdge>) {
  const tab = useDiagramId();
  const path = useMemo(() => {
    if (data?.points) return routePath([{ x: sourceX, y: sourceY }, ...data.points, { x: targetX, y: targetY }]);
    return getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0, offset: STUB })[0];
  }, [data?.points, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);
  if (!data) return null;

  const tone: Tone = selected ? "selected" : data.hub ? "hub" : "plain";
  return <BaseEdge id={id} path={path} markerEnd={markerUrl(tab, "reads", tone)} style={{ ...lineStyle(tone), strokeDasharray: DEPENDENCY_DASHES }} />;
}
