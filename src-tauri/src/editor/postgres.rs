//! PostgreSQL side of the data editor: a table's columns and primary key, a
//! page of its rows as text, its row count, and the statements for a batch of
//! edits. Names are always quoted and values always bound; each value is cast
//! to its column's catalog type.

use std::collections::HashSet;

use sqlx::{PgConnection, Row};

use super::model::{CellValue, DataColumn, DataPage, DataSource, EditBatch};
use super::session_postgres::{CANCELLED, Lease, err};
use crate::designer::{qualified, quote_ident};

/// Row count queries give up after this long; the pager then shows no total.
const COUNT_TIMEOUT: &str = "5s";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Columns of the columns query: name, type, nullable, has default, read-only reason.
type ColumnRow = (String, String, bool, bool, Option<String>);

/// Loads the table's columns and primary key. Needs PostgreSQL 12+ (`attgenerated`).
pub async fn load_source(conn: &mut PgConnection, schema: &str, table: &str) -> Result<DataSource, String> {
    let name = qualified(schema, table);
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT FROM pg_class WHERE oid = to_regclass($1) AND relkind IN ('r', 'p'))",
    )
    .bind(&name)
    .fetch_one(&mut *conn)
    .await
    .map_err(err)?;
    if !exists {
        return Err(format!("Table {name} no longer exists."));
    }
    let columns: Vec<ColumnRow> = sqlx::query_as(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                a.atthasdef OR a.attidentity <> '',
                CASE WHEN a.attgenerated <> '' THEN 'Generated column'
                     WHEN a.attidentity = 'a' THEN 'Identity column (GENERATED ALWAYS)'
                     WHEN a.atttypid = 'bytea'::regtype THEN 'Binary data'
                END
         FROM pg_attribute a
         WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum",
    )
    .bind(&name)
    .fetch_all(&mut *conn)
    .await
    .map_err(err)?;
    let primary_key: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname::text
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = to_regclass($1) AND i.indisprimary
         ORDER BY k.ord",
    )
    .bind(&name)
    .fetch_all(&mut *conn)
    .await
    .map_err(err)?;
    let read_only = primary_key
        .is_empty()
        .then(|| "This table has no primary key, so its rows can't be told apart for editing.".to_string());
    let columns = columns
        .into_iter()
        .map(|(name, type_name, nullable, has_default, read_only)| DataColumn {
            name,
            type_name,
            nullable,
            has_default,
            read_only,
        })
        .collect();
    Ok(DataSource { columns, primary_key, read_only })
}

/// `SELECT` of one page, every column as text, ordered by the primary key
/// (or by `ctid` without one, so paging is at least stable while nothing changes).
/// The sort columns are qualified: a bare name would sort by the text output
/// column of the same name.
pub fn select_page_sql(schema: &str, table: &str, source: &DataSource, offset: u64, limit: u64) -> String {
    let target = qualified(schema, table);
    let columns: Vec<_> = source.columns.iter().map(|c| format!("{}::text", quote_ident(&c.name))).collect();
    let order: Vec<_> = if source.primary_key.is_empty() {
        vec![format!("{target}.ctid")]
    } else {
        source.primary_key.iter().map(|c| format!("{target}.{}", quote_ident(c))).collect()
    };
    format!("SELECT {} FROM {target} ORDER BY {} LIMIT {limit} OFFSET {offset}", columns.join(", "), order.join(", "))
}

/// The table's shape and one page of its rows. Runs in a scope that is
/// always rolled back.
pub async fn fetch_page(lease: &mut Lease<'_>, schema: &str, table: &str, offset: u64, limit: u64) -> Result<DataPage, String> {
    lease.open_scope().await?;
    let page = read_page(lease.conn(), schema, table, offset, limit).await;
    let closed = lease.close_scope(false).await;
    let page = page?;
    closed?;
    Ok(page)
}

async fn read_page(conn: &mut PgConnection, schema: &str, table: &str, offset: u64, limit: u64) -> Result<DataPage, String> {
    let source = load_source(conn, schema, table).await?;
    let sql = select_page_sql(schema, table, &source, offset, limit);
    let fetched = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(&mut *conn).await.map_err(err)?;
    let width = source.columns.len();
    let rows = fetched
        .iter()
        .map(|row| (0..width).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect())
        .collect();
    Ok(DataPage { source, rows })
}

/// The exact row count, or `None` if counting takes longer than [`COUNT_TIMEOUT`].
pub async fn count_rows(lease: &mut Lease<'_>, schema: &str, table: &str) -> Result<Option<i64>, String> {
    lease.open_scope().await?;
    let count = count_with_timeout(lease.conn(), schema, table).await;
    let closed = lease.close_scope(false).await;
    let count = match count {
        Ok(n) => Some(n),
        Err(e) if is_timeout(&e) => None,
        Err(e) => return Err(err(e)),
    };
    closed?;
    Ok(count)
}

/// Counts inside the caller's scope; its rollback ends the `SET LOCAL`.
async fn count_with_timeout(conn: &mut PgConnection, schema: &str, table: &str) -> Result<i64, sqlx::Error> {
    let timeout = format!("SET LOCAL statement_timeout = '{COUNT_TIMEOUT}'");
    sqlx::raw_sql(sqlx::AssertSqlSafe(timeout)).execute(&mut *conn).await?;
    let sql = format!("SELECT count(*) FROM {}", qualified(schema, table));
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).fetch_one(conn).await
}

fn is_timeout(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|db| db.code().as_deref() == Some("57014") && db.message().contains("statement timeout"))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// One statement of an edit batch with its bound values.
#[derive(Debug, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub binds: Vec<Option<String>>,
    /// Must change exactly one row (an UPDATE or DELETE by primary key).
    pub single_row: bool,
}

/// A `$n::type` placeholder for a bind; the cast makes PostgreSQL convert
/// the text the way it would a literal.
fn placeholder(binds: &mut Vec<Option<String>>, value: Option<String>, type_name: &str) -> String {
    binds.push(value);
    format!("${}::{type_name}", binds.len())
}

/// Turns a batch into statements: deletes, then updates, then inserts (so a
/// key freed by a delete can be reused). Every column is checked against
/// `source`, so the batch can't name anything else.
pub fn build_statements(schema: &str, table: &str, source: &DataSource, batch: &EditBatch) -> Result<Vec<Statement>, String> {
    if let Some(reason) = &source.read_only {
        return Err(reason.clone());
    }
    let target = qualified(schema, table);
    let column = |name: &str| -> Result<&DataColumn, String> {
        let c = source.columns.iter().find(|c| c.name == name).ok_or_else(|| format!("Column \"{name}\" no longer exists."))?;
        match &c.read_only {
            Some(reason) => Err(format!("Column \"{name}\" can't be edited: {reason}.")),
            None => Ok(c),
        }
    };
    let key_columns: Vec<&DataColumn> = source
        .primary_key
        .iter()
        .map(|k| source.columns.iter().find(|c| &c.name == k).ok_or_else(|| format!("Column \"{k}\" no longer exists.")))
        .collect::<Result<_, _>>()?;
    let where_key = |binds: &mut Vec<Option<String>>, key: &[String]| -> Result<String, String> {
        if key.len() != key_columns.len() {
            return Err("A row's primary key doesn't match the table's.".into());
        }
        let terms: Vec<_> = key_columns
            .iter()
            .zip(key)
            .map(|(c, v)| format!("{} = {}", quote_ident(&c.name), placeholder(binds, Some(v.clone()), &c.type_name)))
            .collect();
        Ok(terms.join(" AND "))
    };
    let distinct = |values: &[CellValue]| -> Result<(), String> {
        let mut seen = HashSet::new();
        match values.iter().find(|v| !seen.insert(v.column.as_str())) {
            Some(v) => Err(format!("Column \"{}\" is set twice.", v.column)),
            None => Ok(()),
        }
    };

    let mut statements = Vec::new();
    for key in &batch.deletes {
        let mut binds = Vec::new();
        let sql = format!("DELETE FROM {target} WHERE {}", where_key(&mut binds, key)?);
        statements.push(Statement { sql, binds, single_row: true });
    }
    for update in batch.updates.iter().filter(|u| !u.values.is_empty()) {
        distinct(&update.values)?;
        let mut binds = Vec::new();
        let sets = update
            .values
            .iter()
            .map(|v| {
                let c = column(&v.column)?;
                Ok(format!("{} = {}", quote_ident(&c.name), placeholder(&mut binds, v.value.clone(), &c.type_name)))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let sql = format!("UPDATE {target} SET {} WHERE {}", sets.join(", "), where_key(&mut binds, &update.key)?);
        statements.push(Statement { sql, binds, single_row: true });
    }
    for values in &batch.inserts {
        distinct(values)?;
        let mut binds = Vec::new();
        let sql = if values.is_empty() {
            format!("INSERT INTO {target} DEFAULT VALUES")
        } else {
            let (names, placeholders): (Vec<_>, Vec<_>) = values
                .iter()
                .map(|v| {
                    let c = column(&v.column)?;
                    Ok((quote_ident(&c.name), placeholder(&mut binds, v.value.clone(), &c.type_name)))
                })
                .collect::<Result<Vec<_>, String>>()?
                .into_iter()
                .unzip();
            format!("INSERT INTO {target} ({}) VALUES ({})", names.join(", "), placeholders.join(", "))
        };
        statements.push(Statement { sql, binds, single_row: false });
    }
    Ok(statements)
}

/// Applies a batch of edits all or nothing: in its own transaction, or inside
/// the user's transaction in a savepoint (so a failure leaves it usable).
/// Returns the number of rows changed.
pub async fn apply_edits(lease: &mut Lease<'_>, schema: &str, table: &str, batch: &EditBatch) -> Result<u64, String> {
    lease.open_scope().await?;
    let applied = run_batch(lease.conn(), schema, table, batch).await;
    let closed = lease.close_scope(applied.is_ok()).await;
    let applied = applied?;
    closed?;
    Ok(applied)
}

async fn run_batch(conn: &mut PgConnection, schema: &str, table: &str, batch: &EditBatch) -> Result<u64, String> {
    // Checked against the table as this connection sees it now.
    let source = load_source(conn, schema, table).await?;
    let mut changed = 0;
    for statement in build_statements(schema, table, &source, batch)? {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(statement.sql.clone()));
        for value in &statement.binds {
            query = query.bind(value.clone());
        }
        let failed = |message: String| format!("{message}\n\nFailed statement:\n{}", statement.sql);
        let rows = match query.execute(&mut *conn).await {
            Ok(done) => done.rows_affected(),
            // Stop's error stays exactly CANCELLED, so the UI shows it as a notice.
            Err(e) => {
                let message = err(e);
                return Err(if message == CANCELLED { message } else { failed(message) });
            }
        };
        if statement.single_row && rows != 1 {
            return Err(failed(format!(
                "The row was changed or deleted by someone else ({rows} rows matched). Refresh and try again."
            )));
        }
        changed += rows;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::model::RowUpdate;

    fn col(name: &str, type_name: &str) -> DataColumn {
        DataColumn { name: name.into(), type_name: type_name.into(), nullable: true, has_default: false, read_only: None }
    }

    fn source() -> DataSource {
        DataSource {
            columns: vec![
                col("id", "integer"),
                col("Name", "character varying(20)"),
                DataColumn { read_only: Some("Generated column".into()), ..col("total", "numeric") },
            ],
            primary_key: vec!["id".into()],
            read_only: None,
        }
    }

    fn cell(column: &str, value: Option<&str>) -> CellValue {
        CellValue { column: column.into(), value: value.map(String::from) }
    }

    #[test]
    fn selects_a_page_as_text_in_key_order() {
        assert_eq!(
            select_page_sql("public", "items", &source(), 2000, 1000),
            r#"SELECT "id"::text, "Name"::text, "total"::text FROM "public"."items" ORDER BY "public"."items"."id" LIMIT 1000 OFFSET 2000"#
        );
        let keyless = DataSource { primary_key: vec![], ..source() };
        assert!(select_page_sql("s", "t", &keyless, 0, 10).ends_with(r#"ORDER BY "s"."t".ctid LIMIT 10 OFFSET 0"#));
    }

    #[test]
    fn builds_deletes_then_updates_then_inserts() {
        let batch = EditBatch {
            inserts: vec![vec![cell("Name", Some("new")), cell("id", Some("9"))], vec![]],
            updates: vec![
                RowUpdate { key: vec!["1".into()], values: vec![cell("Name", None), cell("id", Some("2"))] },
                RowUpdate { key: vec!["3".into()], values: vec![] },
            ],
            deletes: vec![vec!["5".into()]],
        };
        let statements = build_statements("public", "items", &source(), &batch).unwrap();
        let s = |sql: &str, binds: &[Option<&str>], single_row| Statement {
            sql: sql.into(),
            binds: binds.iter().map(|b| b.map(String::from)).collect(),
            single_row,
        };
        assert_eq!(
            statements,
            vec![
                s(r#"DELETE FROM "public"."items" WHERE "id" = $1::integer"#, &[Some("5")], true),
                s(
                    r#"UPDATE "public"."items" SET "Name" = $1::character varying(20), "id" = $2::integer WHERE "id" = $3::integer"#,
                    &[None, Some("2"), Some("1")],
                    true
                ),
                s(
                    r#"INSERT INTO "public"."items" ("Name", "id") VALUES ($1::character varying(20), $2::integer)"#,
                    &[Some("new"), Some("9")],
                    false
                ),
                s(r#"INSERT INTO "public"."items" DEFAULT VALUES"#, &[], false),
            ]
        );
    }

    #[test]
    fn composite_keys_and_rejections() {
        let composite = DataSource { primary_key: vec!["id".into(), "Name".into()], ..source() };
        let update = |key: &[&str], values| EditBatch {
            updates: vec![RowUpdate { key: key.iter().map(|k| k.to_string()).collect(), values }],
            ..Default::default()
        };
        let statements = build_statements("s", "t", &composite, &update(&["1", "a"], vec![cell("id", Some("2"))])).unwrap();
        assert!(statements[0].sql.ends_with(r#"WHERE "id" = $2::integer AND "Name" = $3::character varying(20)"#));

        let reject = |source: &DataSource, batch: &EditBatch| build_statements("s", "t", source, batch).unwrap_err();
        assert!(reject(&composite, &update(&["1"], vec![cell("id", Some("2"))])).contains("primary key"));
        assert!(reject(&source(), &update(&["1"], vec![cell("total", Some("2"))])).contains("Generated column"));
        assert!(reject(&source(), &update(&["1"], vec![cell("nope", Some("2"))])).contains("no longer exists"));
        assert!(reject(&source(), &update(&["1"], vec![cell("id", Some("2")), cell("id", Some("3"))])).contains("twice"));
        let keyless = DataSource { primary_key: vec![], read_only: Some("no key".into()), ..source() };
        assert_eq!(reject(&keyless, &EditBatch { inserts: vec![vec![]], ..Default::default() }), "no key");
    }

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn edits_data_on_live_server() {
        use crate::editor::session_postgres::{CANCELLED, HeldSession};
        use std::sync::Arc;

        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let pool = crate::explorer::sessions::SessionManager::default().pool(&config, "postgres");
        let schema = "huxdb_data_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_data_test CASCADE;
             CREATE SCHEMA huxdb_data_test;
             CREATE TYPE huxdb_data_test.mood AS ENUM ('sad', 'happy');
             CREATE TABLE huxdb_data_test.items (
               id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
               name text NOT NULL DEFAULT 'unnamed',
               price numeric(10,2), at timestamptz, doc jsonb, uid uuid, ok bool, tags int[],
               mood huxdb_data_test.mood, raw bytea,
               doubled numeric GENERATED ALWAYS AS (price * 2) STORED);
             INSERT INTO huxdb_data_test.items (name, price) SELECT 'item ' || g, g FROM generate_series(1, 25) g;
             CREATE TABLE huxdb_data_test.keyless (a int);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session = Arc::new(HeldSession::new("live"));
        let page = |offset| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "items", offset, 10).await }
        };
        let apply = |batch: EditBatch| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { apply_edits(&mut session.lease(&pool).await.unwrap(), schema, "items", &batch).await }
        };
        let name_of = |id: i32| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT name FROM huxdb_data_test.items WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&pool)
                    .await
                    .unwrap()
            }
        };
        let update = |id: &str, values| EditBatch {
            updates: vec![RowUpdate { key: vec![id.into()], values }],
            ..Default::default()
        };

        // Shape and paging.
        let first = page(10).await.unwrap();
        assert_eq!(first.source.primary_key, ["id"]);
        let read_only: Vec<_> = first.source.columns.iter().filter(|c| c.read_only.is_some()).map(|c| c.name.as_str()).collect();
        assert_eq!(read_only, ["raw", "doubled"]);
        assert_eq!(first.rows.len(), 10);
        assert_eq!(first.rows[0][..3], [Some("11".into()), Some("item 11".into()), Some("11.00".into())]);
        assert_eq!(count_rows(&mut session.lease(&pool).await.unwrap(), schema, "items").await, Ok(Some(25)));
        let keyless = fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "keyless", 0, 10).await.unwrap();
        assert!(keyless.source.read_only.is_some());

        // Every kind of value goes in as text and is cast by the server.
        let typed = vec![
            cell("price", Some("12.5")),
            cell("at", Some("2024-01-02 03:04:05+00")),
            cell("doc", Some(r#"{"a": [1, 2]}"#)),
            cell("uid", Some("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")),
            cell("ok", Some("true")),
            cell("tags", Some("{1,2,3}")),
            cell("mood", Some("happy")),
            cell("name", Some("")),
        ];
        assert_eq!(apply(update("1", typed)).await, Ok(1));
        let row = &page(0).await.unwrap().rows[0];
        assert_eq!(row[1].as_deref(), Some(""), "an empty string stays an empty string");
        assert_eq!(row[2].as_deref(), Some("12.50"));
        assert_eq!(row[7].as_deref(), Some("{1,2,3}"));
        assert_eq!(row[10].as_deref(), Some("25.00"), "the generated column follows");

        // Inserts take defaults; deletes and updates must hit exactly one row.
        let inserted = EditBatch { inserts: vec![vec![], vec![cell("name", Some("named")), cell("price", None)]], ..Default::default() };
        assert_eq!(apply(inserted).await, Ok(2));
        assert_eq!(name_of(26).await.as_deref(), Some("unnamed"));
        let gone = apply(EditBatch { deletes: vec![vec!["999".into()]], ..Default::default() }).await.unwrap_err();
        assert!(gone.contains("0 rows matched"), "{gone}");
        let bad = apply(EditBatch {
            deletes: vec![vec!["2".into()]],
            updates: vec![RowUpdate { key: vec!["3".into()], values: vec![cell("price", Some("abc"))] }],
            ..Default::default()
        })
        .await
        .unwrap_err();
        assert!(bad.contains("invalid input syntax") && bad.contains("Failed statement"), "{bad}");
        assert_eq!(name_of(2).await.as_deref(), Some("item 2"), "a failed batch changes nothing");

        // Inside a transaction: edits are visible to the tab only, a failed
        // batch leaves the transaction usable, and rollback undoes it all.
        session.begin(&pool).await.unwrap();
        assert!(session.begin(&pool).await.is_err());
        assert_eq!(apply(update("4", vec![cell("name", Some("in tx"))])).await, Ok(1));
        assert!(apply(update("4", vec![cell("price", Some("abc"))])).await.is_err());
        assert_eq!(page(0).await.unwrap().rows[3][1].as_deref(), Some("in tx"));
        assert_eq!(name_of(4).await.as_deref(), Some("item 4"), "other connections don't see it yet");
        session.end(false).await.unwrap();
        assert_eq!(name_of(4).await.as_deref(), Some("item 4"));
        assert!(session.end(false).await.is_err());

        session.begin(&pool).await.unwrap();
        assert_eq!(apply(EditBatch { deletes: vec![vec!["5".into()]], ..Default::default() }).await, Ok(1));
        session.end(true).await.unwrap();
        assert_eq!(name_of(5).await, None);

        // Stop cancels the running statement; an open transaction survives it.
        session.begin(&pool).await.unwrap();
        apply(update("6", vec![cell("name", Some("kept"))])).await.unwrap();
        let sleeper = {
            let (session, pool) = (session.clone(), pool.clone());
            tokio::spawn(async move {
                let mut lease = session.lease(&pool).await.unwrap();
                lease.open_scope().await.unwrap();
                let slept = sqlx::raw_sql("SELECT pg_sleep(10)").execute(lease.conn()).await.map_err(err);
                lease.close_scope(false).await.unwrap();
                slept.map(drop)
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        session.cancel(&pool).await.unwrap();
        assert_eq!(sleeper.await.unwrap(), Err(CANCELLED.to_string()));
        session.end(true).await.unwrap();
        assert_eq!(name_of(6).await.as_deref(), Some("kept"));

        // Stop on a Commit waiting for a row lock reports exactly CANCELLED.
        let mut blocker = pool.begin().await.unwrap();
        sqlx::raw_sql("UPDATE huxdb_data_test.items SET name = 'locked' WHERE id = 7").execute(&mut *blocker).await.unwrap();
        let waiting = tokio::spawn(apply(update("7", vec![cell("name", Some("waits"))])));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        session.cancel(&pool).await.unwrap();
        assert_eq!(waiting.await.unwrap(), Err(CANCELLED.to_string()));
        blocker.rollback().await.unwrap();
        assert_eq!(name_of(7).await.as_deref(), Some("item 7"));

        sqlx::raw_sql("DROP SCHEMA huxdb_data_test CASCADE").execute(&pool).await.unwrap();
    }
}
