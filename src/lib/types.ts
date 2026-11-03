// Mirrors `src-tauri/src/connections/model.rs` (serde camelCase / kebab-case).

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface ConnectionConfig {
  /** Empty string for a connection that has not been saved yet. */
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string | null;
  sslMode: SslMode;
  color: string | null;
}

export const SSL_MODES: { value: SslMode; label: string; description: string }[] = [
  { value: "disable", label: "Disable", description: "Never use SSL." },
  { value: "prefer", label: "Prefer", description: "Use SSL if the server supports it." },
  { value: "require", label: "Require", description: "Always use SSL; don't verify the certificate." },
  { value: "verify-ca", label: "Verify CA", description: "Require SSL and a certificate from a trusted CA." },
  {
    value: "verify-full",
    label: "Verify Full",
    description: "Like Verify CA, and the certificate must match the host name.",
  },
];

export const CONNECTION_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function newConnection(): ConnectionConfig {
  return {
    id: "",
    name: "",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    database: null,
    sslMode: "prefer",
    color: null,
  };
}

// Mirrors `src-tauri/src/explorer/postgres.rs`.

/** A function or procedure; `arguments` (identity argument types) tells overloads apart. */
export interface FunctionInfo {
  name: string;
  arguments: string;
}

export interface SchemaObjects {
  tables: string[];
  views: string[];
  materializedViews: string[];
  functions: FunctionInfo[];
}

/** One row of the details pane's tables list. */
export interface TableInfo {
  name: string;
  /** Planner estimate; null if the table was never analyzed or is partitioned. */
  rows: number | null;
  oid: number;
  owner: string;
  /** Created by initdb (OID below 16384). */
  systemTable: boolean;
  comment: string | null;
}

/** One row of the details pane's views list. */
export interface ViewInfo {
  name: string;
  oid: number;
  owner: string;
  /** Created by initdb (OID below 16384). */
  systemView: boolean;
  comment: string | null;
}
