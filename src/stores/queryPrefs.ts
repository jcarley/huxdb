// Query editor preferences kept across restarts (localStorage), shared by every query tab.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface QueryPrefs {
  /** The completion list, as in Navicat's Code Completion setting. */
  completion: boolean;
  upperCaseKeywords: boolean;

  setCompletion: (on: boolean) => void;
  setUpperCaseKeywords: (on: boolean) => void;
}

export const useQueryPrefs = create<QueryPrefs>()(
  persist(
    (set) => ({
      completion: true,
      upperCaseKeywords: true,

      setCompletion: (completion) => set({ completion }),
      setUpperCaseKeywords: (upperCaseKeywords) => set({ upperCaseKeywords }),
    }),
    {
      name: "huxdb-query-editor",
      partialize: ({ completion, upperCaseKeywords }) => ({ completion, upperCaseKeywords }),
    },
  ),
);
