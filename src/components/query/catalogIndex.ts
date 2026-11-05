// Lookups over a completion catalog, by name and along the search path.

import type { CatalogColumn, CatalogFunction, CatalogRelation, CatalogSchema, CompletionCatalog } from "../../lib/types";
import { findCte } from "./sqlScope";
import type { Cte, Scope, Source } from "./sqlScope";

interface IndexedSchema {
  schema: CatalogSchema;
  relations: Map<string, CatalogRelation>;
  functions: Map<string, CatalogFunction[]>;
}

export interface CatalogIndex {
  schemas: Map<string, IndexedSchema>;
  /** Schemas searched for an unqualified name, in order. */
  scope: string[];
}

/** A column as far as it's known: the columns of a CTE or subquery have no type here. */
export type KnownColumn = Pick<CatalogColumn, "name" | "quoted"> & { dataType?: string };

/** Schemas whose relations resolve without a qualifier, in order. A tab's schema
 * becomes its session's `search_path`, with `public` after it (`apply_schema` in the
 * backend) and `pg_catalog` searched first, as PostgreSQL does when it isn't listed. */
export function searchScope(catalog: CompletionCatalog, schema = ""): string[] {
  return schema ? [...new Set(["pg_catalog", schema, "public"])] : catalog.searchPath;
}

export function buildIndex(catalog: CompletionCatalog, schema = ""): CatalogIndex {
  const schemas = new Map<string, IndexedSchema>();
  for (const s of catalog.schemas) {
    const functions = new Map<string, CatalogFunction[]>();
    for (const f of s.functions) {
      const overloads = functions.get(f.name);
      if (overloads) overloads.push(f);
      else functions.set(f.name, [f]);
    }
    schemas.set(s.name, { schema: s, relations: new Map(s.relations.map((r) => [r.name, r])), functions });
  }
  return { schemas, scope: searchScope(catalog, schema) };
}

/** A relation by bare or qualified name. */
export function findRelation(index: CatalogIndex, path: string[]): CatalogRelation | null {
  if (path.length === 2) return index.schemas.get(path[0])?.relations.get(path[1]) ?? null;
  if (path.length !== 1) return null;
  for (const name of index.scope) {
    const relation = index.schemas.get(name)?.relations.get(path[0]);
    if (relation) return relation;
  }
  return null;
}

/** Overloads by bare name across the search path, as PostgreSQL considers them, or by qualified name. */
export function findFunctions(index: CatalogIndex, path: string[]): CatalogFunction[] {
  if (path.length === 2) return index.schemas.get(path[0])?.functions.get(path[1]) ?? [];
  if (path.length !== 1) return [];
  return index.scope.flatMap((name) => index.schemas.get(name)?.functions.get(path[0]) ?? []);
}

function withAliases(columns: KnownColumn[], aliases: string[] | undefined): KnownColumn[] {
  if (!aliases?.length) return columns;
  const renamed = columns.map((column, i) => (i < aliases.length ? { name: aliases[i], dataType: column.dataType } : column));
  return aliases.length > columns.length ? [...renamed, ...aliases.slice(columns.length).map((name) => ({ name }))] : renamed;
}

/** What a query's SELECT list gives. `seen` stops a CTE that reads itself. */
function queryColumns(index: CatalogIndex, query: Scope, seen: Set<Cte>): KnownColumn[] {
  return query.output.flatMap((item) => {
    if ("name" in item) return [{ name: item.name }];
    const sources = query.sources.filter((s) => item.qualifier === null || s.name === item.qualifier);
    return sources.flatMap((source) => sourceColumns(index, source, query, seen));
  });
}

export function sourceColumns(index: CatalogIndex, source: Source, scope: Scope, seen = new Set<Cte>()): KnownColumn[] {
  switch (source.kind) {
    case "function":
      return withAliases([], source.columnAliases);
    case "query":
      return withAliases(queryColumns(index, source.query, seen), source.columnAliases);
    case "table": {
      const found = source.path.length === 1 ? findCte(scope, source.path[0]) : null;
      if (found) return withAliases(cteColumns(index, found.cte, seen), source.columnAliases);
      return withAliases(findRelation(index, source.path)?.columns ?? [], source.columnAliases);
    }
  }
}

export function cteColumns(index: CatalogIndex, cte: Cte, seen = new Set<Cte>()): KnownColumn[] {
  if (seen.has(cte)) return [];
  seen.add(cte);
  // Only the first arm names the output, so a recursive CTE resolves through it.
  const columns = withAliases(queryColumns(index, cte.query, seen), cte.columnAliases);
  seen.delete(cte);
  return columns;
}
