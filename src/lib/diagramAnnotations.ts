// Labels and notes on the diagram canvas: pure helpers, with measuring passed in.
import type { Box, Measure, Point } from "./diagramLayout";
import type { DiagramAnnotation, DiagramColor } from "./types";

export const DIAGRAM_COLORS: DiagramColor[] = ["primary", "secondary", "accent", "info", "success", "warning", "error"];
export const ANNOTATION_FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 20, 24];
export const NOTE_PADDING = 8;
export const NOTE_MIN_WIDTH = 120;
/** How far a pasted annotation lands from its original. */
export const PASTE_OFFSET = 20;

const ID_PREFIX = "a:";
const TITLE_LENGTH = 40;

export function lineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.4);
}

/** Object ids are numbers (OIDs, or negative for tables not yet created), so the prefix tells them apart. */
export function isAnnotationId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** What may go to the database side: the selection without its notes and labels. */
export function objectNodes(ids: string[]): string[] {
  return ids.filter((id) => !isAnnotationId(id));
}

export function newAnnotationId(): string {
  return ID_PREFIX + crypto.randomUUID();
}

/** Wraps at spaces, breaking a word wider than `width` by character. A line's trailing space doesn't count. */
export function wrapText(text: string, width: number, measure: (line: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.replace(/\t/g, "    ").split("\n")) {
    let current = "";
    for (const word of paragraph.match(/[^ ]* */g)?.filter((w) => w !== "") ?? []) {
      if (measure((current + word).trimEnd()) <= width) {
        current += word;
        continue;
      }
      // Leading spaces alone aren't a line: they stay in front of the word.
      if (current.trim() !== "") {
        out.push(current.trimEnd());
        current = "";
      }
      if (measure(word.trimEnd()) <= width) {
        current = word;
        continue;
      }
      // One word wider than the box: fill each line with as many characters as fit, at least one.
      for (const ch of Array.from(word.trimEnd())) {
        if (current !== "" && measure(current + ch) > width) {
          out.push(current);
          current = "";
        }
        current += ch;
      }
      current += word.slice(word.trimEnd().length); // the separator survives the break
    }
    out.push(current.trimEnd());
  }
  return out;
}

/** Inter's italic isn't bundled, so the browser slants the regular face at the same widths: italic isn't measured. */
export function annotationLines(a: DiagramAnnotation, measure: Measure): string[] {
  if (a.kind === "label") return a.text.replace(/\t/g, "    ").split("\n");
  return wrapText(a.text, a.width - 2 * NOTE_PADDING, (line) => measure(line, a.bold, a.fontSize));
}

export function annotationBox(a: DiagramAnnotation, measure: Measure): Box {
  const lines = annotationLines(a, measure);
  const height = lines.length * lineHeight(a.fontSize) + 2 * NOTE_PADDING;
  if (a.kind === "note") return { width: a.width, height: Math.max(a.height, height) };
  const widest = Math.max(...lines.map((line) => measure(line, a.bold, a.fontSize)));
  return { width: Math.ceil(widest) + 2 * NOTE_PADDING, height };
}

/** A resize's size held to the minimum width and to the text at that width. A size taken from the pointer alone can be shorter than the lines it now wraps to. */
export function fitNote(a: DiagramAnnotation, size: Box, measure: Measure): Box {
  const width = Math.max(size.width, NOTE_MIN_WIDTH);
  return annotationBox({ ...a, width, height: size.height }, measure);
}

export function newAnnotation(kind: "label" | "note", at: Point, z: number): DiagramAnnotation {
  const note = kind === "note";
  return {
    id: newAnnotationId(),
    kind,
    x: at.x,
    y: at.y,
    width: note ? 200 : 0,
    height: note ? 100 : 0,
    text: "",
    fontSize: 12,
    bold: false,
    italic: false,
    color: note ? "warning" : null,
    z,
  };
}

export function topZ(list: { z: number }[]): number {
  return list.length === 0 ? 1 : Math.max(...list.map((a) => a.z)) + 1;
}

export function bottomZ(list: { z: number }[]): number {
  return list.length === 0 ? -1 : Math.min(...list.map((a) => a.z)) - 1;
}

export function annotationTitle(a: DiagramAnnotation): string {
  const first = a.text.split("\n").find((line) => line.trim() !== "")?.trim();
  if (!first) return `(empty ${a.kind})`;
  const chars = Array.from(first);
  return chars.length > TITLE_LENGTH ? chars.slice(0, TITLE_LENGTH).join("") + "…" : first;
}
