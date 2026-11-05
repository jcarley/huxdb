import { Eye, Layers, SquareFunction, Table, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DiagramObjectKind } from "../../lib/types";

/** The tree's icons, so an object looks the same in both. */
export const OBJECT_ICONS: Record<DiagramObjectKind, LucideIcon> = {
  table: Table,
  view: Eye,
  "materialized-view": Layers,
  function: SquareFunction,
  procedure: Workflow,
};

/** Plural headings for the picker. */
export const KIND_HEADINGS: Record<DiagramObjectKind, string> = {
  table: "Tables",
  view: "Views",
  "materialized-view": "Materialized Views",
  function: "Functions",
  procedure: "Procedures",
};
