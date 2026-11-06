import { beforeEach, describe, expect, it } from "vitest";
import { restorePrefs, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useShellPrefs } from "./shellPrefs";

describe("shell preferences", () => {
  beforeEach(() => useShellPrefs.setState({ sidebarWidth: 288, sidebarCollapsed: false }));

  it("starts at the panel's old fixed width, open", () => {
    expect(useShellPrefs.getInitialState()).toMatchObject({ sidebarWidth: 288, sidebarCollapsed: false });
  });

  it("holds the width to its limits", () => {
    useShellPrefs.getState().setSidebarWidth(10);
    expect(useShellPrefs.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    useShellPrefs.getState().setSidebarWidth(5000);
    expect(useShellPrefs.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    expect([SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]).toEqual([180, 600]);
  });

  it("rounds the width", () => {
    useShellPrefs.getState().setSidebarWidth(300.6);
    expect(useShellPrefs.getState().sidebarWidth).toBe(301);
  });

  it("toggles collapsed without touching the width", () => {
    useShellPrefs.getState().setSidebarWidth(400);
    useShellPrefs.getState().toggleSidebar();
    expect(useShellPrefs.getState()).toMatchObject({ sidebarCollapsed: true, sidebarWidth: 400 });
    useShellPrefs.getState().toggleSidebar();
    expect(useShellPrefs.getState()).toMatchObject({ sidebarCollapsed: false, sidebarWidth: 400 });
  });

  it("holds a stored width to its limits and keeps what else was stored", () => {
    const restored = restorePrefs({ sidebarWidth: 9000, sidebarCollapsed: true }, useShellPrefs.getState());
    expect(restored).toMatchObject({ sidebarWidth: SIDEBAR_MAX_WIDTH, sidebarCollapsed: true });
  });

  it("ignores a stored width that isn't a number", () => {
    expect(restorePrefs({ sidebarWidth: "abc" }, useShellPrefs.getState()).sidebarWidth).toBe(288);
  });

  it("uses the defaults when nothing was stored", () => {
    expect(restorePrefs(undefined, useShellPrefs.getState())).toMatchObject({ sidebarWidth: 288, sidebarCollapsed: false });
  });
});
