import { describe, expect, it } from "vitest";
import { childEnd, lineKind, parentEnd, relationshipFacts, relationshipNotes } from "./diagramCardinality";
import type { DiagramForeignKey } from "./types";

const fk: DiagramForeignKey = {
  oid: 1,
  name: "fk",
  childOid: 1,
  parentOid: 2,
  childColumns: ["a"],
  parentColumns: ["id"],
  childPartition: null,
  parentPartition: null,
  matchType: "s",
  onUpdate: "a",
  onDelete: "a",
  childRequiresParent: false,
  uniqueVia: null,
  validated: true,
  enforced: true,
};

describe("the marks", () => {
  it("makes the parent required when the child needs one", () => {
    expect(parentEnd(fk)).toBe("zero-or-one");
    expect(parentEnd({ ...fk, childRequiresParent: true })).toBe("one");
  });

  it("limits the child to one when a unique index says so, and never requires it", () => {
    expect(childEnd(fk)).toBe("zero-or-many");
    expect(childEnd({ ...fk, uniqueVia: "uq" })).toBe("zero-or-one");
  });
});

describe("lineKind", () => {
  it("marks keys that aren't checked", () => {
    expect(lineKind(fk)).toBe("plain");
    expect(lineKind({ ...fk, validated: false })).toBe("unchecked");
    expect(lineKind({ ...fk, enforced: false })).toBe("unchecked");
  });

  it("marks lines rolled up from a partition, at either end", () => {
    expect(lineKind({ ...fk, childPartition: "p" })).toBe("partition");
    expect(lineKind({ ...fk, parentPartition: "p" })).toBe("partition");
  });

  it("shows an unchecked key as unchecked even on a partition", () => {
    expect(lineKind({ ...fk, childPartition: "p", validated: false })).toBe("unchecked");
  });
});

describe("relationshipFacts", () => {
  it("states an optional, many-sided line", () => {
    expect(relationshipFacts(fk, "orders", "users")).toEqual(["Each orders row can have one users row.", "Each users row can have many orders rows."]);
  });

  it("states a required, one-sided line", () => {
    expect(relationshipFacts({ ...fk, childRequiresParent: true, uniqueVia: "uq" }, "orders", "users")).toEqual(["Each orders row needs one users row.", "Each users row can have one orders row."]);
  });
});

describe("relationshipNotes", () => {
  it("always says what the child end's zero means", () => {
    expect(relationshipNotes(fk)).toEqual([expect.stringContaining("can't express that a parent must have children")]);
  });

  it("says a key isn't enforced rather than not validated, when it's both", () => {
    const notes = relationshipNotes({ ...fk, enforced: false, validated: false });
    expect(notes.filter((n) => n.startsWith("Not "))).toEqual([expect.stringContaining("Not enforced")]);
    expect(relationshipNotes({ ...fk, validated: false })[1]).toContain("Not validated");
  });

  it("names the partition", () => {
    expect(relationshipNotes({ ...fk, childPartition: "logs_a" })[1]).toContain("logs_a");
    expect(relationshipNotes({ ...fk, parentPartition: "years_a" })[1]).toContain("years_a");
  });
});
