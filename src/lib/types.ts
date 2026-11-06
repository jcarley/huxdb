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
  /** Its type has default ordering and equality operators (json doesn't). */
  comparable: boolean;
  /** The base type without its modifier, e.g. `numeric`, which filter values are cast to. */
  filterType: string;
  /** Its base type is a string type, so a value can be the empty string. */
  textLike: boolean;
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

export type FilterOp =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "contains"
  | "begins-with"
  | "ends-with"
  | "is-null"
  | "is-not-null"
  | "is-empty"
  | "between"
  | "in";

interface FilterNodeBase {
  /** Client-side only: the backend ignores it. */
  id: string;
  /** SQL `NOT`. */
  negated: boolean;
  /** Left out of the query, but kept in the builder. */
  disabled: boolean;
}

export interface FilterCondition extends FilterNodeBase {
  kind: "condition";
  column: string;
  op: FilterOp;
  /** The value of a comparison or text match. */
  value: string | null;
  /** The two ends of a between, or the lines of an in-list. */
  values: string[];
}

export interface FilterGroup extends FilterNodeBase {
  kind: "group";
  op: "and" | "or";
  children: FilterNode[];
}

/** The user's SQL expression, treated like the typed WHERE. */
export interface FilterCustom extends FilterNodeBase {
  kind: "custom";
  sql: string;
}

/** A structured filter: conditions on columns, joined in groups. */
export type FilterNode = FilterCondition | FilterGroup | FilterCustom;

export interface SortKey {
  column: string;
  descending: boolean;
}

/** Which rows a data tab shows, and in what order. */
export interface DataSpec {
  /** Always a group here: the builder's top level. */
  filter: FilterGroup | null;
  sort: SortKey[];
  /** The user's SQL, ANDed with `filter`. */
  whereSql: string | null;
  /** The user's SQL; the UI sets this or `sort`, not both. */
  orderSql: string | null;
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

// Query editor (`src-tauri/src/query/model.rs`). Offsets are UTF-16, as CodeMirror's are.

/** Where a query tab's SQL runs. An empty `schema` leaves the server's search_path. */
export interface QueryTarget {
  connectionId: string;
  database: string;
  schema: string;
}

export type RunScope = { kind: "all" } | { kind: "selection"; from: number; to: number } | { kind: "cursor"; pos: number };

export interface TextRange {
  from: number;
  to: number;
}

/** A tab's transaction. `aborted` failed, and only a rollback gets out of it. */
export type TxState = "idle" | "open" | "aborted";

/** A statement's rows, as text. Columns go by position, as names can repeat. */
export interface ResultSet {
  columns: string[];
  rows: (string | null)[][];
  /** A limit was reached, so some rows aren't here. */
  truncated: boolean;
  /** The limit stopped the statement, rather than it running to the end. */
  cancelledAtLimit: boolean;
}

export interface QueryError {
  message: string;
  code: string | null;
  detail: string | null;
  hint: string | null;
  /** Where in the text the server says it went wrong. */
  position: number | null;
}

export type RelationKind = "table" | "view" | "materialized-view";

export interface CatalogColumn {
  name: string;
  /** `quote_ident` of the name, when that isn't the name. */
  quoted?: string;
  dataType: string;
}

export interface CatalogRelation {
  name: string;
  quoted?: string;
  kind: RelationKind;
  columns: CatalogColumn[];
}

/** One overload. */
export interface CatalogFunction {
  name: string;
  quoted?: string;
  /** Names, types and defaults, as `pg_get_function_arguments` writes them. */
  arguments: string;
  /** None for a procedure. */
  result?: string;
  minArgs: number;
  maxArgs: number;
  variadic: boolean;
}

export interface CatalogSchema {
  name: string;
  quoted?: string;
  relations: CatalogRelation[];
  functions: CatalogFunction[];
}

/** What code completion knows about a database. */
export interface CompletionCatalog {
  /** `current_schemas(true)` on a fresh connection, in search order. */
  searchPath: string[];
  schemas: CatalogSchema[];
}

export interface StatementOutcome {
  index: number;
  range: TextRange;
  sql: string;
  elapsedMs: number;
  /** Rows the server reports, also past a limit. Null if it didn't finish. */
  rowsAffected: number | null;
  result: ResultSet | null;
  error: QueryError | null;
  /** Stop ended it. */
  cancelled: boolean;
  notices: string[];
  note: string | null;
  tx: TxState;
  /** It may have changed what code completion knows about. */
  changesCatalog: boolean;
}

export type QueryEvent =
  | { event: "statement-started"; index: number; total: number; range: TextRange }
  | { event: "statement-finished"; outcome: StatementOutcome }
  | { event: "run-done"; tx: TxState; stopped: boolean; sessionLost: string | null };

// Saved queries.

/** Mirrors `SavedQueryInfo` in `saved_queries/store.rs`. */
export interface SavedQueryInfo {
  id: string;
  name: string;
  /** Empty for a file with no sidecar. */
  database: string;
  schema: string;
  modifiedMs: number | null;
  size: number;
}

export interface SavedQuery extends SavedQueryInfo {
  sql: string;
}

export interface SavedQuerySummary {
  count: number;
  dir: string;
}

export interface ExternalFile {
  path: string;
  name: string;
  modifiedMs: number | null;
}

export interface ExternalSql extends ExternalFile {
  sql: string;
}

export type DiagramObjectKind = "table" | "view" | "materialized-view" | "function" | "procedure";

/** An object a diagram can hold. */
export interface DiagramCandidate {
  oid: number;
  schema: string;
  name: string;
  kind: DiagramObjectKind;
  /** Argument list of a function or procedure; null for a relation. */
  signature: string | null;
}

export interface DiagramColumn {
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
  comment: string | null;
}

export interface DiagramTable {
  /** Negative for a function: opaque to the frontend. */
  oid: number;
  schema: string;
  name: string;
  /** Absent in diagrams saved before views and functions: a table. */
  kind?: DiagramObjectKind;
  signature?: string | null;
  comment: string | null;
  columns: DiagramColumn[];
}

/** One constraint, one line. */
export interface DiagramForeignKey {
  oid: number;
  name: string;
  childOid: number;
  parentOid: number;
  childColumns: string[];
  parentColumns: string[];
  /** The partition holding this key, when the line is drawn from its root. */
  childPartition: string | null;
  /** The partition this key references, when the line is drawn to its root. */
  parentPartition: string | null;
  /** `pg_constraint`'s codes: see `foreignKeyRules`. */
  matchType: string;
  onUpdate: string;
  onDelete: string;
  /** A row of the child table must have a parent. */
  childRequiresParent: boolean;
  /** The unique index holding a parent to at most one child, if there is one. */
  uniqueVia: string | null;
  /** False for `NOT VALID`. */
  validated: boolean;
  /** False for `NOT ENFORCED`. */
  enforced: boolean;
}

/** A view or function (by OID) reading from another object. */
export interface DiagramDependency {
  dependentOid: number;
  sourceOid: number;
}

export interface DiagramStructure {
  tables: DiagramTable[];
  foreignKeys: DiagramForeignKey[];
  dependencies?: DiagramDependency[];
}

/** Where a view column's value comes from. */
export interface ColumnOrigin {
  schema: string;
  relation: string;
  column: string | null;
}

export interface ViewColumnSource {
  column: string;
  source: ColumnOrigin | null;
}

/** What the list shows about a saved diagram. */
export interface DiagramInfo {
  id: string;
  name: string;
  database: string;
  objects: number;
  modifiedMs: number | null;
}

export interface DiagramSummary {
  count: number;
  dir: string;
}

export interface DiagramViewport {
  x: number;
  y: number;
  zoom: number;
}

export type DiagramLayoutQuality = "draft" | "normal";

/** How a diagram draws and arranges its tables. Saved with it. */
export interface DiagramOptions {
  showFieldComments: boolean;
  showNotNull: boolean;
  showObjectComments: boolean;
  showSchemaNames: boolean;
  showRelationshipNames: boolean;
  fontSize: number;
  blackAndWhite: boolean;
  /** Auto Layout's base spacing, in px. */
  objectDistance: number;
  layoutQuality: DiagramLayoutQuality;
  groupBySchema: boolean;
}

/** Stored apart from the schema, so a refresh changes the snapshot and leaves positions alone. */
export interface DiagramLayoutFile {
  /** By `tableKey`. */
  tables: Record<string, { x: number; y: number }>;
  /** ELK's bend points, by `foreignKeyKey`. */
  routes: Record<string, { x: number; y: number }[]>;
  viewport: DiagramViewport | null;
  /** Absent from diagrams saved before options existed. */
  options?: DiagramOptions;
  /** Absent from diagrams saved before labels and notes existed. */
  annotations?: DiagramAnnotation[];
  colors?: DiagramColors;
}

/** Theme colours a table or line can take, as daisyUI names them. */
export type DiagramColor = "primary" | "secondary" | "accent" | "info" | "success" | "warning" | "error";

/** Colours of objects and lines, keyed by `tableKey` and `foreignKeyKey`. */
export interface DiagramColors {
  objects: Record<string, DiagramColor>;
  lines: Record<string, DiagramColor>;
}

/** A label or note drawn on the canvas. It lives only in the diagram file, never in the database. */
export interface DiagramAnnotation {
  id: string;
  kind: "label" | "note";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: DiagramColor | null;
  z: number;
}

/** What a saved diagram's file holds beyond its name and database. */
export interface DiagramContent {
  objects: number;
  layout: DiagramLayoutFile;
  /** The structure as last accepted, which drift is compared against. */
  snapshot: DiagramStructure;
  /** `tableKey` of every table the database had then. */
  known: string[];
}

export interface SavedDiagram extends DiagramInfo, DiagramContent {}
