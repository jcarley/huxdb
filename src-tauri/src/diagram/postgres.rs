//! Catalog reads for diagrams. Nothing here writes, and everything goes by OID, because a
//! `'schema.x'::regclass` literal fails for a role without USAGE on the schema while the
//! catalogs stay readable.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sqlx::{Column, Connection, Executor, PgPool, SqlSafeStr, Statement};
use sqlx::postgres::types::Oid;

/// Waiting longer than this for a catalog lock reports an error with Retry.
const LOCK_TIMEOUT: &str = "SET LOCAL lock_timeout = '5s'";
/// `format_type` output depends on the path, so drift can only compare it under a fixed one.
const FIXED_PATH: &str = "SET LOCAL search_path = pg_catalog";

/// Partitions aren't offered: a partitioned table stands for its tree, and a partition can't
/// have a column its parent lacks. TOAST and temp schemas start with `pg_`. An extension's views
/// (`pg_stat_statements`, PostGIS's `geometry_columns`) would bury the schema's own. Its tables
/// stay, because saved diagrams can hold them and a table missing here reads as removed.
const CANDIDATES: &str = "SELECT c.oid::int8, n.nspname::text, c.relname::text, c.relkind::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND (c.relkind NOT IN ('v', 'm')
           OR NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))
    ORDER BY 2, 3";

/// A function's id is its OID negated, since `pg_proc` and `pg_class` OIDs can collide. Trigger
/// functions and anything taking or returning `internal` can't be called from SQL, and an
/// extension's functions would bury the schema's own.
const FUNCTION_CANDIDATES: &str = "SELECT -p.oid::int8, n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid), p.prokind::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p')
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype, 'internal'::regtype)
      AND NOT 'internal'::regtype = ANY (p.proargtypes::oid[]::regtype[])
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 2, 3, 4";

const TABLES: &str = "SELECT c.oid::int8, n.nspname::text, c.relname::text, obj_description(c.oid, 'pg_class'), c.relkind::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = ANY ($1::oid[])
    ORDER BY 2, 3";

const COLUMNS: &str = "SELECT a.attrelid::int8, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        col_description(a.attrelid, a.attnum)
    FROM pg_attribute a
    WHERE a.attrelid = ANY ($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum";

/// `pg_get_function_result` is null for a procedure. Arguments come from the identity form,
/// because `pg_get_function_arguments` deparses default expressions.
const FUNCTIONS: &str = "SELECT -p.oid::int8, n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid), p.prokind::text,
        obj_description(p.oid, 'pg_proc'), pg_get_function_result(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = ANY ($1::oid[])
    ORDER BY 2, 3, 4";

/// Unnamed arguments are `$n`, and `proargmodes` is null when every argument is IN.
const FUNCTION_ARGUMENTS: &str = "SELECT p.oid::int8, a.ord::int4, COALESCE(NULLIF(a.name, ''), '$' || a.ord), format_type(a.type, NULL), COALESCE(a.mode::text, 'i')
    FROM pg_proc p
    CROSS JOIN LATERAL ROWS FROM (unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])), unnest(p.proargmodes), unnest(p.proargnames)) WITH ORDINALITY AS a(type, mode, name, ord)
    WHERE p.oid = ANY ($1::oid[])
    ORDER BY 1, 2";

const PRIMARY_KEYS: &str = "SELECT i.indrelid::int8, a.attname::text
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ANY ($1::oid[]) AND i.indisprimary";

/// `conenforced` and `conperiod` arrived in PostgreSQL 18, and naming them on an older server
/// is an error, so each version gets its own text.
///
/// `conparentid = 0` drops the clones a partitioned foreign key makes, on both sides. What
/// survives from a partition (its own foreign key, or one referencing a partition directly)
/// is rolled up to the root. Columns are read by name from the row that owns them, because a
/// partition's attnums can differ from its parent's.
///
/// Whether a child needs a parent, and which unique index holds it to one child per parent,
/// are facts only about the table holding the key. A partition's own key says nothing about
/// its siblings, so neither is claimed for the root. A temporal key's unique index spans
/// periods, so one parent can have many children.
///
/// The cast keeps `indkey` 0-based. Without it the slice comes back empty, and an empty set
/// is contained in everything, so every unique index would match.
macro_rules! foreign_keys {
    ($enforced:literal, $temporal:literal) => {
        concat!(
            "SELECT con.oid::int8, con.conname::text, r.child::int8, r.parent::int8, k.child_cols, k.parent_cols,
       CASE WHEN r.child <> con.conrelid THEN (SELECT relname::text FROM pg_class WHERE oid = con.conrelid) END,
       CASE WHEN r.parent <> con.confrelid THEN (SELECT relname::text FROM pg_class WHERE oid = con.confrelid) END,
       con.confmatchtype::text, con.confupdtype::text, con.confdeltype::text,
       r.child = con.conrelid AND (k.all_not_null OR (con.confmatchtype = 'f' AND k.any_not_null)),
       CASE WHEN r.child = con.conrelid AND NOT ",
            $temporal,
            " THEN uq.index_name END,
       con.convalidated, ",
            $enforced,
            "
FROM pg_constraint con
CROSS JOIN LATERAL (
    SELECT COALESCE(pg_partition_root(con.conrelid)::oid, con.conrelid) AS child,
           COALESCE(pg_partition_root(con.confrelid)::oid, con.confrelid) AS parent
) r
CROSS JOIN LATERAL (
    SELECT array_agg(u.child ORDER BY u.ord) AS child_nums,
           array_agg(ca.attname::text ORDER BY u.ord) AS child_cols,
           array_agg(pa.attname::text ORDER BY u.ord) AS parent_cols,
           bool_and(ca.attnotnull) AS all_not_null,
           bool_or(ca.attnotnull) AS any_not_null
    FROM unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(child, parent, ord)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.child
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = u.parent
) k
LEFT JOIN LATERAL (
    SELECT ic.relname::text AS index_name
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = con.conrelid
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisexclusion
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND (i.indkey::int2[])[0:i.indnkeyatts - 1] <@ k.child_nums
    ORDER BY i.indisprimary DESC, i.indnkeyatts, ic.relname
    LIMIT 1
) uq ON true
WHERE con.contype = 'f' AND con.conparentid = 0
  AND r.child = ANY ($1::oid[]) AND r.parent = ANY ($1::oid[])
ORDER BY r.child, con.conname"
        )
    };
}

const FOREIGN_KEYS: &str = foreign_keys!("con.conenforced", "con.conperiod");
const FOREIGN_KEYS_BEFORE_18: &str = foreign_keys!("true", "false");
/// The first version with `conenforced` and `conperiod`.
const PG_18: i32 = 180000;

/// Tables one foreign key away from the given ones, in either direction, rolled up as above.
const RELATED: &str = "SELECT DISTINCT other::int8
FROM pg_constraint con
CROSS JOIN LATERAL (
    SELECT COALESCE(pg_partition_root(con.conrelid)::oid, con.conrelid) AS child,
           COALESCE(pg_partition_root(con.confrelid)::oid, con.confrelid) AS parent
) r
CROSS JOIN LATERAL (VALUES (CASE WHEN r.child = ANY ($1::oid[]) THEN r.parent END), (CASE WHEN r.parent = ANY ($1::oid[]) THEN r.child END)) AS o(other)
WHERE con.contype = 'f' AND con.conparentid = 0 AND other IS NOT NULL AND NOT other = ANY ($1::oid[])";

/// Signed edges from what depends on something to what it reads or calls: a view or
/// materialized view to its relations and functions (from its `_RETURN` rule), and a function
/// to what it names (only a `BEGIN ATOMIC` body records that). One macro for the structure and
/// related reads, so they can't disagree. A partition rolls up to its root, and `DISTINCT`
/// collapses a table's per-column rows into one edge.
macro_rules! edges {
    ($tail:literal) => {
        concat!(
            "WITH raw AS (
    SELECT r.ev_class::int8 AS dependent, d.refclassid, d.refobjid
    FROM pg_rewrite r
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
    WHERE r.rulename = '_RETURN' AND d.deptype = 'n' AND d.refobjid <> r.ev_class
  UNION ALL
    SELECT -p.oid::int8, d.refclassid, d.refobjid
    FROM pg_proc p
    JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
    WHERE p.pronamespace <> 'pg_catalog'::regnamespace AND d.deptype = 'n'
), edges AS (
    SELECT DISTINCT dependent,
           CASE WHEN refclassid = 'pg_proc'::regclass THEN -refobjid::int8
                ELSE COALESCE(pg_partition_root(refobjid)::oid, refobjid)::int8 END AS source
    FROM raw
    WHERE refclassid = 'pg_proc'::regclass
       OR (refclassid = 'pg_class'::regclass
           AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = refobjid AND c.relkind IN ('r', 'p', 'f', 'v', 'm')))
) ",
            $tail
        )
    };
}

const DEPENDENCIES: &str = edges!(
    "SELECT dependent, source FROM edges
WHERE dependent <> source AND dependent = ANY ($1::int8[]) AND source = ANY ($1::int8[]) ORDER BY 1, 2"
);

/// Objects one dependency away from the given ids, either direction. One hop per call, so a
/// cycle can't loop; the caller's ids are the visited set.
const RELATED_DEPENDENCIES: &str = edges!(
    "SELECT source FROM edges WHERE dependent = ANY ($1::int8[])
UNION SELECT dependent FROM edges WHERE source = ANY ($1::int8[])"
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagramObjectKind {
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
}

/// An object the picker can offer. A function's `oid` is negative, and `signature` tells
/// overloads apart.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramCandidate {
    pub oid: i64,
    pub schema: String,
    pub name: String,
    pub kind: DiagramObjectKind,
    pub signature: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramTable {
    pub oid: i64,
    pub schema: String,
    pub name: String,
    pub kind: DiagramObjectKind,
    pub signature: Option<String>,
    pub comment: Option<String>,
    pub columns: Vec<DiagramColumn>,
}

/// One constraint, one line: two foreign keys between a pair of tables are two of these.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramForeignKey {
    pub oid: i64,
    pub name: String,
    pub child_oid: i64,
    pub parent_oid: i64,
    pub child_columns: Vec<String>,
    pub parent_columns: Vec<String>,
    /// The partition holding this key, when the line is drawn from its root.
    pub child_partition: Option<String>,
    /// The partition this key references, when the line is drawn to its root.
    pub parent_partition: Option<String>,
    /// `pg_constraint`'s codes: `s` simple, `f` full.
    pub match_type: String,
    /// `a` no action, `r` restrict, `c` cascade, `n` set null, `d` set default.
    pub on_update: String,
    pub on_delete: String,
    /// A row of the child table must have a parent. False for a key held by a partition.
    pub child_requires_parent: bool,
    /// The unique index holding a parent to at most one child, if there is one.
    pub unique_via: Option<String>,
    /// False for `NOT VALID`: existing rows weren't checked.
    pub validated: bool,
    /// False for `NOT ENFORCED`: no row is checked. Always true before PostgreSQL 18.
    pub enforced: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramStructure {
    pub tables: Vec<DiagramTable>,
    pub foreign_keys: Vec<DiagramForeignKey>,
    pub dependencies: Vec<DiagramDependency>,
}

/// A line from a view, materialized view or function to something it reads or calls, both
/// ids signed as elsewhere.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramDependency {
    pub dependent_oid: i64,
    pub source_oid: i64,
}

/// The origin of every distinct (relation, attribute number) pair the view's columns report. Attribute 0 is a whole-row
/// reference, which names the relation only; a dropped or unknown attribute doesn't resolve.
const ORIGINS: &str = "SELECT p.rel::int8, p.att, n.nspname::text, c.relname::text, a.attname::text
    FROM unnest($1::oid[], $2::int2[]) AS p(rel, att)
    JOIN pg_class c ON c.oid = p.rel JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = p.att AND NOT a.attisdropped
    WHERE p.att = 0 OR a.attname IS NOT NULL";

/// Where one of a view's output columns comes from, when it is a plain column of a table or
/// another view. `column: None` is a whole-row reference.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOrigin {
    pub schema: String,
    pub relation: String,
    pub column: Option<String>,
}

/// `source` is None for anything computed, a union, or a column that couldn't be resolved.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewColumnSource {
    pub column: String,
    pub source: Option<ColumnOrigin>,
}

type OriginNames = HashMap<(u32, i16), (String, String, Option<String>)>;

type CandidateRow = (i64, String, String, String);
type FunctionCandidateRow = (i64, String, String, String, String);
type TableRow = (i64, String, String, Option<String>, String);
type FunctionRow = (i64, String, String, String, String, Option<String>, Option<String>);
type ArgumentRow = (i64, i32, String, String, String);
type ColumnRow = (i64, String, String, bool, Option<String>);
type PrimaryKeyRow = (i64, String);
type ForeignKeyRow = (i64, String, i64, i64, Vec<String>, Vec<String>, Option<String>, Option<String>, String, String, String, bool, Option<String>, bool, bool);

fn err(e: sqlx::Error) -> String {
    // lock_not_available, from lock_timeout.
    if e.as_database_error().is_some_and(|d| d.code().as_deref() == Some("55P03")) {
        return "Another session is holding a lock on the catalog. Retry when it has finished.".into();
    }
    e.to_string()
}

/// Read-only with a fixed path: a function's identity arguments are part of its key, and their
/// text depends on `search_path`, so it has to read the same here as in `load_structure`.
pub async fn list_candidates(pool: &PgPool) -> Result<Vec<DiagramCandidate>, String> {
    let mut tx = pool.begin_with("BEGIN READ ONLY").await.map_err(err)?;
    sqlx::query(FIXED_PATH).execute(&mut *tx).await.map_err(err)?;
    let rows: Vec<CandidateRow> = sqlx::query_as(CANDIDATES).fetch_all(&mut *tx).await.map_err(err)?;
    let functions: Vec<FunctionCandidateRow> = sqlx::query_as(FUNCTION_CANDIDATES).fetch_all(&mut *tx).await.map_err(err)?;
    tx.rollback().await.map_err(err)?;
    let relations = rows.into_iter().map(|(oid, schema, name, relkind)| DiagramCandidate { oid, schema, name, kind: relation_kind(&relkind), signature: None });
    let functions = functions.into_iter().map(|(oid, schema, name, signature, prokind)| DiagramCandidate { oid, schema, name, kind: function_kind(&prokind), signature: Some(signature) });
    Ok(relations.chain(functions).collect())
}

/// Traces a view's output columns to the table columns they come from, using the origin the
/// server reports when the definition is prepared. The definition is read qualified (fixed
/// path), and its text is prepared in a transaction that is rolled back.
pub async fn view_sources(pool: &PgPool, oid: i64) -> Result<Vec<ViewColumnSource>, String> {
    let mut conn = pool.acquire().await.map_err(err)?;
    // Prepared statements are cached by text, and the table behind the same text can change.
    // Closing the connection afterwards covers every exit, an error or a dropped future too,
    // which clearing the cache at the end wouldn't.
    conn.close_on_drop();
    let columns = {
        let mut tx = conn.begin_with("BEGIN READ ONLY").await.map_err(err)?;
        sqlx::query(LOCK_TIMEOUT).execute(&mut *tx).await.map_err(err)?;
        sqlx::query(FIXED_PATH).execute(&mut *tx).await.map_err(err)?;
        let definition: Option<String> = sqlx::query_scalar("SELECT pg_get_viewdef($1::oid)").bind(Oid(oid as u32)).fetch_one(&mut *tx).await.map_err(err)?;
        let definition = definition.ok_or("Not a view.")?;
        // The newline keeps a trailing `-- comment` from reaching anything after it.
        let text = sqlx::AssertSqlSafe(format!("{}\n", crate::designer::query_text(&definition))).into_sql_str();
        let statement = (&mut *tx).prepare(text).await.map_err(err)?;
        let columns: Vec<(String, Option<(u32, i16)>)> = statement
            .columns()
            .iter()
            .map(|c| {
                let origin = c.relation_id().filter(|r| r.0 != 0).zip(c.relation_attribute_no()).map(|(r, a)| (r.0, a));
                (c.name().to_string(), origin)
            })
            .collect();
        let mut pairs: Vec<(u32, i16)> = columns.iter().filter_map(|(_, o)| *o).collect();
        pairs.sort_unstable();
        pairs.dedup();
        let relations: Vec<Oid> = pairs.iter().map(|&(r, _)| Oid(r)).collect();
        let attributes: Vec<i16> = pairs.iter().map(|&(_, a)| a).collect();
        let found: Vec<(i64, i16, String, String, Option<String>)> = sqlx::query_as(ORIGINS).bind(&relations).bind(&attributes).fetch_all(&mut *tx).await.map_err(err)?;
        tx.rollback().await.map_err(err)?;
        let names: OriginNames = found.into_iter().map(|(r, a, schema, relation, column)| ((r as u32, a), (schema, relation, column))).collect();
        origins(columns, &names)
    };
    Ok(columns)
}

/// A pair that didn't resolve is no origin, not a failure.
fn origins(columns: Vec<(String, Option<(u32, i16)>)>, names: &OriginNames) -> Vec<ViewColumnSource> {
    columns
        .into_iter()
        .map(|(column, origin)| {
            let source = origin.and_then(|key| names.get(&key)).map(|(schema, relation, column)| ColumnOrigin { schema: schema.clone(), relation: relation.clone(), column: column.clone() });
            ViewColumnSource { column, source }
        })
        .collect()
}

fn relation_kind(relkind: &str) -> DiagramObjectKind {
    match relkind {
        "v" => DiagramObjectKind::View,
        "m" => DiagramObjectKind::MaterializedView,
        _ => DiagramObjectKind::Table,
    }
}

fn function_kind(prokind: &str) -> DiagramObjectKind {
    if prokind == "p" { DiagramObjectKind::Procedure } else { DiagramObjectKind::Function }
}

/// Relation OIDs, then function OIDs with their signs removed.
fn split_oids(ids: &[i64]) -> (Vec<Oid>, Vec<Oid>) {
    let relations = ids.iter().filter(|&&id| id >= 0).map(|&id| Oid(id as u32)).collect();
    let functions = ids.iter().filter(|&&id| id < 0).map(|&id| Oid(id.unsigned_abs() as u32)).collect();
    (relations, functions)
}

/// A function's arguments in order, then what it returns. Table-result columns (`t`) are part
/// of the result, so they aren't listed twice.
fn function_rows(arguments: Vec<(i32, String, String, String)>, result: Option<String>) -> Vec<DiagramColumn> {
    let row = |name: String, data_type: String| DiagramColumn { name, data_type, not_null: false, primary_key: false, comment: None };
    let mut rows: Vec<DiagramColumn> = arguments
        .into_iter()
        .filter(|(_, _, _, mode)| mode != "t")
        .map(|(_, name, data_type, mode)| {
            let suffix = match mode.as_str() {
                "o" => " (OUT)",
                "b" => " (INOUT)",
                "v" => " (VARIADIC)",
                _ => "",
            };
            row(name, format!("{data_type}{suffix}"))
        })
        .collect();
    if let Some(result) = result {
        rows.push(row("returns".into(), result));
    }
    rows
}

/// Separate reads in one snapshot, which were faster than one JSON document. View definitions
/// and defaults stay out of it: `pg_get_viewdef` and `pg_get_expr` block on another session's
/// lock on a table, and these queries don't.
pub async fn load_structure(pool: &PgPool, ids: &[i64]) -> Result<DiagramStructure, String> {
    let (oids, function_oids) = split_oids(ids);
    let mut tx = pool.begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await.map_err(err)?;
    sqlx::query(LOCK_TIMEOUT).execute(&mut *tx).await.map_err(err)?;
    sqlx::query(FIXED_PATH).execute(&mut *tx).await.map_err(err)?;
    let tables: Vec<TableRow> = sqlx::query_as(TABLES).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let columns: Vec<ColumnRow> = sqlx::query_as(COLUMNS).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let primary_keys: Vec<PrimaryKeyRow> = sqlx::query_as(PRIMARY_KEYS).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let version: i32 = sqlx::query_scalar("SELECT current_setting('server_version_num')::int4").fetch_one(&mut *tx).await.map_err(err)?;
    let foreign_keys_query = if version >= PG_18 { FOREIGN_KEYS } else { FOREIGN_KEYS_BEFORE_18 };
    let foreign_keys: Vec<ForeignKeyRow> = sqlx::query_as(foreign_keys_query).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let functions: Vec<FunctionRow> = sqlx::query_as(FUNCTIONS).bind(&function_oids).fetch_all(&mut *tx).await.map_err(err)?;
    let arguments: Vec<ArgumentRow> = sqlx::query_as(FUNCTION_ARGUMENTS).bind(&function_oids).fetch_all(&mut *tx).await.map_err(err)?;
    let dependencies: Vec<(i64, i64)> = sqlx::query_as(DEPENDENCIES).bind(ids).fetch_all(&mut *tx).await.map_err(err)?;
    tx.rollback().await.map_err(err)?;
    let mut structure = assemble(tables, columns, primary_keys, foreign_keys);
    structure.tables.extend(function_tables(functions, arguments));
    structure.dependencies = dependencies.into_iter().map(|(dependent_oid, source_oid)| DiagramDependency { dependent_oid, source_oid }).collect();
    Ok(structure)
}

/// For Add Related Tables, which offers these in the picker rather than adding them: a hub
/// table can have hundreds.
pub async fn related_tables(pool: &PgPool, oids: &[i64]) -> Result<Vec<i64>, String> {
    let (relations, _) = split_oids(oids);
    let mut related: Vec<i64> = sqlx::query_scalar(RELATED).bind(&relations).fetch_all(pool).await.map_err(err)?;
    related.extend(sqlx::query_scalar::<_, i64>(RELATED_DEPENDENCIES).bind(oids).fetch_all(pool).await.map_err(err)?);
    // The candidate list is the one definition of what a diagram can hold: no aggregates,
    // extension functions or system relations.
    let offered: std::collections::HashSet<i64> = list_candidates(pool).await?.into_iter().map(|c| c.oid).collect();
    related.retain(|id| !oids.contains(id) && offered.contains(id));
    related.sort_unstable();
    related.dedup();
    Ok(related)
}

fn function_tables(functions: Vec<FunctionRow>, arguments: Vec<ArgumentRow>) -> Vec<DiagramTable> {
    let mut by_function: HashMap<i64, Vec<(i32, String, String, String)>> = HashMap::new();
    for (oid, ord, name, data_type, mode) in arguments {
        by_function.entry(-oid).or_default().push((ord, name, data_type, mode));
    }
    functions
        .into_iter()
        .map(|(oid, schema, name, signature, prokind, comment, result)| DiagramTable {
            oid,
            schema,
            name,
            kind: function_kind(&prokind),
            signature: Some(signature),
            comment,
            columns: function_rows(by_function.remove(&oid).unwrap_or_default(), result),
        })
        .collect()
}

fn assemble(tables: Vec<TableRow>, columns: Vec<ColumnRow>, primary_keys: Vec<PrimaryKeyRow>, foreign_keys: Vec<ForeignKeyRow>) -> DiagramStructure {
    let primary_keys: HashSet<(i64, String)> = primary_keys.into_iter().collect();
    let mut by_table: HashMap<i64, Vec<DiagramColumn>> = HashMap::new();
    for (oid, name, data_type, not_null, comment) in columns {
        let primary_key = primary_keys.contains(&(oid, name.clone()));
        by_table.entry(oid).or_default().push(DiagramColumn { name, data_type, not_null, primary_key, comment });
    }
    let tables = tables
        .into_iter()
        .map(|(oid, schema, name, comment, relkind)| DiagramTable { oid, schema, name, kind: relation_kind(&relkind), signature: None, comment, columns: by_table.remove(&oid).unwrap_or_default() })
        .collect();
    let foreign_keys = foreign_keys
        .into_iter()
        .map(
            |(oid, name, child_oid, parent_oid, child_columns, parent_columns, child_partition, parent_partition, match_type, on_update, on_delete, child_requires_parent, unique_via, validated, enforced)| DiagramForeignKey {
                oid,
                name,
                child_oid,
                parent_oid,
                child_columns,
                parent_columns,
                child_partition,
                parent_partition,
                match_type,
                on_update,
                on_delete,
                child_requires_parent,
                unique_via,
                validated,
                enforced,
            },
        )
        .collect();
    DiagramStructure { tables, foreign_keys, dependencies: Vec::new() }
}

#[cfg(test)]
mod tests {
    use sqlx::AssertSqlSafe;

    use super::*;
    use crate::connections::model::{ConnectionConfig, sample};
    use crate::explorer::sessions::SessionManager;

    #[test]
    fn marks_primary_keys_and_keeps_column_order() {
        let structure = assemble(
            vec![(1, "public".into(), "orders".into(), Some("Orders".into()), "r".into()), (2, "public".into(), "empty".into(), None, "r".into())],
            vec![(1, "id".into(), "bigint".into(), true, None), (1, "note".into(), "text".into(), false, Some("Free text".into())), (9, "gone".into(), "text".into(), false, None)],
            vec![(1, "id".into())],
            vec![(5, "fk".into(), 1, 1, vec!["a".into()], vec!["id".into()], None, None, "s".into(), "a".into(), "c".into(), true, Some("uq".into()), true, true)],
        );
        let orders = &structure.tables[0];
        assert_eq!(orders.columns.iter().map(|c| (c.name.as_str(), c.primary_key)).collect::<Vec<_>>(), [("id", true), ("note", false)]);
        assert!(orders.columns[0].not_null && !orders.columns[1].not_null);
        assert!(structure.tables[1].columns.is_empty());
        assert_eq!(structure.foreign_keys[0].child_columns, ["a"]);
        assert_eq!(structure.foreign_keys[0].on_delete, "c");
        assert_eq!(structure.foreign_keys[0].unique_via.as_deref(), Some("uq"));
        assert!(structure.foreign_keys[0].child_requires_parent);
        assert_eq!(orders.comment.as_deref(), Some("Orders"));
        assert_eq!(orders.columns[1].comment.as_deref(), Some("Free text"));
    }

    #[test]
    fn splits_relations_from_functions_by_sign() {
        let (relations, functions) = split_oids(&[5, -7, 9]);
        assert_eq!(relations, [Oid(5), Oid(9)]);
        assert_eq!(functions, [Oid(7)]);
    }

    #[test]
    fn a_functions_rows_are_its_arguments_then_what_it_returns() {
        let rows = function_rows(
            vec![(1, "a".into(), "integer".into(), "i".into()), (2, "$2".into(), "text".into(), "o".into()), (3, "t".into(), "int4".into(), "t".into())],
            Some("TABLE(t integer)".into()),
        );
        assert_eq!(
            rows.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect::<Vec<_>>(),
            [("a", "integer"), ("$2", "text (OUT)"), ("returns", "TABLE(t integer)")]
        );
    }

    /// A schema name of its own per run, so the test never has to drop anything.
    fn fresh_schema(prefix: &str) -> String {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
        format!("{prefix}_{}_{nanos}", std::process::id())
    }

    fn live_pool() -> sqlx::PgPool {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = ConnectionConfig { id: "live".into(), port, ..sample("live") };
        SessionManager::default().pool(&config, "postgres")
    }

    #[tokio::test]
    #[ignore]
    async fn reads_foreign_keys_across_schemas_and_partitions_on_live_server() {
        let pool = live_pool();
        let a = fresh_schema("huxdb_diagram_a");
        let b = fresh_schema("huxdb_diagram_b");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {a};
             CREATE SCHEMA {b};
             CREATE TABLE {a}.parent (x int, y int, PRIMARY KEY (y, x), gone int);
             ALTER TABLE {a}.parent DROP COLUMN gone;
             CREATE TABLE {b}.pair (a_x int, a_y int, other int, FOREIGN KEY (a_y, a_x) REFERENCES {a}.parent (y, x));
             CREATE TABLE {b}.self (id int PRIMARY KEY, up int REFERENCES {b}.self (id) ON DELETE CASCADE ON UPDATE SET NULL);
             COMMENT ON TABLE {b}.self IS 'Self table';
             COMMENT ON COLUMN {b}.self.up IS 'Its parent';
             CREATE TABLE {b}.twice (one int REFERENCES {b}.self (id), two int REFERENCES {b}.self (id));
             CREATE TABLE {a}.events (id int, at date, owner int REFERENCES {b}.self (id), PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
             CREATE TABLE {a}.events_2026 PARTITION OF {a}.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == a || c.schema == b).collect();
        assert_eq!(ours.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["events", "parent", "pair", "self", "twice"]);

        let oids: Vec<i64> = ours.iter().map(|c| c.oid).collect();
        let structure = load_structure(&pool, &oids).await.unwrap();
        let oid = |name: &str| ours.iter().find(|c| c.name == name).unwrap().oid;

        let parent = structure.tables.iter().find(|t| t.name == "parent").unwrap();
        assert_eq!(parent.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["x", "y"]);
        assert!(parent.columns.iter().all(|c| c.primary_key && c.not_null));
        assert!(!structure.tables.iter().find(|t| t.name == "pair").unwrap().columns[2].not_null);

        let pair = structure.foreign_keys.iter().find(|f| f.child_oid == oid("pair")).unwrap();
        assert_eq!(pair.child_columns, ["a_y", "a_x"]);
        assert_eq!(pair.parent_columns, ["y", "x"]);
        assert_eq!(pair.parent_oid, oid("parent"));

        assert_eq!(structure.foreign_keys.iter().filter(|f| f.child_oid == oid("self")).count(), 1);
        let own = structure.foreign_keys.iter().find(|f| f.child_oid == oid("self")).unwrap();
        assert_eq!((own.match_type.as_str(), own.on_update.as_str(), own.on_delete.as_str()), ("s", "n", "c"));
        let self_table = structure.tables.iter().find(|t| t.name == "self").unwrap();
        assert_eq!(self_table.comment.as_deref(), Some("Self table"));
        assert_eq!(self_table.columns[1].comment.as_deref(), Some("Its parent"));
        assert_eq!(structure.foreign_keys.iter().filter(|f| f.child_oid == oid("twice")).count(), 2);
        let events: Vec<_> = structure.foreign_keys.iter().filter(|f| f.child_oid == oid("events")).collect();
        assert_eq!(events.len(), 1, "the partition's clone must not draw a second line");
        assert_eq!(events[0].child_partition, None);

        let mut related = related_tables(&pool, &[oid("self")]).await.unwrap();
        related.sort();
        let mut expected = vec![oid("twice"), oid("events")];
        expected.sort();
        assert_eq!(related, expected, "both directions, no partitions, and not the table itself");
        assert_eq!(related_tables(&pool, &[oid("twice")]).await.unwrap(), [oid("self")]);
    }

    #[tokio::test]
    #[ignore]
    async fn lists_views_and_functions_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_v");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.t (id int PRIMARY KEY, label text);
             CREATE VIEW {s}.v AS SELECT id, label FROM {s}.t;
             CREATE MATERIALIZED VIEW {s}.m AS SELECT id FROM {s}.t;
             CREATE FUNCTION {s}.add(a integer, b integer) RETURNS integer LANGUAGE sql AS 'SELECT a + b';
             CREATE FUNCTION {s}.add(a text) RETURNS text LANGUAGE sql AS 'SELECT a';
             COMMENT ON FUNCTION {s}.add(a text) IS 'Echoes';
             CREATE FUNCTION {s}.nothing() RETURNS void LANGUAGE sql AS '';
             CREATE PROCEDURE {s}.tidy(INOUT n integer) LANGUAGE plpgsql AS 'BEGIN END';
             CREATE FUNCTION {s}.on_change() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
             CREATE EXTENSION IF NOT EXISTS pg_trgm;
             ALTER EXTENSION pg_trgm SET SCHEMA {s};
             CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
             ALTER EXTENSION pg_stat_statements SET SCHEMA {s};",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == s).collect();
        let kinds = |name: &str| ours.iter().filter(|c| c.name == name).map(|c| c.kind).collect::<Vec<_>>();
        assert_eq!(kinds("t"), [DiagramObjectKind::Table]);
        assert_eq!(kinds("v"), [DiagramObjectKind::View]);
        assert_eq!(kinds("m"), [DiagramObjectKind::MaterializedView]);
        assert_eq!(kinds("add"), [DiagramObjectKind::Function; 2]);
        assert_eq!(kinds("tidy"), [DiagramObjectKind::Procedure]);
        assert!(kinds("on_change").is_empty(), "trigger functions aren't offered");
        assert!(kinds("similarity").is_empty(), "an extension's functions aren't offered");
        assert!(kinds("pg_stat_statements").is_empty(), "an extension's views aren't offered");
        assert!(ours.iter().all(|c| (c.kind == DiagramObjectKind::Function || c.kind == DiagramObjectKind::Procedure) == (c.oid < 0)));

        let structure = load_structure(&pool, &ours.iter().map(|c| c.oid).collect::<Vec<_>>()).await.unwrap();
        let view = structure.tables.iter().find(|t| t.name == "v").unwrap();
        assert_eq!(view.kind, DiagramObjectKind::View);
        assert_eq!(view.signature, None);
        assert_eq!(view.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect::<Vec<_>>(), [("id", "integer"), ("label", "text")]);
        assert_eq!(structure.tables.iter().find(|t| t.name == "m").unwrap().kind, DiagramObjectKind::MaterializedView);

        let adds: Vec<_> = structure.tables.iter().filter(|t| t.name == "add").collect();
        assert_eq!(adds.len(), 2);
        assert!(adds.iter().all(|t| t.oid < 0 && t.kind == DiagramObjectKind::Function));
        let two = adds.iter().find(|t| t.signature.as_deref() == Some("a integer, b integer")).unwrap();
        assert_eq!(two.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect::<Vec<_>>(), [("a", "integer"), ("b", "integer"), ("returns", "integer")]);
        let one = adds.iter().find(|t| t.signature.as_deref() == Some("a text")).unwrap();
        assert_eq!(one.comment.as_deref(), Some("Echoes"));

        let nothing = structure.tables.iter().find(|t| t.name == "nothing").unwrap();
        assert_eq!(nothing.signature.as_deref(), Some(""));
        let tidy = structure.tables.iter().find(|t| t.name == "tidy").unwrap();
        assert_eq!(tidy.kind, DiagramObjectKind::Procedure);
        assert_eq!(tidy.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect::<Vec<_>>(), [("n", "integer (INOUT)")]);
    }

    #[tokio::test]
    #[ignore]
    async fn rolls_a_partitions_own_foreign_key_up_to_its_root_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_p");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.owners (id int PRIMARY KEY);
             CREATE TABLE {s}.logs (id int, at date, owner int) PARTITION BY RANGE (at);
             CREATE TABLE {s}.logs_a PARTITION OF {s}.logs FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
             ALTER TABLE {s}.logs_a ADD FOREIGN KEY (owner) REFERENCES {s}.owners (id);",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == s).collect();
        assert_eq!(ours.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["logs", "owners"]);
        let structure = load_structure(&pool, &ours.iter().map(|c| c.oid).collect::<Vec<_>>()).await.unwrap();
        assert_eq!(structure.foreign_keys.len(), 1);
        let fk = &structure.foreign_keys[0];
        assert_eq!(fk.child_partition.as_deref(), Some("logs_a"));
        assert_eq!(fk.child_oid, ours[0].oid);
        assert_eq!(fk.child_columns, ["owner"]);
    }

    /// The child end, from each kind of unique index. These are the research's 13 cases, plus
    /// the NOT NULL rules for the parent end.
    #[tokio::test]
    #[ignore]
    async fn derives_cardinality_from_the_child_table_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_c");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             SET search_path = {s};
             CREATE TABLE parent (a int, b int, UNIQUE (a), UNIQUE (a, b));
             CREATE TABLE exact_pk (p int PRIMARY KEY REFERENCES parent (a));
             CREATE TABLE exact_unique (p int REFERENCES parent (a), UNIQUE (p));
             CREATE TABLE index_only (p int REFERENCES parent (a));
             CREATE UNIQUE INDEX index_only_p ON index_only (p);
             CREATE TABLE deferred (p int REFERENCES parent (a), UNIQUE (p) DEFERRABLE INITIALLY DEFERRED);
             CREATE TABLE wider (p int REFERENCES parent (a), q int, UNIQUE (p, q));
             CREATE TABLE contained (x int, y int, FOREIGN KEY (x, y) REFERENCES parent (a, b), UNIQUE (x));
             CREATE TABLE key_with_include (p int, q int, FOREIGN KEY (p, q) REFERENCES parent (a, b), UNIQUE (p) INCLUDE (q));
             CREATE TABLE only_included (p int REFERENCES parent (a), q int, UNIQUE (q) INCLUDE (p));
             CREATE TABLE partial (p int REFERENCES parent (a), f bool);
             CREATE UNIQUE INDEX partial_p ON partial (p) WHERE f;
             CREATE TABLE expression (p int REFERENCES parent (a));
             CREATE UNIQUE INDEX expression_p ON expression ((p + 0));
             CREATE TABLE mixed_expression (p int REFERENCES parent (a), q int);
             CREATE UNIQUE INDEX mixed_expression_p ON mixed_expression (p, (q + 1));
             CREATE TABLE nulls_not_distinct (p int REFERENCES parent (a), UNIQUE NULLS NOT DISTINCT (p));
             CREATE TABLE invalid (p int REFERENCES parent (a));
             CREATE UNIQUE INDEX invalid_p ON invalid (p);
             UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'invalid_p'::regclass;
             CREATE TABLE all_required (x int NOT NULL, y int NOT NULL, FOREIGN KEY (x, y) REFERENCES parent (a, b));
             CREATE TABLE simple_part (x int, y int NOT NULL, FOREIGN KEY (x, y) REFERENCES parent (a, b));
             CREATE TABLE full_part (x int, y int NOT NULL, FOREIGN KEY (x, y) REFERENCES parent (a, b) MATCH FULL);
             CREATE TABLE all_nullable (x int, y int, FOREIGN KEY (x, y) REFERENCES parent (a, b) MATCH FULL);
             CREATE TABLE unchecked (p int);
             ALTER TABLE unchecked ADD FOREIGN KEY (p) REFERENCES parent (a) NOT VALID;
             RESET search_path;",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == s).collect();
        let structure = load_structure(&pool, &ours.iter().map(|c| c.oid).collect::<Vec<_>>()).await.unwrap();
        let fk = |name: &str| {
            let oid = ours.iter().find(|c| c.name == name).unwrap().oid;
            structure.foreign_keys.iter().find(|f| f.child_oid == oid).unwrap()
        };

        for (table, index) in [
            ("exact_pk", Some("exact_pk_pkey")),
            ("exact_unique", Some("exact_unique_p_key")),
            ("index_only", Some("index_only_p")),
            ("deferred", Some("deferred_p_key")),
            ("wider", None),
            ("contained", Some("contained_x_key")),
            ("key_with_include", Some("key_with_include_p_q_key")),
            ("only_included", None),
            ("partial", None),
            ("expression", None),
            ("mixed_expression", None),
            ("nulls_not_distinct", Some("nulls_not_distinct_p_key")),
            ("invalid", None),
        ] {
            assert_eq!(fk(table).unique_via.as_deref(), index, "{table}");
        }

        for (table, required) in [("exact_pk", true), ("wider", false), ("all_required", true), ("simple_part", false), ("full_part", true), ("all_nullable", false)] {
            assert_eq!(fk(table).child_requires_parent, required, "{table}");
        }

        assert!(fk("exact_pk").validated && fk("exact_pk").enforced);
        assert!(!fk("unchecked").validated);
    }

    /// A partition's unique index and NOT NULL say nothing about its siblings.
    #[tokio::test]
    #[ignore]
    async fn claims_nothing_about_a_root_from_its_partition_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_u");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.owners (id int PRIMARY KEY);
             CREATE TABLE {s}.logs (at date, owner int) PARTITION BY RANGE (at);
             CREATE TABLE {s}.logs_a PARTITION OF {s}.logs FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
             ALTER TABLE {s}.logs_a ALTER COLUMN owner SET NOT NULL;
             ALTER TABLE {s}.logs_a ADD UNIQUE (owner);
             ALTER TABLE {s}.logs_a ADD FOREIGN KEY (owner) REFERENCES {s}.owners (id);
             CREATE TABLE {s}.years (id int NOT NULL, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
             CREATE TABLE {s}.years_a PARTITION OF {s}.years FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
             CREATE TABLE {s}.pin (id int PRIMARY KEY, at date NOT NULL, FOREIGN KEY (id, at) REFERENCES {s}.years_a (id, at));",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == s).collect();
        let oid = |name: &str| ours.iter().find(|c| c.name == name).unwrap().oid;
        let structure = load_structure(&pool, &ours.iter().map(|c| c.oid).collect::<Vec<_>>()).await.unwrap();

        let held = structure.foreign_keys.iter().find(|f| f.child_oid == oid("logs")).unwrap();
        assert_eq!(held.child_partition.as_deref(), Some("logs_a"));
        assert_eq!(held.unique_via, None, "a partition's index proves nothing across the root");
        assert!(!held.child_requires_parent, "other partitions need no parent");

        let referencing = structure.foreign_keys.iter().find(|f| f.child_oid == oid("pin")).unwrap();
        assert_eq!(referencing.parent_oid, oid("years"));
        assert_eq!(referencing.parent_partition.as_deref(), Some("years_a"));
        assert_eq!(referencing.child_partition, None);
        assert_eq!(referencing.unique_via.as_deref(), Some("pin_pkey"), "the child is a plain table, so its index holds");
        assert!(referencing.child_requires_parent);
    }

    /// Skips itself below PostgreSQL 18, which has neither kind of key.
    #[tokio::test]
    #[ignore]
    async fn reads_not_enforced_and_temporal_keys_on_live_server() {
        let pool = live_pool();
        let version: i32 = sqlx::query_scalar("SELECT current_setting('server_version_num')::int4").fetch_one(&pool).await.unwrap();
        if version < PG_18 {
            return;
        }
        let s = fresh_schema("huxdb_diagram_t");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             CREATE EXTENSION IF NOT EXISTS btree_gist;
             CREATE TABLE {s}.parent (id int PRIMARY KEY);
             CREATE TABLE {s}.loose (id int PRIMARY KEY, p int NOT NULL, FOREIGN KEY (p) REFERENCES {s}.parent (id) NOT ENFORCED);
             CREATE TABLE {s}.spans (id int, during daterange, PRIMARY KEY (id, during WITHOUT OVERLAPS));
             CREATE TABLE {s}.visits (id int, during daterange, UNIQUE (id, during), FOREIGN KEY (id, PERIOD during) REFERENCES {s}.spans (id, PERIOD during));",
        )))
        .execute(&pool)
        .await
        .unwrap();

        let candidates = list_candidates(&pool).await.unwrap();
        let ours: Vec<_> = candidates.iter().filter(|c| c.schema == s).collect();
        let oid = |name: &str| ours.iter().find(|c| c.name == name).unwrap().oid;
        let structure = load_structure(&pool, &ours.iter().map(|c| c.oid).collect::<Vec<_>>()).await.unwrap();

        let loose = structure.foreign_keys.iter().find(|f| f.child_oid == oid("loose")).unwrap();
        assert!(!loose.enforced);
        assert!(loose.child_requires_parent, "the marks still describe the declared rule");

        let visits = structure.foreign_keys.iter().find(|f| f.child_oid == oid("visits")).unwrap();
        assert!(visits.enforced);
        assert_eq!(visits.unique_via, None, "a temporal key's index spans periods");
    }

    #[tokio::test]
    #[ignore]
    async fn reads_through_a_role_without_schema_usage_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_r");
        sqlx::raw_sql(AssertSqlSafe(format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.a (id int PRIMARY KEY);
             CREATE TABLE {s}.b (a_id int REFERENCES {s}.a (id));
             CREATE ROLE {s}_role LOGIN PASSWORD 'secret';",
        )))
        .execute(&pool)
        .await
        .unwrap();
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let limited = ConnectionConfig { id: "limited".into(), port, username: format!("{s}_role"), ..sample("limited") };
        let limited = SessionManager::default().pool(&limited, "postgres");

        let candidates = list_candidates(&limited).await.unwrap();
        let oids: Vec<i64> = candidates.iter().filter(|c| c.schema == s).map(|c| c.oid).collect();
        assert_eq!(oids.len(), 2);
        let structure = load_structure(&limited, &oids).await.unwrap();
        assert_eq!(structure.foreign_keys.len(), 1);
        assert!(structure.tables.iter().all(|t| !t.columns.is_empty()));
    }

    async fn run(pool: &sqlx::PgPool, sql: String) {
        sqlx::raw_sql(AssertSqlSafe(sql)).execute(pool).await.unwrap();
    }

    async fn rel(pool: &sqlx::PgPool, name: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(format!("SELECT '{name}'::regclass::oid::int8"))).fetch_one(pool).await.unwrap()
    }

    async fn func(pool: &sqlx::PgPool, signature: &str) -> i64 {
        -sqlx::query_scalar::<_, i64>(AssertSqlSafe(format!("SELECT '{signature}'::regprocedure::oid::int8"))).fetch_one(pool).await.unwrap()
    }

    async fn lines(pool: &sqlx::PgPool, ids: &[i64]) -> Vec<(i64, i64)> {
        load_structure(pool, ids).await.unwrap().dependencies.iter().map(|d| (d.dependent_oid, d.source_oid)).collect()
    }

    #[tokio::test]
    #[ignore]
    async fn keeps_whole_row_and_count_views_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_w");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.t (id int PRIMARY KEY);
             CREATE VIEW {s}.c AS SELECT count(*) FROM {s}.t;
             CREATE VIEW {s}.w AS SELECT t FROM {s}.t;")).await;
        let (t, c, w) = (rel(&pool, &format!("{s}.t")).await, rel(&pool, &format!("{s}.c")).await, rel(&pool, &format!("{s}.w")).await);
        assert_eq!(lines(&pool, &[t, c, w]).await, [(c.min(w), t), (c.max(w), t)]);
    }

    #[tokio::test]
    #[ignore]
    async fn reads_views_across_schemas_on_live_server() {
        let pool = live_pool();
        let (a, b) = (fresh_schema("huxdb_diagram_a"), fresh_schema("huxdb_diagram_b"));
        run(&pool, format!(
            "CREATE SCHEMA {a}; CREATE SCHEMA {b};
             CREATE TABLE {b}.t (id int PRIMARY KEY);
             CREATE VIEW {a}.v AS SELECT id FROM {b}.t;
             CREATE VIEW {a}.vv AS SELECT id FROM {a}.v;
             CREATE MATERIALIZED VIEW {a}.m AS SELECT id FROM {b}.t;")).await;
        let (t, v, vv, m) = (rel(&pool, &format!("{b}.t")).await, rel(&pool, &format!("{a}.v")).await, rel(&pool, &format!("{a}.vv")).await, rel(&pool, &format!("{a}.m")).await);
        let mut got = lines(&pool, &[t, v, vv, m]).await;
        got.sort();
        let mut want = vec![(v, t), (vv, v), (m, t)];
        want.sort();
        assert_eq!(got, want);
    }

    #[tokio::test]
    #[ignore]
    async fn draws_no_line_to_what_is_not_on_the_diagram_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_n");
        run(&pool, format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (id int); CREATE VIEW {s}.v AS SELECT id FROM {s}.t;")).await;
        let v = rel(&pool, &format!("{s}.v")).await;
        assert!(lines(&pool, &[v]).await.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn draws_a_view_of_a_partition_to_its_root_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_p");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.p (id int, d date) PARTITION BY RANGE (d);
             CREATE TABLE {s}.p_2024 PARTITION OF {s}.p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
             CREATE VIEW {s}.v AS SELECT id FROM {s}.p_2024;")).await;
        let (p, v) = (rel(&pool, &format!("{s}.p")).await, rel(&pool, &format!("{s}.v")).await);
        assert_eq!(lines(&pool, &[p, v]).await, [(v, p)]);
        let p24 = rel(&pool, &format!("{s}.p_2024")).await;
        assert_eq!(related_tables(&pool, &[p]).await.unwrap(), [v]);
        assert_eq!(related_tables(&pool, &[v]).await.unwrap(), [p]);
        assert!(!related_tables(&pool, &[v]).await.unwrap().contains(&p24));
    }

    #[tokio::test]
    #[ignore]
    async fn links_a_view_to_a_function_it_calls_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_f");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE FUNCTION {s}.f(a int) RETURNS int LANGUAGE sql AS 'SELECT a';
             CREATE VIEW {s}.v AS SELECT {s}.f(1) AS x;")).await;
        let (f, v) = (func(&pool, &format!("{s}.f(int)")).await, rel(&pool, &format!("{s}.v")).await);
        assert!(f < 0);
        assert_eq!(lines(&pool, &[f, v]).await, [(v, f)]);
    }

    #[tokio::test]
    #[ignore]
    async fn links_only_an_atomic_function_to_its_table_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_t");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.t (id int);
             CREATE FUNCTION {s}.atomic() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT count(*)::int FROM {s}.t; END;
             CREATE FUNCTION {s}.plain() RETURNS int LANGUAGE plpgsql AS 'BEGIN RETURN (SELECT count(*) FROM {s}.t); END';")).await;
        let (t, a, p) = (rel(&pool, &format!("{s}.t")).await, func(&pool, &format!("{s}.atomic()")).await, func(&pool, &format!("{s}.plain()")).await);
        assert_eq!(lines(&pool, &[t, a, p]).await, [(a, t)]);
    }

    #[tokio::test]
    #[ignore]
    async fn related_survives_a_view_cycle_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_c");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE VIEW {s}.c1 AS SELECT 1 AS id;
             CREATE VIEW {s}.c2 AS SELECT id FROM {s}.c1;
             CREATE OR REPLACE VIEW {s}.c1 AS SELECT id FROM {s}.c2 UNION ALL SELECT 1;")).await;
        // c1 now reads c2, which reads c1.
        let (c1, c2) = (rel(&pool, &format!("{s}.c1")).await, rel(&pool, &format!("{s}.c2")).await);
        assert_eq!(related_tables(&pool, &[c1]).await.unwrap(), [c2]);
        let both = related_tables(&pool, &[c1, c2]).await.unwrap();
        assert!(both.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn related_finds_views_of_a_table_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_x");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.t (id int PRIMARY KEY);
             CREATE FUNCTION {s}.f() RETURNS int LANGUAGE sql AS 'SELECT 1';
             CREATE VIEW {s}.v AS SELECT id, {s}.f() AS x FROM {s}.t;")).await;
        let (t, v, f) = (rel(&pool, &format!("{s}.t")).await, rel(&pool, &format!("{s}.v")).await, func(&pool, &format!("{s}.f()")).await);
        assert_eq!(related_tables(&pool, &[t]).await.unwrap(), [v]);
        let mut of_view = related_tables(&pool, &[v]).await.unwrap();
        of_view.sort();
        let mut want = vec![t, f];
        want.sort();
        assert_eq!(of_view, want);
    }

    #[tokio::test]
    #[ignore]
    async fn related_offers_only_candidates_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_o");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.t (id int PRIMARY KEY);
             CREATE FUNCTION {s}.sfunc(int, int) RETURNS int LANGUAGE sql AS 'SELECT $1 + $2';
             CREATE AGGREGATE {s}.total(int) (sfunc = {s}.sfunc, stype = int);
             CREATE VIEW {s}.v AS SELECT id, (SELECT {s}.total(id) FROM {s}.t) AS x, (SELECT count(*) FROM pg_catalog.pg_class) AS n FROM {s}.t;")).await;
        let (t, v) = (rel(&pool, &format!("{s}.t")).await, rel(&pool, &format!("{s}.v")).await);
        assert_eq!(related_tables(&pool, &[v]).await.unwrap(), [t]);
    }

    fn origin(sources: &[ViewColumnSource], column: &str) -> Option<(String, Option<String>)> {
        sources.iter().find(|s| s.column == column).unwrap().source.as_ref().map(|o| (o.relation.clone(), o.column.clone()))
    }

    fn some(relation: &str, column: &str) -> Option<(String, Option<String>)> {
        Some((relation.into(), Some(column.into())))
    }

    #[test]
    fn a_column_whose_lookup_is_missing_has_no_origin() {
        let names = HashMap::from([
            ((10u32, 1i16), ("s".to_string(), "t".to_string(), Some("id".to_string()))),
            ((10, 0), ("s".to_string(), "t".to_string(), None)),
        ]);
        let columns = vec![("a".to_string(), Some((10u32, 1i16))), ("b".to_string(), Some((99, 1))), ("c".to_string(), None), ("d".to_string(), Some((10, 0)))];
        let out = origins(columns, &names);
        assert_eq!(out[0].source.as_ref().unwrap().column.as_deref(), Some("id"));
        assert!(out[1].source.is_none() && out[2].source.is_none());
        let whole = out[3].source.as_ref().unwrap();
        assert_eq!((whole.relation.as_str(), whole.column.as_deref()), ("t", None));
    }

    #[tokio::test]
    #[ignore]
    async fn traces_view_columns_through_sqlx_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_t");
        run(&pool, format!(
            "CREATE SCHEMA {s};
             CREATE TABLE {s}.emp (id int PRIMARY KEY, boss int, name text);
             CREATE TABLE {s}.dept (id int PRIMARY KEY, title text);
             CREATE VIEW {s}.plain AS SELECT e.id, e.boss AS manager FROM {s}.emp e;
             CREATE VIEW {s}.joined AS SELECT e.name, d.title FROM {s}.emp e JOIN {s}.dept d ON d.id = e.boss;
             CREATE VIEW {s}.cte AS WITH x AS (SELECT name AS n FROM {s}.emp) SELECT n FROM x;
             CREATE VIEW {s}.sub AS SELECT q.t FROM (SELECT title AS t FROM {s}.dept) q;
             CREATE VIEW {s}.over AS SELECT manager AS m FROM {s}.plain;
             CREATE VIEW {s}.computed AS SELECT id::text AS a, coalesce(boss, 0) AS b, count(*) AS c, 1 AS d FROM {s}.emp GROUP BY id, boss;
             CREATE VIEW {s}.u AS SELECT id AS x, name AS y FROM {s}.emp UNION ALL SELECT id, title FROM {s}.dept;
             CREATE VIEW {s}.whole AS SELECT e AS r FROM {s}.emp e;"
        )).await;
        let trace = |name: &'static str| {
            let pool = pool.clone();
            let s = s.clone();
            async move { view_sources(&pool, rel(&pool, &format!("{s}.{name}")).await).await.unwrap() }
        };
        let plain = trace("plain").await;
        assert_eq!(origin(&plain, "id"), some("emp", "id"));
        assert_eq!(origin(&plain, "manager"), some("emp", "boss"));
        assert_eq!(plain[0].source.as_ref().unwrap().schema, s);
        let joined = trace("joined").await;
        assert_eq!(origin(&joined, "name"), some("emp", "name"));
        assert_eq!(origin(&joined, "title"), some("dept", "title"));
        assert_eq!(origin(&trace("cte").await, "n"), some("emp", "name"));
        assert_eq!(origin(&trace("sub").await, "t"), some("dept", "title"));
        assert_eq!(origin(&trace("over").await, "m"), some("plain", "manager"));
        let computed = trace("computed").await;
        for c in ["a", "b", "c", "d"] {
            assert_eq!(origin(&computed, c), None, "{c}");
        }
        let u = trace("u").await;
        assert_eq!(origin(&u, "x"), None);
        assert_eq!(origin(&u, "y"), None);
        // The server reports no relation for a whole-row reference (0 and 0), unlike the research.
        assert_eq!(origin(&trace("whole").await, "r"), None);
    }

    #[tokio::test]
    #[ignore]
    async fn trace_times_out_on_a_lock_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_tl");
        run(&pool, format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (id int); CREATE VIEW {s}.v AS SELECT id FROM {s}.t;")).await;
        let view = rel(&pool, &format!("{s}.v")).await;
        let mut holder = pool.begin().await.unwrap();
        sqlx::raw_sql(AssertSqlSafe(format!("LOCK TABLE {s}.t IN ACCESS EXCLUSIVE MODE"))).execute(&mut *holder).await.unwrap();
        let e = view_sources(&pool, view).await.unwrap_err();
        holder.rollback().await.unwrap();
        assert!(e.starts_with("Another session is holding a lock"), "{e}");
    }

    #[tokio::test]
    #[ignore]
    async fn trace_is_not_fooled_by_the_statement_cache_on_live_server() {
        // One connection, so the second trace could hit the first's cached statement: the view
        // text is identical, only the table's column order differs, so a stale
        // attribute number would resolve to the other column. With the connection's
        // close_on_drop removed this still passed, so it can't fail today (sqlx's prepare
        // evidently re-describes); it guards against a future caching change.
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = ConnectionConfig { id: "one".into(), port, ..sample("one") };
        let pool = SessionManager::default().pool(&config, "postgres");
        let s = fresh_schema("huxdb_diagram_tc");
        run(&pool, format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (a int, b int); CREATE VIEW {s}.v AS SELECT b FROM {s}.t;")).await;
        let first = view_sources(&pool, rel(&pool, &format!("{s}.v")).await).await.unwrap();
        assert_eq!(origin(&first, "b"), some("t", "b"));
        run(&pool, format!("DROP VIEW {s}.v; DROP TABLE {s}.t; CREATE TABLE {s}.t (b int, a int); CREATE VIEW {s}.v AS SELECT b FROM {s}.t;")).await;
        let second = view_sources(&pool, rel(&pool, &format!("{s}.v")).await).await.unwrap();
        assert_eq!(origin(&second, "b"), some("t", "b"));
    }

    #[tokio::test]
    #[ignore]
    async fn trace_reports_a_role_without_schema_usage_on_live_server() {
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_tr");
        run(&pool, format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (id int); CREATE VIEW {s}.v AS SELECT id FROM {s}.t; CREATE ROLE {s}_role LOGIN PASSWORD 'secret';")).await;
        let view = rel(&pool, &format!("{s}.v")).await;
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let limited = ConnectionConfig { id: "limited".into(), port, username: format!("{s}_role"), ..sample("limited") };
        let limited = SessionManager::default().pool(&limited, "postgres");
        // Preparing the definition needs USAGE on the schema, so the trace is an error.
        assert!(view_sources(&limited, view).await.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn trace_reports_a_non_view_as_an_error_on_live_server() {
        // PostgreSQL records a view's dependencies, so ordinary DDL can't leave a view that
        // fails to Parse; a table's id is the nearest failure that DDL can make.
        let pool = live_pool();
        let s = fresh_schema("huxdb_diagram_tb");
        run(&pool, format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (id int);")).await;
        assert!(view_sources(&pool, rel(&pool, &format!("{s}.t")).await).await.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn candidate_signatures_match_the_structure_on_live_server() {
        let pool = live_pool();
        // `public` is on the default search_path, so an unqualified enum name would show there.
        let n = fresh_schema("huxdb_sig");
        run(&pool, format!("CREATE TYPE public.{n}_mood AS ENUM ('a'); CREATE FUNCTION public.{n}_f(m public.{n}_mood) RETURNS int LANGUAGE sql AS 'SELECT 1';")).await;
        let candidates = list_candidates(&pool).await.unwrap();
        let c = candidates.iter().find(|c| c.name == format!("{n}_f")).unwrap();
        let structure = load_structure(&pool, &[c.oid]).await.unwrap();
        assert_eq!(c.signature, structure.tables[0].signature);
        assert!(c.signature.as_deref().unwrap().contains(&format!("public.{n}_mood")), "{:?}", c.signature);
    }
}
