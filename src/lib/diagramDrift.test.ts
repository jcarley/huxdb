import { describe, expect, it } from "vitest";
import { compareStructure, foreignKeyKey, reportCount, resolveOids, tableKey } from "./diagramDrift";
import type { DiagramCandidate, DiagramColumn, DiagramForeignKey, DiagramStructure, DiagramTable } from "./types";

const column = (name: string, dataType = "integer", more: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, dataType, notNull: false, primaryKey: false, comment: null, ...more });
const table = (oid: number, name: string, columns = [column("id")], schema = "public"): DiagramTable => ({ oid, schema, name, comment: null, columns });
const fk = (oid: number, name: string, childOid: number, parentOid: number, childColumns = ["a"], parentColumns = ["id"]): DiagramForeignKey => ({ oid, name, childOid, parentOid, childColumns, parentColumns, rolledUp: false, matchType: "s", onUpdate: "a", onDelete: "a" });
const candidate = ({ oid, schema, name }: DiagramTable): DiagramCandidate => ({ oid, schema, name });
const structure = (tables: DiagramTable[], foreignKeys: DiagramForeignKey[] = []): DiagramStructure => ({ tables, foreignKeys });
const compare = (saved: DiagramStructure, current: DiagramStructure, extra: DiagramCandidate[] = [], known = saved.tables.map(tableKey)) =>
  compareStructure(saved, known, current, [...current.tables.map(candidate), ...extra]);

describe("keys", () => {
  it("can't be confused by a dot in a name", () => {
    expect(tableKey({ schema: "a.b", name: "c" })).not.toBe(tableKey({ schema: "a", name: "b.c" }));
  });

  it("are case-sensitive", () => {
    expect(tableKey({ schema: "public", name: "Users" })).not.toBe(tableKey({ schema: "public", name: "users" }));
  });

  it("scope a constraint name to its table", () => {
    const key = fk(1, "orders_cust_fkey", 1, 2);
    expect(foreignKeyKey(key, { schema: "public", name: "a" })).not.toBe(foreignKeyKey(key, { schema: "public", name: "b" }));
  });
});

describe("resolveOids", () => {
  it("finds tables by name, because a dropped and re-created table has a new OID", () => {
    const snapshot = structure([table(1, "a"), table(2, "gone")]);
    expect(resolveOids(snapshot, [{ oid: 9, schema: "public", name: "a" }])).toEqual([9]);
  });
});

describe("compareStructure", () => {
  it("reports nothing for an unchanged database", () => {
    const s = structure([table(1, "a"), table(2, "b")], [fk(5, "f", 1, 2)]);
    expect(reportCount(compare(s, s))).toBe(0);
  });

  it("ignores a re-created table's new OIDs", () => {
    const before = structure([table(1, "a"), table(2, "b")], [fk(5, "f", 1, 2)]);
    const after = structure([table(11, "a"), table(12, "b")], [fk(15, "f", 11, 12)]);
    expect(reportCount(compare(before, after))).toBe(0);
  });

  it("describes each kind of column change", () => {
    const before = structure([table(1, "a", [column("id"), column("gone"), column("n"), column("o")])]);
    const after = structure([table(1, "a", [column("id"), column("new"), column("n", "bigint"), column("o", "integer", { notNull: true })])]);
    expect(compare(before, after).modified[0].changes).toEqual(["Column new added", "Column gone removed", "Column n: integer → bigint", "Column o: now NOT NULL"]);
  });

  it("notices a changed primary key, and doesn't care about column order", () => {
    const before = structure([table(1, "a", [column("x"), column("y")])]);
    const pk = structure([table(1, "a", [column("x", "integer", { primaryKey: true }), column("y")])]);
    expect(compare(before, pk).modified[0].changes).toEqual(["Primary key: () → (x)"]);
    const reordered = structure([table(1, "a", [column("y"), column("x")])]);
    expect(reportCount(compare(before, reordered))).toBe(0);
  });

  it("reports a removed table, without offering a rename when its OID is gone too", () => {
    const report = compare(structure([table(1, "a"), table(2, "b")]), structure([table(1, "a")]));
    expect(report.removed).toEqual([{ key: tableKey({ schema: "public", name: "b" }), schema: "public", name: "b", renamedTo: null }]);
  });

  it("offers a possible rename when the OID has a new name, and doesn't also call it added", () => {
    const saved = structure([table(1, "old")]);
    const report = compare(saved, structure([]), [{ oid: 1, schema: "public", name: "new" }]);
    expect(report.removed[0].renamedTo?.name).toBe("new");
    expect(report.added).toEqual([]);
  });

  it("tells a new table from one that was left out", () => {
    const saved = structure([table(1, "a")]);
    const report = compare(saved, structure([table(1, "a")]), [{ oid: 2, schema: "public", name: "left_out" }, { oid: 3, schema: "public", name: "brand_new" }], [tableKey({ schema: "public", name: "a" }), tableKey({ schema: "public", name: "left_out" })]);
    expect(report.added.map((c) => c.name)).toEqual(["brand_new"]);
  });

  it("only offers new tables from schemas the diagram uses", () => {
    const report = compare(structure([table(1, "a")]), structure([table(1, "a")]), [{ oid: 2, schema: "other", name: "new" }]);
    expect(report.added).toEqual([]);
  });

  it("reports foreign keys added, removed and repointed", () => {
    const tables = [table(1, "a", [column("id"), column("x")]), table(2, "b"), table(3, "c")];
    const before = structure(tables, [fk(5, "kept", 1, 2), fk(6, "gone", 1, 2), fk(7, "moved", 1, 2)]);
    const after = structure(tables, [fk(5, "kept", 1, 2), fk(8, "new", 1, 2), fk(7, "moved", 1, 3)]);
    expect(compare(before, after).foreignKeys.sort()).toEqual(["a.gone removed", "a.moved changed", "a.new added"]);
  });

  it("doesn't list foreign keys of a removed table on their own", () => {
    const before = structure([table(1, "a"), table(2, "b")], [fk(5, "f", 1, 2)]);
    const report = compare(before, structure([table(1, "a")]));
    expect(report.foreignKeys).toEqual([]);
    expect(report.removed).toHaveLength(1);
  });

  it("tells two tables of the same name in different schemas apart", () => {
    const before = structure([table(1, "a", [column("id")], "s1"), table(2, "a", [column("id")], "s2")]);
    const after = structure([table(1, "a", [column("id")], "s1"), table(2, "a", [column("id"), column("x")], "s2")]);
    expect(compare(before, after).modified.map((m) => m.schema)).toEqual(["s2"]);
  });
});
