// Diagram preferences kept across restarts (localStorage): pane widths, shared by every tab.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface DiagramPrefs {
  objectsWidth: number;
  sideWidth: number;
  setWidth: (pane: "objectsWidth" | "sideWidth", width: number) => void;
}

export const useDiagramPrefs = create<DiagramPrefs>()(
  persist(
    (set) => ({
      objectsWidth: 200,
      sideWidth: 260,
      setWidth: (pane, width) => set({ [pane]: Math.round(width) }),
    }),
    { name: "huxdb-diagram", partialize: ({ objectsWidth, sideWidth }) => ({ objectsWidth, sideWidth }) },
  ),
);
