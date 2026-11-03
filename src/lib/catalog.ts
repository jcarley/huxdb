// Cached catalog lookups for the designer's pickers (schemas, tables, columns).
// Entries for a schema are dropped when a designer saves into it.

import { useEffect, useState } from "react";
import * as api from "./api";

const cache = new Map<string, Promise<unknown>>();
const SEP = "\u001f";

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let entry = cache.get(key) as Promise<T> | undefined;
  if (!entry) {
    entry = load();
    // A failed lookup isn't cached, so the next render retries.
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}

export function invalidateCatalog(connectionId: string, database: string, schema: string) {
  const tables = ["tables", connectionId, database, schema].join(SEP);
  const columns = ["columns", connectionId, database, schema, ""].join(SEP);
  for (const key of cache.keys()) {
    if (key === tables || key.startsWith(columns)) cache.delete(key);
  }
}

export type Lookup<T = string> = { status: "loading" } | { status: "loaded"; names: T[] } | { status: "error"; error: string };

function useLookup<T = string>(key: string | null, load: () => Promise<T[]>): Lookup<T> {
  const [state, setState] = useState<{ key: string | null; lookup: Lookup<T> }>({ key, lookup: { status: "loading" } });
  useEffect(() => {
    if (key === null) return;
    let ignore = false;
    cached(key, load).then(
      (names) => !ignore && setState({ key, lookup: { status: "loaded", names } }),
      (err) => !ignore && setState({ key, lookup: { status: "error", error: api.errorMessage(err) } }),
    );
    return () => {
      ignore = true;
    };
    // `load` is derived from `key`.
  }, [key]);
  if (key === null) return { status: "loaded", names: [] };
  return state.key === key ? state.lookup : { status: "loading" };
}

export const useSchemas = (connectionId: string, database: string) =>
  useLookup(["schemas", connectionId, database].join(SEP), () => api.listSchemas(connectionId, database));

/** Tables of a schema; nothing while `schema` is blank. */
export const useTables = (connectionId: string, database: string, schema: string) =>
  useLookup(schema ? ["tables", connectionId, database, schema].join(SEP) : null, () =>
    api.listSchemaObjects(connectionId, database, schema).then((o) => o.tables),
  );

/** Columns of a table; nothing while `table` is blank. */
export const useColumns = (connectionId: string, database: string, schema: string, table: string) =>
  useLookup(table ? ["columns", connectionId, database, schema, table].join(SEP) : null, () =>
    api.listTableColumns(connectionId, database, schema, table),
  );

export const useRoles = (connectionId: string, database: string) =>
  useLookup(["roles", connectionId, database].join(SEP), () => api.listRoles(connectionId, database));

export const useTablespaces = (connectionId: string, database: string) =>
  useLookup(["tablespaces", connectionId, database].join(SEP), () => api.listTablespaces(connectionId, database));

export const useTriggerFunctions = (connectionId: string, database: string) =>
  useLookup(["triggerFunctions", connectionId, database].join(SEP), () => api.listTriggerFunctions(connectionId, database));
