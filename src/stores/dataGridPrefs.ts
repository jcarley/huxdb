// Data grid preferences kept across restarts (localStorage): the grid's font
// size, shared by every data tab, and column widths the user set, per table.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DataTarget } from "../lib/types";

export const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24];
export const DEFAULT_FONT_SIZE = 12;

interface DataGridPrefs {
  fontSize: number;
  /** Table key (see `tableKey`) → column name → width in px. */
  columnWidths: Record<string, Record<string, number>>;

  /** Steps the font size up (+1) or down (-1) through FONT_SIZES; 0 resets it. */
  zoom: (step: -1 | 0 | 1) => void;
  setColumnWidth: (table: string, column: string, width: number) => void;
}

/** Identifies a table across sessions. */
export const tableKey = ({ connectionId, database, schema, table }: DataTarget) =>
  [connectionId, database, schema, table].join("\u001f");

export const useDataGridPrefs = create<DataGridPrefs>()(
  persist(
    (set) => ({
      fontSize: DEFAULT_FONT_SIZE,
      columnWidths: {},

      zoom: (step) =>
        set((s) => {
          if (step === 0) return { fontSize: DEFAULT_FONT_SIZE };
          const index = FONT_SIZES.indexOf(s.fontSize);
          const from = index < 0 ? FONT_SIZES.indexOf(DEFAULT_FONT_SIZE) : index;
          return { fontSize: FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, from + step))] };
        }),

      setColumnWidth: (table, column, width) =>
        set((s) => ({ columnWidths: { ...s.columnWidths, [table]: { ...s.columnWidths[table], [column]: Math.round(width) } } })),
    }),
    { name: "huxdb-data-grid", partialize: ({ fontSize, columnWidths }) => ({ fontSize, columnWidths }) },
  ),
);
