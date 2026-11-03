//! PostgreSQL side of the table designer: loading a table's design from the
//! catalog, and turning a (loaded, edited) pair of designs into DDL.

use sqlx::PgPool;

use super::model::{
    CheckDesign, ColumnDesign, ForeignKeyAction, ForeignKeyDesign, Identity, IndexColumn, IndexDesign, TableDesign,
    UniqueDesign,
};

fn err(e: sqlx::Error) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// Columns of the columns query: name, type, typmod, not null, default,
/// generated expression, identity, comment.
type ColumnRow = (String, String, i32, bool, Option<String>, Option<String>, String, Option<String>);

/// Loads a table's fields, primary key and comment. Needs PostgreSQL 12+
/// (`attgenerated`).
pub async fn load_table_design(pool: &PgPool, schema: &str, table: &str) -> Result<TableDesign, String> {
    let comment: Option<Option<String>> = sqlx::query_scalar(
        "SELECT obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(err)?;
    let Some(comment) = comment else {
        return Err(format!("Table \"{schema}\".\"{table}\" no longer exists."));
    };

    let rows: Vec<ColumnRow> = sqlx::query_as(
        "SELECT a.attname::text,
                format_type(a.atttypid, NULL),
                a.atttypmod,
                a.attnotnull,
                CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
                CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END,
                a.attidentity::text,
                col_description(c.oid, a.attnum)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let key: Vec<(String, String)> = sqlx::query_as(
        "SELECT con.conname::text, a.attname::text
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
         ORDER BY k.ord",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let columns = rows
        .into_iter()
        .map(|(name, data_type, typmod, not_null, default, generated, identity, comment)| {
            let (length, scale) = decode_typmod(&data_type, typmod);
            let key_order = key.iter().position(|(_, col)| *col == name).map(|i| i as u32 + 1);
            ColumnDesign {
                original_name: Some(name.clone()),
                name,
                data_type,
                length,
                scale,
                not_null,
                default,
                identity: match identity.as_str() {
                    "a" => Some(Identity::Always),
                    "d" => Some(Identity::ByDefault),
                    _ => None,
                },
                generated,
                comment,
                key_order,
            }
        })
        .collect();

    let (foreign_keys, uniques, checks) = load_constraints(pool, schema, table).await?;
    Ok(TableDesign {
        schema: schema.to_string(),
        name: table.to_string(),
        comment,
        primary_key_name: key.first().map(|(name, _)| name.clone()),
        columns,
        indexes: load_indexes(pool, schema, table).await?,
        foreign_keys,
        uniques,
        checks,
    })
}

/// Columns of the constraints query: name, type, columns, referenced schema,
/// table and columns, update and delete actions, check expression, no
/// inherit, comment.
type ConstraintRow = (
    String,
    String,
    Vec<String>,
    Option<String>,
    Option<String>,
    Vec<String>,
    String,
    String,
    Option<String>,
    bool,
    Option<String>,
);

fn foreign_key_action(code: &str) -> ForeignKeyAction {
    match code {
        "r" => ForeignKeyAction::Restrict,
        "c" => ForeignKeyAction::Cascade,
        "n" => ForeignKeyAction::SetNull,
        "d" => ForeignKeyAction::SetDefault,
        _ => ForeignKeyAction::NoAction,
    }
}

/// Foreign key, unique and check constraints. NOT NULL constraints (PG 18
/// stores them here too) belong to the Fields tab, and the primary key is
/// loaded with the columns.
async fn load_constraints(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<(Vec<ForeignKeyDesign>, Vec<UniqueDesign>, Vec<CheckDesign>), String> {
    let rows: Vec<ConstraintRow> = sqlx::query_as(
        "SELECT con.conname::text,
                con.contype::text,
                ARRAY(SELECT a.attname::text
                      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                      ORDER BY k.ord),
                rn.nspname::text,
                rc.relname::text,
                ARRAY(SELECT a.attname::text
                      FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                      ORDER BY k.ord),
                con.confupdtype::text,
                con.confdeltype::text,
                CASE WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid) END,
                con.connoinherit,
                obj_description(con.oid, 'pg_constraint')
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class rc ON rc.oid = con.confrelid
         LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('f', 'u', 'c')
         ORDER BY con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let (mut foreign_keys, mut uniques, mut checks) = (Vec::new(), Vec::new(), Vec::new());
    for (name, kind, columns, ref_schema, ref_table, ref_columns, on_update, on_delete, expression, no_inherit, comment) in
        rows
    {
        let original_name = Some(name.clone());
        match kind.as_str() {
            "f" => foreign_keys.push(ForeignKeyDesign {
                original_name,
                name,
                columns,
                ref_schema: ref_schema.unwrap_or_default(),
                ref_table: ref_table.unwrap_or_default(),
                ref_columns,
                on_update: foreign_key_action(&on_update),
                on_delete: foreign_key_action(&on_delete),
                comment,
            }),
            "u" => uniques.push(UniqueDesign { original_name, name, columns, comment }),
            _ => checks.push(CheckDesign {
                original_name,
                name,
                expression: expression.unwrap_or_default(),
                no_inherit,
                comment,
            }),
        }
    }
    Ok((foreign_keys, uniques, checks))
}

/// Columns of the indexes query: name, method, unique, predicate, comment,
/// keys, descending flags.
type IndexRow = (String, String, bool, Option<String>, Option<String>, Vec<String>, Vec<bool>);

/// Indexes that don't back a primary key, unique or exclusion constraint.
/// Keys are column names, or expression text for expression keys.
async fn load_indexes(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<IndexDesign>, String> {
    let rows: Vec<IndexRow> = sqlx::query_as(
        "SELECT i.relname::text,
                am.amname::text,
                x.indisunique,
                pg_get_expr(x.indpred, x.indrelid),
                obj_description(i.oid, 'pg_class'),
                ARRAY(SELECT CASE WHEN k.attnum = 0 THEN pg_get_indexdef(x.indexrelid, k.ord::int, true)
                                  ELSE a.attname::text END
                      FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                      LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                      WHERE k.ord <= x.indnkeyatts
                      ORDER BY k.ord),
                ARRAY(SELECT (o.opt & 1) = 1
                      FROM unnest(x.indoption::int2[]) WITH ORDINALITY AS o(opt, ord)
                      WHERE o.ord <= x.indnkeyatts
                      ORDER BY o.ord)
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am am ON am.oid = i.relam
         WHERE n.nspname = $1 AND c.relname = $2
           AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                           WHERE con.conindid = x.indexrelid AND con.conrelid = x.indrelid
                             AND con.contype IN ('p', 'u', 'x'))
         ORDER BY i.relname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, method, unique, predicate, comment, keys, descending)| IndexDesign {
            original_name: Some(name.clone()),
            name,
            columns: keys
                .into_iter()
                .zip(descending.into_iter().chain(std::iter::repeat(false)))
                .map(|(column, descending)| IndexColumn { column, descending })
                .collect(),
            method,
            unique,
            predicate,
            comment,
        })
        .collect())
}

/// A table's column names in order, for picking a foreign key's referenced fields.
pub async fn list_columns(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<String>, String> {
    sqlx::query_scalar(
        "SELECT a.attname::text
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)
}

/// Splits a type modifier into the designer's (length, scale), based on the
/// type `format_type(oid, NULL)` names. Arrays carry their element's modifier.
pub fn decode_typmod(data_type: &str, typmod: i32) -> (Option<i32>, Option<i32>) {
    if typmod < 0 {
        return (None, None);
    }
    let base = data_type.trim_end_matches("[]");
    match base {
        "character varying" | "character" => (Some(typmod - 4), None),
        "bit" | "bit varying" => (Some(typmod), None),
        "numeric" => {
            let t = typmod - 4;
            (Some((t >> 16) & 0xffff), Some(t & 0xffff))
        }
        "time without time zone" | "time with time zone" | "timestamp without time zone"
        | "timestamp with time zone" => (Some(typmod), None),
        // Interval fields (YEAR TO MONTH…) live in the high bits; only precision is shown.
        "interval" => match typmod & 0xffff {
            0xffff => (None, None),
            p => (Some(p), None),
        },
        _ => (None, None),
    }
}

/// Runs the statements that turn `original` into `edited` (or create it) in one
/// transaction, then reloads the table. On failure nothing is applied and the
/// error names the statement that failed.
pub async fn save_table_design(
    pool: &PgPool,
    original: Option<&TableDesign>,
    edited: &TableDesign,
) -> Result<TableDesign, String> {
    let statements = generate_table_ddl(original, edited);
    let mut tx = pool.begin().await.map_err(err)?;
    for statement in &statements {
        if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.as_str())).execute(&mut *tx).await {
            // Dropping the transaction rolls it back; say so explicitly anyway.
            let _ = tx.rollback().await;
            return Err(format!("{}\n\nFailed statement:\n{statement}", err(e)));
        }
    }
    tx.commit().await.map_err(err)?;
    // An existing table keeps its name; the designer doesn't rename tables.
    let name = original.map_or(&edited.name, |o| &o.name);
    load_table_design(pool, &edited.schema, name).await
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/// Quotes an identifier, always, so case and special characters survive.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

/// The full type: `numeric(10,2)`, `character varying(50)[]`,
/// `timestamp(3) with time zone`.
pub fn format_column_type(c: &ColumnDesign) -> String {
    let Some(length) = c.length else {
        return c.data_type.clone();
    };
    let modifier = match c.scale {
        Some(scale) => format!("({length},{scale})"),
        None => format!("({length})"),
    };
    let base = c.data_type.trim_end_matches("[]");
    let arrays = &c.data_type[base.len()..];
    for zone in [" with time zone", " without time zone"] {
        if let Some(head) = base.strip_suffix(zone) {
            return format!("{head}{modifier}{zone}{arrays}");
        }
    }
    format!("{base}{modifier}{arrays}")
}

fn identity_sql(identity: Identity) -> &'static str {
    match identity {
        Identity::Always => "ALWAYS",
        Identity::ByDefault => "BY DEFAULT",
    }
}

/// A column definition for CREATE TABLE or ADD COLUMN.
fn column_definition(c: &ColumnDesign) -> String {
    let mut sql = format!("{} {}", quote_ident(&c.name), format_column_type(c));
    if let Some(expr) = &c.generated {
        sql += &format!(" GENERATED ALWAYS AS ({expr}) STORED");
    } else if let Some(identity) = c.identity {
        sql += &format!(" GENERATED {} AS IDENTITY", identity_sql(identity));
    } else if let Some(default) = &c.default {
        sql += &format!(" DEFAULT {default}");
    }
    if c.not_null {
        sql += " NOT NULL";
    }
    sql
}

/// Key columns in key order.
fn key_columns(design: &TableDesign) -> Vec<&ColumnDesign> {
    let mut keyed: Vec<_> = design.columns.iter().filter(|c| c.key_order.is_some()).collect();
    keyed.sort_by_key(|c| c.key_order);
    keyed
}

fn primary_key_clause(design: &TableDesign) -> Option<String> {
    let keyed = key_columns(design);
    if keyed.is_empty() {
        return None;
    }
    let names: Vec<_> = keyed.iter().map(|c| quote_ident(&c.name)).collect();
    let constraint = match &design.primary_key_name {
        Some(name) => format!("CONSTRAINT {} ", quote_ident(name)),
        None => String::new(),
    };
    Some(format!("{constraint}PRIMARY KEY ({})", names.join(", ")))
}

fn comment_sql(target: &str, comment: &Option<String>) -> String {
    let value = comment.as_deref().map_or("NULL".to_string(), quote_literal);
    format!("COMMENT ON {target} IS {value}")
}

// Indexes and table constraints -------------------------------------------

/// Creation order; drops run in reverse. Foreign keys go last so they can
/// reference this table's own new unique constraints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObjectKind {
    Unique,
    Check,
    Index,
    ForeignKey,
}

/// An index or table constraint, rendered so two versions compare as text.
struct TableObject<'a> {
    kind: ObjectKind,
    original_name: Option<&'a str>,
    name: &'a str,
    comment: &'a Option<String>,
    /// `CREATE [UNIQUE] INDEX` for indexes; empty for constraints.
    head: &'static str,
    /// Definition without the name: `ON t USING btree (…)` or `UNIQUE (…)`.
    /// `None` when it uses a column that no longer exists.
    body: Option<String>,
}

/// What a name in a constraint refers to: `None` if it is no column (an index
/// expression), `Some(None)` for a dropped column, else the column's new name.
type ColumnMap<'m> = &'m dyn Fn(&str) -> Option<Option<String>>;

fn column_list(names: &[String], map: ColumnMap) -> Option<String> {
    let quoted: Option<Vec<_>> = names.iter().map(|n| map(n).flatten().map(|n| quote_ident(&n))).collect();
    quoted.map(|q| q.join(", "))
}

fn index_keys(columns: &[IndexColumn], map: ColumnMap) -> Option<String> {
    let keys: Option<Vec<_>> = columns
        .iter()
        .map(|c| {
            let key = match map(&c.column) {
                None => format!("({})", c.column),
                Some(None) => return None,
                Some(Some(name)) => quote_ident(&name),
            };
            Some(if c.descending { format!("{key} DESC") } else { key })
        })
        .collect();
    keys.map(|k| k.join(", "))
}

fn action_sql(action: ForeignKeyAction) -> &'static str {
    match action {
        ForeignKeyAction::NoAction => "NO ACTION",
        ForeignKeyAction::Restrict => "RESTRICT",
        ForeignKeyAction::Cascade => "CASCADE",
        ForeignKeyAction::SetNull => "SET NULL",
        ForeignKeyAction::SetDefault => "SET DEFAULT",
    }
}

fn index_body(x: &IndexDesign, table: &str, map: ColumnMap) -> Option<String> {
    let keys = index_keys(&x.columns, map)?;
    let predicate = x.predicate.as_ref().map(|p| format!(" WHERE ({p})")).unwrap_or_default();
    Some(format!("ON {table} USING {} ({keys}){predicate}", x.method))
}

fn foreign_key_body(x: &ForeignKeyDesign, map: ColumnMap, self_ref: (&str, &str)) -> Option<String> {
    let columns = column_list(&x.columns, map)?;
    // A self-reference points at this table's columns, which may be renamed too.
    let identity = |n: &str| Some(Some(n.to_string()));
    let ref_map: ColumnMap = if (x.ref_schema.as_str(), x.ref_table.as_str()) == self_ref { map } else { &identity };
    let ref_columns = column_list(&x.ref_columns, ref_map)?;
    let mut sql = format!(
        "FOREIGN KEY ({columns}) REFERENCES {} ({ref_columns})",
        qualified(&x.ref_schema, &x.ref_table)
    );
    if x.on_update != ForeignKeyAction::NoAction {
        sql += &format!(" ON UPDATE {}", action_sql(x.on_update));
    }
    if x.on_delete != ForeignKeyAction::NoAction {
        sql += &format!(" ON DELETE {}", action_sql(x.on_delete));
    }
    Some(sql)
}

fn check_body(x: &CheckDesign) -> String {
    let no_inherit = if x.no_inherit { " NO INHERIT" } else { "" };
    format!("CHECK ({}){no_inherit}", x.expression)
}

fn unique_body(x: &UniqueDesign, map: ColumnMap) -> Option<String> {
    Some(format!("UNIQUE ({})", column_list(&x.columns, map)?))
}

/// The design's indexes and constraints in creation order. `table` is the
/// qualified name index bodies use; `map` resolves the design's column names.
fn table_objects<'a>(design: &'a TableDesign, table: &str, map: ColumnMap) -> Vec<TableObject<'a>> {
    let self_ref = (design.schema.as_str(), design.name.as_str());
    let object = |kind, original_name: &'a Option<String>, name: &'a String, comment, head, body| TableObject {
        kind,
        original_name: original_name.as_deref(),
        name: name.as_str(),
        comment,
        head,
        body,
    };
    let mut objects = Vec::new();
    for x in &design.uniques {
        objects.push(object(ObjectKind::Unique, &x.original_name, &x.name, &x.comment, "", unique_body(x, map)));
    }
    for x in &design.checks {
        objects.push(object(ObjectKind::Check, &x.original_name, &x.name, &x.comment, "", Some(check_body(x))));
    }
    for x in &design.indexes {
        let head = if x.unique { "CREATE UNIQUE INDEX" } else { "CREATE INDEX" };
        objects.push(object(ObjectKind::Index, &x.original_name, &x.name, &x.comment, head, index_body(x, table, map)));
    }
    for x in &design.foreign_keys {
        let body = foreign_key_body(x, map, self_ref);
        objects.push(object(ObjectKind::ForeignKey, &x.original_name, &x.name, &x.comment, "", body));
    }
    objects
}

/// `CONSTRAINT "name" ` for a named constraint; empty lets PostgreSQL name it.
fn constraint_prefix(name: &str) -> String {
    if name.is_empty() { String::new() } else { format!("CONSTRAINT {} ", quote_ident(name)) }
}

/// The statement that creates an object (its body must be present) on `table`.
fn create_object(o: &TableObject, table: &str) -> String {
    let body = o.body.as_deref().unwrap_or_default();
    match o.kind {
        ObjectKind::Index => {
            let name = if o.name.is_empty() { String::new() } else { format!("{} ", quote_ident(o.name)) };
            format!("{} {name}{body}", o.head)
        }
        _ => format!("ALTER TABLE {table} ADD {}{body}", constraint_prefix(o.name)),
    }
}

fn object_comment(o: &TableObject, schema: &str, table: &str) -> String {
    let target = match o.kind {
        ObjectKind::Index => format!("INDEX {}", qualified(schema, o.name)),
        _ => format!("CONSTRAINT {} ON {table}", quote_ident(o.name)),
    };
    comment_sql(&target, o.comment)
}

/// The statements that turn `original` into `edited`, one change per statement,
/// in an order PostgreSQL accepts. With no original, the statements create the
/// table. Both designs must be normalized. Renaming the table isn't supported
/// here: an existing table keeps its original name.
pub fn generate_table_ddl(original: Option<&TableDesign>, edited: &TableDesign) -> Vec<String> {
    match original {
        None => create_table(edited),
        Some(original) => alter_table(original, edited),
    }
}

fn create_table(design: &TableDesign) -> Vec<String> {
    let table = qualified(&design.schema, &design.name);
    let map = |n: &str| design.columns.iter().any(|c| c.name == n).then(|| Some(n.to_string()));
    let objects = table_objects(design, &table, &map);

    // Constraints go inside CREATE TABLE; indexes need their own statements.
    let mut lines: Vec<String> = design.columns.iter().map(column_definition).collect();
    lines.extend(primary_key_clause(design));
    for o in objects.iter().filter(|o| o.kind != ObjectKind::Index) {
        lines.push(format!("{}{}", constraint_prefix(o.name), o.body.as_deref().unwrap_or_default()));
    }
    let mut statements = vec![format!("CREATE TABLE {table} (\n  {}\n)", lines.join(",\n  "))];
    for o in objects.iter().filter(|o| o.kind == ObjectKind::Index) {
        statements.push(create_object(o, &table));
    }

    if design.comment.is_some() {
        statements.push(comment_sql(&format!("TABLE {table}"), &design.comment));
    }
    for c in design.columns.iter().filter(|c| c.comment.is_some()) {
        statements.push(comment_sql(&format!("COLUMN {table}.{}", quote_ident(&c.name)), &c.comment));
    }
    for o in objects.iter().filter(|o| o.comment.is_some()) {
        statements.push(object_comment(o, &design.schema, &table));
    }
    statements
}

fn alter_table(original: &TableDesign, edited: &TableDesign) -> Vec<String> {
    let table = qualified(&original.schema, &original.name);
    let alter = |action: String| format!("ALTER TABLE {table} {action}");
    let mut statements = Vec::new();

    let find_original = |name: &str| original.columns.iter().find(|c| c.name == name);
    let kept: Vec<(&ColumnDesign, &ColumnDesign)> = edited
        .columns
        .iter()
        .filter_map(|e| e.original_name.as_deref().and_then(find_original).map(|o| (o, e)))
        .collect();

    // Indexes and constraints as they were, with column names mapped through
    // this edit's renames, and as they are now. An object whose definition
    // didn't change is kept (PostgreSQL follows column renames by itself);
    // any other loaded object is dropped and its edited version created.
    let renamed = |n: &str| -> Option<Option<String>> {
        if !original.columns.iter().any(|c| c.name == n) {
            return None;
        }
        Some(kept.iter().find(|(o, _)| o.name == n).map(|(_, e)| e.name.clone()))
    };
    let current = |n: &str| edited.columns.iter().any(|c| c.name == n).then(|| Some(n.to_string()));
    let old_objects = table_objects(original, &table, &renamed);
    let new_objects = table_objects(edited, &table, &current);
    let successor = |o: &TableObject| new_objects.iter().find(|n| n.kind == o.kind && n.original_name == Some(o.name));
    let unchanged = |o: &TableObject, n: &TableObject| o.body.is_some() && o.head == n.head && o.body == n.body;
    let predecessor = |n: &TableObject| {
        old_objects
            .iter()
            .find(|o| n.kind == o.kind && n.original_name == Some(o.name))
            .filter(|o| unchanged(o, n))
    };

    // 0. Drop indexes and constraints that were removed or changed, before
    //    the columns they use change.
    for o in old_objects.iter().rev() {
        if successor(o).is_some_and(|n| unchanged(o, n)) {
            continue;
        }
        statements.push(match o.kind {
            ObjectKind::Index => format!("DROP INDEX {}", qualified(&original.schema, o.name)),
            _ => alter(format!("DROP CONSTRAINT {}", quote_ident(o.name))),
        });
    }

    // 1. Drop the primary key if its columns changed. Columns are compared by
    //    their original names, so renaming a key column keeps the key.
    let old_key: Vec<Option<&str>> = key_columns(original).iter().map(|c| Some(c.name.as_str())).collect();
    let new_key: Vec<Option<&str>> = key_columns(edited).iter().map(|c| c.original_name.as_deref()).collect();
    let key_changed = old_key != new_key;
    if key_changed && !old_key.is_empty() {
        let name = original.primary_key_name.clone().unwrap_or_else(|| format!("{}_pkey", original.name));
        statements.push(alter(format!("DROP CONSTRAINT {}", quote_ident(&name))));
    }

    // 2. Drop removed columns.
    for o in &original.columns {
        if !kept.iter().any(|(k, _)| k.name == o.name) {
            statements.push(alter(format!("DROP COLUMN {}", quote_ident(&o.name))));
        }
    }

    // 3. Rename columns.
    for (o, e) in &kept {
        if o.name != e.name {
            statements.push(alter(format!("RENAME COLUMN {} TO {}", quote_ident(&o.name), quote_ident(&e.name))));
        }
    }

    // 4. Alter kept columns, by their new names. Identity goes first when
    //    dropped and last when added, so it never coexists with a default.
    for (o, e) in &kept {
        let column = |action: String| alter(format!("ALTER COLUMN {} {action}", quote_ident(&e.name)));
        if o.identity.is_some() && e.identity.is_none() {
            statements.push(column("DROP IDENTITY".into()));
        }
        let (old_type, new_type) = (format_column_type(o), format_column_type(e));
        if old_type != new_type {
            statements.push(column(format!("TYPE {new_type}")));
        }
        if o.default != e.default && e.generated.is_none() {
            statements.push(column(match &e.default {
                Some(default) => format!("SET DEFAULT {default}"),
                None => "DROP DEFAULT".into(),
            }));
        }
        if o.not_null != e.not_null {
            statements.push(column(if e.not_null { "SET NOT NULL" } else { "DROP NOT NULL" }.into()));
        }
        match (o.identity, e.identity) {
            (None, Some(new)) => statements.push(column(format!("ADD GENERATED {} AS IDENTITY", identity_sql(new)))),
            (Some(old), Some(new)) if old != new => {
                statements.push(column(format!("SET GENERATED {}", identity_sql(new))))
            }
            _ => {}
        }
    }

    // 5. Add new columns, in grid order.
    for e in edited.columns.iter().filter(|e| e.original_name.as_deref().and_then(find_original).is_none()) {
        statements.push(alter(format!("ADD COLUMN {}", column_definition(e))));
    }

    // 6. Re-create the primary key.
    if key_changed && let Some(clause) = primary_key_clause(edited) {
        statements.push(alter(format!("ADD {clause}")));
    }

    // 6b. Rename kept indexes and constraints; create new and changed ones.
    for n in &new_objects {
        match predecessor(n) {
            Some(o) if o.name != n.name => statements.push(match n.kind {
                ObjectKind::Index => format!(
                    "ALTER INDEX {} RENAME TO {}",
                    qualified(&original.schema, o.name),
                    quote_ident(n.name)
                ),
                _ => alter(format!("RENAME CONSTRAINT {} TO {}", quote_ident(o.name), quote_ident(n.name))),
            }),
            Some(_) => {}
            None => statements.push(create_object(n, &table)),
        }
    }

    // 7. Comments.
    if original.comment != edited.comment {
        statements.push(comment_sql(&format!("TABLE {table}"), &edited.comment));
    }
    for e in &edited.columns {
        let old = e.original_name.as_deref().and_then(find_original).map(|o| &o.comment);
        if old.map_or(e.comment.is_some(), |old| *old != e.comment) {
            statements.push(comment_sql(&format!("COLUMN {table}.{}", quote_ident(&e.name)), &e.comment));
        }
    }
    for n in &new_objects {
        // A re-created object lost its comment along with the old version.
        let old = predecessor(n).map(|o| o.comment);
        if old.map_or(n.comment.is_some(), |old| old != n.comment) {
            statements.push(object_comment(n, &original.schema, &table));
        }
    }

    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> ColumnDesign {
        ColumnDesign {
            original_name: Some(name.into()),
            name: name.into(),
            data_type: data_type.into(),
            ..Default::default()
        }
    }

    fn new_col(name: &str, data_type: &str) -> ColumnDesign {
        ColumnDesign { original_name: None, ..col(name, data_type) }
    }

    fn table(columns: Vec<ColumnDesign>) -> TableDesign {
        TableDesign { schema: "public".into(), name: "items".into(), columns, ..Default::default() }
    }

    /// An existing table: `id` (identity key), `name` varchar(50), `price` numeric(10,2).
    fn existing() -> TableDesign {
        TableDesign {
            primary_key_name: Some("items_pkey".into()),
            ..table(vec![
                ColumnDesign { not_null: true, identity: Some(Identity::Always), key_order: Some(1), ..col("id", "integer") },
                ColumnDesign { length: Some(50), ..col("name", "character varying") },
                ColumnDesign { length: Some(10), scale: Some(2), default: Some("0".into()), ..col("price", "numeric") },
            ])
        }
    }

    fn diff(edit: impl FnOnce(&mut TableDesign)) -> Vec<String> {
        let original = existing();
        let mut edited = original.clone();
        edit(&mut edited);
        generate_table_ddl(Some(&original), &edited.normalized())
    }

    const T: &str = "ALTER TABLE \"public\".\"items\"";

    #[test]
    fn creates_a_table_with_key_and_comments() {
        let design = TableDesign {
            comment: Some("It's items".into()),
            ..table(vec![
                ColumnDesign { identity: Some(Identity::ByDefault), key_order: Some(1), ..new_col("id", "bigint") },
                ColumnDesign { length: Some(20), default: Some("'x'".into()), comment: Some("label".into()), ..new_col("label", "character varying") },
                ColumnDesign { generated: Some("id * 2".into()), ..new_col("twice", "bigint") },
            ])
        }
        .normalized();
        assert_eq!(
            generate_table_ddl(None, &design),
            [
                "CREATE TABLE \"public\".\"items\" (\n  \"id\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"label\" character varying(20) DEFAULT 'x',\n  \"twice\" bigint GENERATED ALWAYS AS (id * 2) STORED,\n  PRIMARY KEY (\"id\")\n)",
                "COMMENT ON TABLE \"public\".\"items\" IS 'It''s items'",
                "COMMENT ON COLUMN \"public\".\"items\".\"label\" IS 'label'",
            ]
        );
    }

    #[test]
    fn unchanged_design_needs_no_statements() {
        assert!(diff(|_| {}).is_empty());
    }

    #[test]
    fn adds_drops_and_renames_columns_in_order() {
        let statements = diff(|t| {
            t.columns.remove(2);
            t.columns[1].name = "title".into();
            t.columns.push(ColumnDesign { not_null: true, default: Some("now()".into()), ..new_col("created", "timestamp with time zone") });
        });
        assert_eq!(
            statements,
            [
                format!("{T} DROP COLUMN \"price\""),
                format!("{T} RENAME COLUMN \"name\" TO \"title\""),
                format!("{T} ADD COLUMN \"created\" timestamp with time zone DEFAULT now() NOT NULL"),
            ]
        );
    }

    #[test]
    fn alters_type_default_and_nullability() {
        let statements = diff(|t| {
            t.columns[1].length = Some(100);
            t.columns[1].not_null = true;
            t.columns[2].scale = Some(3);
            t.columns[2].default = None;
        });
        assert_eq!(
            statements,
            [
                format!("{T} ALTER COLUMN \"name\" TYPE character varying(100)"),
                format!("{T} ALTER COLUMN \"name\" SET NOT NULL"),
                format!("{T} ALTER COLUMN \"price\" TYPE numeric(10,3)"),
                format!("{T} ALTER COLUMN \"price\" DROP DEFAULT"),
            ]
        );
        assert_eq!(diff(|t| t.columns[1].default = Some("'n/a'".into())), [format!("{T} ALTER COLUMN \"name\" SET DEFAULT 'n/a'")]);
    }

    #[test]
    fn changes_identity() {
        assert_eq!(diff(|t| t.columns[0].identity = Some(Identity::ByDefault)), [format!("{T} ALTER COLUMN \"id\" SET GENERATED BY DEFAULT")]);
        assert_eq!(diff(|t| t.columns[0].identity = None), [format!("{T} ALTER COLUMN \"id\" DROP IDENTITY")]);
        // Default dropped before identity added; NOT NULL set first because identity requires it.
        assert_eq!(
            diff(|t| {
                t.columns[2].default = None;
                t.columns[2].identity = Some(Identity::Always);
            }),
            [
                format!("{T} ALTER COLUMN \"price\" DROP DEFAULT"),
                format!("{T} ALTER COLUMN \"price\" SET NOT NULL"),
                format!("{T} ALTER COLUMN \"price\" ADD GENERATED ALWAYS AS IDENTITY"),
            ]
        );
    }

    #[test]
    fn renaming_a_key_column_keeps_the_key() {
        assert_eq!(diff(|t| t.columns[0].name = "item_id".into()), [format!("{T} RENAME COLUMN \"id\" TO \"item_id\"")]);
    }

    #[test]
    fn changing_the_key_drops_and_recreates_it() {
        let statements = diff(|t| {
            t.columns[1].key_order = Some(2);
            t.columns[0].name = "item_id".into();
        });
        assert_eq!(
            statements,
            [
                format!("{T} DROP CONSTRAINT \"items_pkey\""),
                format!("{T} RENAME COLUMN \"id\" TO \"item_id\""),
                format!("{T} ALTER COLUMN \"name\" SET NOT NULL"),
                format!("{T} ADD CONSTRAINT \"items_pkey\" PRIMARY KEY (\"item_id\", \"name\")"),
            ]
        );
        assert_eq!(diff(|t| t.columns[0].key_order = None), [format!("{T} DROP CONSTRAINT \"items_pkey\"")]);
    }

    #[test]
    fn sets_and_clears_comments() {
        assert_eq!(
            diff(|t| {
                t.comment = Some("All items".into());
                t.columns[1].comment = Some("Display name".into());
            }),
            [
                "COMMENT ON TABLE \"public\".\"items\" IS 'All items'".to_string(),
                "COMMENT ON COLUMN \"public\".\"items\".\"name\" IS 'Display name'".to_string(),
            ]
        );
        let mut original = existing();
        original.columns[1].comment = Some("old".into());
        let mut edited = original.clone();
        edited.columns[1].comment = Some("  ".into());
        assert_eq!(
            generate_table_ddl(Some(&original), &edited.normalized()),
            ["COMMENT ON COLUMN \"public\".\"items\".\"name\" IS NULL"]
        );
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("Order \"Lines\""), "\"Order \"\"Lines\"\"\"");
        let design = TableDesign { schema: "My Schema".into(), name: "T".into(), columns: vec![new_col("ID", "int")], ..Default::default() };
        assert_eq!(generate_table_ddl(None, &design), ["CREATE TABLE \"My Schema\".\"T\" (\n  \"ID\" int\n)"]);
    }

    #[test]
    fn formats_type_modifiers() {
        let typed = |data_type: &str, length, scale| ColumnDesign { data_type: data_type.into(), length, scale, ..Default::default() };
        assert_eq!(format_column_type(&typed("text", None, None)), "text");
        assert_eq!(format_column_type(&typed("numeric", Some(10), Some(2))), "numeric(10,2)");
        assert_eq!(format_column_type(&typed("character varying[]", Some(50), None)), "character varying(50)[]");
        assert_eq!(format_column_type(&typed("timestamp with time zone", Some(3), None)), "timestamp(3) with time zone");
        assert_eq!(format_column_type(&typed("time without time zone[]", Some(0), None)), "time(0) without time zone[]");
    }

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn round_trips_designs_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let sessions = crate::explorer::sessions::SessionManager::default();
        let pool = sessions.pool(&config, "postgres");
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_designer_test CASCADE;
             CREATE SCHEMA huxdb_designer_test;",
        )
        .execute(&pool)
        .await
        .unwrap();
        let schema = "huxdb_designer_test";

        // Create through the designer.
        let created = TableDesign {
            schema: schema.into(),
            name: "Order Lines".into(),
            comment: Some("lines".into()),
            columns: vec![
                ColumnDesign { identity: Some(Identity::Always), key_order: Some(1), ..new_col("id", "integer") },
                ColumnDesign { key_order: Some(2), ..new_col("line", "smallint") },
                ColumnDesign { length: Some(40), default: Some("'none'::character varying".into()), comment: Some("what".into()), ..new_col("label", "character varying") },
                ColumnDesign { length: Some(10), scale: Some(2), ..new_col("price", "numeric") },
                ColumnDesign { length: Some(3), ..new_col("at", "timestamp with time zone") },
                new_col("code", "text"),
            ],
            ..Default::default()
        }
        .normalized();
        let loaded = save_table_design(&pool, None, &created).await.unwrap();
        assert_eq!(loaded.comment.as_deref(), Some("lines"));
        assert_eq!(loaded.primary_key_name.as_deref(), Some("Order Lines_pkey"));
        let summary: Vec<_> = loaded
            .columns
            .iter()
            .map(|c| (c.name.as_str(), format_column_type(c), c.not_null, c.key_order, c.identity))
            .collect();
        assert_eq!(
            summary,
            [
                ("id", "integer".to_string(), true, Some(1), Some(Identity::Always)),
                ("line", "smallint".to_string(), true, Some(2), None),
                ("label", "character varying(40)".to_string(), false, None, None),
                ("price", "numeric(10,2)".to_string(), false, None, None),
                ("at", "timestamp(3) with time zone".to_string(), false, None, None),
                ("code", "text".to_string(), false, None, None),
            ]
        );
        assert_eq!(loaded.columns[2].default.as_deref(), Some("'none'::character varying"));
        assert_eq!(loaded.columns[2].comment.as_deref(), Some("what"));
        assert!(generate_table_ddl(Some(&loaded), &loaded.normalized()).is_empty(), "a loaded design round-trips");

        // Alter: rename a key column, change a type, add a column, shrink the key.
        let mut edited = loaded.clone();
        edited.columns[0].name = "line_id".into();
        edited.columns[1].key_order = None;
        edited.columns[3].length = Some(12);
        edited.columns.push(ColumnDesign { default: Some("true".into()), not_null: true, ..new_col("active", "boolean") });
        let altered = save_table_design(&pool, Some(&loaded), &edited.normalized()).await.unwrap();
        let names: Vec<_> = altered.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["line_id", "line", "label", "price", "at", "code", "active"]);
        assert_eq!(altered.columns[0].key_order, Some(1));
        assert_eq!(altered.columns[1].key_order, None);
        assert_eq!(format_column_type(&altered.columns[3]), "numeric(12,2)");

        // A failing statement rolls the whole save back.
        sqlx::raw_sql("INSERT INTO huxdb_designer_test.\"Order Lines\" (line, code) VALUES (1, 'abc')")
            .execute(&pool)
            .await
            .unwrap();
        let mut bad = altered.clone();
        bad.columns[2].name = "caption".into();
        bad.columns[5].data_type = "integer".into();
        let error = save_table_design(&pool, Some(&altered), &bad.normalized()).await.unwrap_err();
        let after = load_table_design(&pool, schema, "Order Lines").await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_designer_test CASCADE").execute(&pool).await.unwrap();

        assert!(error.contains("Failed statement:\nALTER TABLE \"huxdb_designer_test\".\"Order Lines\" ALTER COLUMN \"code\" TYPE integer"), "{error}");
        assert_eq!(after, altered, "the rename before the failure was rolled back");
    }

    fn index(name: &str, columns: &[&str]) -> IndexDesign {
        IndexDesign {
            original_name: Some(name.into()),
            name: name.into(),
            columns: columns.iter().map(|c| IndexColumn { column: c.to_string(), descending: false }).collect(),
            method: "btree".into(),
            ..Default::default()
        }
    }

    /// `existing()` plus a parent_id self-reference, an index, a unique and a check.
    fn with_objects() -> TableDesign {
        let mut t = existing();
        t.columns.push(col("parent_id", "integer"));
        t.indexes = vec![
            index("items_name_idx", &["name"]),
            IndexDesign { predicate: Some("price > 0".into()), ..index("items_lower_idx", &["lower((name)::text)"]) },
        ];
        t.uniques = vec![UniqueDesign {
            original_name: Some("items_name_key".into()),
            name: "items_name_key".into(),
            columns: vec!["name".into()],
            comment: Some("one per name".into()),
        }];
        t.checks = vec![CheckDesign {
            original_name: Some("items_price_check".into()),
            name: "items_price_check".into(),
            expression: "price >= 0".into(),
            ..Default::default()
        }];
        t.foreign_keys = vec![ForeignKeyDesign {
            original_name: Some("items_parent_fkey".into()),
            name: "items_parent_fkey".into(),
            columns: vec!["parent_id".into()],
            ref_schema: "public".into(),
            ref_table: "items".into(),
            ref_columns: vec!["id".into()],
            on_delete: ForeignKeyAction::Cascade,
            ..Default::default()
        }];
        t
    }

    fn diff_objects(edit: impl FnOnce(&mut TableDesign)) -> Vec<String> {
        let original = with_objects();
        let mut edited = original.clone();
        edit(&mut edited);
        generate_table_ddl(Some(&original), &edited.normalized())
    }

    #[test]
    fn creates_constraints_inline_and_indexes_after() {
        let mut design = with_objects();
        design.primary_key_name = None;
        for c in &mut design.columns {
            c.original_name = None;
        }
        design.indexes.truncate(1);
        design.indexes[0].original_name = None;
        design.indexes[0].columns[0].descending = true;
        design.indexes[0].comment = Some("by name".into());
        design.checks[0].name = "".into();
        let statements = generate_table_ddl(None, &design.normalized());
        assert_eq!(
            statements[0],
            "CREATE TABLE \"public\".\"items\" (\n  \"id\" integer GENERATED ALWAYS AS IDENTITY NOT NULL,\n  \"name\" character varying(50),\n  \"price\" numeric(10,2) DEFAULT 0,\n  \"parent_id\" integer,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"items_name_key\" UNIQUE (\"name\"),\n  CHECK (price >= 0),\n  CONSTRAINT \"items_parent_fkey\" FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"items\" (\"id\") ON DELETE CASCADE\n)"
        );
        assert_eq!(
            statements[1..],
            [
                "CREATE INDEX \"items_name_idx\" ON \"public\".\"items\" USING btree (\"name\" DESC)",
                "COMMENT ON CONSTRAINT \"items_name_key\" ON \"public\".\"items\" IS 'one per name'",
                "COMMENT ON INDEX \"public\".\"items_name_idx\" IS 'by name'",
            ]
        );
    }

    #[test]
    fn renaming_columns_keeps_indexes_and_constraints() {
        assert!(diff_objects(|_| {}).is_empty());
        // The UI rewrites references when a field is renamed.
        let statements = diff_objects(|t| {
            t.columns[0].name = "item_id".into();
            t.columns[1].name = "title".into();
            t.indexes[0].columns[0].column = "title".into();
            t.uniques[0].columns[0] = "title".into();
            t.foreign_keys[0].ref_columns[0] = "item_id".into();
        });
        assert_eq!(
            statements,
            [format!("{T} RENAME COLUMN \"id\" TO \"item_id\""), format!("{T} RENAME COLUMN \"name\" TO \"title\"")]
        );
    }

    #[test]
    fn changed_objects_are_dropped_first_and_recreated_last() {
        let statements = diff_objects(|t| {
            t.indexes[0].columns[0].descending = true;
            t.checks[0].expression = "price > 0".into();
            t.foreign_keys[0].on_delete = ForeignKeyAction::SetNull;
            t.columns[2].default = None;
        });
        assert_eq!(
            statements,
            [
                format!("{T} DROP CONSTRAINT \"items_parent_fkey\""),
                "DROP INDEX \"public\".\"items_name_idx\"".to_string(),
                format!("{T} DROP CONSTRAINT \"items_price_check\""),
                format!("{T} ALTER COLUMN \"price\" DROP DEFAULT"),
                format!("{T} ADD CONSTRAINT \"items_price_check\" CHECK (price > 0)"),
                "CREATE INDEX \"items_name_idx\" ON \"public\".\"items\" USING btree (\"name\" DESC)".to_string(),
                format!("{T} ADD CONSTRAINT \"items_parent_fkey\" FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"items\" (\"id\") ON DELETE SET NULL"),
            ]
        );
    }

    #[test]
    fn renames_objects_and_restores_comments_on_recreated_ones() {
        assert_eq!(
            diff_objects(|t| {
                t.indexes[1].name = "items_lower_name_idx".into();
                t.checks[0].name = "price_not_negative".into();
            }),
            [
                format!("{T} RENAME CONSTRAINT \"items_price_check\" TO \"price_not_negative\""),
                "ALTER INDEX \"public\".\"items_lower_idx\" RENAME TO \"items_lower_name_idx\"".to_string(),
            ]
        );
        assert_eq!(
            diff_objects(|t| t.uniques[0].columns.push("price".into())),
            [
                format!("{T} DROP CONSTRAINT \"items_name_key\""),
                format!("{T} ADD CONSTRAINT \"items_name_key\" UNIQUE (\"name\", \"price\")"),
                "COMMENT ON CONSTRAINT \"items_name_key\" ON \"public\".\"items\" IS 'one per name'".to_string(),
            ]
        );
    }

    #[test]
    fn dropping_a_column_drops_its_objects_first() {
        // The UI removes a deleted field from the objects that use it.
        let statements = diff_objects(|t| {
            t.columns.remove(1);
            t.uniques.clear();
            t.indexes.remove(0);
        });
        assert_eq!(
            statements,
            [
                "DROP INDEX \"public\".\"items_name_idx\"".to_string(),
                format!("{T} DROP CONSTRAINT \"items_name_key\""),
                format!("{T} DROP COLUMN \"name\""),
            ]
        );
    }

    #[test]
    fn adds_new_objects_after_columns() {
        let statements = diff_objects(|t| {
            t.columns.push(new_col("sku", "text"));
            t.uniques.push(UniqueDesign { name: "".into(), columns: vec!["sku".into()], ..Default::default() });
            t.indexes.push(IndexDesign {
                original_name: None,
                unique: true,
                method: "".into(),
                ..index("items_sku_idx", &["sku"])
            });
        });
        assert_eq!(
            statements,
            [
                format!("{T} ADD COLUMN \"sku\" text"),
                format!("{T} ADD UNIQUE (\"sku\")"),
                "CREATE UNIQUE INDEX \"items_sku_idx\" ON \"public\".\"items\" USING btree (\"sku\")".to_string(),
            ]
        );
    }

    #[test]
    fn validation_checks_constraints() {
        let ok = with_objects().normalized();
        assert_eq!(ok.validate(), Ok(()));
        type Edit = Box<dyn Fn(&mut TableDesign)>;
        let cases: Vec<Edit> = vec![
            Box::new(|t| t.uniques[0].columns = vec!["nope".into()]),
            Box::new(|t| t.uniques[0].columns.clear()),
            Box::new(|t| t.foreign_keys[0].ref_columns.clear()),
            Box::new(|t| t.foreign_keys[0].ref_table = "".into()),
            Box::new(|t| t.checks[0].expression = " ".into()),
            Box::new(|t| t.indexes[0].columns.clear()),
            Box::new(|t| t.indexes[0].name = "items_name_key".into()),
            Box::new(|t| t.checks[0].name = "".into()),
            Box::new(|t| {
                t.indexes.push(IndexDesign { original_name: None, name: "".into(), comment: Some("c".into()), ..index("", &["name"]) })
            }),
        ];
        for (i, edit) in cases.iter().enumerate() {
            let mut t = ok.clone();
            edit(&mut t);
            assert!(t.normalized().validate().is_err(), "case {i}");
        }
    }

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn round_trips_constraints_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let sessions = crate::explorer::sessions::SessionManager::default();
        let pool = sessions.pool(&config, "postgres");
        let schema = "huxdb_constraints_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_constraints_test CASCADE;
             CREATE SCHEMA huxdb_constraints_test;
             CREATE TABLE huxdb_constraints_test.groups (id int PRIMARY KEY, code text UNIQUE);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let created = TableDesign {
            schema: schema.into(),
            name: "items".into(),
            columns: vec![
                ColumnDesign { key_order: Some(1), ..new_col("id", "integer") },
                new_col("name", "text"),
                ColumnDesign { length: Some(10), scale: Some(2), ..new_col("price", "numeric") },
                new_col("group_id", "integer"),
                new_col("parent_id", "integer"),
            ],
            indexes: vec![
                IndexDesign {
                    name: "items_name_idx".into(),
                    columns: vec![
                        IndexColumn { column: "name".into(), descending: true },
                        IndexColumn { column: "lower(name)".into(), descending: false },
                    ],
                    predicate: Some("price > 0".into()),
                    comment: Some("lookups".into()),
                    ..Default::default()
                },
                IndexDesign {
                    name: "items_price_brin".into(),
                    method: "BRIN".into(),
                    columns: vec![IndexColumn { column: "price".into(), descending: false }],
                    ..Default::default()
                },
            ],
            uniques: vec![UniqueDesign { name: "items_name_key".into(), columns: vec!["name".into(), "group_id".into()], ..Default::default() }],
            checks: vec![CheckDesign { name: "items_price_check".into(), expression: "price >= 0".into(), no_inherit: true, comment: Some("no refunds".into()), ..Default::default() }],
            foreign_keys: vec![
                ForeignKeyDesign {
                    name: "items_group_fkey".into(),
                    columns: vec!["group_id".into()],
                    ref_schema: schema.into(),
                    ref_table: "groups".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: ForeignKeyAction::SetNull,
                    on_update: ForeignKeyAction::Cascade,
                    ..Default::default()
                },
                ForeignKeyDesign {
                    name: "items_parent_fkey".into(),
                    columns: vec!["parent_id".into()],
                    ref_schema: schema.into(),
                    ref_table: "items".into(),
                    ref_columns: vec!["id".into()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
        .normalized();
        let loaded = save_table_design(&pool, None, &created).await.unwrap();

        // The primary key's and unique constraint's indexes stay off the Indexes tab.
        let indexes: Vec<_> = loaded.indexes.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(indexes, ["items_name_idx", "items_price_brin"]);
        let x = &loaded.indexes[0];
        assert_eq!(x.method, "btree");
        assert_eq!(x.columns, [IndexColumn { column: "name".into(), descending: true }, IndexColumn { column: "lower(name)".into(), descending: false }]);
        assert_eq!(x.predicate.as_deref(), Some("(price > (0)::numeric)"));
        assert_eq!(x.comment.as_deref(), Some("lookups"));
        assert_eq!(loaded.indexes[1].method, "brin");
        assert_eq!(loaded.uniques[0].columns, ["name", "group_id"]);
        let check = &loaded.checks[0];
        assert!(check.no_inherit);
        assert_eq!(check.comment.as_deref(), Some("no refunds"));
        let fk = &loaded.foreign_keys[0];
        assert_eq!((fk.ref_table.as_str(), fk.ref_columns.as_slice()), ("groups", ["id".to_string()].as_slice()));
        assert_eq!((fk.on_update, fk.on_delete), (ForeignKeyAction::Cascade, ForeignKeyAction::SetNull));
        assert_eq!(loaded.foreign_keys[1].ref_table, "items");
        assert!(generate_table_ddl(Some(&loaded), &loaded.normalized()).is_empty(), "a loaded design round-trips");

        // Rename columns that indexes and constraints use (the UI rewrites the
        // references), rename an index, and change a check.
        let mut edited = loaded.clone();
        edited.columns[0].name = "item_id".into();
        edited.columns[1].name = "title".into();
        edited.indexes[0].columns[0].column = "title".into();
        edited.indexes[1].name = "items_price_idx".into();
        edited.uniques[0].columns[0] = "title".into();
        edited.foreign_keys[1].ref_columns[0] = "item_id".into();
        edited.checks[0].expression = "price > 0".into();
        let statements = generate_table_ddl(Some(&loaded), &edited.normalized());
        assert_eq!(statements.len(), 6, "{statements:#?}");
        let altered = save_table_design(&pool, Some(&loaded), &edited.normalized()).await.unwrap();
        let check_def: String = sqlx::query_scalar(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'items_price_check'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let groups_fk_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_constraint WHERE conrelid = 'huxdb_constraints_test.items'::regclass AND contype = 'f'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_constraints_test CASCADE").execute(&pool).await.unwrap();

        assert_eq!(altered.indexes[0].columns[0].column, "title");
        assert_eq!(altered.indexes[1].name, "items_price_idx");
        assert_eq!(altered.uniques[0].columns, ["title", "group_id"]);
        assert_eq!(altered.foreign_keys[1].ref_columns, ["item_id"]);
        assert_eq!(altered.checks[0].comment.as_deref(), Some("no refunds"), "comment restored after re-create");
        assert_eq!(check_def, "CHECK ((price > (0)::numeric)) NO INHERIT");
        assert_eq!(groups_fk_rows, 2);
        assert!(generate_table_ddl(Some(&altered), &altered.normalized()).is_empty());
    }

    #[test]
    fn decodes_type_modifiers() {
        assert_eq!(decode_typmod("character varying", 54), (Some(50), None));
        assert_eq!(decode_typmod("character[]", 14), (Some(10), None));
        assert_eq!(decode_typmod("numeric", (10 << 16 | 2) + 4), (Some(10), Some(2)));
        assert_eq!(decode_typmod("timestamp with time zone", 3), (Some(3), None));
        assert_eq!(decode_typmod("bit", 8), (Some(8), None));
        assert_eq!(decode_typmod("interval", 0x7fff_0000 | 6), (Some(6), None));
        assert_eq!(decode_typmod("integer", -1), (None, None));
        assert_eq!(decode_typmod("numeric", -1), (None, None));
    }
}
