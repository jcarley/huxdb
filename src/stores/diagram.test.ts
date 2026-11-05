import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { DiagramStructure } from "../lib/types";
import { useDiagrams } from "./diagram";

vi.mock("../lib/api", () => ({
  diagramStructure: vi.fn(),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock("../lib/diagramBrowser", () => ({
  fontsReady: async () => {},
  measureText: (text: string) => text.length * 6,
  runElk: async (graph: { children: { id: string }[] }) => ({ ...graph, width: 100, height: 100, children: graph.children.map((c) => ({ ...c, x: 0, y: 0 })) }),
}));

const structure = (name: string): DiagramStructure => ({
  tables: [{ oid: 1, schema: "public", name, columns: [{ name: "id", dataType: "bigint", primaryKey: true }] }],
  foreignKeys: [],
});
const tab = { id: "t", connectionId: "c", database: "db" };
const load = vi.mocked(api.diagramStructure);
const settled = () => new Promise((r) => setTimeout(r));

beforeEach(() => {
  load.mockReset();
  useDiagrams.setState({ diagrams: {}, picker: null });
});

describe("loading a diagram", () => {
  it("reads the chosen tables and lays them out", async () => {
    load.mockResolvedValue(structure("orders"));
    useDiagrams.getState().open(tab, [1]);
    expect(useDiagrams.getState().diagrams.t.status).toBe("loading");
    await settled();
    expect(load).toHaveBeenCalledWith("c", "db", [1]);
    const diagram = useDiagrams.getState().diagrams.t;
    expect(diagram.status).toBe("ready");
    expect(diagram.nodes[0].data.table.name).toBe("orders");
  });

  it("shows an error, and a retry clears it", async () => {
    load.mockRejectedValueOnce("lock");
    useDiagrams.getState().open(tab, [1]);
    await settled();
    expect(useDiagrams.getState().diagrams.t).toMatchObject({ status: "error", error: "lock" });
    load.mockResolvedValue(structure("orders"));
    await useDiagrams.getState().load("t");
    expect(useDiagrams.getState().diagrams.t).toMatchObject({ status: "ready", error: null });
  });

  it("ignores an answer for a closed tab", async () => {
    let answer!: (s: DiagramStructure) => void;
    load.mockReturnValue(new Promise((r) => (answer = r)));
    useDiagrams.getState().open(tab, [1]);
    useDiagrams.getState().dispose("t");
    answer(structure("orders"));
    await settled();
    expect(useDiagrams.getState().diagrams.t).toBeUndefined();
  });

  it("lets only the newest of two loads answer", async () => {
    let first!: (s: DiagramStructure) => void;
    load.mockReturnValueOnce(new Promise((r) => (first = r)));
    useDiagrams.getState().open(tab, [1]);
    load.mockResolvedValueOnce(structure("new"));
    await useDiagrams.getState().load("t");
    first(structure("old"));
    await settled();
    expect(useDiagrams.getState().diagrams.t.nodes[0].data.table.name).toBe("new");
  });
});
