import { createContext, useContext } from "react";

/** The tab a table node belongs to, since React Flow's node props don't carry it. */
export const DiagramId = createContext("");
export const useDiagramId = () => useContext(DiagramId);
