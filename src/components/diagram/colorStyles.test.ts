import { describe, expect, it } from "vitest";
import { objectStyle, sharedColor } from "./colorStyles";

describe("objectStyle", () => {
  it("fills a table's header with the colour and its content text", () => {
    const { header, outline } = objectStyle("success", "table");
    expect(header).toEqual({ background: "var(--color-success)", color: "var(--color-success-content)" });
    expect(outline).toEqual({ borderColor: "var(--color-success)" });
  });

  it("tints a view's and a function's header, with base text", () => {
    for (const kind of ["view", "materialized-view", "function", "procedure"] as const) {
      const { header, outline } = objectStyle("error", kind);
      expect(header.background).toBe("color-mix(in oklab, var(--color-error) 20%, var(--color-base-100))");
      expect(header.color).toBe("var(--color-base-content)");
      expect(outline).toEqual({ borderColor: "var(--color-error)" });
    }
  });

  it("gives nothing for no colour", () => {
    expect(objectStyle(null, "table")).toEqual({ outline: {}, header: {} });
  });
});

describe("sharedColor", () => {
  it("is the colour all share, none if none has one, and mixed otherwise", () => {
    expect(sharedColor(["error", "error"])).toBe("error");
    expect(sharedColor([null, null])).toBeNull();
    expect(sharedColor(["error", null])).toBe("mixed");
    expect(sharedColor(["error", "info"])).toBe("mixed");
    expect(sharedColor([])).toBeNull();
  });
});
