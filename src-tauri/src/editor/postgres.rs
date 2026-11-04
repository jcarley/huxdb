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

/// Filtered pages give up after this long. Unfiltered ones have no limit, so
/// Last works on a large table.
const PAGE_TIMEOUT: &str = if cfg!(test) { "2s" } else { "60s" };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Columns of the columns query: name, type, nullable, has default, read-only
/// reason, comparable, type without its modifier, text-like.
type ColumnRow = (String, String, bool, bool, Option<String>, bool, String, bool);

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
                                      AND c.castmethod = 'b' AND c.castcontext = 'i'))),
                -- The base type, as a domain's modifier would cut a value and its
                -- CHECK would reject one. -1, not NULL: with NULL, char(3) comes
                -- back as `character`, which means char(1).
                format_type(b.oid, -1),
                b.typcategory = 'S'
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
        .map(|(name, type_name, nullable, has_default, read_only, comparable, filter_type, text_like)| DataColumn {
            name,
            type_name,
            nullable,
            has_default,
            read_only,
            comparable,
            filter_type,
            text_like,
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

/// The filter without its disabled nodes and the groups they leave empty, so
/// that a group of disabled conditions isn't `FALSE`. `None` if nothing is left.
fn prune(node: &FilterNode) -> Option<FilterNode> {
    match node {
        FilterNode::Group { disabled: true, .. } | FilterNode::Condition { disabled: true, .. } | FilterNode::Custom { disabled: true, .. } => None,
        FilterNode::Group { op, children, negated, disabled } => {
            let children: Vec<_> = children.iter().filter_map(prune).collect();
            (!children.is_empty()).then_some(FilterNode::Group { op: *op, children, negated: *negated, disabled: *disabled })
        }
        other => Some(other.clone()),
    }
}

/// Whether the spec narrows the rows at all.
fn filtered(spec: &DataSpec) -> bool {
    spec.filter.as_ref().and_then(prune).is_some() || typed(&spec.where_sql).is_some()
}

/// A LIKE pattern matching `value` literally, with `%` on the given sides.
fn like_pattern(value: &str, before: bool, after: bool) -> String {
    let mut pattern = String::with_capacity(value.len() + 2);
    if before {
        pattern.push('%');
    }
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    if after {
        pattern.push('%');
    }
    pattern
}

fn parenthesized(negated: bool, sql: String) -> String {
    if negated { format!("NOT ({sql})") } else { format!("({sql})") }
}

/// A pruned filter as SQL, every value bound.
fn filter_sql(node: &FilterNode, source: &DataSource, binds: &mut Vec<Option<String>>) -> Result<String, String> {
    match node {
        FilterNode::Group { op, children, negated, .. } => {
            let joiner = match op {
                GroupOp::And => " AND ",
                GroupOp::Or => " OR ",
            };
            let terms = children.iter().map(|c| filter_sql(c, source, binds)).collect::<Result<Vec<_>, _>>()?;
            Ok(parenthesized(*negated, terms.join(joiner)))
        }
        FilterNode::Condition { column, op, value, values, negated, .. } => {
            let sql = condition_sql(column, *op, value.as_deref(), values, source, binds)?;
            Ok(if *negated { parenthesized(true, sql) } else { sql })
        }
        FilterNode::Custom { sql, negated, .. } => {
            let text = typed(&Some(sql.clone())).ok_or("A custom filter condition is empty.")?;
            Ok(parenthesized(*negated, text))
        }
    }
}

fn condition_sql(
    column: &str,
    op: FilterOp,
    value: Option<&str>,
    values: &[String],
    source: &DataSource,
    binds: &mut Vec<Option<String>>,
) -> Result<String, String> {
    let name = quote_ident(&find_column(source, column)?.name);
    let required = || value.ok_or_else(|| format!("The filter on column \"{column}\" has no value."));
    let (operator, before, after) = match op {
        FilterOp::IsNull => return Ok(format!("{name} IS NULL")),
        FilterOp::IsNotNull => return Ok(format!("{name} IS NOT NULL")),
        FilterOp::IsEmpty => {
            let c = find_column(source, column)?;
            if !c.text_like {
                return Err(format!("Column \"{column}\" has type {}, which isn't text, so it can't be empty.", c.type_name));
            }
            return Ok(format!("{name} = ''"));
        }
        FilterOp::Contains => ("ILIKE", true, true),
        FilterOp::BeginsWith => ("ILIKE", false, true),
        FilterOp::EndsWith => ("ILIKE", true, false),
        FilterOp::Between => {
            let c = comparable_column(source, column)?;
            let [low, high] = values else {
                return Err(format!("The filter on column \"{column}\" needs two values."));
            };
            if low.is_empty() || high.is_empty() {
                return Err(format!("The filter on column \"{column}\" needs two values."));
            }
            let low = placeholder(binds, Some(low.clone()), &c.filter_type);
            let high = placeholder(binds, Some(high.clone()), &c.filter_type);
            return Ok(format!("{name} BETWEEN {low} AND {high}"));
        }
        FilterOp::In => {
            let c = comparable_column(source, column)?;
            // The UI's list has a line per item, so blank lines mean nothing.
            let items: Vec<_> = values.iter().filter(|v| !v.is_empty()).map(|v| placeholder(binds, Some(v.clone()), &c.filter_type)).collect();
            if items.is_empty() {
                return Err(format!("The filter on column \"{column}\" has no values."));
            }
            return Ok(format!("{name} IN ({})", items.join(", ")));
        }
        FilterOp::Eq | FilterOp::Ne | FilterOp::Lt | FilterOp::Le | FilterOp::Gt | FilterOp::Ge => {
            let operator = match op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Lt => "<",
                FilterOp::Le => "<=",
                FilterOp::Gt => ">",
                _ => ">=",
            };
            let c = comparable_column(source, column)?;
            let value = required()?.to_string();
            return Ok(format!("{name} {operator} {}", placeholder(binds, Some(value), &c.filter_type)));
        }
    };
    // Text matching compares what the grid shows, whatever the column's type.
    let pattern = like_pattern(required()?, before, after);
    Ok(format!("{name}::text {operator} {}", placeholder(binds, Some(pattern), "text")))
}

/// The spec's ` WHERE …`, or nothing. Parentheses keep the typed part one
/// condition next to the structured filter.
fn where_clause(source: &DataSource, spec: &DataSpec, binds: &mut Vec<Option<String>>) -> Result<String, String> {
    let mut terms = Vec::new();
    if let Some(filter) = spec.filter.as_ref().and_then(prune) {
        terms.push(filter_sql(&filter, source, binds)?);
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
    let limited = filtered(spec);
    if limited {
        set_timeout(conn, PAGE_TIMEOUT).await?;
    }
    // Not persistent: nearly every page and filter is a different statement.
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).persistent(false);
    for value in binds {
        query = query.bind(value);
    }
    let fetched = query.fetch_all(&mut *conn).await.map_err(|e| {
        if limited && is_timeout(&e) {
            format!("The filter took longer than {PAGE_TIMEOUT}, so it was stopped. A narrower filter, or one on an indexed column, may be faster.")
        } else {
            err(e)
        }
    })?;
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
    set_timeout(conn, COUNT_TIMEOUT).await?;
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

/// Limits the rest of the scope's statements; the scope's rollback ends it.
async fn set_timeout(conn: &mut PgConnection, timeout: &str) -> Result<(), String> {
    let sql = format!("SET LOCAL statement_timeout = '{timeout}'");
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(conn).await.map(drop).map_err(err)
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
        DataColumn {
            name: name.into(),
            type_name: type_name.into(),
            nullable: true,
            has_default: false,
            read_only: None,
            comparable: true,
            filter_type: type_name.split('(').next().unwrap().into(),
            text_like: false,
        }
    }

    fn source() -> DataSource {
        DataSource {
            columns: vec![
                col("id", "integer"),
                DataColumn { text_like: true, ..col("Name", "character varying(20)") },
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
        FilterNode::Condition { column: column.into(), op, value: value.map(String::from), values: vec![], negated: false, disabled: false }
    }

    fn list(column: &str, op: FilterOp, values: &[&str]) -> FilterNode {
        FilterNode::Condition { column: column.into(), op, value: None, values: values.iter().map(|v| v.to_string()).collect(), negated: false, disabled: false }
    }

    fn group(op: GroupOp, children: Vec<FilterNode>) -> FilterNode {
        FilterNode::Group { op, children, negated: false, disabled: false }
    }

    fn custom(sql: &str) -> FilterNode {
        FilterNode::Custom { sql: sql.into(), negated: false, disabled: false }
    }

    fn set_flags(node: FilterNode, negate: bool, disable: bool) -> FilterNode {
        match node {
            FilterNode::Group { op, children, .. } => FilterNode::Group { op, children, negated: negate, disabled: disable },
            FilterNode::Condition { column, op, value, values, .. } => FilterNode::Condition { column, op, value, values, negated: negate, disabled: disable },
            FilterNode::Custom { sql, .. } => FilterNode::Custom { sql, negated: negate, disabled: disable },
        }
    }

    fn negated(node: FilterNode) -> FilterNode {
        set_flags(node, true, false)
    }

    fn disabled(node: FilterNode) -> FilterNode {
        set_flags(node, false, true)
    }

    /// The spec's WHERE clause for one filter, and its binds.
    fn where_of(node: FilterNode) -> (String, Vec<Option<String>>) {
        let spec = DataSpec { filter: Some(node), ..Default::default() };
        let mut binds = Vec::new();
        let sql = where_clause(&source(), &spec, &mut binds).unwrap();
        (sql, binds)
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
                negated: false,
                disabled: false,
                children: vec![
                    condition("id", FilterOp::Eq, Some("1")),
                    group(GroupOp::Or, vec![condition("Name", FilterOp::Ne, Some("x'y")), condition("Name", FilterOp::IsNull, None)]),
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
            "FROM \"s\".\"t\" WHERE (\"id\" = $1::integer AND (\"Name\" <> $2::character varying OR \"Name\" IS NULL) AND \"total\" IS NOT NULL) \
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
        let empty = |op| DataSpec { filter: Some(group(op, vec![])), ..Default::default() };
        assert_eq!(inner_sql(&empty(GroupOp::And)), inner_sql(&DataSpec::default()));
        assert_eq!(inner_sql(&empty(GroupOp::Or)), inner_sql(&DataSpec::default()));
    }

    #[test]
    fn every_operator_makes_its_condition() {
        let cases = [
            (condition("id", FilterOp::Lt, Some("5")), r#""id" < $1::integer"#, vec!["5"]),
            (condition("id", FilterOp::Le, Some("5")), r#""id" <= $1::integer"#, vec!["5"]),
            (condition("id", FilterOp::Gt, Some("5")), r#""id" > $1::integer"#, vec!["5"]),
            (condition("id", FilterOp::Ge, Some("5")), r#""id" >= $1::integer"#, vec!["5"]),
            (condition("id", FilterOp::Contains, Some("5")), r#""id"::text ILIKE $1::text"#, vec!["%5%"]),
            (condition("Name", FilterOp::BeginsWith, Some("a")), r#""Name"::text ILIKE $1::text"#, vec!["a%"]),
            (condition("Name", FilterOp::EndsWith, Some("a")), r#""Name"::text ILIKE $1::text"#, vec!["%a"]),
            (condition("Name", FilterOp::IsEmpty, None), r#""Name" = ''"#, vec![]),
            (list("id", FilterOp::Between, &["1", "9"]), r#""id" BETWEEN $1::integer AND $2::integer"#, vec!["1", "9"]),
            (list("id", FilterOp::In, &["1", "2", "3"]), r#""id" IN ($1::integer, $2::integer, $3::integer)"#, vec!["1", "2", "3"]),
        ];
        for (node, expected, binds) in cases {
            let (sql, bound) = where_of(node);
            assert_eq!(sql, format!(" WHERE {expected}"));
            assert_eq!(bound, binds.iter().map(|b| Some(b.to_string())).collect::<Vec<_>>());
        }
    }

    #[test]
    fn filter_values_are_cast_without_the_type_modifier() {
        // `$1::character varying(20)` would silently cut a longer value.
        assert_eq!(where_of(condition("Name", FilterOp::Eq, Some("x"))).0, r#" WHERE "Name" = $1::character varying"#);
    }

    #[test]
    fn like_patterns_escape_their_wildcards() {
        let pattern = |op, value| where_of(condition("Name", op, Some(value))).1[0].clone().unwrap();
        assert_eq!(pattern(FilterOp::Contains, r"50%_c\d"), r"%50\%\_c\\d%");
        assert_eq!(pattern(FilterOp::BeginsWith, "%"), r"\%%");
        assert_eq!(pattern(FilterOp::EndsWith, "_"), r"%\_");
    }

    #[test]
    fn negation_and_nesting() {
        let (sql, binds) = where_of(group(
            GroupOp::Or,
            vec![
                negated(condition("id", FilterOp::Contains, Some("1"))),
                negated(group(GroupOp::And, vec![condition("id", FilterOp::Eq, Some("2")), negated(custom("id > 3"))])),
            ],
        ));
        assert_eq!(
            sql,
            " WHERE (NOT (\"id\"::text ILIKE $1::text) OR NOT (\"id\" = $2::integer AND NOT (\nid > 3\n)))"
        );
        assert_eq!(binds, [Some("%1%".to_string()), Some("2".to_string())]);
    }

    #[test]
    fn custom_conditions_are_kept_apart_like_typed_text() {
        assert_eq!(where_of(group(GroupOp::And, vec![custom(" a = 1 -- x ")])).0, " WHERE ((\na = 1 -- x\n))");
    }

    #[test]
    fn disabled_nodes_bind_nothing_and_empty_groups_vanish() {
        // The bind after a disabled condition is still $1.
        let (sql, binds) = where_of(group(
            GroupOp::And,
            vec![disabled(condition("id", FilterOp::Eq, Some("1"))), condition("id", FilterOp::Eq, Some("2"))],
        ));
        assert_eq!(sql, r#" WHERE ("id" = $1::integer)"#);
        assert_eq!(binds, [Some("2".to_string())]);

        // All off under OR is no filter, not FALSE, at any depth.
        let off = group(
            GroupOp::Or,
            vec![disabled(condition("id", FilterOp::Eq, Some("1"))), group(GroupOp::And, vec![disabled(custom("nonsense"))])],
        );
        assert_eq!(where_of(off.clone()), (String::new(), vec![]));
        assert!(!filtered(&DataSpec { filter: Some(off), ..Default::default() }));

        // An incomplete disabled condition is never looked at.
        assert_eq!(where_of(group(GroupOp::And, vec![disabled(condition("nope", FilterOp::Eq, None))])).0, "");
    }

    #[test]
    fn only_a_real_filter_counts_as_filtered() {
        assert!(!filtered(&DataSpec::default()));
        assert!(!filtered(&DataSpec { where_sql: Some("  ".into()), sort: vec![SortKey { column: "id".into(), descending: false }], ..Default::default() }));
        assert!(filtered(&DataSpec { where_sql: Some("a".into()), ..Default::default() }));
        assert!(filtered(&DataSpec { filter: Some(condition("id", FilterOp::IsNull, None)), ..Default::default() }));
    }

    #[test]
    fn reads_the_filter_the_frontend_sends() {
        // The client's `id` is ignored, and the flags are optional.
        let node: FilterNode = serde_json::from_str(
            r#"{"kind": "group", "id": "n1", "op": "or", "children": [
                {"kind": "condition", "id": "n2", "column": "a", "op": "begins-with", "value": "x", "values": [], "negated": true, "disabled": false},
                {"kind": "condition", "column": "a", "op": "in", "value": null, "values": ["1"]},
                {"kind": "custom", "id": "n3", "sql": "true", "negated": false, "disabled": true}
            ]}"#,
        )
        .unwrap();
        let FilterNode::Group { op: GroupOp::Or, children, negated: false, disabled: false } = node else { panic!() };
        assert!(matches!(&children[0], FilterNode::Condition { op: FilterOp::BeginsWith, negated: true, .. }));
        assert!(matches!(&children[1], FilterNode::Condition { op: FilterOp::In, negated: false, .. }));
        assert!(matches!(&children[2], FilterNode::Custom { disabled: true, .. }));
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
        assert!(reject(filter(condition("doc", FilterOp::Gt, Some("1")))).contains("can't be compared"));
        assert!(reject(filter(list("doc", FilterOp::In, &["1"]))).contains("can't be compared"));
        assert!(reject(filter(list("doc", FilterOp::Between, &["1", "2"]))).contains("can't be compared"));
        assert!(reject(filter(condition("id", FilterOp::IsEmpty, None))).contains("isn't text"));
        assert!(reject(filter(list("id", FilterOp::Between, &["1"]))).contains("two values"));
        assert!(reject(filter(list("id", FilterOp::Between, &["1", ""]))).contains("two values"));
        assert!(reject(filter(list("id", FilterOp::In, &[]))).contains("no values"));
        assert!(reject(filter(list("id", FilterOp::In, &["", ""]))).contains("no values"));
        assert!(reject(filter(condition("id", FilterOp::Contains, None))).contains("no value"));
        assert!(reject(filter(custom("  "))).contains("empty"));
        // A null check works on any type.
        assert!(select_page_sql("s", "t", &source, &filter(condition("doc", FilterOp::IsNull, None)), 0, 10).is_ok());
        // And text matching works on the text the grid shows.
        assert!(select_page_sql("s", "t", &source, &filter(condition("doc", FilterOp::Contains, Some("a"))), 0, 10).is_ok());
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

        let count_where = |text: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM huxdb_filter_test.t WHERE {text}")))
                    .fetch_one(&pool)
                    .await
                    .unwrap()
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

        // The builder's operators, on the values the server really holds.
        let spec_of = |node: FilterNode| DataSpec { filter: Some(node), ..Default::default() };
        let matches = |node: FilterNode| count(spec_of(node));
        assert_eq!(matches(condition("age", FilterOp::Contains, Some("5"))).await, Ok(Some(3)), "5, 15, 25");
        assert_eq!(matches(condition("mood", FilterOp::Contains, Some("APP"))).await, Ok(Some(count_where("mood = 'happy'").await)), "any case, on an enum");
        assert_eq!(matches(condition("doc", FilterOp::Contains, Some("{"))).await, Ok(Some(25)), "on json, which can't be compared");
        assert_eq!(matches(condition("grp", FilterOp::BeginsWith, Some("g"))).await, Ok(Some(23)), "two were edited above");
        assert_eq!(matches(condition("label", FilterOp::EndsWith, Some("5"))).await, Ok(Some(3)));
        assert_eq!(matches(condition("age", FilterOp::Gt, Some("20"))).await, Ok(Some(5)));
        assert_eq!(matches(condition("age", FilterOp::Le, Some("20"))).await, Ok(Some(20)));
        assert_eq!(matches(list("age", FilterOp::Between, &["3", "5"])).await, Ok(Some(3)));
        assert_eq!(matches(list("age", FilterOp::In, &["1", "", "2", "99"])).await, Ok(Some(2)));
        assert_eq!(matches(negated(list("age", FilterOp::In, &["1", "2"]))).await, Ok(Some(23)));
        assert_eq!(matches(custom("age % 2 = 0")).await, Ok(Some(12)));
        assert!(matches(condition("age", FilterOp::Gt, Some("abc"))).await.unwrap_err().contains("invalid input syntax"));
        // (age <= 2 OR (age > 20 AND NOT age = 25))
        let nested = group(
            GroupOp::Or,
            vec![
                condition("age", FilterOp::Le, Some("2")),
                group(GroupOp::And, vec![condition("age", FilterOp::Gt, Some("20")), negated(condition("age", FilterOp::Eq, Some("25")))]),
            ],
        );
        assert_eq!(matches(nested.clone()).await, Ok(Some(6)));
        assert_eq!(page(spec_of(nested), 0, 25).await.unwrap().rows.len(), 6);
        // NOT keeps NULL rows out, like <>: 20 of the 25 have an amount.
        assert_eq!(matches(negated(condition("amount", FilterOp::Gt, Some("0")))).await, Ok(Some(0)));
        // Custom text is as guarded as the typed WHERE.
        assert!(matches(custom(write)).await.unwrap_err().contains("read-only transaction"));
        assert_eq!(page(spec_of(group(GroupOp::And, vec![custom("true --")])), 0, 10).await.unwrap().rows.len(), 10);
        assert_eq!(original_ages().await, 25);

        // LIKE's wildcards in a value are literal, and each type's value keeps
        // its precision: a cast to the column's own type would round or cut it.
        let values = "
             CREATE TABLE huxdb_filter_test.vals (
               id int PRIMARY KEY, txt text, n numeric(10,2), v varchar(3), c char(3), b bit(3),
               ts timestamp(0), d huxdb_filter_test.dv, e text, p huxdb_filter_test.pos);
             INSERT INTO huxdb_filter_test.vals VALUES
               (1, '50% off', 1.01, 'abc', 'abc', B'101', '2024-01-01 00:00:01', '', '', 1),
               (2, '50 off', 2.00, 'abd', 'x', B'111', '2024-01-01 00:00:02', 'abcde', 'y', 2),
               (3, 'a_b', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
               (4, 'axb', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
               (5, 'c\\d', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);";
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DOMAIN huxdb_filter_test.dv AS varchar(5); CREATE DOMAIN huxdb_filter_test.pos AS int CHECK (VALUE > 0); {values}"))).execute(&pool).await.unwrap();
        let vals = |node: FilterNode| {
            let (session, pool) = (session.clone(), pool.clone());
            async move { count_rows(&mut session.lease(&pool).await.unwrap(), schema, "vals", &DataSpec { filter: Some(node), ..Default::default() }).await }
        };
        assert_eq!(vals(condition("txt", FilterOp::Contains, Some("0%"))).await, Ok(Some(1)));
        assert_eq!(vals(condition("txt", FilterOp::Contains, Some("a_b"))).await, Ok(Some(1)));
        assert_eq!(vals(condition("txt", FilterOp::Contains, Some("c\\d"))).await, Ok(Some(1)));
        assert_eq!(vals(condition("n", FilterOp::Gt, Some("1.005"))).await, Ok(Some(2)), "1.005 isn't rounded up to 1.01");
        assert_eq!(vals(condition("n", FilterOp::Eq, Some("1.005"))).await, Ok(Some(0)));
        assert_eq!(vals(condition("v", FilterOp::Eq, Some("abcd"))).await, Ok(Some(0)), "abcd isn't cut to abc");
        assert_eq!(vals(condition("c", FilterOp::Eq, Some("abcd"))).await, Ok(Some(0)));
        assert_eq!(vals(condition("c", FilterOp::Eq, Some("abc"))).await, Ok(Some(1)), "a char(3) isn't cut to one character");
        assert_eq!(vals(condition("c", FilterOp::Eq, Some("x"))).await, Ok(Some(1)), "padding doesn't count");
        assert_eq!(vals(condition("b", FilterOp::Eq, Some("101"))).await, Ok(Some(1)), "a bit(3) isn't cut to one bit");
        assert_eq!(vals(condition("ts", FilterOp::Gt, Some("2024-01-01 00:00:01.4"))).await, Ok(Some(1)), "fractions aren't rounded away");
        assert_eq!(vals(condition("d", FilterOp::Eq, Some("abcdefg"))).await, Ok(Some(0)), "a domain's modifier doesn't cut it either");
        assert_eq!(vals(condition("p", FilterOp::Gt, Some("-1"))).await, Ok(Some(2)), "a domain's CHECK is about stored values");
        assert_eq!(vals(condition("e", FilterOp::IsEmpty, None)).await, Ok(Some(1)));
        assert_eq!(vals(condition("d", FilterOp::IsEmpty, None)).await, Ok(Some(1)), "a text domain can be empty");
        assert!(vals(condition("n", FilterOp::IsEmpty, None)).await.unwrap_err().contains("isn't text"));

        // A slow filter times out inside a transaction, which stays usable,
        // with its timeout back as it was. An unfiltered page has no limit.
        session.begin(&pool).await.unwrap();
        assert_eq!(apply(EditBatch { deletes: vec![vec!["25".into()]], ..Default::default() }).await, Ok(1));
        let slow = page(typed_where("pg_sleep(1) IS NOT NULL"), 0, 25).await.unwrap_err();
        assert!(slow.contains("took longer than"), "{slow}");
        assert_eq!(count(filter("id", FilterOp::Eq, Some("25"))).await, Ok(Some(0)), "still sees its own delete");
        let setting: String = {
            let mut lease = session.lease(&pool).await.unwrap();
            sqlx::query_scalar("SELECT current_setting('statement_timeout')").fetch_one(lease.conn()).await.unwrap()
        };
        assert_eq!(setting, "0");
        session.end(false).await.unwrap();
        assert_eq!(count(DataSpec::default()).await, Ok(Some(25)));

        // A server-side timeout on an unfiltered page isn't called the filter's.
        session.begin(&pool).await.unwrap();
        {
            let mut lease = session.lease(&pool).await.unwrap();
            sqlx::raw_sql("SET LOCAL statement_timeout = '100ms'").execute(lease.conn()).await.unwrap();
        }
        let slow = page(typed_order("pg_sleep(0.5)::text"), 0, 25).await.unwrap_err();
        assert!(slow.contains("statement timeout") && !slow.contains("filter"), "{slow}");
        session.end(false).await.unwrap();

        // Counting gives up without an error; Stop cancels a slow page.
        assert_eq!(count(typed_where("pg_sleep(6) IS NOT NULL")).await, Ok(None));
        let slow = tokio::spawn(page(typed_where("pg_sleep(10) IS NOT NULL"), 0, 10));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        session.cancel(&pool).await.unwrap();
        assert_eq!(slow.await.unwrap(), Err(CANCELLED.to_string()));

        sqlx::raw_sql("DROP SCHEMA huxdb_filter_test CASCADE").execute(&pool).await.unwrap();
    }
}
