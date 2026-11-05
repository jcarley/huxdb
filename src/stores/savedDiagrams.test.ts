import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { DiagramContent, DiagramInfo } from "../lib/types";
import { useDiagrams } from "./diagram";
import { useSavedDiagrams } from "./savedDiagrams";
import { useTabs } from "./tabs";

vi.mock("../lib/api", () => ({
  CHANGED_MARKER: "[changed] ",
  errorMessage: (e: unknown) => String(e),
  listDiagrams: vi.fn(async () => []),
  loadDiagram: vi.fn(),
  createDiagram: vi.fn(),
  updateDiagram: vi.fn(),
  renameDiagram: vi.fn(),
  duplicateDiagram: vi.fn(),
  deleteDiagram: vi.fn(),
  diagramStructure: vi.fn(async () => ({ tables: [], foreignKeys: [] })),
  diagramCandidates: vi.fn(async () => []),
}));
vi.mock("../lib/diagramBrowser", () => ({ fontsReady: async () => {}, measureText: () => 10, runElk: async (g: object) => g, startLayout: () => ({ run: async (g: object) => g, cancel: () => {}, finish: () => {} }) }));

const info = (more: Partial<DiagramInfo> = {}): DiagramInfo => ({ id: "d1", name: "Mine", database: "db", objects: 0, modifiedMs: 500, ...more });
const content: DiagramContent = { objects: 0, layout: { tables: {}, routes: {}, viewport: null }, snapshot: { tables: [], foreignKeys: [] }, known: [] };
const saved = () => useSavedDiagrams.getState();
const diagrams = () => useDiagrams.getState();
const tabs = () => useTabs.getState();
const settled = () => new Promise((r) => setTimeout(r));

const newTab = async () => {
  tabs().openDiagram({ connectionId: "c", database: "db", schema: "" }, []);
  await settled();
  return tabs().tabs[tabs().tabs.length - 1].id;
};
const openedTab = async () => {
  vi.mocked(api.loadDiagram).mockResolvedValue({ ...info(), ...content });
  await saved().open("c", "d1");
  await settled();
  return tabs().tabs[tabs().tabs.length - 1].id;
};

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ tabs: [], activeId: null, pendingClose: null });
  useDiagrams.setState({ diagrams: {} });
  useSavedDiagrams.setState({ lists: {}, versions: {}, prompt: null, error: null });
});

describe("saving", () => {
  it("asks for a name the first time, and writes nothing", async () => {
    const id = await newTab();
    expect(await saved().save(id)).toBe(false);
    expect(saved().prompt).toEqual({ kind: "save-as", tabId: id });
    expect(api.updateDiagram).not.toHaveBeenCalled();
  });

  it("binds the tab to its new diagram", async () => {
    const id = await newTab();
    vi.mocked(api.createDiagram).mockResolvedValue(info());
    await saved().saveAs(id, "Mine");
    const tab = tabs().tabs[0];
    expect(tab).toMatchObject({ name: "Mine", source: { kind: "saved", id: "d1" } });
    expect(diagrams().diagrams[id]).toMatchObject({ dirty: false, stamp: 500 });
    expect(saved().prompt).toBeNull();
    expect(saved().versions.c).toBe(1);
  });

  it("keeps the prompt open when a name is taken", async () => {
    const id = await newTab();
    saved().setPrompt({ kind: "save-as", tabId: id });
    vi.mocked(api.createDiagram).mockRejectedValue("A diagram named \"x\" already exists.");
    await expect(saved().saveAs(id, "x")).rejects.toContain("already exists");
    expect(saved().prompt).not.toBeNull();
  });

  it("saves over its file, sending the stamp it last saw", async () => {
    const id = await openedTab();
    vi.mocked(api.updateDiagram).mockResolvedValue(info({ modifiedMs: 900 }));
    expect(await saved().save(id)).toBe(true);
    expect(vi.mocked(api.updateDiagram).mock.calls[0][3]).toBe(500);
    expect(diagrams().diagrams[id].stamp).toBe(900);
  });

  it("asks before overwriting a file that changed, then sends no stamp", async () => {
    const id = await openedTab();
    vi.mocked(api.updateDiagram).mockRejectedValueOnce("[changed] It changed on disk.");
    expect(await saved().save(id)).toBe(false);
    expect(saved().prompt).toEqual({ kind: "overwrite", tabId: id, message: "It changed on disk." });
    vi.mocked(api.updateDiagram).mockResolvedValue(info());
    expect(await saved().save(id, true)).toBe(true);
    expect(vi.mocked(api.updateDiagram).mock.calls[1][3]).toBeNull();
  });

  it("reports any other failure and stays dirty", async () => {
    const id = await openedTab();
    diagrams().markUnsaved(id);
    vi.mocked(api.updateDiagram).mockRejectedValue("disk full");
    expect(await saved().save(id)).toBe(false);
    expect(saved().error).toBe("disk full");
    expect(diagrams().diagrams[id].dirty).toBe(true);
  });
});

describe("opening", () => {
  it("focuses a diagram that's already open", async () => {
    const id = await openedTab();
    tabs().activate(null);
    await saved().open("c", "d1");
    expect(tabs().tabs).toHaveLength(1);
    expect(tabs().activeId).toBe(id);
  });

  it("reports a refused file and opens no tab", async () => {
    vi.mocked(api.loadDiagram).mockRejectedValue("saved by a newer version");
    await saved().open("c", "d1");
    expect(saved().error).toContain("newer version");
    expect(tabs().tabs).toEqual([]);
  });
});

describe("rename and delete", () => {
  it("renames the open tab, and follows the file's new stamp", async () => {
    const id = await openedTab();
    saved().setPrompt({ kind: "rename", connectionId: "c", diagram: info() });
    vi.mocked(api.renameDiagram).mockResolvedValue(info({ name: "New", modifiedMs: 800 }));
    await saved().rename("New");
    expect(tabs().tabs[0].name).toBe("New");
    expect(diagrams().diagrams[id].stamp).toBe(800);
  });

  it("turns an open tab into an unsaved one when its file is deleted", async () => {
    const id = await openedTab();
    saved().setPrompt({ kind: "delete", connectionId: "c", diagram: info() });
    vi.mocked(api.deleteDiagram).mockResolvedValue();
    await saved().confirmDelete();
    expect(tabs().tabs[0].source).toBeUndefined();
    expect(diagrams().diagrams[id].dirty).toBe(true);
  });
});
