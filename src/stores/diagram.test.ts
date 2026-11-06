import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { foreignKeyKey, tableKey } from "../lib/diagramDrift";
import { newAnnotation, PASTE_OFFSET } from "../lib/diagramAnnotations";
import type { DiagramAnnotation, DiagramColors, DiagramCandidate, DiagramColumn, DiagramStructure, DiagramTable, SavedDiagram } from "../lib/types";
import { isAnnotationNode } from "../lib/diagramFlow";
import type { DiagramEdge, TableNode } from "../lib/diagramFlow";
import { DEFAULT_OPTIONS } from "../lib/diagramLayout";
import { useDiagrams } from "./diagram";

/** Places tables in a row. With `hold`, a job waits until `release`, as a slow worker would. */
const elk = vi.hoisted(() => {
  type Graph = { children: { id: string }[] };
  const place = (graph: Graph, step: number) => ({ ...graph, width: 100, height: 100, children: graph.children.map((c, i) => ({ ...c, x: i * step, y: 0 })) });
  const state = {
    hold: false,
    step: 300,
    waiting: [] as (() => void)[],
    finished: 0,
    start: () => {
      let reject: ((e: Error) => void) | null = null;
      return {
        run: (graph: Graph) =>
          new Promise((resolve, fail) => {
            reject = fail;
            const answer = place(graph, state.step);
            if (state.hold) state.waiting.push(() => resolve(answer));
            else resolve(answer);
          }),
        cancel: () => reject?.(new Error("Layout cancelled")),
        finish: () => void state.finished++,
      };
    },
    release: () => {
      for (const go of state.waiting.splice(0)) go();
    },
  };
  return state;
});

vi.mock("../lib/api", () => ({
  diagramStructure: vi.fn(),
  diagramCandidates: vi.fn(),
  diagramViewSources: vi.fn(),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock("../lib/diagramBrowser", () => ({
  fontsReady: async () => {},
  measureText: (text: string) => text.length * 6,
  runElk: async (graph: { children: { id: string }[] }) => ({ ...graph, width: 100, height: 100, children: graph.children.map((c) => ({ ...c, x: 0, y: 0 })) }),
  startLayout: () => elk.start(),
}));

const column = (name: string, more: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, dataType: "bigint", notNull: false, primaryKey: false, comment: null, ...more });
const table = (oid: number, name: string, columns = [column("id")]): DiagramTable => ({ oid, schema: "public", name, comment: null, columns });
const structure = (...tables: DiagramTable[]): DiagramStructure => ({ tables, foreignKeys: [] });
const candidates = (s: DiagramStructure): DiagramCandidate[] => s.tables.map(({ oid, schema, name }) => ({ oid, schema, name, kind: "table", signature: null }));
const tab = { id: "t", connectionId: "c", database: "db" };
const loadStructure = vi.mocked(api.diagramStructure);
const loadCandidates = vi.mocked(api.diagramCandidates);
const viewSources = vi.mocked(api.diagramViewSources);
const store = () => useDiagrams.getState();
const editor = () => store().diagrams.t;
const tableNodes = () => editor().nodes.filter((n): n is TableNode => !isAnnotationNode(n));
const settled = () => new Promise((r) => setTimeout(r));

/** The database as it is now. */
const database = (s: DiagramStructure, extra: DiagramCandidate[] = []) => {
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
  viewSources.mockReset();
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
    expect(tableNodes()[0].data.table.name).toBe("orders");
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
    expect(tableNodes()[0].data.table.name).toBe("new");
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
    expect(tableNodes()[0].data.table.columns).toHaveLength(2);
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
    database(s, [{ oid: 3, schema: "public", name: "brand_new", kind: "table", signature: null }]);
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
    expect(tableNodes().map((n) => n.data.table.name)).toEqual(["a", "b", "brand_new"]);
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
    expect(tableNodes().find((n) => n.data.table.name === "renamed")?.position.x).toBe(500);
  });

  it("drops the table when a possible rename isn't confirmed", async () => {
    database(structure(table(1, "a"), table(2, "renamed")));
    await openSaved(savedDiagram(s));
    await store().acceptReport("t", { add: [], renames: [] });
    expect(tableNodes().map((n) => n.data.table.name)).toEqual(["a"]);
  });
});

describe("options", () => {
  const s = structure(table(1, "a"), table(2, "b"));

  it("default to showing schemas for a diagram of several", async () => {
    database({ tables: [table(1, "a"), { ...table(2, "b"), schema: "other" }], foreignKeys: [] });
    store().open(tab, [1, 2]);
    await settled();
    expect(editor().options?.showSchemaNames).toBe(true);
  });

  it("are filled in for a file saved before options existed, which stays clean", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    expect(editor().options).toEqual(DEFAULT_OPTIONS);
    expect(editor().dirty).toBe(false);
  });

  it("come back from the file", async () => {
    database(s);
    const saved = savedDiagram(s);
    saved.layout.options = { ...DEFAULT_OPTIONS, fontSize: 14, blackAndWhite: true };
    await openSaved(saved);
    expect(editor().options).toMatchObject({ fontSize: 14, blackAndWhite: true });
    expect(tableNodes()[0].data.options.fontSize).toBe(14);
    expect(editor().dirty).toBe(false);
  });

  it("grow tables in place, offer a layout, and need a save", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    const before = editor().nodes[1];
    await store().setOptions("t", { fontSize: 16 });
    const after = editor().nodes[1];
    expect(after.position).toEqual(before.position);
    expect(after.height).toBeGreaterThan(before.height!);
    expect(editor()).toMatchObject({ offerLayout: true, dirty: true });
    expect(store().content("t")?.layout.options?.fontSize).toBe(16);
  });

  it("don't offer a layout when no table changed size, and are clean again when undone", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    await store().setOptions("t", { blackAndWhite: true });
    expect(editor()).toMatchObject({ offerLayout: false, dirty: true });
    await store().setOptions("t", { blackAndWhite: false });
    expect(editor().dirty).toBe(false);
  });

  it("offers a new layout when names arrive, not when they go", async () => {
    const s = structure(table(1, "a"));
    database(s);
    await openSaved(savedDiagram(s));
    await store().setOptions("t", { showRelationshipNames: false });
    expect(editor().offerLayout).toBe(false);
    await store().setOptions("t", { showRelationshipNames: true });
    expect(editor().offerLayout).toBe(true);
  });

  it("drop routes only when they move rows", async () => {
    const linked: DiagramStructure = { tables: [table(1, "a", [column("id"), column("b_id")]), table(2, "b")], foreignKeys: [{ oid: 9, name: "fk", childOid: 1, parentOid: 2, childColumns: ["b_id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true }] };
    database(linked);
    const saved = savedDiagram(linked);
    saved.layout.routes = { [JSON.stringify(["public", "a", "fk"])]: [{ x: 5, y: 5 }] };
    await openSaved(saved);
    expect(editor().edges[0].data?.points).toHaveLength(1);
    await store().setOptions("t", { showNotNull: true });
    expect(editor().edges[0].data?.points).toHaveLength(1);
    await store().setOptions("t", { fontSize: 14 });
    expect(editor().edges[0].data?.points).toBeUndefined();
  });
});

describe("auto layout", () => {
  const key = (oid: number, childOid: number, parentOid: number) => ({ oid, name: `fk${oid}`, childOid, parentOid, childColumns: ["id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true });
  const s: DiagramStructure = { tables: [table(1, "a"), table(2, "b"), table(3, "c")], foreignKeys: [key(7, 1, 2), key(8, 2, 3)] };
  const places = () => Object.fromEntries(editor().nodes.map((n) => [n.id, n.position]));
  const opened = async () => {
    database(s);
    await openSaved(savedDiagram(s));
  };

  beforeEach(() => {
    Object.assign(elk, { hold: false, step: 300, finished: 0 });
    elk.waiting.length = 0;
  });

  it("moves everything, and Undo puts it back and cleans the tab", async () => {
    await opened();
    const before = places();
    await store().autoLayout("t");
    expect(places()).not.toEqual(before);
    expect(editor()).toMatchObject({ dirty: true, layingOut: false, offerLayout: false });
    store().undoLayout("t");
    expect(places()).toEqual(before);
    expect(editor().dirty).toBe(false);
    expect(editor().undo).toEqual([]);
  });

  it("brings a whole layout into view, but leaves the view alone for a selection", async () => {
    await opened();
    await store().autoLayout("t");
    expect(editor().layoutsDone).toBe(1);
    await store().autoLayout("t", ["1", "2"]);
    expect(editor().layoutsDone).toBe(1);
  });

  it("undoes one layout at a time, routes and the banner's offer included", async () => {
    await opened();
    await store().setOptions("t", { fontSize: 16 });
    const offered = places();
    await store().autoLayout("t");
    expect(editor().offerLayout).toBe(false);
    const first = places();
    elk.step = 500;
    await store().autoLayout("t");
    store().undoLayout("t");
    expect(places()).toEqual(first);
    store().undoLayout("t");
    expect(places()).toEqual(offered);
    expect(editor().offerLayout).toBe(true);
  });

  it("leaves other tables alone, keeps the selection's corner, and drops lines leaving it", async () => {
    await opened();
    await store().autoLayout("t");
    const edges = editor().edges.map((e) => ({ ...e, data: { ...e.data!, points: [{ x: 1, y: 1 }] } }) as DiagramEdge);
    store().setEdges("t", edges);
    const before = places();
    elk.step = 900;
    await store().autoLayout("t", ["1", "2"]);
    const after = places();
    expect(after["3"]).toEqual(before["3"]);
    expect(Math.min(after["1"].x, after["2"].x)).toBe(Math.min(before["1"].x, before["2"].x));
    expect(Math.abs(after["2"].x - after["1"].x)).toBe(900);
    const line = (id: string) => editor().edges.find((e) => e.id === id)?.data?.points;
    expect(line("8")).toBeUndefined();
    expect(line("7")).not.toEqual([{ x: 1, y: 1 }]);
  });

  it("lets a second layout replace the first, whose late result is dropped", async () => {
    await opened();
    elk.hold = true;
    const first = store().autoLayout("t");
    await settled();
    expect(editor().layingOut).toBe(true);
    elk.step = 500;
    const second = store().autoLayout("t");
    await settled();
    await first;
    expect(editor().layingOut).toBe(true);
    elk.release();
    await second;
    expect(editor().layingOut).toBe(false);
    expect(editor().undo).toHaveLength(1);
    expect(Object.values(places()).map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 500, 1000]);
  });

  it("changes nothing when cancelled, and reports no error", async () => {
    await opened();
    const before = places();
    elk.hold = true;
    const run = store().autoLayout("t");
    await settled();
    store().cancelLayout("t");
    await run;
    expect(places()).toEqual(before);
    expect(editor()).toMatchObject({ layingOut: false, layoutError: null, undo: [] });
  });

  it("stops when a table is dragged, so a late result can't undo the drag", async () => {
    await opened();
    elk.hold = true;
    const run = store().autoLayout("t");
    await settled();
    store().setNodes("t", editor().nodes, new Set(["1"]), false);
    await run;
    expect(editor().layingOut).toBe(false);
    expect(editor().undo).toEqual([]);
  });

  it("forgets what it could undo once the tables change", async () => {
    await opened();
    await store().autoLayout("t");
    store().removeTables("t", ["3"]);
    expect(editor().undo).toEqual([]);
  });

  it("saves its settings without moving anything", async () => {
    await opened();
    const before = places();
    store().setLayoutOptions("t", { objectDistance: 80, groupBySchema: true });
    expect(places()).toEqual(before);
    expect(editor().dirty).toBe(true);
    expect(store().content("t")?.layout.options).toMatchObject({ objectDistance: 80, groupBySchema: true });
    store().setLayoutOptions("t", { objectDistance: DEFAULT_OPTIONS.objectDistance, groupBySchema: false });
    expect(editor().dirty).toBe(false);
  });
});

describe("selection", () => {
  const s = structure(table(1, "a"), table(2, "b"));

  it("finds a selected line's foreign key, for its columns to light up", async () => {
    const foreignKey = { oid: 9, name: "fk", childOid: 1, parentOid: 2, childColumns: ["id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true };
    const linked = { ...s, foreignKeys: [foreignKey] };
    database(linked);
    await openSaved(savedDiagram(linked));
    store().select("t", { nodes: [], edge: "9" });
    expect(editor().selection.foreignKey?.name).toBe("fk");
    store().select("t", { nodes: [], edge: null });
    expect(editor().selection.foreignKey).toBeNull();
  });

  it("selecting from the list marks one node, and clears any other", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    store().selectNode("t", "1");
    store().selectNode("t", "2");
    expect(editor().nodes.map((n) => !!n.selected)).toEqual([false, true]);
    expect(editor().selection).toEqual({ nodes: ["2"], edge: null, foreignKey: null });
  });

  it("doesn't write the same selection again, since React Flow repeats itself", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    store().select("t", { nodes: ["1"], edge: null });
    const before = editor();
    store().select("t", { nodes: ["1"], edge: null });
    expect(editor()).toBe(before);
  });
});

describe("changing the tables", () => {
  const s = structure(table(1, "a"), table(2, "b"), table(3, "c"));

  it("removes a table from the diagram and the saved set, without calling it drift", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    store().removeTables("t", ["2"]);
    expect(tableNodes().map((n) => n.data.table.name)).toEqual(["a", "c"]);
    expect(editor().dirty).toBe(true);
    const content = store().content("t")!;
    expect(content.objects).toBe(2);
    expect(content.snapshot.tables.map((t) => t.name)).toEqual(["a", "c"]);
    expect(content.layout.tables[tableKey(table(2, "b"))]).toBeUndefined();
    // It's still in the database, and left out on purpose, so it isn't "added" later.
    expect(content.known).toContain(tableKey(table(2, "b")));
    await store().load("t");
    expect(editor().report).toBeNull();
  });

  it("removes a table's foreign keys with it", async () => {
    const linked: DiagramStructure = { ...s, foreignKeys: [{ oid: 9, name: "fk", childOid: 1, parentOid: 2, childColumns: ["id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true }] };
    database(linked);
    await openSaved(savedDiagram(linked));
    store().removeTables("t", ["2"]);
    expect(editor().edges).toEqual([]);
    expect(store().content("t")?.snapshot.foreignKeys).toEqual([]);
  });

  it("adds and drops tables, keeping those that stay in place", async () => {
    const now = structure(table(1, "a"), table(2, "b"), table(3, "c"), table(4, "d"));
    database(now);
    await openSaved(savedDiagram(structure(table(1, "a"), table(2, "b"), table(3, "c")), now.tables.map(tableKey)));
    const place = editor().nodes[1].position;
    await store().setTables("t", [2, 3, 4]);
    expect(tableNodes().map((n) => n.data.table.name)).toEqual(["b", "c", "d"]);
    expect(editor().nodes[0].position).toEqual(place);
    expect(editor()).toMatchObject({ offerLayout: true, dirty: true, report: null });
    expect(store().content("t")?.layout.tables[tableKey(table(1, "a"))]).toBeUndefined();
  });
});

describe("tracing a view", () => {
  const columns = [{ column: "id", source: { schema: "public", relation: "orders", column: "id" } }];
  const openView = async () => {
    database(structure({ ...table(7, "v"), kind: "view" }));
    store().open(tab, [7]);
    await settled();
  };

  it("runs when a view is selected, and not again while loading or ready", async () => {
    await openView();
    viewSources.mockResolvedValue(columns);
    store().selectNode("t", "7");
    store().selectNode("t", "7");
    expect(editor().traces[7]).toEqual({ status: "loading" });
    await settled();
    store().selectNode("t", "7");
    expect(viewSources).toHaveBeenCalledTimes(1);
    expect(viewSources).toHaveBeenCalledWith("c", "db", 7);
    expect(editor().traces[7]).toEqual({ status: "ready", columns });
  });

  it("doesn't run for a table", async () => {
    database(structure(table(1, "orders")));
    store().open(tab, [1]);
    await settled();
    store().selectNode("t", "1");
    expect(viewSources).not.toHaveBeenCalled();
  });

  it("stores a failure, and runs again on retry", async () => {
    await openView();
    viewSources.mockRejectedValueOnce("boom");
    await store().traceView("t", 7);
    expect(editor().traces[7]).toEqual({ status: "error", error: "boom" });
    viewSources.mockResolvedValue(columns);
    await store().traceView("t", 7);
    expect(editor().traces[7]).toEqual({ status: "ready", columns });
  });

  it("drops an answer that arrives after the traces were cleared", async () => {
    await openView();
    let answer: (c: typeof columns) => void = () => {};
    viewSources.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const running = store().traceView("t", 7);
    useDiagrams.setState((s) => ({ diagrams: { ...s.diagrams, t: { ...s.diagrams.t, traces: {} } } }));
    answer(columns);
    await running;
    expect(editor().traces).toEqual({});
  });
});

describe("annotations", () => {
  const s: DiagramStructure = { tables: [table(1, "a"), table(2, "b")], foreignKeys: [] };
  const note: DiagramAnnotation = { ...newAnnotation("note", { x: 777, y: 888 }, 2), text: "remember" };
  const colors: DiagramColors = { objects: { [tableKey(table(1, "a"))]: "info" }, lines: {} };
  const withNote = () => {
    const saved = savedDiagram(s);
    return { ...saved, layout: { ...saved.layout, annotations: [note], colors } };
  };
  const annotationNodes = () => editor().nodes.filter((n) => n.id === note.id);
  const opened = async () => {
    database(s);
    await openSaved(withNote());
  };

  beforeEach(() => {
    Object.assign(elk, { hold: false, step: 300, finished: 0 });
    elk.waiting.length = 0;
  });

  it("round-trips through the file", async () => {
    await opened();
    expect(editor()).toMatchObject({ annotations: [note], colors, dirty: false });
    expect(annotationNodes()).toHaveLength(1);
    expect(store().content("t")?.layout).toMatchObject({ annotations: [note], colors });
  });

  it("opens a file with neither as empty, and clean", async () => {
    database(s);
    await openSaved(savedDiagram(s));
    expect(editor()).toMatchObject({ annotations: [], colors: { objects: {}, lines: {} }, dirty: false });
  });

  it("keeps annotations in place through a reload, new options and a whole layout", async () => {
    await opened();
    const place = () => annotationNodes().map((n) => n.position);
    await store().load("t");
    expect(place()).toEqual([{ x: 777, y: 888 }]);
    await store().setOptions("t", { fontSize: 16 });
    expect(place()).toEqual([{ x: 777, y: 888 }]);
    await store().autoLayout("t");
    expect(place()).toEqual([{ x: 777, y: 888 }]);
    expect(editor().nodes.filter((n) => n.id !== note.id)).toHaveLength(2);
  });

  it("lays out only the tables in a selection, and the whole diagram for an annotation alone", async () => {
    await opened();
    const before = Object.fromEntries(editor().nodes.map((n) => [n.id, n.position]));
    await store().autoLayout("t", [note.id, "1", "2"]);
    expect(editor().layoutsDone).toBe(0);
    expect(annotationNodes()[0].position).toEqual(before[note.id]);
    await store().autoLayout("t", [note.id]);
    expect(editor().layoutsDone).toBe(1);
  });

  it("counts dragging an annotation as a change, and saves its new place", async () => {
    await opened();
    const nodes = editor().nodes.map((n) => (n.id === note.id ? { ...n, position: { x: 10, y: 20 } } : n));
    store().setNodes("t", nodes, new Set([note.id]), false);
    store().setNodes("t", nodes, new Set(), true);
    expect(editor().dirty).toBe(true);
    expect(store().content("t")?.layout.annotations?.[0]).toMatchObject({ x: 10, y: 20 });
  });

  it("keeps the height the user set when the text needs more, and stays clean after a table drag", async () => {
    const tall = { ...note, text: "word ".repeat(200), height: 100 };
    database(s);
    const saved = withNote();
    await openSaved({ ...saved, layout: { ...saved.layout, annotations: [tall] } });
    expect(annotationNodes()[0].height).toBeGreaterThan(100);
    drag(0);
    expect(editor().annotations[0].height).toBe(100);
    expect(editor().dirty).toBe(false);
  });

  it("draws the annotations as they are when a load finishes, not as they were when it began", async () => {
    await opened();
    database(s);
    const running = store().load("t");
    useDiagrams.setState((st) => ({ diagrams: { ...st.diagrams, t: { ...st.diagrams.t, annotations: [{ ...note, text: "edited meanwhile" }] } } }));
    await running;
    expect(annotationNodes()[0].data.lines).toEqual(["edited meanwhile"]);
  });

  it("doesn't remove an annotation when asked to remove its id as a table", async () => {
    await opened();
    store().removeTables("t", [note.id, "1"]);
    expect(editor().annotations).toEqual([note]);
    expect(annotationNodes()).toHaveLength(1);
    expect(tableNodes().map((n) => n.id)).toEqual(["2"]);
  });
});

describe("editing annotations", () => {
  const s: DiagramStructure = { tables: [table(1, "a"), table(2, "b")], foreignKeys: [] };
  const clean = async () => {
    database(s);
    const saved = savedDiagram(s);
    await openSaved(saved);
    expect(editor().dirty).toBe(false);
  };
  const add = (kind: "label" | "note" = "note", at = { x: 5, y: 6 }) => {
    store().addAnnotation("t", kind, at);
    return editor().annotations[editor().annotations.length - 1];
  };
  const node = (annotationId: string) => editor().nodes.find((n) => n.id === annotationId)!;

  it("adds on top, selects the new node and starts editing it", async () => {
    await clean();
    const first = add();
    const second = add("label");
    expect(second.z).toBeGreaterThan(first.z);
    expect(editor().editing).toBe(second.id);
    expect(editor().selection).toEqual({ nodes: [second.id], edge: null, foreignKey: null });
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([second.id]);
    expect(editor().dirty).toBe(true);
  });

  it("clears a selected table and line when adding", async () => {
    await clean();
    store().selectNode("t", "1");
    const a = add();
    expect(node("1").selected).toBe(false);
    expect(editor().selection.nodes).toEqual([a.id]);
  });

  it("re-wraps on a text change without touching other nodes, and keeps selection and place", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "hello" });
    store().stopEditing("t");
    store().select("t", { nodes: [a.id], edge: null });
    const before = editor().nodes;
    const place = node(a.id).position;
    store().updateAnnotation("t", a.id, { text: "hello world" });
    const after = editor().nodes;
    expect((node(a.id).data as { lines: string[] }).lines).toEqual(["hello world"]);
    expect(node(a.id).position).toEqual(place);
    expect(node(a.id).selected).toBe(true);
    expect(after.filter((n) => n.id !== a.id).every((n) => before.includes(n))).toBe(true);
    expect(editor().annotations[0].text).toBe("hello world");
    expect(editor().editing).toBeNull();
  });

  it("doesn't change editing when updating", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "x" });
    expect(editor().editing).toBe(a.id);
  });

  it("grows a note's node with its text while content keeps the height the user set", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "word ".repeat(200) });
    expect(node(a.id).height).toBeGreaterThan(100);
    expect(store().content("t")?.layout.annotations?.[0].height).toBe(100);
  });

  it("sizes a label's node by its text", async () => {
    await clean();
    const a = add("label");
    store().updateAnnotation("t", a.id, { text: "ab" });
    const narrow = node(a.id).width!;
    store().updateAnnotation("t", a.id, { text: "abcdefgh" });
    expect(node(a.id).width!).toBeGreaterThan(narrow);
  });

  it("removes an annotation left blank, and stays clean when that was the only change", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "  \n " });
    store().stopEditing("t");
    expect(editor().annotations).toEqual([]);
    expect(editor().nodes.some((n) => n.id === a.id)).toBe(false);
    expect(editor().editing).toBeNull();
    expect(editor().dirty).toBe(false);
  });

  it("keeps an annotation with text when editing stops", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "keep" });
    store().stopEditing("t");
    expect(editor().annotations.map((x) => x.id)).toEqual([a.id]);
    expect(editor().editing).toBeNull();
    expect(editor().dirty).toBe(true);
  });

  it("starts editing an annotation", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "x" });
    store().stopEditing("t");
    expect(editor().editing).toBeNull();
    store().startEditing("t", a.id);
    expect(editor().editing).toBe(a.id);
  });

  it("sends to back below zero and keeps order, and brings to front above all", async () => {
    await clean();
    const [a, b, c] = [add(), add(), add()];
    store().sendToBack("t", [b.id, c.id]);
    const z = (x: DiagramAnnotation) => editor().annotations.find((n) => n.id === x.id)!.z;
    expect(z(b)).toBeLessThan(0);
    expect(z(c)).toBeLessThan(0);
    expect(z(b)).toBeLessThan(z(c));
    expect(z(c)).toBeLessThan(z(a));
    expect(node(b.id).zIndex).toBe(z(b));
    store().bringToFront("t", [b.id, c.id]);
    expect(z(b)).toBeGreaterThan(z(a));
    expect(z(c)).toBeGreaterThan(z(b));
  });

  it("deletes the node, the annotation and its selection, and clears editing", async () => {
    await clean();
    const a = add();
    const b = add();
    store().select("t", { nodes: [a.id, b.id], edge: null });
    store().deleteAnnotations("t", [b.id]);
    expect(editor().annotations.map((x) => x.id)).toEqual([a.id]);
    expect(editor().nodes.some((n) => n.id === b.id)).toBe(false);
    expect(editor().selection.nodes).toEqual([a.id]);
    expect(editor().editing).toBeNull();
  });

  it("leaves editing alone when deleting another annotation", async () => {
    await clean();
    const a = add();
    const b = add();
    store().deleteAnnotations("t", [a.id]);
    expect(editor().editing).toBe(b.id);
  });

  it("pastes copies with new ids, offset, selected alone, and offsets again on a second paste", async () => {
    await clean();
    const a = add();
    store().updateAnnotation("t", a.id, { text: "hi" });
    store().stopEditing("t");
    store().copyAnnotations("t", [a.id]);
    store().updateAnnotation("t", a.id, { text: "changed after copy" });
    store().pasteAnnotations("t");
    store().pasteAnnotations("t");
    const [orig, one, two] = editor().annotations;
    expect(one.id).not.toBe(orig.id);
    expect(one.text).toBe("hi");
    expect([one.x, one.y]).toEqual([orig.x + PASTE_OFFSET, orig.y + PASTE_OFFSET]);
    expect([two.x, two.y]).toEqual([orig.x + 2 * PASTE_OFFSET, orig.y + 2 * PASTE_OFFSET]);
    expect(editor().selection.nodes).toEqual([two.id]);
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([two.id]);
    expect(two.z).toBeGreaterThan(one.z);
  });

  it("does nothing when pasting an empty clipboard", async () => {
    await clean();
    const before = editor();
    store().pasteAnnotations("t");
    expect(editor().annotations).toBe(before.annotations);
    expect(editor().nodes).toBe(before.nodes);
    expect(editor().selection).toBe(before.selection);
  });

  it("colours an object by its key, ignores annotations, and null removes it", async () => {
    await clean();
    store().setObjectColor("t", ["1", "a:x"], "error");
    expect(editor().colors.objects).toEqual({ [tableKey(table(1, "a"))]: "error" });
    expect(editor().dirty).toBe(true);
    store().setObjectColor("t", ["1"], null);
    expect(editor().colors.objects).toEqual({});
    expect(editor().dirty).toBe(false);
  });

  it("colours a line by its foreign key key", async () => {
    const fk = { oid: 9, name: "fk_ab", childOid: 1, parentOid: 2, childColumns: ["id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true };
    const withFk: DiagramStructure = { ...s, foreignKeys: [fk] };
    database(withFk);
    await openSaved(savedDiagram(withFk));
    store().setLineColor("t", "9", "info");
    expect(editor().colors.lines).toEqual({ [foreignKeyKey(fk, table(1, "a"))]: "info" });
    expect(editor().dirty).toBe(true);
  });
});

describe("colours across structure changes", () => {
  const s: DiagramStructure = { tables: [table(1, "a"), table(2, "b")], foreignKeys: [] };
  const keyA = tableKey(table(1, "a"));
  const keyB = tableKey(table(2, "b"));
  const coloured = async () => {
    database(s);
    const saved = savedDiagram(s);
    await openSaved({ ...saved, layout: { ...saved.layout, colors: { objects: { [keyA]: "info", [keyB]: "error" }, lines: {} } } });
  };

  it("survives a load", async () => {
    await coloured();
    await store().load("t");
    expect(editor().colors.objects).toEqual({ [keyA]: "info", [keyB]: "error" });
  });

  it("is dropped by removeTables", async () => {
    await coloured();
    store().removeTables("t", ["2"]);
    expect(editor().colors.objects).toEqual({ [keyA]: "info" });
  });

  it("is dropped by setTables leaving the table out", async () => {
    await coloured();
    database(s);
    await store().setTables("t", [1]);
    expect(editor().colors.objects).toEqual({ [keyA]: "info" });
  });

  it("stays after a refresh that finds the table gone, until the removal is accepted", async () => {
    await coloured();
    database(structure(table(1, "a")));
    await store().load("t");
    expect(editor().colors.objects).toEqual({ [keyA]: "info", [keyB]: "error" });
    await store().acceptReport("t", { add: [], renames: [] });
    expect(editor().colors.objects).toEqual({ [keyA]: "info" });
  });

  it("moves with a rename accepted in the report", async () => {
    await coloured();
    const renamed = table(2, "b2");
    database(structure(table(1, "a"), renamed));
    await store().load("t");
    expect(editor().report?.removed[0].renamedTo?.name).toBe("b2");
    await store().acceptReport("t", { add: [], renames: [keyB] });
    expect(editor().colors.objects).toEqual({ [keyA]: "info", [tableKey(renamed)]: "error" });
  });

  it("keeps the colour of a table reported as removed when another is removed, and drops it on accept", async () => {
    await coloured();
    database(structure(table(1, "a")));
    await store().load("t");
    store().removeTables("t", ["1"]);
    expect(editor().colors.objects).toEqual({ [keyB]: "error" });
    await store().acceptReport("t", { add: [], renames: [] });
    expect(editor().colors.objects).toEqual({});
  });

  it("keeps a colour set while accepting", async () => {
    await coloured();
    database(structure(table(1, "a")));
    await store().load("t");
    const accepting = store().acceptReport("t", { add: [], renames: [] });
    store().setObjectColor("t", ["1"], "success");
    await accepting;
    expect(editor().colors.objects).toEqual({ [keyA]: "success" });
  });

  it("moves a renamed child's line colours with it", async () => {
    const fk = { oid: 9, name: "fk_ba", childOid: 2, parentOid: 1, childColumns: ["id"], parentColumns: ["id"], childPartition: null, parentPartition: null, matchType: "s", onUpdate: "a", onDelete: "a", childRequiresParent: false, uniqueVia: null, validated: true, enforced: true };
    const old: DiagramStructure = { tables: [table(1, "a"), table(2, "b")], foreignKeys: [fk] };
    database(old);
    const saved = savedDiagram(old);
    await openSaved({ ...saved, layout: { ...saved.layout, colors: { objects: {}, lines: { [foreignKeyKey(fk, table(2, "b"))]: "info" } } } });
    database({ tables: [table(1, "a"), table(2, "b2")], foreignKeys: [fk] });
    await store().load("t");
    await store().acceptReport("t", { add: [], renames: [keyB] });
    expect(editor().colors.lines).toEqual({ [foreignKeyKey(fk, table(2, "b2"))]: "info" });
  });
});
