// The browser side of diagram layout: ELK's worker and text measuring.

import ELK from "elkjs/lib/elk-api";
import type { ElkNode } from "elkjs/lib/elk-api";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

/** Bundled so sizes don't vary by platform. They feed layout, so one measurement serves everything. */
export const DIAGRAM_FONT = "Inter";
const font = (bold: boolean, size: number) => `${bold ? 600 : 400} ${size}px ${DIAGRAM_FONT}, system-ui, sans-serif`;

let elk: InstanceType<typeof ELK> | null = null;
let context: CanvasRenderingContext2D | null = null;

/** The worker is 1.6 MB, so it starts with the first diagram. */
export const runElk = (graph: ElkNode) => (elk ??= new ELK({ workerFactory: () => new Worker(workerUrl) })).layout(graph);

export function measureText(text: string, bold: boolean, size: number) {
  context ??= document.createElement("canvas").getContext("2d")!;
  context.font = font(bold, size);
  return context.measureText(text).width;
}

/** Measuring before the font loads would size every table for a fallback font. */
export const fontsReady = () => Promise.all([document.fonts.load(font(false, 11)), document.fonts.load(font(true, 11))]);
