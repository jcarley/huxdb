//! PostgreSQL side of the data editor: a table's columns and primary key, a
//! filtered and sorted page of its rows as text, its row count, and the
//! statements for a batch of edits. Names are always quoted and values always
//! bound; each value is cast to its column's catalog type. The one exception
//! is the filter bar's typed WHERE and ORDER BY, which are the user's SQL and
//! run only in a read-only scope.

use std::collections::HashSet;

use sqlx::{PgConnection, Row};

use super::model::{CellValue, DataColumn, DataPage, DataSource, DataSpec, EditBatch, FilterNode, FilterOp, GroupOp};
use super::session_postgres::{CANCELLED, Lease, err};
use crate::designer::{qualified, quote_ident};

/// Row count queries give up after this long; the pager then shows no total.
const COUNT_TIMEOUT: &str = "5s";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Columns of the columns query: name, type, nullable, has default, read-only
/// reason, comparable.
type ColumnRow = (String, String, bool, bool, Option<String>, bool);

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
                END,
                -- A default btree operator class, as sorting looks one up: for
                -- the type under any domains, a type it is implicitly binary
                -- coercible to (varchar to text), or its polymorphic family.
                EXISTS (
                  SELECT FROM pg_opclass o
                  JOIN pg_am m ON m.oid = o.opcmethod
                  JOIN pg_type i ON i.oid = o.opcintype
                  WHERE m.amname = 'btree' AND o.opcdefault
                    AND (i.oid = b.oid
                         OR i.typname = CASE WHEN b.typcategory = 'A' THEN 'anyarray'
                                             WHEN b.typtype = 'e' THEN 'anyenum'
                                             WHEN b.typtype = 'r' THEN 'anyrange'
                                             WHEN b.typtype = 'm' THEN 'anymultirange'
                                             WHEN b.typtype = 'c' THEN 'record'
                                        END
                         OR EXISTS (SELECT FROM pg_cast c
                                    WHERE c.castsource = b.oid AND c.casttarget = i.oid
                                      AND c.castmethod = 'b' AND c.castcontext = 'i')))
         FROM pg_attribute a
         CROSS JOIN LATERAL (
           WITH RECURSIVE base AS (
             SELECT t.oid, t.typtype, t.typcategory, t.typbasetype FROM pg_type t WHERE t.oid = a.atttypid
             UNION ALL
             SELECT p.oid, p.typtype, p.typcategory, p.typbasetype
             FROM pg_type p JOIN base ON p.oid = base.typbasetype
           )
           SELECT oid, typtype, typcategory FROM base WHERE typbasetype = 0
         ) b
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
        .map(|(name, type_name, nullable, has_default, read_only, comparable)| DataColumn {
            name,
            type_name,
            nullable,
            has_default,
            read_only,
            comparable,
        })
        .collect();
    Ok(DataSource { columns, primary_key, read_only })
}

/// The spec's typed text if there's any. It goes between newlines so that a
/// trailing `--` comment can't swallow the SQL generated after it.
fn typed(text: &Option<String>) -> Option<String> {
    text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(|t| format!("\n{t}\n"))
}

/// A column the filter or sort names, checked against the loaded `source`.
fn comparable_column<'a>(source: &'a DataSource, name: &str) -> Result<&'a DataColumn, String> {
    let column = find_column(source, name)?;
    if column.comparable {
        Ok(column)
    } else {
        Err(format!("Column \"{name}\" has type {}, which can't be compared.", column.type_name))
    }
}

fn find_column<'a>(source: &'a DataSource, name: &str) -> Result<&'a DataColumn, String> {
    source.columns.iter().find(|c| c.name == name).ok_or_else(|| format!("Column \"{name}\" no longer exists."))
}

fn filter_sql(node: &FilterNode, source: &DataSource, binds: &mut Vec<Option<String>>) -> Result<String, String> {
    match node {
        FilterNode::Group { op, children } => {
            let (joiner, empty) = match op {
                GroupOp::And => (" AND ", "TRUE"),
                GroupOp::Or => (" OR ", "FALSE"),
            };
            if children.is_empty() {
                return Ok(empty.to_string());
            }
            let terms = children.iter().map(|c| filter_sql(c, source, binds)).collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", terms.join(joiner)))
        }
        FilterNode::Condition { column, op, value } => {
            let name = quote_ident(&find_column(source, column)?.name);
            let operator = match op {
                FilterOp::IsNull => return Ok(format!("{name} IS NULL")),
                FilterOp::IsNotNull => return Ok(format!("{name} IS NOT NULL")),
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
            };
            let c = comparable_column(source, column)?;
            let value = value.clone().ok_or_else(|| format!("The filter on column \"{column}\" has no value."))?;
            Ok(format!("{name} {operator} {}", placeholder(binds, Some(value), &c.type_name)))
        }
    }
}

/// The spec's ` WHERE …`, or nothing. Parentheses keep the typed part one
/// condition next to the structured filter.
fn where_clause(source: &DataSource, spec: &DataSpec, binds: &mut Vec<Option<String>>) -> Result<String, String> {
    let mut terms = Vec::new();
    if let Some(filter) = &spec.filter {
        terms.push(filter_sql(filter, source, binds)?);
    }
    if let Some(text) = typed(&spec.where_sql) {
        terms.push(format!("({text})"));
    }
    Ok(if terms.is_empty() { String::new() } else { format!(" WHERE {}", terms.join(" AND ")) })
}

/// The sort terms: the header's, the typed ones, and last the primary key (or
/// `tableoid, ctid` without one: `ctid` alone repeats across partitions),
/// because pages are only reliable in a unique order. The last term also
/// makes text that tries to end the ORDER BY a syntax error.
fn order_terms(schema: &str, table: &str, source: &DataSource, spec: &DataSpec) -> Result<Vec<String>, String> {
    let target = qualified(schema, table);
    let mut terms = spec
        .sort
        .iter()
        .map(|key| {
            let name = quote_ident(&comparable_column(source, &key.column)?.name);
            Ok(format!("{target}.{name}{}", if key.descending { " DESC" } else { "" }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    terms.extend(typed(&spec.order_sql));
    if source.primary_key.is_empty() {
        terms.push(format!("{target}.tableoid"));
        terms.push(format!("{target}.ctid"));
    } else {
        terms.extend(source.primary_key.iter().map(|c| format!("{target}.{}", quote_ident(c))));
    }
    Ok(terms)
}

/// `SELECT` of one page and its binds, every column as text. Filtering and
/// sorting happen in a subquery that keeps the columns' real types: at the
/// top level `ORDER BY age` or `ORDER BY 1` would sort the text output.
pub fn select_page_sql(
    schema: &str,
    table: &str,
    source: &DataSource,
    spec: &DataSpec,
    offset: u64,
    limit: u64,
) -> Result<(String, Vec<Option<String>>), String> {
    let target = qualified(schema, table);
    let columns: Vec<_> = source.columns.iter().map(|c| format!("q.{}::text", quote_ident(&c.name))).collect();
    let mut binds = Vec::new();
    let filter = where_clause(source, spec, &mut binds)?;
    let order = order_terms(schema, table, source, spec)?.join(", ");
    let sql = format!("SELECT {} FROM (SELECT * FROM {target}{filter} ORDER BY {order} LIMIT {limit} OFFSET {offset}) q", columns.join(", "));
    Ok((sql, binds))
}

/// `SELECT count(*)` of the rows the spec selects, and its binds.
fn count_sql(schema: &str, table: &str, source: &DataSource, spec: &DataSpec) -> Result<(String, Vec<Option<String>>), String> {
    let mut binds = Vec::new();
    let filter = where_clause(source, spec, &mut binds)?;
    Ok((format!("SELECT count(*) FROM {}{filter}", qualified(schema, table)), binds))
}

/// The table's shape and one page of its rows. Runs in a read-only scope that
/// is always rolled back.
pub async fn fetch_page(lease: &mut Lease<'_>, schema: &str, table: &str, spec: &DataSpec, offset: u64, limit: u64) -> Result<DataPage, String> {
    lease.open_read_scope().await?;
    let page = read_page(lease.conn(), schema, table, spec, offset, limit).await;
    let closed = lease.close_scope(false).await;
    let page = page?;
    closed?;
    Ok(page)
}

async fn read_page(conn: &mut PgConnection, schema: &str, table: &str, spec: &DataSpec, offset: u64, limit: u64) -> Result<DataPage, String> {
    let source = load_source(conn, schema, table).await?;
    let (sql, binds) = select_page_sql(schema, table, &source, spec, offset, limit)?;
    // Not persistent: nearly every page and filter is a different statement.
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).persistent(false);
    for value in binds {
        query = query.bind(value);
    }
    let fetched = query.fetch_all(&mut *conn).await.map_err(err)?;
    let width = source.columns.len();
    let rows = fetched
        .iter()
        .map(|row| (0..width).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect())
        .collect();
    Ok(DataPage { source, rows })
}

/// The exact number of rows the spec selects, or `None` if counting takes
/// longer than [`COUNT_TIMEOUT`].
pub async fn count_rows(lease: &mut Lease<'_>, schema: &str, table: &str, spec: &DataSpec) -> Result<Option<i64>, String> {
    lease.open_read_scope().await?;
    let count = count_with_timeout(lease.conn(), schema, table, spec).await;
    let closed = lease.close_scope(false).await;
    let count = count?;
    closed?;
    Ok(count)
}

/// Counts inside the caller's scope; its rollback ends the `SET LOCAL`.
async fn count_with_timeout(conn: &mut PgConnection, schema: &str, table: &str, spec: &DataSpec) -> Result<Option<i64>, String> {
    let source = load_source(conn, schema, table).await?;
    let (sql, binds) = count_sql(schema, table, &source, spec)?;
    let timeout = format!("SET LOCAL statement_timeout = '{COUNT_TIMEOUT}'");
    sqlx::raw_sql(sqlx::AssertSqlSafe(timeout)).execute(&mut *conn).await.map_err(err)?;
    let mut query = sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).persistent(false);
    for value in binds {
        query = query.bind(value);
    }
    match query.fetch_one(conn).await {
        Ok(n) => Ok(Some(n)),
        Err(e) if is_timeout(&e) => Ok(None),
        Err(e) => Err(err(e)),
    }
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
        let c = find_column(source, name)?;
        match &c.read_only {
            Some(reason) => Err(format!("Column \"{name}\" can't be edited: {reason}.")),
            None => Ok(c),
        }
    };
    let key_columns: Vec<&DataColumn> = source
        .primary_key
        .iter()
        .map(|k| find_column(source, k))
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
    use crate::editor::model::{RowUpdate, SortKey};

    fn col(name: &str, type_name: &str) -> DataColumn {
        DataColumn { name: name.into(), type_name: type_name.into(), nullable: true, has_default: false, read_only: None, comparable: true }
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
        let page = |source: &DataSource| select_page_sql("public", "items", source, &DataSpec::default(), 2000, 1000).unwrap();
        assert_eq!(
            page(&source()),
            (
                r#"SELECT q."id"::text, q."Name"::text, q."total"::text FROM (SELECT * FROM "public"."items" ORDER BY "public"."items"."id" LIMIT 1000 OFFSET 2000) q"#.to_string(),
                vec![]
            )
        );
        let keyless = DataSource { primary_key: vec![], ..source() };
        assert!(page(&keyless).0.ends_with(r#"ORDER BY "public"."items".tableoid, "public"."items".ctid LIMIT 1000 OFFSET 2000) q"#));
    }

    fn condition(column: &str, op: FilterOp, value: Option<&str>) -> FilterNode {
        FilterNode::Condition { column: column.into(), op, value: value.map(String::from) }
    }

    fn inner_sql(spec: &DataSpec) -> (String, Vec<Option<String>>) {
        let (sql, binds) = select_page_sql("s", "t", &source(), spec, 0, 10).unwrap();
        let start = sql.find(r#"FROM "s"."t""#).unwrap();
        (sql[start..].to_string(), binds)
    }

    #[test]
    fn sorts_by_header_keys_then_the_primary_key() {
        let key = |column: &str, descending| SortKey { column: column.into(), descending };
        let spec = DataSpec { sort: vec![key("Name", true), key("total", false)], ..Default::default() };
        assert_eq!(
            inner_sql(&spec).0,
            r#"FROM "s"."t" ORDER BY "s"."t"."Name" DESC, "s"."t"."total", "s"."t"."id" LIMIT 10 OFFSET 0) q"#
        );
    }

    #[test]
    fn filters_with_bound_values_and_keeps_typed_text_apart() {
        let spec = DataSpec {
            filter: Some(FilterNode::Group {
                op: GroupOp::And,
                children: vec![
                    condition("id", FilterOp::Eq, Some("1")),
                    FilterNode::Group {
                        op: GroupOp::Or,
                        children: vec![condition("Name", FilterOp::Ne, Some("x'y")), condition("Name", FilterOp::IsNull, None)],
                    },
                    condition("total", FilterOp::IsNotNull, None),
                ],
            }),
            where_sql: Some("  price > 1 -- note  ".into()),
            order_sql: Some("price DESC --".into()),
            ..Default::default()
        };
        let (sql, binds) = inner_sql(&spec);
        assert_eq!(
            sql,
            "FROM \"s\".\"t\" WHERE (\"id\" = $1::integer AND (\"Name\" <> $2::character varying(20) OR \"Name\" IS NULL) AND \"total\" IS NOT NULL) \
             AND (\nprice > 1 -- note\n) ORDER BY \nprice DESC --\n, \"s\".\"t\".\"id\" LIMIT 10 OFFSET 0) q"
        );
        assert_eq!(binds, [Some("1".to_string()), Some("x'y".to_string())]);

        let (count, count_binds) = count_sql("s", "t", &source(), &spec).unwrap();
        assert!(count.starts_with(r#"SELECT count(*) FROM "s"."t" WHERE ("id" = $1::integer"#), "{count}");
        assert_eq!(count_binds, binds);
    }

    #[test]
    fn blank_typed_text_and_empty_groups() {
        let blank = DataSpec { where_sql: Some(" \n ".into()), order_sql: Some("".into()), ..Default::default() };
        assert_eq!(inner_sql(&blank), inner_sql(&DataSpec::default()));
        let group = |op| DataSpec { filter: Some(FilterNode::Group { op, children: vec![] }), ..Default::default() };
        assert!(inner_sql(&group(GroupOp::And)).0.contains("WHERE TRUE"));
        assert!(inner_sql(&group(GroupOp::Or)).0.contains("WHERE FALSE"));
    }

    #[test]
    fn rejects_columns_the_source_does_not_allow() {
        let source = DataSource { columns: vec![DataColumn { comparable: false, ..col("doc", "json") }, col("id", "integer")], ..source() };
        let reject = |spec: DataSpec| select_page_sql("s", "t", &source, &spec, 0, 10).unwrap_err();
        let sort = |column: &str| DataSpec { sort: vec![SortKey { column: column.into(), descending: false }], ..Default::default() };
        let filter = |node| DataSpec { filter: Some(node), ..Default::default() };

        assert!(reject(sort("nope")).contains("no longer exists"));
        assert!(reject(sort("doc")).contains("can't be compared"));
        assert!(reject(filter(condition("nope", FilterOp::IsNull, None))).contains("no longer exists"));
        assert!(reject(filter(condition("doc", FilterOp::Eq, Some("{}")))).contains("can't be compared"));
        assert!(reject(filter(condition("id", FilterOp::Eq, None))).contains("no value"));
        // A null check works on any type.
        assert!(select_page_sql("s", "t", &source, &filter(condition("doc", FilterOp::IsNull, None)), 0, 10).is_ok());
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
            async move { fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "items", &DataSpec::default(), offset, 10).await }
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
        assert_eq!(count_rows(&mut session.lease(&pool).await.unwrap(), schema, "items", &DataSpec::default()).await, Ok(Some(25)));
        let keyless = fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "keyless", &DataSpec::default(), 0, 10).await.unwrap();
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

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn filters_and_sorts_on_live_server() {
        use crate::editor::session_postgres::{CANCELLED, HeldSession};
        use std::collections::{HashMap, HashSet};
        use std::sync::Arc;

        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live-filter".into(),
            port,
            ..crate::connections::model::sample("live-filter")
        };
        let pool = crate::explorer::sessions::SessionManager::default().pool(&config, "postgres");
        let schema = "huxdb_filter_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_filter_test CASCADE;
             CREATE SCHEMA huxdb_filter_test;
             SET search_path = huxdb_filter_test;
             CREATE TYPE mood AS ENUM ('sad', 'happy');
             CREATE DOMAIN small AS int;
             CREATE DOMAIN smaller AS small;
             CREATE TABLE t (
               id int PRIMARY KEY, age int, grp text, label varchar(10), amount numeric(10,2),
               at timestamptz, uid uuid, mood mood, doc json, bin jsonb, x xml, pt point,
               dom smaller, arr int[], rng int4range, raw bytea, jarr json[]);
             INSERT INTO t (id, age, grp, label, amount, at, uid, mood, doc, bin)
             SELECT g, 26 - g, 'g' || g % 3, 'l' || g, CASE WHEN g % 5 <> 0 THEN g * 1.5 END,
                    '2024-01-01 00:00:00+00'::timestamptz + g * interval '1 day',
                    md5(g::text)::uuid, (ARRAY['sad', 'happy'])[g % 2 + 1]::mood, '{}', '{}'
             FROM generate_series(1, 25) g;
             CREATE FUNCTION touch() RETURNS bool LANGUAGE plpgsql AS
               $$ BEGIN UPDATE huxdb_filter_test.t SET age = 0; RETURN true; END $$;
             CREATE TABLE parts (a int, b int) PARTITION BY RANGE (a);
             CREATE TABLE parts_low PARTITION OF parts FOR VALUES FROM (0) TO (100);
             CREATE TABLE parts_high PARTITION OF parts FOR VALUES FROM (100) TO (200);
             INSERT INTO parts SELECT g, g % 2 FROM generate_series(50, 149) g;
             RESET search_path;",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session = Arc::new(HeldSession::new("live-filter"));
        let page = |spec: DataSpec, offset, limit| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "t", &spec, offset, limit).await }
        };
        let count = |spec: DataSpec| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { count_rows(&mut session.lease(&pool).await.unwrap(), schema, "t", &spec).await }
        };
        let typed_where = |text: &str| DataSpec { where_sql: Some(text.into()), ..Default::default() };
        let typed_order = |text: &str| DataSpec { order_sql: Some(text.into()), ..Default::default() };
        let filter = |column: &str, op, value: Option<&str>| DataSpec { filter: Some(condition(column, op, value)), ..Default::default() };
        let column = |name: &str| ["id", "age", "grp", "label", "amount", "at", "uid", "mood"].iter().position(|c| *c == name).unwrap();
        let ids = |page: &DataPage| page.rows.iter().map(|r| r[0].clone().unwrap()).collect::<Vec<_>>();
        let original_ages = || {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM huxdb_filter_test.t WHERE age > 0").fetch_one(&pool).await.unwrap()
            }
        };

        // Which types sort follows the catalog, through domains and coercions.
        let source = page(DataSpec::default(), 0, 1).await.unwrap().source;
        let comparable: HashMap<_, _> = source.columns.iter().map(|c| (c.name.as_str(), c.comparable)).collect();
        for name in ["id", "grp", "label", "amount", "at", "uid", "mood", "bin", "dom", "arr", "rng", "raw"] {
            assert!(comparable[name], "{name} is comparable");
        }
        for name in ["doc", "x", "pt"] {
            assert!(!comparable[name], "{name} isn't comparable");
        }

        // Typed sorts see the real types, by name and by position: 9 before 10.
        let by_age = page(typed_order("age"), 0, 25).await.unwrap();
        assert_eq!(by_age.rows[0][column("age")].as_deref(), Some("1"));
        assert_eq!(by_age.rows[9][column("age")].as_deref(), Some("10"));
        let by_position = page(typed_order("2 DESC"), 0, 25).await.unwrap();
        assert_eq!(by_position.rows[0][column("age")].as_deref(), Some("25"));
        // And so do header sorts.
        let header = |name: &str, descending| DataSpec { sort: vec![SortKey { column: name.into(), descending }], ..Default::default() };
        assert_eq!(page(header("age", true), 0, 1).await.unwrap().rows[0][column("age")].as_deref(), Some("25"));
        assert_eq!(page(header("amount", false), 16, 1).await.unwrap().rows[0][column("amount")].as_deref(), Some("31.50"));

        // Paging through a non-unique sort neither repeats nor skips rows.
        let mut seen = Vec::new();
        for offset in (0..25).step_by(7) {
            seen.extend(ids(&page(header("grp", false), offset, 7).await.unwrap()));
        }
        assert_eq!(seen.len(), 25);
        assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 25);

        // A keyless partitioned table too: ctid repeats across its partitions.
        let mut seen = Vec::new();
        for offset in (0..100).step_by(30) {
            let spec = header("b", false);
            let rows = fetch_page(&mut session.lease(&pool).await.unwrap(), schema, "parts", &spec, offset, 30).await.unwrap();
            seen.extend(ids(&rows));
        }
        assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 100);

        // Filter by Value on each kind of value, as the grid shows it.
        let row = page(typed_where("id = 7"), 0, 1).await.unwrap().rows[0].clone();
        for name in ["id", "age", "grp", "label", "amount", "at", "uid", "mood"] {
            let i = column(name);
            let value = row[i].as_deref();
            let equal = page(filter(name, FilterOp::Eq, value), 0, 25).await.unwrap();
            assert!(equal.rows.iter().any(|r| r[0].as_deref() == Some("7")), "{name} = {value:?}");
            assert!(equal.rows.iter().all(|r| r[i].as_deref() == value), "{name}");
            let other = page(filter(name, FilterOp::Ne, value), 0, 25).await.unwrap();
            assert!(!other.rows.is_empty() && other.rows.iter().all(|r| r[i].as_deref() != value), "{name}");
        }
        assert_eq!(count(filter("amount", FilterOp::IsNull, None)).await, Ok(Some(5)));
        assert_eq!(count(filter("doc", FilterOp::IsNotNull, None)).await, Ok(Some(25)));

        // The count follows both kinds of filter together.
        let both = DataSpec { where_sql: Some("id <= 10".into()), ..filter("grp", FilterOp::Eq, Some("g1")) };
        assert_eq!(count(both.clone()).await, Ok(Some(4)));
        assert_eq!(page(both, 0, 25).await.unwrap().rows.len(), 4);

        // Typed text can't remove the generated LIMIT or the unique order.
        assert_eq!(page(typed_where("1=1 --"), 0, 10).await.unwrap().rows.len(), 10);
        let commented = page(typed_order("grp --"), 0, 25).await.unwrap();
        assert_eq!(ids(&commented), ids(&page(header("grp", false), 0, 25).await.unwrap()));
        assert_eq!(commented.rows.len(), 25);
        assert!(page(typed_order("grp LIMIT 1 --"), 0, 10).await.is_err());
        assert!(page(typed_where("true) --"), 0, 10).await.is_err());
        assert!(page(typed_where("true) LIMIT 1 --"), 0, 10).await.is_err());
        assert!(page(typed_where("/* open"), 0, 10).await.is_err());

        // One statement only, and no writes.
        let two = "true); DELETE FROM huxdb_filter_test.t; SELECT (true";
        assert!(page(typed_where(two), 0, 10).await.is_err());
        assert!(count(typed_where(two)).await.is_err());
        let write = "huxdb_filter_test.touch()";
        let bypass = "set_config('transaction_read_only', 'off', true) = 'off'";
        let refused = page(typed_where(write), 0, 10).await.unwrap_err();
        assert!(refused.contains("read-only transaction"), "{refused}");
        assert!(count(typed_where(write)).await.unwrap_err().contains("read-only transaction"));
        assert!(page(typed_where(bypass), 0, 10).await.is_err());
        assert!(page(typed_order("huxdb_filter_test.touch()"), 0, 10).await.is_err());
        assert!(page(typed_order("id FOR UPDATE OF t"), 0, 10).await.is_err());
        assert_eq!(original_ages().await, 25);

        // The same inside a transaction, which stays usable and read-write.
        session.begin(&pool).await.unwrap();
        let edit = EditBatch {
            updates: vec![RowUpdate { key: vec!["1".into()], values: vec![cell("grp", Some("first"))] }],
            ..Default::default()
        };
        let apply = |batch: EditBatch| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { apply_edits(&mut session.lease(&pool).await.unwrap(), schema, "t", &batch).await }
        };
        assert_eq!(apply(edit.clone()).await, Ok(1));
        let refused = page(typed_where(write), 0, 10).await.unwrap_err();
        assert!(refused.contains("read-only transaction"), "{refused}");
        assert!(page(typed_where(bypass), 0, 10).await.is_err());
        assert!(page(typed_where(two), 0, 10).await.is_err());
        let held = session.lease(&pool).await;
        let read_only: String = {
            let mut lease = held.unwrap();
            sqlx::query_scalar("SELECT current_setting('transaction_read_only')").fetch_one(lease.conn()).await.unwrap()
        };
        assert_eq!(read_only, "off", "the transaction is read-write again");
        assert_eq!(count(filter("grp", FilterOp::Eq, Some("first"))).await, Ok(Some(1)), "sees its own edit");
        let second = EditBatch {
            updates: vec![RowUpdate { key: vec!["2".into()], values: vec![cell("grp", Some("second"))] }],
            ..Default::default()
        };
        assert_eq!(apply(second).await, Ok(1));
        session.end(true).await.unwrap();
        assert_eq!(count(typed_where("grp IN ('first', 'second')")).await, Ok(Some(2)), "the writes committed");
        assert_eq!(original_ages().await, 25);

        // Counting gives up without an error; Stop cancels a slow page.
        assert_eq!(count(typed_where("pg_sleep(6) IS NOT NULL")).await, Ok(None));
        let slow = tokio::spawn(page(typed_where("pg_sleep(10) IS NOT NULL"), 0, 10));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        session.cancel(&pool).await.unwrap();
        assert_eq!(slow.await.unwrap(), Err(CANCELLED.to_string()));

        sqlx::raw_sql("DROP SCHEMA huxdb_filter_test CASCADE").execute(&pool).await.unwrap();
    }
}
