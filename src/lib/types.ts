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

// Mirrors src-tauri/src/designer/model.rs

export type Identity = "always" | "by-default";

export interface ColumnDesign {
  /** Name when loaded; null for a field added in the designer. Diffing matches on it. */
  originalName: string | null;
  name: string;
  /** Type without modifiers, e.g. `character varying`, `integer[]`. */
  dataType: string;
  length: number | null;
  scale: number | null;
  notNull: boolean;
  /** Raw SQL expression; text defaults need their quotes. */
  default: string | null;
  identity: Identity | null;
  /** Generated column expression; read-only for now. */
  generated: string | null;
  comment: string | null;
  /** 1-based position in the primary key. */
  keyOrder: number | null;
}

export interface TableDesign {
  schema: string;
  name: string;
  comment: string | null;
  primaryKeyName: string | null;
  columns: ColumnDesign[];
  indexes: IndexDesign[];
  foreignKeys: ForeignKeyDesign[];
  uniques: UniqueDesign[];
  checks: CheckDesign[];
}

/** An index key: a column name, or an expression when it names no column. */
export interface IndexColumn {
  column: string;
  descending: boolean;
}

/** Indexes backing a primary key or unique constraint show on those tabs, not here. */
export interface IndexDesign {
  originalName: string | null;
  /** Blank lets PostgreSQL pick a name. */
  name: string;
  columns: IndexColumn[];
  method: string;
  unique: boolean;
  /** Partial index condition (the WHERE clause). */
  predicate: string | null;
  comment: string | null;
}

export const FOREIGN_KEY_ACTIONS = ["no-action", "restrict", "cascade", "set-null", "set-default"] as const;
export type ForeignKeyAction = (typeof FOREIGN_KEY_ACTIONS)[number];

export interface ForeignKeyDesign {
  originalName: string | null;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  /** Referenced fields, paired by position with `columns`. */
  refColumns: string[];
  onUpdate: ForeignKeyAction;
  onDelete: ForeignKeyAction;
  comment: string | null;
}

export interface UniqueDesign {
  originalName: string | null;
  name: string;
  columns: string[];
  comment: string | null;
}

export interface CheckDesign {
  originalName: string | null;
  name: string;
  /** Boolean SQL expression without the CHECK keyword. */
  expression: string;
  noInherit: boolean;
  comment: string | null;
}

export const INDEX_METHODS = ["btree", "hash", "gist", "spgist", "gin", "brin"];

export const newIndex = (): IndexDesign => ({
  originalName: null,
  name: "",
  columns: [],
  method: "btree",
  unique: false,
  predicate: null,
  comment: null,
});

export const newForeignKey = (refSchema: string): ForeignKeyDesign => ({
  originalName: null,
  name: "",
  columns: [],
  refSchema,
  refTable: "",
  refColumns: [],
  onUpdate: "no-action",
  onDelete: "no-action",
  comment: null,
});

export const newUnique = (): UniqueDesign => ({ originalName: null, name: "", columns: [], comment: null });

export const newCheck = (): CheckDesign => ({ originalName: null, name: "", expression: "", noInherit: false, comment: null });

export const newColumn = (): ColumnDesign => ({
  originalName: null,
  name: "",
  dataType: "",
  length: null,
  scale: null,
  notNull: false,
  default: null,
  identity: null,
  generated: null,
  comment: null,
  keyOrder: null,
});
