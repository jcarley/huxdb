import { describe, expect, it } from "vitest";
import { annotationKeyAction } from "./diagramKeys";

const k = (key: string, meta = false, more = {}) => ({ key, meta, inField: false, textSelected: false, ...more });

describe("annotationKeyAction", () => {
  it("deletes selected annotations", () => expect(annotationKeyAction(k("Backspace"), ["a:1"], false)).toBe("delete"));
  it("leaves Backspace to a text field", () => expect(annotationKeyAction(k("Backspace", false, { inField: true }), ["a:1"], false)).toBeNull());
  it("ignores a selection of objects", () => expect(annotationKeyAction(k("Delete"), ["1"], false)).toBeNull());
  it("acts on a mixed selection", () => expect(annotationKeyAction(k("Delete"), ["1", "a:1"], false)).toBe("delete"));
  it("copies", () => expect(annotationKeyAction(k("c", true), ["a:1"], false)).toBe("copy"));
  it("leaves copying to selected text", () => expect(annotationKeyAction(k("c", true, { textSelected: true }), ["a:1"], false)).toBeNull());
  it("pastes only with something to paste", () => {
    expect(annotationKeyAction(k("v", true), [], true)).toBe("paste");
    expect(annotationKeyAction(k("v", true), [], false)).toBeNull();
  });
  it("leaves paste to selected text", () => expect(annotationKeyAction(k("v", true, { textSelected: true }), [], true)).toBeNull());
  it("leaves paste to a text field", () => expect(annotationKeyAction(k("v", true, { inField: true }), [], true)).toBeNull());
});
