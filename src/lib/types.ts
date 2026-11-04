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
  excludes: ExcludeDesign[];
  triggers: TriggerDesign[];
  options: TableOptions;
  rules: RuleDesign[];
}

/** ON SELECT rules would turn a table into a view, so they aren't offered. */
export const RULE_EVENTS = ["insert", "update", "delete"] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

export interface RuleDesign {
  originalName: string | null;
  name: string;
  event: RuleEvent;
  /** DO INSTEAD; otherwise DO ALSO. */
  instead: boolean;
  /** WHERE condition without its parentheses; may use only NEW and OLD. */
  condition: string | null;
  /** The commands: `NOTHING`, one command, or `(cmd1; cmd2)`. */
  actions: string;
  comment: string | null;
  /** Set for a rule whose definition couldn't be parsed; it is read-only. */
  definition: string | null;
}

/** An exclusion constraint element: a column (or expression) and its operator. */
export interface ExcludeElement {
  column: string;
  operator: string;
}

export interface ExcludeDesign {
  originalName: string | null;
  name: string;
  method: string;
  elements: ExcludeElement[];
  predicate: string | null;
  comment: string | null;
}

export type TriggerTiming = "before" | "after";
export const TRIGGER_ENABLED = ["origin", "disabled", "replica", "always"] as const;
export type TriggerEnabled = (typeof TRIGGER_ENABLED)[number];

export interface TriggerDesign {
  originalName: string | null;
  name: string;
  timing: TriggerTiming;
  /** FOR EACH ROW; otherwise FOR EACH STATEMENT. */
  forEachRow: boolean;
  onInsert: boolean;
  onUpdate: boolean;
  onDelete: boolean;
  onTruncate: boolean;
  /** UPDATE OF these fields; empty means any field. */
  updateColumns: string[];
  /** WHEN condition without its parentheses. */
  when: string | null;
  functionSchema: string;
  functionName: string;
  /** Arguments as SQL literals, e.g. `'audit', 42`. */
  arguments: string;
  enabled: TriggerEnabled;
  comment: string | null;
  /** Set for triggers the designer can't edit (constraint triggers, transition tables). */
  definition: string | null;
}

export interface QualifiedName {
  schema: string;
  name: string;
}

export const PARTITION_STRATEGIES = ["range", "list", "hash"] as const;
export type PartitionStrategy = (typeof PARTITION_STRATEGIES)[number];

export interface PartitionDesign {
  strategy: PartitionStrategy;
  /** Columns or expressions. */
  keys: string[];
}

export interface TableOptions {
  /** Null on a new table means the current user. */
  owner: string | null;
  /** Null means the database's default tablespace. */
  tablespace: string | null;
  unlogged: boolean;
  fillFactor: number | null;
  inherits: QualifiedName[];
  /** Only used when creating a table. */
  partitionBy: PartitionDesign | null;
  /** Read-only: an existing partitioned table's key. */
  partitionKey: string | null;
  /** Read-only: a partition's parent and bounds. */
  partitionOf: string | null;
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

export const newExclude = (): ExcludeDesign => ({
  originalName: null,
  name: "",
  method: "gist",
  elements: [],
  predicate: null,
  comment: null,
});

export const newTrigger = (): TriggerDesign => ({
  originalName: null,
  name: "",
  timing: "before",
  forEachRow: true,
  onInsert: false,
  onUpdate: false,
  onDelete: false,
  onTruncate: false,
  updateColumns: [],
  when: null,
  functionSchema: "",
  functionName: "",
  arguments: "",
  enabled: "origin",
  comment: null,
  definition: null,
});

export const newRule = (): RuleDesign => ({
  originalName: null,
  name: "",
  event: "insert",
  instead: false,
  condition: null,
  actions: "",
  comment: null,
  definition: null,
});

export const newOptions = (): TableOptions => ({
  owner: null,
  tablespace: null,
  unlogged: false,
  fillFactor: null,
  inherits: [],
  partitionBy: null,
  partitionKey: null,
  partitionOf: null,
});

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

// Mirrors src-tauri/src/designer/view.rs and view_postgres.rs

export type CheckOption = "local" | "cascaded";

export interface ViewDesign {
  schema: string;
  name: string;
  /** The SELECT, as PostgreSQL normalized it or as typed. */
  definition: string;
  /** Null on a new view means the current user. */
  owner: string | null;
  comment: string | null;
  checkOption: CheckOption | null;
  securityBarrier: boolean;
  /** PostgreSQL 15+. */
  securityInvoker: boolean;
  /** Read-only: whether the server has security_invoker. */
  supportsSecurityInvoker: boolean;
}

/** Preview rows, every value as text (null for NULL). */
export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  /** More rows exist than were returned. */
  truncated: boolean;
}

// Mirrors src-tauri/src/editor/model.rs and mod.rs

/** The table a data tab shows. */
export interface DataTarget {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
}

export interface DataColumn {
  name: string;
  /** `format_type()` output, e.g. `numeric(10,2)`. */
  typeName: string;
  nullable: boolean;
  /** Has a DEFAULT (or is an identity column), so a new row can leave it out. */
  hasDefault: boolean;
  /** Why the column can't be edited, if so. */
  readOnly: string | null;
}

export interface DataSource {
  columns: DataColumn[];
  /** Primary key column names in key order; empty when there is none. */
  primaryKey: string[];
  /** Why the whole table is read-only (no primary key), if so. */
  readOnly: string | null;
}

/** A page of rows, every value as text (null for NULL), in column order. */
export interface DataPage {
  source: DataSource;
  rows: (string | null)[][];
}

export interface CellValue {
  column: string;
  value: string | null;
}

/** Changed cells of an existing row, found by its original primary key values. */
export interface RowUpdate {
  key: string[];
  values: CellValue[];
}

export interface EditBatch {
  deletes: string[][];
  updates: RowUpdate[];
  /** Each new row lists only its edited columns; the rest get their defaults. */
  inserts: CellValue[][];
}
