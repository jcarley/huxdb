import { BaseEdge, getSmoothStepPath, useStore } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useMemo } from "react";
import { DIAGRAM_FONT } from "../../lib/diagramBrowser";
import type { FkEdge } from "../../lib/diagramFlow";
import { FK_DASHES, NAME_LIFT, namePlace, routePath, selfLoop, selfLoopNamePlace, shortName, STUB } from "../../lib/diagramLines";
import { useDiagrams } from "../../stores/diagram";
import { useDiagramId } from "./DiagramId";
import { lineStyle, markerUrl } from "./FkMarkers";
import type { Tone } from "./FkMarkers";

/** Below this zoom a name can't be read, and hundreds of them only make noise. */
const NAMES_FROM_ZOOM = 0.5;

/** SVG text, not `EdgeLabelRenderer`: it adds no DOM element per name, and it's in the picture for export. */
function FkName({ name, x, y, fontSize }: { name: string; x: number; y: number; fontSize: number }) {
  const shown = useStore((s) => s.transform[2] >= NAMES_FROM_ZOOM);
  if (!shown) return null;
  return (
    <text x={x} y={y - NAME_LIFT} fontSize={fontSize} style={{ fontFamily: `${DIAGRAM_FONT}, system-ui, sans-serif`, fill: "var(--color-base-content)", stroke: "var(--color-base-100)", strokeWidth: 3, paintOrder: "stroke", pointerEvents: "auto" }}>
      <title>{name}</title>
      {shortName(name)}
    </text>
  );
}

/** ELK's route when it still holds, otherwise a plain path between the two columns. */
export function FkLine({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<FkEdge>) {
  const tab = useDiagramId();
  // Zero when names are off, so each line subscribes to one number.
  const nameSize = useDiagrams((s) => {
    const options = s.diagrams[tab]?.options;
    return options?.showRelationshipNames ? options.fontSize - 1 : 0;
  });
  // The line's own colour, if any, by its constraint's key.
  const color = useDiagrams((s) => (data ? s.diagrams[tab]?.colors.lines[data.key] : undefined));
  const self = source === target;
  const path = useMemo(() => {
    if (self) return selfLoop(sourceX, sourceY, targetY);
    if (data?.points) return routePath([{ x: sourceX, y: sourceY }, ...data.points, { x: targetX, y: targetY }]);
    // Square corners, so a line looks the same before and after its table moves.
    return getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0, offset: STUB })[0];
  }, [data?.points, self, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);
  if (!data) return null;

  const tone: Tone = selected ? "selected" : color ?? (data.hub ? "hub" : "plain");
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerUrl(tab, `child-${data.childEnd}`, tone)} markerEnd={markerUrl(tab, `parent-${data.parentEnd}`, tone)} style={{ ...lineStyle(tone), strokeDasharray: FK_DASHES[data.kind] }} />
      {nameSize > 0 && <FkName name={data.name} {...(self ? selfLoopNamePlace(sourceX, sourceY, targetY) : namePlace(sourceX, sourceY))} fontSize={nameSize} />}
    </>
  );
}
