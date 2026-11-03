// Typed wrappers around the Tauri commands in `src-tauri/src/connections/mod.rs`.
// Commands reject with a plain error string.

import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "./types";

export const listConnections = () => invoke<ConnectionConfig[]>("list_connections");

export const saveConnection = (config: ConnectionConfig) =>
  invoke<ConnectionConfig>("save_connection", { config });

export const deleteConnection = (id: string) => invoke<void>("delete_connection", { id });

/** Resolves to the server's `version()` string. */
export const testConnection = (config: ConnectionConfig) =>
  invoke<string>("test_connection", { config });

export const errorMessage = (err: unknown) => (typeof err === "string" ? err : String(err));
