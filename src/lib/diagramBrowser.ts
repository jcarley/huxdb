// The browser side of diagram layout: ELK's worker and text measuring.

import ELK from "elkjs/lib/elk-api";
import type { ElkNode } from "elkjs/lib/elk-api";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

/** Bundled so sizes don't vary by platform. They feed layout, so one measurement serves everything. */
export const DIAGRAM_FONT = "Inter";
const font = (bold: boolean, size: number) => `${bold ? 600 : 400} ${size}px ${DIAGRAM_FONT}, system-ui, sans-serif`;

type Elk = InstanceType<typeof ELK>;

let elk: Elk | null = null;
let context: CanvasRenderingContext2D | null = null;

const startElk = () => new ELK({ workerFactory: () => new Worker(workerUrl) });

/** The worker is 1.6 MB, so it starts with the first diagram. */
export const runElk = (graph: ElkNode) => (elk ??= startElk()).layout(graph);

export interface LayoutJob {
  run: (graph: ElkNode) => Promise<ElkNode>;
  /** Stops ELK mid-graph, and rejects what's waiting on it. */
  cancel: () => void;
  /** Hands back a worker that's still alive. */
  finish: () => void;
}

/**
 * A cancellable layout, on a worker of its own: cancelling can only stop a worker, and a shared
 * one could be working for another tab. Terminating leaves ELK's promise pending for ever, so
 * each graph races a rejection that `cancel` fires.
 */
export function startLayout(): LayoutJob {
  const worker = elk ?? startElk();
  elk = null;
  let cancelled = false;
  let reject: ((reason: Error) => void) | null = null;
  const stopped = () => new Error("Layout cancelled");
  return {
    run: (graph) =>
      new Promise((resolve, fail) => {
        if (cancelled) return fail(stopped());
        reject = fail;
        worker.layout(graph).then(resolve, fail);
      }),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      worker.terminateWorker();
      reject?.(stopped());
    },
    finish: () => {
      if (cancelled) return;
      if (elk) worker.terminateWorker();
      else elk = worker;
    },
  };
}

export function measureText(text: string, bold: boolean, size: number) {
  context ??= document.createElement("canvas").getContext("2d")!;
  context.font = font(bold, size);
  return context.measureText(text).width;
}

/** Measuring before the font loads would size every table for a fallback font. */
export const fontsReady = () => Promise.all([document.fonts.load(font(false, 11)), document.fonts.load(font(true, 11))]);
