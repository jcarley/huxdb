import { describe, expect, it } from "vitest";
import { groupCandidates, startingTicks } from "./diagramPicker";
import type { DiagramCandidate } from "./types";

const c = (oid: number, schema: string, name: string, kind: DiagramCandidate["kind"], signature: string | null = null): DiagramCandidate => ({ oid, schema, name, kind, signature });

const tableInPublic = c(1, "public", "orders", "table");
const candidates = [
  c(2, "public", "add", "function", "a integer, b integer"),
  c(3, "public", "refresh", "procedure", ""),
  c(4, "public", "big", "materialized-view"),
  c(5, "public", "recent", "view"),
  tableInPublic,
  c(6, "other", "t", "table"),
  c(7, "other", "v", "view"),
];

describe("diagram picker", () => {
  it("starts with only this schema's tables ticked", () => {
    expect(startingTicks(candidates, "public")).toEqual([tableInPublic.oid]);
  });
  it("groups by schema, then by kind in a fixed order", () => {
    expect(groupCandidates(candidates, "").get("public")!.map(([kind]) => kind)).toEqual(["table", "view", "materialized-view", "function", "procedure"]);
  });
  it("searches a function's signature as well as its name", () => {
    const found = groupCandidates(candidates, "integer");
    expect([...found.keys()]).toEqual(["public"]);
    expect(found.get("public")!.flatMap(([, list]) => list.map((x) => x.oid))).toEqual([2]);
  });
  it("drops empty kinds and schemas", () => {
    expect(groupCandidates(candidates, "zzz").size).toBe(0);
  });
});
