import type { ColumnOrigin } from "./types";

export const FUNCTION_NOTE = "Lines show only what PostgreSQL records. A function written as SQL text or PL/pgSQL records nothing about the tables it uses, so one with no lines may still use them.";
export const EXPRESSION_NOTE = "(Expression) means a column has no single source, as with a cast, an aggregate or a UNION. The dashed lines still show everything this view reads.";

/** Where a view column comes from: `table.column`, the table for a whole row, or `(Expression)`. */
export function sourceLabel(source: ColumnOrigin | null, showSchema: boolean) {
  if (!source) return "(Expression)";
  const parts = [...(showSchema ? [source.schema] : []), source.relation, ...(source.column === null ? [] : [source.column])];
  return parts.join(".");
}
