// Window layout preferences kept across restarts (localStorage).

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 600;

const fitWidth = (width: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));

interface ShellPrefs {
  /** The Connections panel's width when open, kept while it's collapsed. */
  sidebarWidth: number;
  sidebarCollapsed: boolean;

  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
}

/** What was stored, on top of the defaults, with a stored width held to the limits too. */
export function restorePrefs(stored: unknown, current: ShellPrefs): ShellPrefs {
  const saved = stored as Partial<ShellPrefs> | undefined;
  const width = saved?.sidebarWidth;
  return { ...current, ...saved, sidebarWidth: fitWidth(typeof width === "number" ? width : current.sidebarWidth) };
}

export const useShellPrefs = create<ShellPrefs>()(
  persist(
    (set) => ({
      sidebarWidth: 288,
      sidebarCollapsed: false,

      setSidebarWidth: (width) => set({ sidebarWidth: fitWidth(width) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: "huxdb-shell",
      partialize: ({ sidebarWidth, sidebarCollapsed }) => ({ sidebarWidth, sidebarCollapsed }),
      merge: restorePrefs,
    },
  ),
);
