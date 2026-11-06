import { NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { memo, useMemo } from "react";
import { DIAGRAM_FONT, measureText } from "../../lib/diagramBrowser";
import { annotationLines, lineHeight, NOTE_MIN_WIDTH, NOTE_PADDING } from "../../lib/diagramAnnotations";
import type { AnnotationNode } from "../../lib/diagramFlow";
import { useDiagrams } from "../../stores/diagram";
import { useDiagramId } from "./DiagramId";
import { noteStyle } from "./colorStyles";

/** A label or a note: text drawn line by line, since wrapping comes from the shared measuring, not CSS. */
export const AnnotationBox = memo(function AnnotationBox({ data, selected, width, height }: NodeProps<AnnotationNode>) {
  const tab = useDiagramId();
  const { annotation: a } = data;
  const editing = useDiagrams((s) => s.diagrams[tab]?.editing === a.id);
  const note = a.kind === "note";
  const line = lineHeight(a.fontSize);
  // While a drag resizes the node its width runs ahead of the saved one, and the lines follow it.
  const lines = useMemo(() => (note && width && width !== a.width ? annotationLines({ ...a, width }, measureText) : data.lines), [a, data.lines, note, width]);
  const text = { fontFamily: `${DIAGRAM_FONT}, system-ui, sans-serif`, fontSize: a.fontSize, fontWeight: a.bold ? 600 : 400, fontStyle: a.italic ? "italic" : "normal", lineHeight: `${line}px` };

  return (
    <>
      {/* Outside the clipped box: its handles straddle the edge, and half of each would be cut off. Its minimum height is one line: React Flow pushes a clamp the wrong way when the pointer holds still, so the text's height is applied in onNodesChange. */}
      {note && <NodeResizer isVisible={selected} minWidth={NOTE_MIN_WIDTH} minHeight={line + 2 * NOTE_PADDING} />}
      <div
        className={`relative overflow-hidden ${note ? "rounded-md shadow-sm" : "in-[.selected]:outline-1 in-[.selected]:outline-dashed in-[.selected]:outline-primary"}`}
        style={{ width, height, padding: NOTE_PADDING, ...text, ...(note ? noteStyle(a.color) : { color: "var(--color-base-content)" }) }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          useDiagrams.getState().startEditing(tab, a.id);
        }}
      >
        {editing ? (
          <textarea
            className="nodrag nokey nopan nowheel absolute inset-0 resize-none overflow-hidden bg-transparent outline-none"
            style={{ ...text, padding: NOTE_PADDING, whiteSpace: note ? "pre-wrap" : "pre" }}
            value={a.text}
            autoFocus
            onChange={(e) => useDiagrams.getState().updateAnnotation(tab, a.id, { text: e.target.value })}
            onBlur={() => useDiagrams.getState().stopEditing(tab)}
            onKeyDown={(e) => {
              if (e.key === "Escape") useDiagrams.getState().stopEditing(tab);
              // ⌘S and the like must still reach the window's listener.
              if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            }}
          />
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: "pre", minHeight: line }}>
              {l}
            </div>
          ))
        )}
      </div>
    </>
  );
});
