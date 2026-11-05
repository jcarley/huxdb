//! Catalog reads for diagrams. Nothing here writes, and everything goes by OID, because a
//! `'schema.x'::regclass` literal fails for a role without USAGE on the schema while the
//! catalogs stay readable.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sqlx::PgPool;
use sqlx::postgres::types::Oid;

/// Waiting longer than this for a catalog lock reports an error with Retry.
const LOCK_TIMEOUT: &str = "SET LOCAL lock_timeout = '5s'";
/// `format_type` output depends on the path, so drift can only compare it under a fixed one.
const FIXED_PATH: &str = "SET LOCAL search_path = pg_catalog";

/// Partitions aren't offered: a partitioned table stands for its tree, and a partition can't
/// have a column its parent lacks. TOAST and temp schemas start with `pg_`.
const CANDIDATES: &str = "SELECT c.oid::int8, n.nspname::text, c.relname::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'f') AND NOT c.relispartition
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ORDER BY 2, 3";

const TABLES: &str = "SELECT c.oid::int8, n.nspname::text, c.relname::text, obj_description(c.oid, 'pg_class')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = ANY ($1::oid[])
    ORDER BY 2, 3";

const COLUMNS: &str = "SELECT a.attrelid::int8, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        col_description(a.attrelid, a.attnum)
    FROM pg_attribute a
    WHERE a.attrelid = ANY ($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum";

const PRIMARY_KEYS: &str = "SELECT i.indrelid::int8, a.attname::text
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ANY ($1::oid[]) AND i.indisprimary";

/// `conparentid = 0` drops the clones a partitioned foreign key makes, on both sides. What
/// survives from a partition (its own foreign key, or one referencing a partition directly)
/// is rolled up to the root. Columns are read by name from the row that owns them, because a
/// partition's attnums can differ from its parent's.
const FOREIGN_KEYS: &str = "SELECT con.oid::int8, con.conname::text, r.child::int8, r.parent::int8,
       k.child_cols, k.parent_cols, r.child <> con.conrelid OR r.parent <> con.confrelid,
       con.confmatchtype::text, con.confupdtype::text, con.confdeltype::text
FROM pg_constraint con
CROSS JOIN LATERAL (
    SELECT COALESCE(pg_partition_root(con.conrelid)::oid, con.conrelid) AS child,
           COALESCE(pg_partition_root(con.confrelid)::oid, con.confrelid) AS parent
) r
CROSS JOIN LATERAL (
    SELECT array_agg(ca.attname::text ORDER BY u.ord) AS child_cols,
           array_agg(pa.attname::text ORDER BY u.ord) AS parent_cols
    FROM unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(child, parent, ord)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.child
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = u.parent
) k
WHERE con.contype = 'f' AND con.conparentid = 0
  AND r.child = ANY ($1::oid[]) AND r.parent = ANY ($1::oid[])
ORDER BY r.child, con.conname";

/// Tables one foreign key away from the given ones, in either direction, rolled up as above.
const RELATED: &str = "SELECT DISTINCT other::int8
FROM pg_constraint con
CROSS JOIN LATERAL (
    SELECT COALESCE(pg_partition_root(con.conrelid)::oid, con.conrelid) AS child,
           COALESCE(pg_partition_root(con.confrelid)::oid, con.confrelid) AS parent
) r
CROSS JOIN LATERAL (VALUES (CASE WHEN r.child = ANY ($1::oid[]) THEN r.parent END), (CASE WHEN r.parent = ANY ($1::oid[]) THEN r.child END)) AS o(other)
WHERE con.contype = 'f' AND con.conparentid = 0 AND other IS NOT NULL AND NOT other = ANY ($1::oid[])";

/// A table the picker can offer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramCandidate {
    pub oid: i64,
    pub schema: String,
    pub name: String,
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
    /// Declared on a partition, and drawn from its root.
    pub rolled_up: bool,
    /// `pg_constraint`'s codes: `s` simple, `f` full.
    pub match_type: String,
    /// `a` no action, `r` restrict, `c` cascade, `n` set null, `d` set default.
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramStructure {
    pub tables: Vec<DiagramTable>,
    pub foreign_keys: Vec<DiagramForeignKey>,
}

type CandidateRow = (i64, String, String);
type TableRow = (i64, String, String, Option<String>);
type ColumnRow = (i64, String, String, bool, Option<String>);
type PrimaryKeyRow = (i64, String);
type ForeignKeyRow = (i64, String, i64, i64, Vec<String>, Vec<String>, bool, String, String, String);

fn err(e: sqlx::Error) -> String {
    // lock_not_available, from lock_timeout.
    if e.as_database_error().is_some_and(|d| d.code().as_deref() == Some("55P03")) {
        return "Another session is holding a lock on the catalog. Retry when it has finished.".into();
    }
    e.to_string()
}

pub async fn list_candidates(pool: &PgPool) -> Result<Vec<DiagramCandidate>, String> {
    let rows: Vec<CandidateRow> = sqlx::query_as(CANDIDATES).fetch_all(pool).await.map_err(err)?;
    Ok(rows.into_iter().map(|(oid, schema, name)| DiagramCandidate { oid, schema, name }).collect())
}

/// Separate reads in one snapshot, which were faster than one JSON document. View definitions
/// and defaults stay out of it: `pg_get_viewdef` and `pg_get_expr` block on another session's
/// lock on a table, and these queries don't.
pub async fn load_structure(pool: &PgPool, oids: &[i64]) -> Result<DiagramStructure, String> {
    let oids: Vec<Oid> = oids.iter().map(|&oid| Oid(oid as u32)).collect();
    let mut tx = pool.begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await.map_err(err)?;
    sqlx::query(LOCK_TIMEOUT).execute(&mut *tx).await.map_err(err)?;
    sqlx::query(FIXED_PATH).execute(&mut *tx).await.map_err(err)?;
    let tables: Vec<TableRow> = sqlx::query_as(TABLES).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let columns: Vec<ColumnRow> = sqlx::query_as(COLUMNS).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let primary_keys: Vec<PrimaryKeyRow> = sqlx::query_as(PRIMARY_KEYS).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    let foreign_keys: Vec<ForeignKeyRow> = sqlx::query_as(FOREIGN_KEYS).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
    tx.rollback().await.map_err(err)?;
    Ok(assemble(tables, columns, primary_keys, foreign_keys))
}

/// For Add Related Tables, which offers these in the picker rather than adding them: a hub
/// table can have hundreds.
pub async fn related_tables(pool: &PgPool, oids: &[i64]) -> Result<Vec<i64>, String> {
    let oids: Vec<Oid> = oids.iter().map(|&oid| Oid(oid as u32)).collect();
    sqlx::query_scalar(RELATED).bind(&oids).fetch_all(pool).await.map_err(err)
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
        .map(|(oid, schema, name, comment)| DiagramTable { oid, schema, name, comment, columns: by_table.remove(&oid).unwrap_or_default() })
        .collect();
    let foreign_keys = foreign_keys
        .into_iter()
        .map(|(oid, name, child_oid, parent_oid, child_columns, parent_columns, rolled_up, match_type, on_update, on_delete)| DiagramForeignKey {
            oid,
            name,
            child_oid,
            parent_oid,
            child_columns,
            parent_columns,
            rolled_up,
            match_type,
            on_update,
            on_delete,
        })
        .collect();
    DiagramStructure { tables, foreign_keys }
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
            vec![(1, "public".into(), "orders".into(), Some("Orders".into())), (2, "public".into(), "empty".into(), None)],
            vec![(1, "id".into(), "bigint".into(), true, None), (1, "note".into(), "text".into(), false, Some("Free text".into())), (9, "gone".into(), "text".into(), false, None)],
            vec![(1, "id".into())],
            vec![(5, "fk".into(), 1, 1, vec!["a".into()], vec!["id".into()], false, "s".into(), "a".into(), "c".into())],
        );
        let orders = &structure.tables[0];
        assert_eq!(orders.columns.iter().map(|c| (c.name.as_str(), c.primary_key)).collect::<Vec<_>>(), [("id", true), ("note", false)]);
        assert!(orders.columns[0].not_null && !orders.columns[1].not_null);
        assert!(structure.tables[1].columns.is_empty());
        assert_eq!(structure.foreign_keys[0].child_columns, ["a"]);
        assert_eq!(structure.foreign_keys[0].on_delete, "c");
        assert_eq!(orders.comment.as_deref(), Some("Orders"));
        assert_eq!(orders.columns[1].comment.as_deref(), Some("Free text"));
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
        assert!(!events[0].rolled_up);

        let mut related = related_tables(&pool, &[oid("self")]).await.unwrap();
        related.sort();
        let mut expected = vec![oid("twice"), oid("events")];
        expected.sort();
        assert_eq!(related, expected, "both directions, no partitions, and not the table itself");
        assert_eq!(related_tables(&pool, &[oid("twice")]).await.unwrap(), [oid("self")]);
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
        assert!(fk.rolled_up);
        assert_eq!(fk.child_oid, ours[0].oid);
        assert_eq!(fk.child_columns, ["owner"]);
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
}
