// Typed wrappers around the Tauri commands in `src-tauri/src/connections/mod.rs`,
// `src-tauri/src/explorer/mod.rs`, `src-tauri/src/designer/mod.rs` and `src-tauri/src/editor/mod.rs`.
// Commands reject with a plain error string.

import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig, DataPage, DataTarget, EditBatch, QualifiedName, QueryResult, SchemaObjects, TableDesign, TableInfo, ViewDesign, ViewInfo } from "./types";

export const listConnections = () => invoke<ConnectionConfig[]>("list_connections");

export const saveConnection = (config: ConnectionConfig) =>
  invoke<ConnectionConfig>("save_connection", { config });

export const deleteConnection = (id: string) => invoke<void>("delete_connection", { id });

/** Resolves to the server's `version()` string. */
export const testConnection = (config: ConnectionConfig) =>
  invoke<string>("test_connection", { config });

// Object tree (`src-tauri/src/explorer/mod.rs`).

/** Connects via the connection's initial database and lists the server's databases. */
export const openConnection = (connectionId: string) =>
  invoke<string[]>("open_connection", { connectionId });

export const closeConnection = (connectionId: string) => invoke<void>("close_connection", { connectionId });

export const listSchemas = (connectionId: string, database: string) =>
  invoke<string[]>("list_schemas", { connectionId, database });

export const listSchemaObjects = (connectionId: string, database: string, schema: string) =>
  invoke<SchemaObjects>("list_schema_objects", { connectionId, database, schema });

export const listTables = (connectionId: string, database: string, schema: string) =>
  invoke<TableInfo[]>("list_tables", { connectionId, database, schema });

export const listViews = (connectionId: string, database: string, schema: string) =>
  invoke<ViewInfo[]>("list_views", { connectionId, database, schema });

// Table designer (`src-tauri/src/designer/mod.rs`).

export const loadTableDesign = (connectionId: string, database: string, schema: string, table: string) =>
  invoke<TableDesign>("load_table_design", { connectionId, database, schema, table });

/** Column names of a table, for a foreign key's referenced fields. */
export const listTableColumns = (connectionId: string, database: string, schema: string, table: string) =>
  invoke<string[]>("list_table_columns", { connectionId, database, schema, table });

export const listRoles = (connectionId: string, database: string) =>
  invoke<string[]>("list_roles", { connectionId, database });

export const listTablespaces = (connectionId: string, database: string) =>
  invoke<string[]>("list_tablespaces", { connectionId, database });

/** Functions that return `trigger`, outside the system schemas. */
export const listTriggerFunctions = (connectionId: string, database: string) =>
  invoke<QualifiedName[]>("list_trigger_functions", { connectionId, database });

/** The statements Save would run; rejects with a validation error. */
export const previewTableDdl = (original: TableDesign | null, edited: TableDesign) =>
  invoke<string[]>("preview_table_ddl", { original, edited });

/** Creates or alters the table in one transaction; resolves to the table as reloaded. */
export const saveTableDesign = (connectionId: string, database: string, original: TableDesign | null, edited: TableDesign) =>
  invoke<TableDesign>("save_table_design", { connectionId, database, original, edited });

// View designer (`src-tauri/src/designer/mod.rs`).

export const loadViewDesign = (connectionId: string, database: string, schema: string, view: string) =>
  invoke<ViewDesign>("load_view_design", { connectionId, database, schema, view });

export const previewViewDdl = (original: ViewDesign | null, edited: ViewDesign, recreate: boolean) =>
  invoke<string[]>("preview_view_ddl", { original, edited, recreate });

/** Rejects with a message starting with `RECREATE_MARKER` when only a drop and re-create can apply it. */
export const saveViewDesign = (connectionId: string, database: string, original: ViewDesign | null, edited: ViewDesign, recreate: boolean) =>
  invoke<ViewDesign>("save_view_design", { connectionId, database, original, edited, recreate });

export const RECREATE_MARKER = "[recreate] ";

/** Runs an unsaved definition read-only (30 s timeout) and returns its first rows. */
export const previewViewRows = (connectionId: string, database: string, definition: string) =>
  invoke<QueryResult>("preview_view_rows", { connectionId, database, definition });

/** EXPLAIN (no ANALYZE) of an unsaved definition, one line per entry. */
export const explainView = (connectionId: string, database: string, definition: string) =>
  invoke<string[]>("explain_view", { connectionId, database, definition });

// Editor sessions (a tab's transaction and Stop) --------------------------------

/** Begin Transaction: the tab's later data commands run in it until `sessionEnd`. */
export const sessionBegin = (tabId: string, connectionId: string, database: string) =>
  invoke<void>("session_begin", { tabId, connectionId, database });

/** Commits or rolls back the tab's transaction. */
export const sessionEnd = (tabId: string, commit: boolean) => invoke<void>("session_end", { tabId, commit });

/** Stop: cancels what the tab is running; that call rejects with `CANCELLED`. */
export const sessionCancel = (tabId: string, connectionId: string, database: string) =>
  invoke<void>("session_cancel", { tabId, connectionId, database });

/** The tab closed: rolls back its transaction, if any. */
export const sessionClose = (tabId: string) => invoke<void>("session_close", { tabId });

/** The error of a statement stopped with Stop. */
export const CANCELLED = "Cancelled";

// Data editor ----------------------------------------------------------------

export const fetchDataPage = (tabId: string, target: DataTarget, offset: number, limit: number) =>
  invoke<DataPage>("data_fetch_page", { tabId, target, offset, limit });

/** Exact row count; null when counting took too long. */
export const countRows = (tabId: string, target: DataTarget) => invoke<number | null>("data_count", { tabId, target });

/** Applies pending edits all or nothing; resolves to the number of rows changed. */
export const applyEdits = (tabId: string, target: DataTarget, batch: EditBatch) =>
  invoke<number>("data_apply", { tabId, target, batch });

export const errorMessage = (err: unknown) => (typeof err === "string" ? err : String(err));
