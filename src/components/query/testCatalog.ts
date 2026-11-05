// A small catalog and an editor state for the query editor's tests.

import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { CatalogColumn, CatalogFunction, CatalogRelation, CompletionCatalog, RelationKind } from "../../lib/types";

const column = (name: string, dataType: string, quoted?: string): CatalogColumn => ({ name, dataType, quoted });
const relation = (name: string, kind: RelationKind, columns: CatalogColumn[], quoted?: string): CatalogRelation => ({ name, kind, columns, quoted });

export const fn = (name: string, args: string, result: string | undefined, min: number, max: number, variadic = false): CatalogFunction => ({
  name,
  arguments: args,
  result,
  minArgs: min,
  maxArgs: max,
  variadic,
});

export const catalog: CompletionCatalog = {
  searchPath: ["pg_catalog", "public"],
  schemas: [
    {
      name: "pg_catalog",
      relations: [relation("pg_class", "table", [column("oid", "oid")])],
      functions: [
        fn("lower", "text", "text", 1, 1),
        fn("round", "numeric", "numeric", 1, 1),
        fn("round", "numeric, integer", "numeric", 2, 2),
        fn("round", "double precision", "double precision", 1, 1),
        fn("left", "text, integer", "text", 2, 2),
        fn("concat", 'VARIADIC "any"', "text", 0, 1, true),
        fn("now", "", "timestamp with time zone", 0, 0),
      ],
    },
    {
      name: "public",
      relations: [
        relation("users", "table", [column("id", "integer"), column("name", "text"), column("Mixed", "text", '"Mixed"'), column("order", "text", '"order"')]),
        relation("Users", "table", [column("upper_only", "text")], '"Users"'),
        relation("orders", "table", [column("id", "integer"), column("user_id", "integer"), column("total", "numeric(10,2)")]),
        relation("order", "table", [column("x", "integer")], '"order"'),
        relation("a.b", "view", [column("d", "integer")], '"a.b"'),
        relation("posts", "materialized-view", [column("title", "text")]),
      ],
      functions: [fn("add_user", "name text, age integer DEFAULT 1", "integer", 1, 2)],
    },
    {
      name: "app",
      relations: [relation("users", "table", [column("app_only", "integer")]), relation("only_app", "table", [column("z", "integer")])],
      functions: [fn("app_fn", "", "integer", 0, 0)],
    },
    { name: "Odd One", quoted: '"Odd One"', relations: [relation("t", "table", [column("q", "integer")])], functions: [] },
  ],
};

/** A fully parsed state, with `|` marking the cursor. */
export function stateAt(marked: string): { state: EditorState; pos: number } {
  const pos = marked.indexOf("|");
  const doc = marked.replace("|", "");
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [sql({ dialect: PostgreSQL })] });
  ensureSyntaxTree(state, doc.length, 1e6);
  return { state, pos };
}
