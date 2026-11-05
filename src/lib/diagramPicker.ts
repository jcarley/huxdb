import { objectLabel } from "./diagramDrift";
import type { DiagramCandidate, DiagramObjectKind } from "./types";

/** The order a schema's kinds are listed in. */
export const KIND_ORDER: DiagramObjectKind[] = ["table", "view", "materialized-view", "function", "procedure"];

/** A new diagram starts with the schema it was opened on, tables only: a function or view is added on purpose. */
export const startingTicks = (candidates: DiagramCandidate[], schema: string) => candidates.filter((c) => c.schema === schema && c.kind === "table").map((c) => c.oid);

/** Schema, then kind. A signature is searched too, so "integer" finds `add(a integer)`. */
export function groupCandidates(candidates: DiagramCandidate[], search: string) {
  const needle = search.trim().toLowerCase();
  const bySchema = new Map<string, Map<DiagramObjectKind, DiagramCandidate[]>>();
  for (const c of candidates) {
    if (needle && !objectLabel(c).toLowerCase().includes(needle)) continue;
    const kinds = bySchema.get(c.schema) ?? new Map<DiagramObjectKind, DiagramCandidate[]>();
    kinds.set(c.kind, [...(kinds.get(c.kind) ?? []), c]);
    bySchema.set(c.schema, kinds);
  }
  const grouped = new Map<string, [DiagramObjectKind, DiagramCandidate[]][]>();
  for (const [schema, kinds] of bySchema) grouped.set(schema, KIND_ORDER.filter((k) => kinds.has(k)).map((k) => [k, kinds.get(k)!]));
  return grouped;
}
