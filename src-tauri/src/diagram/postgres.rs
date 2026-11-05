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
}

type CandidateRow = (i64, String, String);
type TableRow = (i64, String, String, Option<String>);
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
    let version: i32 = sqlx::query_scalar("SELECT current_setting('server_version_num')::int4").fetch_one(&mut *tx).await.map_err(err)?;
    let foreign_keys_query = if version >= PG_18 { FOREIGN_KEYS } else { FOREIGN_KEYS_BEFORE_18 };
    let foreign_keys: Vec<ForeignKeyRow> = sqlx::query_as(foreign_keys_query).bind(&oids).fetch_all(&mut *tx).await.map_err(err)?;
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
}
