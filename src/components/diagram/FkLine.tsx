import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useMemo } from "react";
import type { FkEdge } from "../../lib/diagramFlow";

/** ELK's route when it still holds, otherwise a plain path between the two columns. */
export function FkLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<FkEdge>) {
  const path = useMemo(() => {
    if (data?.points) {
      const route = [{ x: sourceX, y: sourceY }, ...data.points, { x: targetX, y: targetY }];
      return route.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
    }
    return getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0];
  }, [data?.points, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);

  return <BaseEdge id={id} path={path} style={{ stroke: selected || data?.hub ? "var(--color-primary)" : "var(--color-base-content)", strokeOpacity: selected ? 1 : 0.45, strokeWidth: selected ? 2 : 1 }} />;
}
