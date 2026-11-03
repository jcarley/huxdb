// Typed wrappers around the Tauri commands in `src-tauri/src/connections/mod.rs` and
// `src-tauri/src/explorer/mod.rs`.
// Commands reject with a plain error string.

import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig, SchemaObjects, TableInfo } from "./types";

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

export const errorMessage = (err: unknown) => (typeof err === "string" ? err : String(err));
