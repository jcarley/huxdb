import { describe, expect, it } from "vitest";
import {
  NOTE_PADDING,
  annotationBox,
  annotationLines,
  annotationTitle,
  fitNote,
  bottomZ,
  isAnnotationId,
  lineHeight,
  newAnnotation,
  newAnnotationId,
  objectNodes,
  topZ,
  wrapText,
} from "./diagramAnnotations";
import type { DiagramAnnotation } from "./types";

const measure = (s: string) => s.length * 10;
const measureFull = (s: string, _bold: boolean, _size: number) => s.length * 10;
const note: DiagramAnnotation = { ...newAnnotation("note", { x: 0, y: 0 }, 1), fontSize: 10 };
const label: DiagramAnnotation = { ...newAnnotation("label", { x: 0, y: 0 }, 1), fontSize: 10 };

describe("fitNote", () => {
  const n = { ...note, text: "aaa bbb ccc ddd", width: 200, height: 20 };
  it("grows the height when a narrower width wraps to more lines", () => {
    // Text area is the width less both paddings, 10px a letter: 200 holds all 15 letters, 130 wraps "ddd".
    expect(fitNote(n, { width: 200, height: 20 }, measureFull)).toEqual({ width: 200, height: 14 + 2 * NOTE_PADDING });
    expect(fitNote(n, { width: 130, height: 20 }, measureFull)).toEqual({ width: 130, height: 2 * 14 + 2 * NOTE_PADDING });
  });
  it("keeps a height the user made larger", () => expect(fitNote(n, { width: 200, height: 300 }, measureFull)).toEqual({ width: 200, height: 300 }));
  it("keeps the width at the minimum", () => expect(fitNote(n, { width: 40, height: 20 }, measureFull).width).toBe(120));
});

describe("wrapText", () => {
  it("wraps at spaces", () => expect(wrapText("aaa bbb ccc", 75, measure)).toEqual(["aaa bbb", "ccc"]));
  it("keeps blank lines and line breaks", () => expect(wrapText("a\n\nb", 100, measure)).toEqual(["a", "", "b"]));
  it("breaks a word wider than the box by character", () =>
    expect(wrapText("aaaaaaaaaaaa", 50, measure)).toEqual(["aaaaa", "aaaaa", "aa"]));
  it("expands tabs, which measure as nothing", () => expect(wrapText("a\tb", 100, measure)).toEqual(["a    b"]));
  it("keeps the space after a broken word", () =>
    expect(wrapText("cccccccccccc dd", 50, measure)).toEqual(["ccccc", "ccccc", "cc dd"]));
  it("keeps a line of only spaces as one line", () => expect(wrapText("   ", 100, measure)).toEqual([""]));
  it("fits a word exactly the width", () => expect(wrapText("aaaaa bbbbb", 50, measure)).toEqual(["aaaaa", "bbbbb"]));
  it("breaks a long word after a short one", () => expect(wrapText("a cccccccccc", 50, measure)).toEqual(["a", "ccccc", "ccccc"]));
  it("puts one character on a line when the width is smaller than one", () =>
    expect(wrapText("abc", 5, measure)).toEqual(["a", "b", "c"]));
  it("doesn't split an emoji", () => expect(wrapText("😀😀😀", 20, measure)).toEqual(["😀", "😀", "😀"]));
  it("emits no empty first line for leading spaces before a long word", () =>
    expect(wrapText(" cccccccccc", 50, measure)).toEqual([" cccc", "ccccc", "c"]));
  it("gives empty text one line", () => expect(wrapText("", 100, measure)).toEqual([""]));
});

describe("annotation boxes", () => {
  it("defaults", () => {
    expect(note).toMatchObject({ width: 200, height: 100, color: "warning", bold: false, italic: false });
    expect(newAnnotation("label", { x: 1, y: 2 }, 3)).toMatchObject({ x: 1, y: 2, z: 3, fontSize: 12, color: null });
  });
  it("grows a note to fit its text", () => {
    const n = { ...note, text: "a\nb\nc", width: 200, height: 20 };
    expect(lineHeight(10)).toBe(14);
    expect(annotationBox(n, measureFull)).toEqual({ width: 200, height: 3 * 14 + 2 * NOTE_PADDING });
  });
  it("keeps a note's own height when the text fits", () => {
    expect(annotationBox({ ...note, text: "a", height: 200 }, measureFull)).toEqual({ width: 200, height: 200 });
  });
  it("wraps a note to its padded width", () => {
    expect(annotationLines({ ...note, text: "aaa bbb ccc", width: 75 + 2 * NOTE_PADDING }, measureFull)).toEqual(["aaa bbb", "ccc"]);
  });
  it("sizes a label to its longest line and never wraps it", () => {
    const l = { ...label, text: "aaaa bbbb\ncc", width: 10 };
    expect(annotationLines(l, measureFull)).toEqual(["aaaa bbbb", "cc"]);
    expect(annotationBox(l, measureFull)).toEqual({ width: 90 + 2 * NOTE_PADDING, height: 2 * 14 + 2 * NOTE_PADDING });
  });
});

describe("annotation helpers", () => {
  it("says what an empty annotation is", () => expect(annotationTitle({ ...note, text: " \n" })).toBe("(empty note)"));
  it("titles an annotation by its first line, cut short", () => {
    expect(annotationTitle({ ...note, text: "first\nsecond" })).toBe("first");
    expect(annotationTitle({ ...note, text: "x".repeat(50) })).toBe("x".repeat(40) + "…");
  });
  it("tells annotation ids from object ids", () => {
    expect(isAnnotationId(newAnnotationId())).toBe(true);
    expect(isAnnotationId("-42")).toBe(false);
  });
  it("stacks above and below what's there", () => {
    const list = [{ z: 3 }, { z: -1 }];
    expect(topZ(list)).toBe(4);
    expect(bottomZ(list)).toBe(-2);
    expect(topZ([])).toBe(1);
    expect(bottomZ([])).toBe(-1);
  });
  it("drops annotation ids from a selection", () => expect(objectNodes(["1", newAnnotationId(), "-5"])).toEqual(["1", "-5"]));
});
