import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { tableKey } from "../lib/diagramDrift";
import type { DiagramColumn, DiagramStructure, DiagramTable, SavedDiagram } from "../lib/types";
import { useDiagrams } from "./diagram";

vi.mock("../lib/api", () => ({
  diagramStructure: vi.fn(),
  diagramCandidates: vi.fn(),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock("../lib/diagramBrowser", () => ({
  fontsReady: async () => {},
  measureText: (text: string) => text.length * 6,
  runElk: async (graph: { children: { id: string }[] }) => ({ ...graph, width: 100, height: 100, children: graph.children.map((c) => ({ ...c, x: 0, y: 0 })) }),
}));

const column = (name: string, more: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, dataType: "bigint", notNull: false, primaryKey: false, ...more });
const table = (oid: number, name: string, columns = [column("id")]): DiagramTable => ({ oid, schema: "public", name, columns });
const structure = (...tables: DiagramTable[]): DiagramStructure => ({ tables, foreignKeys: [] });
const candidates = (s: DiagramStructure) => s.tables.map(({ oid, schema, name }) => ({ oid, schema, name }));
const tab = { id: "t", connectionId: "c", database: "db" };
const loadStructure = vi.mocked(api.diagramStructure);
const loadCandidates = vi.mocked(api.diagramCandidates);
const store = () => useDiagrams.getState();
const editor = () => store().diagrams.t;
const settled = () => new Promise((r) => setTimeout(r));

/** The database as it is now. */
const database = (s: DiagramStructure, extra: { oid: number; schema: string; name: string }[] = []) => {
  loadStructure.mockImplementation(async (_c, _d, oids) => ({ ...s, tables: s.tables.filter((t) => oids.includes(t.oid)) }));
  loadCandidates.mockResolvedValue([...candidates(s), ...extra]);
};

const savedDiagram = (s: DiagramStructure, known = s.tables.map(tableKey)): SavedDiagram => ({
  id: "d1",
  name: "Saved",
  database: "db",
  objects: s.tables.length,
  modifiedMs: 100,
  layout: { tables: Object.fromEntries(s.tables.map((t, i) => [tableKey(t), { x: i * 500, y: 40 }])), routes: {}, viewport: { x: 1, y: 2, zoom: 0.5 } },
  snapshot: s,
  known,
});

const openSaved = async (saved: SavedDiagram) => {
  store().openSaved(tab, saved);
  await settled();
};

/** Drags the first table to `x`, as React Flow reports it. */
const drag = (x: number) => {
  const nodes = editor().nodes.map((n, i) => (i ? n : { ...n, position: { x, y: n.position.y } }));
  store().setNodes("t", nodes, new Set([nodes[0].id]), false);
  store().setNodes("t", nodes, new Set(), true);
};

beforeEach(() => {
  loadStructure.mockReset();
  loadCandidates.mockReset();
  loadCandidates.mockResolvedValue([]);
  useDiagrams.setState({ diagrams: {}, picker: null });
});

describe("a new diagram", () => {
  it("reads the chosen tables, lays them out, and counts as unsaved", async () => {
    database(structure(table(1, "orders")));
    store().open(tab, [1]);
    expect(editor().status).toBe("loading");
    await settled();
    expect(loadStructure).toHaveBeenCalledWith("c", "db", [1]);
    expect(editor()).toMatchObject({ status: "ready", dirty: true, report: null });
    expect(editor().nodes[0].data.table.name).toBe("orders");
  });

  it("remembers every table the database has, chosen or not", async () => {
    const s = structure(table(1, "orders"), table(2, "left_out"));
    database(s);
    store().open(tab, [1]);
    await settled();
    expect(editor().known).toEqual(s.tables.map(tableKey));
    expect(editor().snapshot?.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("shows an error, and a retry clears it", async () => {
    loadStructure.mockRejectedValueOnce("lock");
    store().open(tab, [1]);
    await settled();
    expect(editor()).toMatchObject({ status: "error", error: "lock" });
    database(structure(table(1, "orders")));
    await store().load("t");
    expect(editor()).toMatchObject({ status: "ready", error: null });
  });

  it("ignores an answer for a closed tab", async () => {
    let answer!: (s: DiagramStructure) => void;
    loadStructure.mockReturnValue(new Promise((r) => (answer = r)));
    store().open(tab, [1]);
    store().dispose("t");
    answer(structure(table(1, "orders")));
    await settled();
    expect(editor()).toBeUndefined();
  });

  it("lets only the newest of two loads answer", async () => {
    let first!: (s: DiagramStructure) => void;
    loadStructure.mockReturnValueOnce(new Promise((r) => (first = r)));
    store().open(tab, [1]);
    await settled();
    loadStructure.mockResolvedValueOnce(structure(table(1, "new")));
    await store().load("t");
    first(structure(table(1, "old")));
    await settled();
    expect(editor().nodes[0].data.table.name).toBe("new");
  });
});

describe("opening a saved diagram", () => {
  const s = structure(table(1, "a"), table(2, "b"));

  it("keeps saved positions and viewport, and is clean when nothing changed", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    expect(editor()).toMatchObject({ status: "ready", dirty: false, report: null, viewport: { x: 1, y: 2, zoom: 0.5 } });
    expect(editor().nodes.map((n) => n.position.x)).toEqual([0, 500]);
  });

  it("finds a re-created table by name, keeping its place", async () => {
    database(structure(table(91, "a"), table(92, "b")));
    await openSaved(savedDiagram(s));
    expect(editor().nodes.map((n) => n.id)).toEqual(["91", "92"]);
    expect(editor().nodes[1].position.x).toBe(500);
    expect(editor().report).toBeNull();
  });

  it("applies column changes at once, reports them, and stays clean", async () => {
    database(structure(table(1, "a", [column("id"), column("added")]), table(2, "b")));
    await openSaved(savedDiagram(s));
    expect(editor().nodes[0].data.table.columns).toHaveLength(2);
    expect(editor().report?.modified[0].changes).toEqual(["Column added added"]);
    expect(editor()).toMatchObject({ offerLayout: true, dirty: false });
  });

  it("takes a removed table off the canvas, and lists it", async () => {
    database(structure(table(1, "a")));
    await openSaved(savedDiagram(s));
    expect(editor().nodes).toHaveLength(1);
    expect(editor().report?.removed.map((r) => r.name)).toEqual(["b"]);
  });

  it("doesn't add a new table by itself", async () => {
    database(s, [{ oid: 3, schema: "public", name: "brand_new" }]);
    await openSaved(savedDiagram(s));
    expect(editor().nodes).toHaveLength(2);
    expect(editor().report?.added.map((c) => c.name)).toEqual(["brand_new"]);
  });

  it("returns the same report next time if it wasn't accepted", async () => {
    database(structure(table(1, "a")));
    const saved = savedDiagram(s);
    await openSaved(saved);
    const content = store().content("t")!;
    expect(content.snapshot).toEqual(s);
    expect(content.layout.tables[tableKey(table(2, "b"))]).toEqual({ x: 500, y: 40 });
  });

  it("shows the error rather than a stale diagram when the database can't be reached", async () => {
    loadCandidates.mockRejectedValue("connection refused");
    await openSaved(savedDiagram(s));
    expect(editor()).toMatchObject({ status: "error", error: "connection refused", nodes: [] });
  });
});

describe("dirty state", () => {
  const s = structure(table(1, "a"), table(2, "b"));

  it("follows a drag, and clears when a table goes back", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    drag(120);
    expect(editor().dirty).toBe(true);
    drag(0);
    expect(editor().dirty).toBe(false);
  });

  it("isn't changed by pan or zoom", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    store().setViewport("t", { x: 9, y: 9, zoom: 2 });
    expect(editor().dirty).toBe(false);
    expect(store().content("t")?.layout.viewport).toEqual({ x: 9, y: 9, zoom: 2 });
  });

  it("clears on save, and measures from there", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    drag(120);
    store().markSaved("t", 200);
    expect(editor()).toMatchObject({ dirty: false, stamp: 200 });
    drag(0);
    expect(editor().dirty).toBe(true);
  });

  it("keeps a moved table's place through a refresh", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    drag(120);
    await store().load("t");
    expect(editor().nodes[0].position.x).toBe(120);
    expect(editor().dirty).toBe(true);
  });

  it("flags a change from a designer without reloading", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    const calls = loadStructure.mock.calls.length;
    store().databaseChanged("c", "other");
    expect(editor().outOfDate).toBe(false);
    store().databaseChanged("c", "db");
    expect(editor().outOfDate).toBe(true);
    expect(loadStructure.mock.calls.length).toBe(calls);
    await store().load("t");
    expect(editor().outOfDate).toBe(false);
  });
});

describe("accepting the report", () => {
  const s = structure(table(1, "a"), table(2, "b"));

  it("updates the snapshot, adds ticked tables, and needs a save", async () => {
    const now = structure(table(1, "a"), table(2, "b"), table(3, "brand_new"), table(4, "ignored"));
    database(now);
    await openSaved(savedDiagram(s));
    await store().acceptReport("t", { add: [3], renames: [] });
    expect(editor().nodes.map((n) => n.data.table.name)).toEqual(["a", "b", "brand_new"]);
    expect(editor()).toMatchObject({ report: null, dirty: true, offerLayout: true });
    expect(editor().snapshot?.tables).toHaveLength(3);
    expect(editor().known).toContain(tableKey(table(4, "ignored")));
    expect(editor().nodes[2].position.y).toBeGreaterThan(40);
  });

  it("forgets a removed table", async () => {
    database(structure(table(1, "a")));
    await openSaved(savedDiagram(s));
    await store().acceptReport("t", { add: [], renames: [] });
    expect(editor().snapshot?.tables).toHaveLength(1);
    expect(store().content("t")?.layout.tables[tableKey(table(2, "b"))]).toBeUndefined();
  });

  it("keeps a confirmed rename's place under its new name", async () => {
    database(structure(table(1, "a"), table(2, "renamed")));
    await openSaved(savedDiagram(s));
    expect(editor().report?.removed[0].renamedTo?.name).toBe("renamed");
    await store().acceptReport("t", { add: [], renames: [tableKey(table(2, "b"))] });
    expect(editor().nodes.find((n) => n.data.table.name === "renamed")?.position.x).toBe(500);
  });

  it("drops the table when a possible rename isn't confirmed", async () => {
    database(structure(table(1, "a"), table(2, "renamed")));
    await openSaved(savedDiagram(s));
    await store().acceptReport("t", { add: [], renames: [] });
    expect(editor().nodes.map((n) => n.data.table.name)).toEqual(["a"]);
  });
});
