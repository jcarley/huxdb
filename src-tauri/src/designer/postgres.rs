//! PostgreSQL side of the table designer: loading a table's design from the
//! catalog, and turning a (loaded, edited) pair of designs into DDL.

use sqlx::PgPool;

use super::model::{ColumnDesign, Identity, TableDesign};

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

    Ok(TableDesign {
        schema: schema.to_string(),
        name: table.to_string(),
        comment,
        primary_key_name: key.first().map(|(name, _)| name.clone()),
        columns,
    })
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
    let mut lines: Vec<String> = design.columns.iter().map(column_definition).collect();
    lines.extend(primary_key_clause(design));
    let mut statements = vec![format!("CREATE TABLE {table} (\n  {}\n)", lines.join(",\n  "))];
    if design.comment.is_some() {
        statements.push(comment_sql(&format!("TABLE {table}"), &design.comment));
    }
    for c in design.columns.iter().filter(|c| c.comment.is_some()) {
        statements.push(comment_sql(&format!("COLUMN {table}.{}", quote_ident(&c.name)), &c.comment));
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
