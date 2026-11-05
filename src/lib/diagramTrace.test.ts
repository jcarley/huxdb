import { describe, expect, it } from "vitest";
import { sourceLabel } from "./diagramTrace";

describe("sourceLabel", () => {
  it("names a column's source", () => {
    expect(sourceLabel({ schema: "s", relation: "emp", column: "id" }, false)).toBe("emp.id");
    expect(sourceLabel({ schema: "s", relation: "emp", column: "id" }, true)).toBe("s.emp.id");
  });
  it("names a whole row by its table", () => {
    expect(sourceLabel({ schema: "s", relation: "emp", column: null }, false)).toBe("emp");
  });
  it("says (Expression) for a column with no origin", () => {
    expect(sourceLabel(null, false)).toBe("(Expression)");
  });
});
