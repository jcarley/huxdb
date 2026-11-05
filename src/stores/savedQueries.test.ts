import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { SavedQueryInfo } from "../lib/types";
import { isQueryDirty, useQueryEditor } from "./queryEditor";
import { useSavedQueries } from "./savedQueries";
import { useTabs } from "./tabs";

vi.mock("../lib/api", () => ({
  errorMessage: (err: unknown) => String(err),
  listSavedQueries: vi.fn(async () => []),
  loadSavedQuery: vi.fn(),
  createSavedQuery: vi.fn(),
  updateSavedQuery: vi.fn(),
  renameSavedQuery: vi.fn(),
  deleteSavedQuery: vi.fn(async () => {}),
  duplicateSavedQuery: vi.fn(),
  openExternalSql: vi.fn(),
  saveExternalSqlAs: vi.fn(),
  writeExternalSql: vi.fn(async () => 7),
  CHANGED_MARKER: "[changed] ",
  queryClose: vi.fn(async () => {}),
}));

const REF = { connectionId: "c", database: "d", schema: "s" };
const info = (id: string, name: string): SavedQueryInfo => ({ id, name, database: "d", schema: "s", modifiedMs: 0, size: 0 });

const tabs = () => useTabs.getState();
const saved = () => useSavedQueries.getState();
const editors = () => useQueryEditor.getState();
const onlyTab = () => tabs().tabs[0];

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ tabs: [], activeId: null, pendingClose: null });
  useQueryEditor.setState({ editors: {} });
  useSavedQueries.setState({ lists: {}, versions: {}, prompt: null, error: null });
});

describe("a new tab", () => {
  it("is clean until its text changes, and clean again when it's emptied", () => {
    tabs().openQuery(REF);
    const { id } = onlyTab();
    expect(isQueryDirty(id)).toBe(false);
    editors().setSql(id, "SELECT 1");
    expect(isQueryDirty(id)).toBe(true);
    editors().setSql(id, "");
    expect(isQueryDirty(id)).toBe(false);
  });

  it("asks for a name on Save, and writes nothing", async () => {
    tabs().openQuery(REF);
    const { id } = onlyTab();
    await expect(saved().save(id)).resolves.toBe(false);
    expect(saved().prompt).toEqual({ kind: "save-as", tabId: id });
    expect(api.updateSavedQuery).not.toHaveBeenCalled();
  });

  it("belongs to the query after Save As", async () => {
    vi.mocked(api.createSavedQuery).mockResolvedValue(info("q1", "Report"));
    vi.mocked(api.updateSavedQuery).mockResolvedValue(info("q1", "Report"));
    tabs().openQuery(REF);
    const { id } = onlyTab();
    editors().setSql(id, "SELECT 1");
    await saved().saveAs(id, "Report");

    expect(api.createSavedQuery).toHaveBeenCalledWith("c", "Report", "d", "s", "SELECT 1");
    expect(onlyTab()).toMatchObject({ name: "Report", source: { kind: "saved", id: "q1" } });
    expect(isQueryDirty(id)).toBe(false);
    expect(saved().prompt).toBeNull();
    expect(saved().versions.c).toBe(1);

    editors().setSql(id, "SELECT 2");
    await saved().save(id);
    expect(api.updateSavedQuery).toHaveBeenCalledWith("c", "q1", "d", "s", "SELECT 2", 0);
    expect(isQueryDirty(id)).toBe(false);
  });

  it("stays dirty and keeps the prompt when the name is taken", async () => {
    vi.mocked(api.createSavedQuery).mockRejectedValue('A query named "Report" already exists.');
    tabs().openQuery(REF);
    const { id } = onlyTab();
    editors().setSql(id, "SELECT 1");
    saved().setPrompt({ kind: "save-as", tabId: id });
    await expect(saved().saveAs(id, "Report")).rejects.toContain("already exists");
    expect(saved().prompt).not.toBeNull();
    expect(onlyTab().source).toBeUndefined();
    expect(isQueryDirty(id)).toBe(true);
  });

  it("doesn't focus a saved query that happens to have its name", async () => {
    tabs().openQuerySource(REF, "Query 99", { kind: "saved", id: "q" }, "", null);
    for (let i = 0; i < 3; i++) tabs().openQuery(REF);
    expect(tabs().tabs).toHaveLength(4);
  });
});

describe("opening", () => {
  it("uses the query's target, and doesn't look edited with CRLF text", async () => {
    vi.mocked(api.loadSavedQuery).mockResolvedValue({ ...info("q1", "Report"), database: "other", schema: "", sql: "SELECT 1;\r\nSELECT 2;" });
    await saved().open("c", "q1");
    expect(onlyTab()).toMatchObject({ database: "other", schema: "", name: "Report" });
    expect(isQueryDirty(onlyTab().id)).toBe(false);
    expect(editors().editors[onlyTab().id].sql).toBe("SELECT 1;\nSELECT 2;");
  });

  it("focuses the tab of a query already open, without loading it", async () => {
    tabs().openQuerySource(REF, "Report", { kind: "saved", id: "q1" }, "text", null);
    const { id } = onlyTab();
    tabs().activate(null);
    await saved().open("c", "q1");
    expect(tabs().activeId).toBe(id);
    expect(tabs().tabs).toHaveLength(1);
    expect(api.loadSavedQuery).not.toHaveBeenCalled();
  });

  it("opens one tab for two opens that race", async () => {
    vi.mocked(api.loadSavedQuery).mockResolvedValue({ ...info("q1", "Report"), sql: "" });
    await Promise.all([saved().open("c", "q1"), saved().open("c", "q1")]);
    expect(tabs().tabs).toHaveLength(1);
  });

  it("reports a query that can't be read", async () => {
    vi.mocked(api.loadSavedQuery).mockRejectedValue("That query no longer exists.");
    await saved().open("c", "q1");
    expect(saved().error).toContain("no longer exists");
    expect(tabs().tabs).toHaveLength(0);
  });
});

describe("external files", () => {
  it("binds the tab, and Save writes back to the file", async () => {
    vi.mocked(api.openExternalSql).mockResolvedValue({ path: "/x/a.sql", name: "a.sql", modifiedMs: 3, sql: "SELECT 1" });
    await saved().openExternal(REF);
    const { id } = onlyTab();
    expect(onlyTab()).toMatchObject({ name: "a.sql", source: { kind: "file", path: "/x/a.sql" } });

    editors().setSql(id, "SELECT 2");
    await expect(saved().save(id)).resolves.toBe(true);
    expect(api.writeExternalSql).toHaveBeenCalledWith("/x/a.sql", "SELECT 2", 3);
    expect(isQueryDirty(id)).toBe(false);
  });

  it("does nothing when the dialog is cancelled", async () => {
    vi.mocked(api.openExternalSql).mockResolvedValue(null);
    await saved().openExternal(REF);
    expect(tabs().tabs).toHaveLength(0);

    vi.mocked(api.saveExternalSqlAs).mockResolvedValue(null);
    tabs().openQuery(REF);
    const { id } = onlyTab();
    editors().setSql(id, "x");
    await saved().saveAsExternal(id);
    expect(onlyTab().source).toBeUndefined();
    expect(isQueryDirty(id)).toBe(true);
  });

  it("rebinds a tab on Save As External File, suggesting its name", async () => {
    vi.mocked(api.saveExternalSqlAs).mockResolvedValue({ path: "/x/b.sql", name: "b.sql", modifiedMs: 5 });
    tabs().openQuerySource(REF, "a.sql", { kind: "file", path: "/x/a.sql" }, "SELECT 1", null);
    const { id } = onlyTab();
    await saved().saveAsExternal(id);
    expect(api.saveExternalSqlAs).toHaveBeenCalledWith("a", "SELECT 1");
    expect(onlyTab()).toMatchObject({ name: "b.sql", source: { kind: "file", path: "/x/b.sql" } });
  });

  it("keeps the tab dirty and shows the error when a write fails", async () => {
    vi.mocked(api.writeExternalSql).mockRejectedValueOnce("Could not save");
    tabs().openQuerySource(REF, "a.sql", { kind: "file", path: "/x/a.sql" }, "SELECT 1", null);
    const { id } = onlyTab();
    editors().setSql(id, "SELECT 2");
    await expect(saved().save(id)).resolves.toBe(false);
    expect(isQueryDirty(id)).toBe(true);
    expect(editors().editors[id].error).toBe("Could not save");
  });
});

describe("a file changed on disk", () => {
  const changed = "[changed] This file changed on disk.";

  it("sends the stamp from load and uses the one each save returns", async () => {
    vi.mocked(api.loadSavedQuery).mockResolvedValue({ ...info("q1", "Report"), modifiedMs: 10, sql: "a" });
    vi.mocked(api.updateSavedQuery).mockResolvedValue({ ...info("q1", "Report"), modifiedMs: 20 });
    await saved().open("c", "q1");
    const { id } = onlyTab();
    await saved().save(id);
    await saved().save(id);
    expect(vi.mocked(api.updateSavedQuery).mock.calls.map((c) => c[5])).toEqual([10, 20]);
  });

  it("offers to overwrite instead of failing, and keeps the tab dirty", async () => {
    vi.mocked(api.writeExternalSql).mockRejectedValueOnce(changed);
    tabs().openQuerySource(REF, "a.sql", { kind: "file", path: "/x/a.sql" }, "SELECT 1", 3);
    const { id } = onlyTab();
    editors().setSql(id, "SELECT 2");

    await expect(saved().save(id)).resolves.toBe(false);
    expect(saved().prompt).toEqual({ kind: "overwrite", tabId: id, message: "This file changed on disk." });
    expect(editors().editors[id].error).toBeNull();
    expect(isQueryDirty(id)).toBe(true);
  });

  it("overwrites without a stamp when the user says so", async () => {
    tabs().openQuerySource(REF, "a.sql", { kind: "file", path: "/x/a.sql" }, "SELECT 1", 3);
    const { id } = onlyTab();
    editors().setSql(id, "SELECT 2");
    await expect(saved().save(id, true)).resolves.toBe(true);
    expect(api.writeExternalSql).toHaveBeenCalledWith("/x/a.sql", "SELECT 2", null);
    expect(isQueryDirty(id)).toBe(false);
  });
});

describe("managing queries", () => {
  it("renames the open tab along with the query", async () => {
    vi.mocked(api.renameSavedQuery).mockResolvedValue(info("q1", "New"));
    tabs().openQuerySource(REF, "Old", { kind: "saved", id: "q1" }, "", null);
    saved().setPrompt({ kind: "rename", connectionId: "c", query: info("q1", "Old") });
    await saved().rename("New");
    expect(onlyTab().name).toBe("New");
    expect(saved().prompt).toBeNull();
  });

  it("leaves an open tab's text as unsaved when its query is deleted", async () => {
    tabs().openQuerySource(REF, "Report", { kind: "saved", id: "q1" }, "SELECT 1", null);
    const { id } = onlyTab();
    expect(isQueryDirty(id)).toBe(false);
    saved().setPrompt({ kind: "delete", connectionId: "c", query: info("q1", "Report") });
    await saved().confirmDelete();
    expect(onlyTab().source).toBeUndefined();
    expect(editors().editors[id].sql).toBe("SELECT 1");
    expect(isQueryDirty(id)).toBe(true);
  });
});

describe("the close prompt's commit", () => {
  it("stays apart from saving the text", async () => {
    tabs().openQuerySource(REF, "Report", { kind: "saved", id: "q1" }, "SELECT 1", null);
    const { id } = onlyTab();
    useQueryEditor.setState((s) => ({ editors: { ...s.editors, [id]: { ...s.editors[id], tx: "open" } } }));
    expect(isQueryDirty(id)).toBe(true);
    await saved().save(id);
    expect(isQueryDirty(id)).toBe(true);
  });
});
