import type { PointerEvent, ReactNode } from "react";
import { MIN_WIDTH } from "./columnWidths";

/** Scales with the font size. */
const ROW_HEADER_WIDTH = "2em";

/** The drag handle on a header's right edge; double-click fits the column. */
export function ResizeHandle({ onResize, onFit }: { onResize: (width: number) => void; onFit: () => void }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startWidth = handle.parentElement!.getBoundingClientRect().width;
    const startX = e.clientX;
    handle.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => onResize(Math.max(MIN_WIDTH, startWidth + m.clientX - startX));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize; double-click to fit"
      className="absolute top-0 -right-1 z-[3] h-full w-2 cursor-col-resize hover:bg-primary/40"
      onPointerDown={onPointerDown}
      onDoubleClick={onFit}
    />
  );
}

/** A grid's fixed-layout <table>: a row header column, then `widths` in px. The widths
 * live in a <colgroup>, so changing one doesn't touch the rows. */
export function SizedTable({ widths, children }: { widths: number[]; children: ReactNode }) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  return (
    <table
      // text-[1em]: daisyUI's .table sets its own font size; follow the grid's zoom instead.
      className="table table-pin-rows table-fixed border-separate border-spacing-0 text-[1em]"
      style={{ width: `calc(${ROW_HEADER_WIDTH} + ${total}px)` }}
    >
      <colgroup>
        <col style={{ width: ROW_HEADER_WIDTH }} />
        {widths.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      {children}
    </table>
  );
}
