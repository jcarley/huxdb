//! PostgreSQL side of the table designer: loading a table's design from the
//! catalog, and turning a (loaded, edited) pair of designs into DDL.

use sqlx::PgPool;

use super::model::{
    CheckDesign, ColumnDesign, ExcludeDesign, ExcludeElement, ForeignKeyAction, ForeignKeyDesign, Identity,
    IndexColumn, IndexDesign, PartitionStrategy, QualifiedName, TableDesign, TableOptions, TriggerDesign,
    RuleDesign, RuleEvent, TriggerEnabled, TriggerTiming, UniqueDesign,
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
        excludes: load_excludes(pool, schema, table).await?,
        triggers: load_triggers(pool, schema, table).await?,
        options: load_options(pool, schema, table).await?,
        rules: load_rules(pool, schema, table).await?,
    })
}

/// Skips one possibly schema-qualified identifier at the start of `text`,
/// stepping over quoted parts (where `""` is a quote), and returns the rest.
fn skip_identifier(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut i = 0;
    loop {
        if bytes.get(i) == Some(&b'"') {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    if bytes.get(i + 1) == Some(&b'"') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1; // closing quote
        } else {
            while i < bytes.len() && !matches!(bytes[i], b'.' | b' ' | b'\n') {
                i += 1;
            }
        }
        if bytes.get(i) == Some(&b'.') {
            i += 1;
        } else {
            return &text[i.min(text.len())..];
        }
    }
}

/// Splits a (non-pretty) `pg_get_ruledef` result into (condition, actions),
/// e.g. `CREATE RULE r AS ON DELETE TO t WHERE (old.locked) DO INSTEAD NOTHING;`
/// gives `(Some("old.locked"), "NOTHING")`. The text is used as is, so string
/// literals in the actions keep their spacing. `None` if it isn't understood.
fn parse_rule(definition: &str) -> Option<(Option<String>, String)> {
    let rest = skip_identifier(definition.strip_prefix("CREATE RULE ")?);
    let rest = rest.strip_prefix(" AS")?.trim_start().strip_prefix("ON ")?;
    let rest = &rest[rest.find(" TO ")? + " TO ".len()..];
    let rest = skip_identifier(rest).trim_start();
    let (condition, rest) = match rest.strip_prefix("WHERE ") {
        Some(after) => {
            let end = after.find(" DO ")?;
            let condition = after[..end].trim();
            let inner = condition.strip_prefix('(').and_then(|c| c.strip_suffix(')')).unwrap_or(condition);
            (Some(inner.to_string()), after[end..].trim_start())
        }
        None => (None, rest),
    };
    let actions = rest.strip_prefix("DO")?.trim_start();
    let actions = actions.strip_prefix("INSTEAD").map(str::trim_start).unwrap_or(actions);
    let actions = actions.trim_end().trim_end_matches(';').trim_end();
    (!actions.is_empty()).then(|| (condition, actions.to_string()))
}

/// Columns of the rules query: name, event code, instead, definition, comment.
type RuleRow = (String, String, bool, String, Option<String>);

/// Table rules (a view's `_RETURN` rule doesn't apply to tables).
async fn load_rules(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<RuleDesign>, String> {
    let rows: Vec<RuleRow> = sqlx::query_as(
        "SELECT r.rulename::text, r.ev_type::text, r.is_instead, pg_get_ruledef(r.oid),
                obj_description(r.oid, 'pg_rewrite')
         FROM pg_rewrite r
         JOIN pg_class c ON c.oid = r.ev_class
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND r.rulename <> '_RETURN'
         ORDER BY r.rulename",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, event, instead, definition, comment)| {
            let event = match event.as_str() {
                "2" => Some(RuleEvent::Update),
                "3" => Some(RuleEvent::Insert),
                "4" => Some(RuleEvent::Delete),
                _ => None, // ON SELECT
            };
            // Anything unexpected stays read-only rather than being rebuilt wrongly.
            let (condition, actions, definition) = match (event, parse_rule(&definition)) {
                (Some(_), Some((condition, actions))) => (condition, actions, None),
                _ => (None, String::new(), Some(definition.trim_end_matches(';').to_string())),
            };
            RuleDesign {
                original_name: Some(name.clone()),
                name,
                event: event.unwrap_or_default(),
                instead,
                condition,
                actions,
                comment,
                definition,
            }
        })
        .collect())
}

/// Columns of the excludes query: name, method, keys, operators, predicate, comment.
type ExcludeRow = (String, String, Vec<String>, Vec<String>, Option<String>, Option<String>);

/// Exclusion constraints. Element expressions show as 0 in `conkey`, so keys
/// come from the backing index, like `load_indexes`' keys.
async fn load_excludes(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<ExcludeDesign>, String> {
    let rows: Vec<ExcludeRow> = sqlx::query_as(
        "SELECT con.conname::text,
                am.amname::text,
                ARRAY(SELECT CASE WHEN k.attnum = 0 THEN pg_get_indexdef(x.indexrelid, k.ord::int, true)
                                  ELSE a.attname::text END
                      FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                      LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                      ORDER BY k.ord),
                ARRAY(SELECT o.oprname::text
                      FROM unnest(con.conexclop) WITH ORDINALITY AS e(op, ord)
                      JOIN pg_operator o ON o.oid = e.op
                      ORDER BY e.ord),
                pg_get_expr(x.indpred, x.indrelid),
                obj_description(con.oid, 'pg_constraint')
         FROM pg_constraint con
         JOIN pg_index x ON x.indexrelid = con.conindid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'x'
         ORDER BY con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, method, keys, operators, predicate, comment)| ExcludeDesign {
            original_name: Some(name.clone()),
            name,
            method,
            elements: keys
                .into_iter()
                .zip(operators)
                .map(|(column, operator)| ExcludeElement { column, operator })
                .collect(),
            predicate,
            comment,
        })
        .collect())
}

/// Columns of the triggers query: name, type bits, enabled, function schema
/// and name, arguments, UPDATE OF columns, definition, read-only, comment.
type TriggerRow = (String, i32, String, String, String, Vec<u8>, Vec<String>, String, bool, Option<String>);

/// `pg_trigger.tgtype` bits (src/include/catalog/pg_trigger.h).
const TRIGGER_ROW: i32 = 1;
const TRIGGER_BEFORE: i32 = 2;
const TRIGGER_INSERT: i32 = 4;
const TRIGGER_DELETE: i32 = 8;
const TRIGGER_UPDATE: i32 = 16;
const TRIGGER_TRUNCATE: i32 = 32;

/// The WHEN condition of a `pg_get_triggerdef` result, without its outer
/// parentheses. (`tgqual` can't be deparsed with `pg_get_expr`.)
fn trigger_when(definition: &str) -> Option<String> {
    let end = definition.rfind(" EXECUTE FUNCTION ")?;
    let start = definition[..end].find(" FOR EACH ")?;
    let when = definition[start..end].find(" WHEN ")? + start + " WHEN ".len();
    let condition = definition[when..end].trim();
    let inner = condition.strip_prefix('(').and_then(|c| c.strip_suffix(')')).unwrap_or(condition);
    Some(inner.to_string())
}

/// `tgargs` (each argument NUL-terminated) as a list of SQL literals.
fn trigger_arguments(raw: &[u8]) -> String {
    let mut args: Vec<_> = raw.split(|&b| b == 0).map(|a| quote_literal(&String::from_utf8_lossy(a))).collect();
    args.pop(); // the empty piece after the final NUL
    args.join(", ")
}

/// User triggers; PostgreSQL's internal foreign key triggers are skipped.
/// Constraint triggers and triggers with transition tables are read-only.
async fn load_triggers(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<TriggerDesign>, String> {
    let rows: Vec<TriggerRow> = sqlx::query_as(
        "SELECT t.tgname::text,
                t.tgtype::int4,
                t.tgenabled::text,
                pn.nspname::text,
                p.proname::text,
                t.tgargs,
                ARRAY(SELECT a.attname::text
                      FROM unnest(t.tgattr::int2[]) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum
                      ORDER BY k.ord),
                pg_get_triggerdef(t.oid, true),
                t.tgconstraint <> 0 OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL,
                obj_description(t.oid, 'pg_trigger')
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
         ORDER BY t.tgname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, bits, enabled, function_schema, function_name, args, update_columns, definition, read_only, comment)| {
            let has = |bit: i32| bits & bit != 0;
            TriggerDesign {
                original_name: Some(name.clone()),
                name,
                timing: if has(TRIGGER_BEFORE) { TriggerTiming::Before } else { TriggerTiming::After },
                for_each_row: has(TRIGGER_ROW),
                on_insert: has(TRIGGER_INSERT),
                on_update: has(TRIGGER_UPDATE),
                on_delete: has(TRIGGER_DELETE),
                on_truncate: has(TRIGGER_TRUNCATE),
                update_columns,
                when: trigger_when(&definition),
                function_schema,
                function_name,
                arguments: trigger_arguments(&args),
                enabled: match enabled.as_str() {
                    "D" => TriggerEnabled::Disabled,
                    "R" => TriggerEnabled::Replica,
                    "A" => TriggerEnabled::Always,
                    _ => TriggerEnabled::Origin,
                },
                comment,
                definition: read_only.then_some(definition),
            }
        })
        .collect())
}

/// Columns of the options query: owner, tablespace, unlogged, fill factor,
/// partition key, partition parent and bounds.
type OptionsRow = (String, Option<String>, bool, Option<String>, Option<String>, Option<String>);

async fn load_options(pool: &PgPool, schema: &str, table: &str) -> Result<TableOptions, String> {
    let (owner, tablespace, unlogged, fill_factor, partition_key, partition_of): OptionsRow = sqlx::query_as(
        "SELECT pg_get_userbyid(c.relowner)::text,
                ts.spcname::text,
                c.relpersistence = 'u',
                (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'fillfactor'),
                CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
                CASE WHEN c.relispartition THEN
                  (SELECT format('%I.%I ', pn.nspname, pc.relname)
                   FROM pg_inherits i
                   JOIN pg_class pc ON pc.oid = i.inhparent
                   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                   WHERE i.inhrelid = c.oid) || pg_get_expr(c.relpartbound, c.oid)
                END
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_one(pool)
    .await
    .map_err(err)?;

    // A partition's parent is its partitioned table, not an inheritance parent.
    let inherits: Vec<(String, String)> = sqlx::query_as(
        "SELECT pn.nspname::text, pc.relname::text
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class pc ON pc.oid = i.inhparent
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT c.relispartition
         ORDER BY i.inhseqno",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(TableOptions {
        owner: Some(owner),
        tablespace,
        unlogged,
        fill_factor: fill_factor.and_then(|f| f.parse().ok()),
        inherits: inherits.into_iter().map(|(schema, name)| QualifiedName { schema, name }).collect(),
        partition_by: None,
        partition_key,
        partition_of,
    })
}

/// Role names for the Owner option, without PostgreSQL's predefined `pg_*` roles.
pub async fn list_roles(pool: &PgPool) -> Result<Vec<String>, String> {
    sqlx::query_scalar("SELECT rolname::text FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1")
        .fetch_all(pool)
        .await
        .map_err(err)
}

pub async fn list_tablespaces(pool: &PgPool) -> Result<Vec<String>, String> {
    sqlx::query_scalar("SELECT spcname::text FROM pg_tablespace ORDER BY 1")
        .fetch_all(pool)
        .await
        .map_err(err)
}

/// Functions returning `trigger`, as `(schema, name)`, outside the system schemas.
pub async fn list_trigger_functions(pool: &PgPool) -> Result<Vec<QualifiedName>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT n.nspname::text, p.proname::text
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prorettype = 'trigger'::regtype
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    Ok(rows.into_iter().map(|(schema, name)| QualifiedName { schema, name }).collect())
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
    Exclude,
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
        .map(|c| key_sql(&c.column, map).map(|key| if c.descending { format!("{key} DESC") } else { key }))
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

/// A key of an index, exclusion constraint or partition key: a quoted column,
/// or a parenthesized expression. `None` if it is a dropped column.
fn key_sql(key: &str, map: ColumnMap) -> Option<String> {
    match map(key) {
        None => Some(format!("({key})")),
        Some(None) => None,
        Some(Some(name)) => Some(quote_ident(&name)),
    }
}

fn exclude_body(x: &ExcludeDesign, map: ColumnMap) -> Option<String> {
    let elements: Option<Vec<_>> = x
        .elements
        .iter()
        .map(|ExcludeElement { column, operator }| Some(format!("{} WITH {operator}", key_sql(column, map)?)))
        .collect();
    let predicate = x.predicate.as_ref().map(|p| format!(" WHERE ({p})")).unwrap_or_default();
    Some(format!("EXCLUDE USING {} ({}){predicate}", x.method, elements?.join(", ")))
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
    for x in &design.excludes {
        objects.push(object(ObjectKind::Exclude, &x.original_name, &x.name, &x.comment, "", exclude_body(x, map)));
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

// Triggers ------------------------------------------------------------------

/// Everything after `CREATE TRIGGER "name"`, or `None` if it uses a dropped
/// column. A read-only trigger's definition stands for itself.
fn trigger_body(t: &TriggerDesign, table: &str, map: ColumnMap) -> Option<String> {
    if let Some(definition) = &t.definition {
        return Some(definition.clone());
    }
    let mut events = Vec::new();
    if t.on_insert {
        events.push("INSERT".to_string());
    }
    if t.on_update {
        events.push(match t.update_columns.as_slice() {
            [] => "UPDATE".to_string(),
            columns => format!("UPDATE OF {}", column_list(columns, map)?),
        });
    }
    if t.on_delete {
        events.push("DELETE".to_string());
    }
    if t.on_truncate {
        events.push("TRUNCATE".to_string());
    }
    let timing = match t.timing {
        TriggerTiming::Before => "BEFORE",
        TriggerTiming::After => "AFTER",
    };
    let level = if t.for_each_row { "ROW" } else { "STATEMENT" };
    let when = t.when.as_ref().map(|w| format!(" WHEN ({w})")).unwrap_or_default();
    Some(format!(
        "{timing} {} ON {table} FOR EACH {level}{when} EXECUTE FUNCTION {}({})",
        events.join(" OR "),
        qualified(&t.function_schema, &t.function_name),
        t.arguments
    ))
}

/// `ALTER TABLE … ENABLE/DISABLE … TRIGGER` to put a trigger in `state`.
fn trigger_enabled_sql(table: &str, name: &str, state: TriggerEnabled) -> String {
    let action = match state {
        TriggerEnabled::Origin => "ENABLE",
        TriggerEnabled::Disabled => "DISABLE",
        TriggerEnabled::Replica => "ENABLE REPLICA",
        TriggerEnabled::Always => "ENABLE ALWAYS",
    };
    format!("ALTER TABLE {table} {action} TRIGGER {}", quote_ident(name))
}

fn trigger_comment(table: &str, t: &TriggerDesign) -> String {
    comment_sql(&format!("TRIGGER {} ON {table}", quote_ident(&t.name)), &t.comment)
}

/// CREATE TRIGGER plus the enabled state and comment a fresh trigger lacks.
fn create_trigger(t: &TriggerDesign, body: &str, table: &str) -> Vec<String> {
    let mut statements = vec![format!("CREATE TRIGGER {} {body}", quote_ident(&t.name))];
    if t.enabled != TriggerEnabled::Origin {
        statements.push(trigger_enabled_sql(table, &t.name, t.enabled));
    }
    if t.comment.is_some() {
        statements.push(trigger_comment(table, t));
    }
    statements
}

// Rules -----------------------------------------------------------------------

/// Everything after `CREATE RULE "name"`. An unparsed rule's definition stands for itself.
fn rule_body(r: &RuleDesign, table: &str) -> String {
    if let Some(definition) = &r.definition {
        return definition.clone();
    }
    let event = match r.event {
        RuleEvent::Insert => "INSERT",
        RuleEvent::Update => "UPDATE",
        RuleEvent::Delete => "DELETE",
    };
    let condition = r.condition.as_ref().map(|c| format!(" WHERE ({c})")).unwrap_or_default();
    let mode = if r.instead { "INSTEAD" } else { "ALSO" };
    format!("AS ON {event} TO {table}{condition} DO {mode} {}", r.actions)
}

fn rule_comment(table: &str, r: &RuleDesign) -> String {
    comment_sql(&format!("RULE {} ON {table}", quote_ident(&r.name)), &r.comment)
}

/// CREATE RULE plus the comment a fresh rule lacks.
fn create_rule(r: &RuleDesign, table: &str) -> Vec<String> {
    let mut statements = vec![format!("CREATE RULE {} {}", quote_ident(&r.name), rule_body(r, table))];
    if r.comment.is_some() {
        statements.push(rule_comment(table, r));
    }
    statements
}

// Table options ---------------------------------------------------------------

/// Put before statements that rewrite the table, so SQL Preview warns about them.
const REWRITE_WARNING: &str = "-- Rewrites the whole table and locks it while it runs.\n";

fn qualified_name(q: &QualifiedName) -> String {
    qualified(&q.schema, &q.name)
}

/// The clauses after CREATE TABLE's column list: INHERITS, PARTITION BY, WITH, TABLESPACE.
fn create_table_suffix(o: &TableOptions, map: ColumnMap) -> String {
    let mut sql = String::new();
    if !o.inherits.is_empty() {
        let parents: Vec<_> = o.inherits.iter().map(qualified_name).collect();
        sql += &format!(" INHERITS ({})", parents.join(", "));
    }
    if let Some(p) = &o.partition_by {
        let strategy = match p.strategy {
            PartitionStrategy::Range => "RANGE",
            PartitionStrategy::List => "LIST",
            PartitionStrategy::Hash => "HASH",
        };
        let keys: Vec<_> = p.keys.iter().filter_map(|k| key_sql(k, map)).collect();
        sql += &format!(" PARTITION BY {strategy} ({})", keys.join(", "));
    }
    if let Some(f) = o.fill_factor {
        sql += &format!(" WITH (fillfactor = {f})");
    }
    if let Some(ts) = &o.tablespace {
        sql += &format!(" TABLESPACE {}", quote_ident(ts));
    }
    sql
}

/// Option changes that go after the column and constraint changes.
fn alter_options(table: &str, old: &TableOptions, new: &TableOptions) -> Vec<String> {
    let alter = |action: String| format!("ALTER TABLE {table} {action}");
    let mut statements = Vec::new();
    if old.fill_factor != new.fill_factor {
        statements.push(alter(match new.fill_factor {
            Some(f) => format!("SET (fillfactor = {f})"),
            None => "RESET (fillfactor)".into(),
        }));
    }
    if old.unlogged != new.unlogged {
        let to = if new.unlogged { "UNLOGGED" } else { "LOGGED" };
        statements.push(format!("{REWRITE_WARNING}{}", alter(format!("SET {to}"))));
    }
    if old.tablespace != new.tablespace {
        // Back to the default: pg_default is the default tablespace unless the
        // database was created with another one.
        let ts = new.tablespace.as_deref().map_or("pg_default".to_string(), quote_ident);
        statements.push(format!("{REWRITE_WARNING}{}", alter(format!("SET TABLESPACE {ts}"))));
    }
    if let Some(owner) = &new.owner
        && old.owner.as_ref() != Some(owner)
    {
        statements.push(alter(format!("OWNER TO {}", quote_ident(owner))));
    }
    statements
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
    let options = &design.options;
    let unlogged = if options.unlogged { "UNLOGGED " } else { "" };
    let suffix = create_table_suffix(options, &map);
    let mut statements = vec![format!("CREATE {unlogged}TABLE {table} (\n  {}\n){suffix}", lines.join(",\n  "))];
    if let Some(owner) = &options.owner {
        statements.push(format!("ALTER TABLE {table} OWNER TO {}", quote_ident(owner)));
    }
    for o in objects.iter().filter(|o| o.kind == ObjectKind::Index) {
        statements.push(create_object(o, &table));
    }
    for t in &design.triggers {
        if let Some(body) = trigger_body(t, &table, &map) {
            statements.extend(create_trigger(t, &body, &table));
        }
    }
    for r in &design.rules {
        statements.extend(create_rule(r, &table));
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

    // Triggers likewise: kept when their definition is unchanged.
    let old_triggers: Vec<_> = original.triggers.iter().map(|t| (t, trigger_body(t, &table, &renamed))).collect();
    let trigger_predecessor = |t: &TriggerDesign| {
        let body = trigger_body(t, &table, &current);
        old_triggers
            .iter()
            .find(|(o, old_body)| t.original_name.as_deref() == Some(o.name.as_str()) && old_body.is_some() && *old_body == body)
            .map(|(o, _)| *o)
    };
    let kept_trigger = |o: &TriggerDesign| edited.triggers.iter().any(|t| trigger_predecessor(t).is_some_and(|p| p.name == o.name));

    // Rules likewise. Column renames don't change a loaded rule's text (the
    // server rewrites the stored rule), so an untouched rule is kept.
    let rule_predecessor = |r: &RuleDesign| {
        original
            .rules
            .iter()
            .find(|o| r.original_name.as_deref() == Some(o.name.as_str()) && rule_body(o, &table) == rule_body(r, &table))
    };
    let kept_rule = |o: &RuleDesign| edited.rules.iter().any(|r| rule_predecessor(r).is_some_and(|p| p.name == o.name));

    // 0. Drop rules, triggers, indexes and constraints that were removed or
    //    changed, before the columns they use change, and detach removed
    //    parents so their inherited columns can be dropped.
    for o in original.rules.iter().filter(|o| !kept_rule(o)) {
        statements.push(format!("DROP RULE {} ON {table}", quote_ident(&o.name)));
    }
    for (o, _) in &old_triggers {
        if !kept_trigger(o) {
            statements.push(format!("DROP TRIGGER {} ON {table}", quote_ident(&o.name)));
        }
    }
    for parent in original.options.inherits.iter().filter(|p| !edited.options.inherits.contains(p)) {
        statements.push(alter(format!("NO INHERIT {}", qualified_name(parent))));
    }
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

    // 5b. Attach new parents, now that the columns they need exist.
    for parent in edited.options.inherits.iter().filter(|p| !original.options.inherits.contains(p)) {
        statements.push(alter(format!("INHERIT {}", qualified_name(parent))));
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

    // 6c. Triggers last: rename and re-enable kept ones, create the rest.
    for t in &edited.triggers {
        match trigger_predecessor(t) {
            Some(o) => {
                if o.name != t.name {
                    statements.push(format!(
                        "ALTER TRIGGER {} ON {table} RENAME TO {}",
                        quote_ident(&o.name),
                        quote_ident(&t.name)
                    ));
                }
                if o.enabled != t.enabled {
                    statements.push(trigger_enabled_sql(&table, &t.name, t.enabled));
                }
                if o.comment != t.comment {
                    statements.push(trigger_comment(&table, t));
                }
            }
            None => {
                if let Some(body) = trigger_body(t, &table, &current) {
                    statements.extend(create_trigger(t, &body, &table));
                }
            }
        }
    }

    // 6d. Rules after everything they could refer to.
    for r in &edited.rules {
        match rule_predecessor(r) {
            Some(o) => {
                if o.name != r.name {
                    statements.push(format!(
                        "ALTER RULE {} ON {table} RENAME TO {}",
                        quote_ident(&o.name),
                        quote_ident(&r.name)
                    ));
                }
                if o.comment != r.comment {
                    statements.push(rule_comment(&table, r));
                }
            }
            None => statements.extend(create_rule(r, &table)),
        }
    }

    // 6e. Storage and ownership options.
    statements.extend(alter_options(&table, &original.options, &edited.options));

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
    use crate::designer::model::PartitionDesign;

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

    fn trigger(name: &str) -> TriggerDesign {
        TriggerDesign {
            original_name: Some(name.into()),
            name: name.into(),
            timing: TriggerTiming::Before,
            for_each_row: true,
            on_update: true,
            update_columns: vec!["price".into()],
            when: Some("old.price IS DISTINCT FROM new.price".into()),
            function_schema: "public".into(),
            function_name: "audit".into(),
            arguments: "'items', 42".into(),
            ..Default::default()
        }
    }

    /// `with_objects()` plus an exclude, a trigger and storage options.
    fn with_phase3() -> TableDesign {
        let mut t = with_objects();
        t.excludes = vec![ExcludeDesign {
            original_name: Some("items_no_overlap".into()),
            name: "items_no_overlap".into(),
            method: "gist".into(),
            elements: vec![
                ExcludeElement { column: "name".into(), operator: "=".into() },
                ExcludeElement { column: "int4range(id, parent_id)".into(), operator: "&&".into() },
            ],
            ..Default::default()
        }];
        t.triggers = vec![trigger("items_audit")];
        t.options = TableOptions {
            owner: Some("app".into()),
            fill_factor: Some(90),
            inherits: vec![QualifiedName { schema: "public".into(), name: "base".into() }],
            ..Default::default()
        };
        t
    }

    fn diff_phase3(edit: impl FnOnce(&mut TableDesign)) -> Vec<String> {
        let original = with_phase3();
        let mut edited = original.clone();
        edit(&mut edited);
        generate_table_ddl(Some(&original), &edited.normalized())
    }

    const AUDIT: &str = "CREATE TRIGGER \"items_audit\" BEFORE UPDATE OF \"price\" ON \"public\".\"items\" FOR EACH ROW WHEN (old.price IS DISTINCT FROM new.price) EXECUTE FUNCTION \"public\".\"audit\"('items', 42)";

    #[test]
    fn creates_excludes_triggers_and_options() {
        let mut design = with_phase3();
        design.primary_key_name = None;
        design.uniques.clear();
        design.checks.clear();
        design.foreign_keys.clear();
        design.indexes.clear();
        design.options = TableOptions {
            owner: Some("app".into()),
            unlogged: true,
            fill_factor: Some(70),
            tablespace: Some("fast".into()),
            partition_by: Some(PartitionDesign { strategy: PartitionStrategy::Range, keys: vec!["price".into(), "lower(name)".into()] }),
            ..Default::default()
        };
        design.triggers[0].enabled = TriggerEnabled::Disabled;
        design.triggers[0].comment = Some("audit prices".into());
        let statements = generate_table_ddl(None, &design.normalized());
        assert!(statements[0].starts_with("CREATE UNLOGGED TABLE \"public\".\"items\" ("), "{}", statements[0]);
        assert!(statements[0].contains(",\n  CONSTRAINT \"items_no_overlap\" EXCLUDE USING gist (\"name\" WITH =, (int4range(id, parent_id)) WITH &&)\n)"));
        assert!(statements[0].ends_with(") PARTITION BY RANGE (\"price\", (lower(name))) WITH (fillfactor = 70) TABLESPACE \"fast\""));
        assert_eq!(
            statements[1..],
            [
                "ALTER TABLE \"public\".\"items\" OWNER TO \"app\"".to_string(),
                AUDIT.to_string(),
                "ALTER TABLE \"public\".\"items\" DISABLE TRIGGER \"items_audit\"".to_string(),
                "COMMENT ON TRIGGER \"items_audit\" ON \"public\".\"items\" IS 'audit prices'".to_string(),
            ]
        );

        let inherited = TableDesign {
            options: TableOptions { inherits: vec![QualifiedName { schema: "public".into(), name: "base".into() }], ..Default::default() },
            ..table(vec![new_col("id", "int")])
        };
        assert!(generate_table_ddl(None, &inherited)[0].ends_with(") INHERITS (\"public\".\"base\")"));
    }

    #[test]
    fn unchanged_triggers_and_excludes_survive_renames() {
        assert!(diff_phase3(|_| {}).is_empty());
        let statements = diff_phase3(|t| {
            t.columns[1].name = "title".into();
            t.columns[2].name = "cost".into();
            // The UI rewrites references to renamed fields.
            t.indexes[0].columns[0].column = "title".into();
            t.uniques[0].columns[0] = "title".into();
            t.excludes[0].elements[0].column = "title".into();
            t.triggers[0].update_columns[0] = "cost".into();
        });
        assert_eq!(
            statements,
            [format!("{T} RENAME COLUMN \"name\" TO \"title\""), format!("{T} RENAME COLUMN \"price\" TO \"cost\"")]
        );
    }

    #[test]
    fn changed_triggers_are_dropped_first_and_recreated_last() {
        let statements = diff_phase3(|t| {
            t.triggers[0].timing = TriggerTiming::After;
            t.triggers[0].enabled = TriggerEnabled::Always;
            t.triggers[0].comment = Some("now after".into());
            t.excludes[0].elements[1].operator = "-|-".into();
            t.columns.remove(3); // parent_id: the UI drops it from the FK
            t.foreign_keys.clear();
            t.excludes[0].elements.truncate(1);
        });
        assert_eq!(
            statements,
            [
                "DROP TRIGGER \"items_audit\" ON \"public\".\"items\"".to_string(),
                format!("{T} DROP CONSTRAINT \"items_parent_fkey\""),
                format!("{T} DROP CONSTRAINT \"items_no_overlap\""),
                format!("{T} DROP COLUMN \"parent_id\""),
                format!("{T} ADD CONSTRAINT \"items_no_overlap\" EXCLUDE USING gist (\"name\" WITH =)"),
                AUDIT.replace("BEFORE", "AFTER"),
                format!("{T} ENABLE ALWAYS TRIGGER \"items_audit\""),
                "COMMENT ON TRIGGER \"items_audit\" ON \"public\".\"items\" IS 'now after'".to_string(),
            ]
        );
    }

    #[test]
    fn kept_triggers_are_renamed_and_toggled() {
        assert_eq!(
            diff_phase3(|t| {
                t.triggers[0].name = "items_price_audit".into();
                t.triggers[0].enabled = TriggerEnabled::Disabled;
                t.excludes[0].name = "items_exclusive".into();
            }),
            [
                format!("{T} RENAME CONSTRAINT \"items_no_overlap\" TO \"items_exclusive\""),
                "ALTER TRIGGER \"items_audit\" ON \"public\".\"items\" RENAME TO \"items_price_audit\"".to_string(),
                format!("{T} DISABLE TRIGGER \"items_price_audit\""),
            ]
        );
    }

    #[test]
    fn read_only_triggers_are_never_recreated() {
        let mut original = with_phase3();
        original.triggers[0].definition = Some("CONSTRAINT TRIGGER …".into());
        let mut edited = original.clone();
        edited.triggers[0].timing = TriggerTiming::After; // ignored: the definition stands
        edited.triggers[0].enabled = TriggerEnabled::Disabled;
        assert_eq!(generate_table_ddl(Some(&original), &edited.normalized()), [format!("{T} DISABLE TRIGGER \"items_audit\"")]);
        edited.triggers.clear();
        assert_eq!(generate_table_ddl(Some(&original), &edited.normalized()), ["DROP TRIGGER \"items_audit\" ON \"public\".\"items\""]);
    }

    #[test]
    fn alters_options_in_order() {
        let statements = diff_phase3(|t| {
            t.columns.remove(2); // price, inherited from base in this story
            t.indexes.remove(1);
            t.checks.clear();
            t.triggers.clear();
            t.columns.push(new_col("region", "text"));
            t.options.inherits = vec![QualifiedName { schema: "sales".into(), name: "regional".into() }];
            t.options.fill_factor = None;
            t.options.unlogged = true;
            t.options.tablespace = Some("fast".into());
            t.options.owner = Some("reporting".into());
        });
        assert_eq!(
            statements,
            [
                "DROP TRIGGER \"items_audit\" ON \"public\".\"items\"".to_string(),
                format!("{T} NO INHERIT \"public\".\"base\""),
                "DROP INDEX \"public\".\"items_lower_idx\"".to_string(),
                format!("{T} DROP CONSTRAINT \"items_price_check\""),
                format!("{T} DROP COLUMN \"price\""),
                format!("{T} ADD COLUMN \"region\" text"),
                format!("{T} INHERIT \"sales\".\"regional\""),
                format!("{T} RESET (fillfactor)"),
                format!("{REWRITE_WARNING}{T} SET UNLOGGED"),
                format!("{REWRITE_WARNING}{T} SET TABLESPACE \"fast\""),
                format!("{T} OWNER TO \"reporting\""),
            ]
        );
        assert_eq!(diff_phase3(|t| t.options.fill_factor = Some(80)), [format!("{T} SET (fillfactor = 80)")]);
        assert_eq!(diff_phase3(|t| t.options.owner = None), Vec::<String>::new(), "a blank owner changes nothing");
    }

    #[test]
    fn parses_trigger_catalog_values() {
        assert_eq!(
            trigger_when("CREATE TRIGGER t BEFORE UPDATE ON s.t FOR EACH ROW WHEN ((old.a IS DISTINCT FROM new.a)) EXECUTE FUNCTION f()"),
            Some("(old.a IS DISTINCT FROM new.a)".into())
        );
        assert_eq!(trigger_when("CREATE TRIGGER t AFTER INSERT ON s.t FOR EACH STATEMENT EXECUTE FUNCTION f()"), None);
        assert_eq!(trigger_arguments(b"audit\0it's\0"), "'audit', 'it''s'");
        assert_eq!(trigger_arguments(b""), "");
    }

    #[test]
    fn validation_checks_phase3() {
        let ok = with_phase3().normalized();
        assert_eq!(ok.validate(), Ok(()));
        type Edit = Box<dyn Fn(&mut TableDesign)>;
        let cases: Vec<Edit> = vec![
            Box::new(|t| t.excludes[0].elements.clear()),
            Box::new(|t| t.excludes[0].elements[0].operator = "".into()),
            Box::new(|t| t.excludes[0].name = "items_name_key".into()),
            Box::new(|t| t.triggers[0].name = "".into()),
            Box::new(|t| t.triggers.push(trigger("items_audit"))),
            Box::new(|t| t.triggers[0].on_update = false),
            Box::new(|t| {
                t.triggers[0].on_truncate = true;
            }),
            Box::new(|t| t.triggers[0].update_columns = vec!["nope".into()]),
            Box::new(|t| t.triggers[0].function_name = "".into()),
            Box::new(|t| t.options.fill_factor = Some(5)),
            Box::new(|t| t.options.partition_by = Some(PartitionDesign::default())),
            Box::new(|t| t.options.partition_by = Some(PartitionDesign { keys: vec!["id".into()], ..Default::default() })),
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
    async fn round_trips_triggers_and_options_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let sessions = crate::explorer::sessions::SessionManager::default();
        let pool = sessions.pool(&config, "postgres");
        let schema = "huxdb_triggers_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_triggers_test CASCADE;
             CREATE SCHEMA huxdb_triggers_test;
             CREATE TABLE huxdb_triggers_test.base (note text);
             CREATE FUNCTION huxdb_triggers_test.audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';",
        )
        .execute(&pool)
        .await
        .unwrap();
        let functions = list_trigger_functions(&pool).await.unwrap();
        assert!(functions.contains(&QualifiedName { schema: schema.into(), name: "audit".into() }));
        assert!(list_roles(&pool).await.unwrap().contains(&"postgres".to_string()));
        assert!(list_tablespaces(&pool).await.unwrap().contains(&"pg_default".to_string()));

        let audit = |name: &str| TriggerDesign {
            name: name.into(),
            function_schema: schema.into(),
            function_name: "audit".into(),
            ..Default::default()
        };
        let created = TableDesign {
            schema: schema.into(),
            name: "bookings".into(),
            columns: vec![
                ColumnDesign { key_order: Some(1), ..new_col("id", "integer") },
                new_col("room", "integer"),
                new_col("during", "int4range"),
            ],
            excludes: vec![ExcludeDesign {
                name: "bookings_no_overlap".into(),
                elements: vec![ExcludeElement { column: "during".into(), operator: "&&".into() }],
                predicate: Some("room > 0".into()),
                comment: Some("one booking at a time".into()),
                ..Default::default()
            }],
            triggers: vec![
                TriggerDesign {
                    for_each_row: true,
                    on_update: true,
                    update_columns: vec!["room".into()],
                    when: Some("old.room IS DISTINCT FROM new.room".into()),
                    arguments: "'bookings', 42".into(),
                    comment: Some("room moves".into()),
                    ..audit("bookings_audit")
                },
                TriggerDesign {
                    timing: TriggerTiming::After,
                    on_truncate: true,
                    on_insert: true,
                    enabled: TriggerEnabled::Disabled,
                    ..audit("bookings_truncate")
                },
            ],
            options: TableOptions {
                fill_factor: Some(80),
                inherits: vec![QualifiedName { schema: schema.into(), name: "base".into() }],
                ..Default::default()
            },
            ..Default::default()
        }
        .normalized();
        let loaded = save_table_design(&pool, None, &created).await.unwrap();

        let names: Vec<_> = loaded.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["note", "id", "room", "during"], "the inherited column comes first");
        let x = &loaded.excludes[0];
        assert_eq!((x.method.as_str(), x.elements.as_slice()), ("gist", [ExcludeElement { column: "during".into(), operator: "&&".into() }].as_slice()));
        assert_eq!(x.predicate.as_deref(), Some("(room > 0)"));
        assert_eq!(x.comment.as_deref(), Some("one booking at a time"));
        let t = &loaded.triggers[0];
        assert_eq!((t.timing, t.for_each_row, t.on_update, t.on_insert), (TriggerTiming::Before, true, true, false));
        assert_eq!(t.update_columns, ["room"]);
        assert_eq!(t.when.as_deref(), Some("old.room IS DISTINCT FROM new.room"));
        assert_eq!(t.arguments, "'bookings', '42'", "arguments are stored as strings");
        assert_eq!(t.comment.as_deref(), Some("room moves"));
        assert_eq!(t.definition, None);
        let t = &loaded.triggers[1];
        assert_eq!((t.timing, t.for_each_row, t.on_insert, t.on_truncate), (TriggerTiming::After, false, true, true));
        assert_eq!(t.enabled, TriggerEnabled::Disabled);
        let o = &loaded.options;
        assert_eq!((o.owner.as_deref(), o.tablespace.as_deref(), o.unlogged, o.fill_factor), (Some("postgres"), None, false, Some(80)));
        assert_eq!(o.inherits, [QualifiedName { schema: schema.into(), name: "base".into() }]);
        assert!(generate_table_ddl(Some(&loaded), &loaded.normalized()).is_empty(), "a loaded design round-trips");

        // Rename a field the trigger and exclude use, rename the exclude,
        // re-enable a trigger, change storage options, drop the parent.
        let mut edited = loaded.clone();
        edited.columns[2].name = "room_no".into();
        edited.triggers[0].update_columns[0] = "room_no".into();
        edited.excludes[0].name = "bookings_exclusive".into();
        edited.triggers[1].enabled = TriggerEnabled::Origin;
        edited.options.fill_factor = Some(60);
        edited.options.inherits.clear();
        let statements = generate_table_ddl(Some(&loaded), &edited.normalized());
        assert_eq!(statements.len(), 5, "{statements:#?}");
        let altered = save_table_design(&pool, Some(&loaded), &edited.normalized()).await.unwrap();
        assert_eq!(altered.triggers[0].update_columns, ["room_no"]);
        assert_eq!(altered.triggers[0].when.as_deref(), Some("old.room_no IS DISTINCT FROM new.room_no"));
        assert_eq!(altered.triggers[1].enabled, TriggerEnabled::Origin);
        assert_eq!(altered.excludes[0].name, "bookings_exclusive");
        assert_eq!(altered.options.fill_factor, Some(60));
        assert!(altered.options.inherits.is_empty());
        assert!(generate_table_ddl(Some(&altered), &altered.normalized()).is_empty());

        // A constraint trigger loads read-only and can still be disabled.
        sqlx::raw_sql(
            "CREATE CONSTRAINT TRIGGER bookings_check AFTER INSERT ON huxdb_triggers_test.bookings
             DEFERRABLE FOR EACH ROW EXECUTE FUNCTION huxdb_triggers_test.audit()",
        )
        .execute(&pool)
        .await
        .unwrap();
        let with_constraint = load_table_design(&pool, schema, "bookings").await.unwrap();
        let check = with_constraint.triggers.iter().find(|t| t.name == "bookings_check").unwrap();
        assert!(check.definition.as_deref().unwrap().starts_with("CREATE CONSTRAINT TRIGGER"));
        let mut disabled = with_constraint.clone();
        disabled.triggers.iter_mut().find(|t| t.name == "bookings_check").unwrap().enabled = TriggerEnabled::Disabled;
        let after = save_table_design(&pool, Some(&with_constraint), &disabled.normalized()).await.unwrap();
        let check = after.triggers.iter().find(|t| t.name == "bookings_check").unwrap();
        assert_eq!(check.enabled, TriggerEnabled::Disabled);

        // A partitioned table and one of its partitions.
        let events = TableDesign {
            schema: schema.into(),
            name: "events".into(),
            columns: vec![new_col("at", "timestamp with time zone"), new_col("kind", "text")],
            options: TableOptions {
                partition_by: Some(PartitionDesign { strategy: PartitionStrategy::Range, keys: vec!["at".into()] }),
                ..Default::default()
            },
            ..Default::default()
        };
        let events = save_table_design(&pool, None, &events.normalized()).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE huxdb_triggers_test.events_2026 PARTITION OF huxdb_triggers_test.events
             FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let partition = load_table_design(&pool, schema, "events_2026").await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_triggers_test CASCADE").execute(&pool).await.unwrap();

        assert_eq!(events.options.partition_key.as_deref(), Some("RANGE (at)"));
        let of = partition.options.partition_of.unwrap();
        assert!(of.starts_with("huxdb_triggers_test.events FOR VALUES FROM"), "{of}");
        assert!(partition.options.inherits.is_empty());
    }

    fn rule(name: &str, event: RuleEvent, instead: bool, condition: Option<&str>, actions: &str) -> RuleDesign {
        RuleDesign {
            original_name: Some(name.into()),
            name: name.into(),
            event,
            instead,
            condition: condition.map(str::to_string),
            actions: actions.into(),
            ..Default::default()
        }
    }

    /// `existing()` with an INSERT log rule and a DELETE guard rule.
    fn with_rules() -> TableDesign {
        let mut t = existing();
        t.rules = vec![
            RuleDesign {
                comment: Some("keep a log".into()),
                ..rule("items_log", RuleEvent::Insert, false, None, "INSERT INTO log (id) VALUES (new.id)")
            },
            rule("items_guard", RuleEvent::Delete, true, Some("old.price > 0"), "NOTHING"),
        ];
        t
    }

    fn diff_rules(edit: impl FnOnce(&mut TableDesign)) -> Vec<String> {
        let original = with_rules();
        let mut edited = original.clone();
        edit(&mut edited);
        generate_table_ddl(Some(&original), &edited.normalized())
    }

    const ITEMS: &str = "\"public\".\"items\"";

    #[test]
    fn parses_rule_definitions() {
        let parse = |d: &str| parse_rule(d);
        assert_eq!(
            parse("CREATE RULE r AS ON DELETE TO public.t WHERE (old.locked) DO INSTEAD NOTHING;"),
            Some((Some("old.locked".into()), "NOTHING".into()))
        );
        assert_eq!(
            parse("CREATE RULE r AS ON INSERT TO t DO  INSERT INTO log (id, note) VALUES (new.id, 'two  spaces');"),
            Some((None, "INSERT INTO log (id, note) VALUES (new.id, 'two  spaces')".into()))
        );
        assert_eq!(
            parse("CREATE RULE \"a TO b\" AS ON UPDATE TO \"my schema\".\"x DO y\" DO INSTEAD ( UPDATE a SET n = 1; NOTIFY t; );"),
            Some((None, "( UPDATE a SET n = 1; NOTIFY t; )".into()))
        );
        assert_eq!(
            parse("CREATE RULE r AS ON INSERT TO t WHERE (new.id > 0) DO INSERT INTO log VALUES (new.id) ON CONFLICT DO NOTHING;"),
            Some((Some("new.id > 0".into()), "INSERT INTO log VALUES (new.id) ON CONFLICT DO NOTHING".into()))
        );
        assert_eq!(parse("something else"), None);
    }

    #[test]
    fn creates_rules_after_triggers() {
        let mut design = with_rules();
        design.primary_key_name = None;
        for c in &mut design.columns {
            c.original_name = None;
        }
        design.triggers = vec![TriggerDesign { on_insert: true, ..trigger("items_audit") }];
        design.triggers[0].update_columns.clear();
        design.triggers[0].on_update = false;
        design.triggers[0].when = None;
        let statements = generate_table_ddl(None, &design.normalized());
        let tail: Vec<_> = statements[1..].iter().map(|s| s.split(' ').take(2).collect::<Vec<_>>().join(" ")).collect();
        assert_eq!(tail, ["CREATE TRIGGER", "CREATE RULE", "COMMENT ON", "CREATE RULE"]);
        assert_eq!(
            statements[2],
            format!("CREATE RULE \"items_log\" AS ON INSERT TO {ITEMS} DO ALSO INSERT INTO log (id) VALUES (new.id)")
        );
        assert_eq!(statements[3], format!("COMMENT ON RULE \"items_log\" ON {ITEMS} IS 'keep a log'"));
        assert_eq!(statements[4], format!("CREATE RULE \"items_guard\" AS ON DELETE TO {ITEMS} WHERE (old.price > 0) DO INSTEAD NOTHING"));
    }

    #[test]
    fn unchanged_rules_survive_column_renames() {
        assert!(diff_rules(|_| {}).is_empty());
        assert_eq!(diff_rules(|t| t.columns[2].name = "cost".into()), [format!("{T} RENAME COLUMN \"price\" TO \"cost\"")]);
    }

    #[test]
    fn changed_rules_are_dropped_first_and_recreated_last() {
        let statements = diff_rules(|t| {
            t.rules[0].actions = "NOTHING;".into();
            t.columns.remove(1);
        });
        assert_eq!(
            statements,
            [
                format!("DROP RULE \"items_log\" ON {ITEMS}"),
                format!("{T} DROP COLUMN \"name\""),
                format!("CREATE RULE \"items_log\" AS ON INSERT TO {ITEMS} DO ALSO NOTHING"),
                format!("COMMENT ON RULE \"items_log\" ON {ITEMS} IS 'keep a log'"),
            ]
        );
    }

    #[test]
    fn renames_and_removes_rules() {
        assert_eq!(
            diff_rules(|t| {
                t.rules[1].name = "items_no_delete".into();
                t.rules[0].comment = None;
            }),
            [
                format!("COMMENT ON RULE \"items_log\" ON {ITEMS} IS NULL"),
                format!("ALTER RULE \"items_guard\" ON {ITEMS} RENAME TO \"items_no_delete\""),
            ]
        );
        assert_eq!(diff_rules(|t| { t.rules.remove(1); }), [format!("DROP RULE \"items_guard\" ON {ITEMS}")]);
    }

    #[test]
    fn unparsed_rules_are_kept_or_dropped_only() {
        let mut original = with_rules();
        original.rules[1] = RuleDesign { definition: Some("CREATE RULE items_guard AS …".into()), ..original.rules[1].clone() };
        let mut edited = original.clone();
        edited.rules[1].actions = "ignored".into();
        assert!(generate_table_ddl(Some(&original), &edited.normalized()).is_empty());
    }

    #[test]
    fn validation_checks_rules() {
        let ok = with_rules().normalized();
        assert_eq!(ok.validate(), Ok(()));
        type Edit = Box<dyn Fn(&mut TableDesign)>;
        let cases: Vec<Edit> = vec![
            Box::new(|t| t.rules[0].name = "".into()),
            Box::new(|t| t.rules[0].name = "_RETURN".into()),
            Box::new(|t| t.rules[1].name = "items_log".into()),
            Box::new(|t| t.rules[0].actions = " ; ".into()),
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
    async fn round_trips_rules_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let sessions = crate::explorer::sessions::SessionManager::default();
        let pool = sessions.pool(&config, "postgres");
        let schema = "huxdb_rules_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_rules_test CASCADE;
             CREATE SCHEMA huxdb_rules_test;
             CREATE TABLE huxdb_rules_test.log (id int, note text);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let created = TableDesign {
            schema: schema.into(),
            name: "docs".into(),
            columns: vec![ColumnDesign { key_order: Some(1), ..new_col("id", "integer") }, new_col("locked", "boolean")],
            rules: vec![
                RuleDesign {
                    name: "docs_log".into(),
                    actions: "INSERT INTO huxdb_rules_test.log (id, note) VALUES (new.id, 'two  spaces')".into(),
                    ..Default::default()
                },
                RuleDesign {
                    name: "docs_guard".into(),
                    event: RuleEvent::Delete,
                    instead: true,
                    condition: Some("old.locked".into()),
                    actions: "NOTHING".into(),
                    comment: Some("locked docs stay".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
        .normalized();
        let loaded = save_table_design(&pool, None, &created).await.unwrap();

        let names: Vec<_> = loaded.rules.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["docs_guard", "docs_log"]);
        let guard = &loaded.rules[0];
        assert_eq!((guard.event, guard.instead, guard.definition.as_deref()), (RuleEvent::Delete, true, None));
        assert_eq!(guard.condition.as_deref(), Some("old.locked"));
        assert_eq!(guard.actions, "NOTHING");
        assert_eq!(guard.comment.as_deref(), Some("locked docs stay"));
        let log = &loaded.rules[1];
        assert_eq!((log.event, log.instead, log.condition.as_deref()), (RuleEvent::Insert, false, None));
        assert!(log.actions.contains("'two  spaces'"), "{}", log.actions);
        assert!(generate_table_ddl(Some(&loaded), &loaded.normalized()).is_empty(), "a loaded design round-trips");

        // Renaming a field the guard's condition uses keeps the rule.
        let mut renamed = loaded.clone();
        renamed.columns[1].name = "frozen".into();
        assert_eq!(generate_table_ddl(Some(&loaded), &renamed.normalized()).len(), 1);
        let after_rename = save_table_design(&pool, Some(&loaded), &renamed.normalized()).await.unwrap();
        assert_eq!(after_rename.rules[0].condition.as_deref(), Some("old.frozen"));

        // Changing a rule re-creates it with its comment; deleting one drops it.
        let mut changed = after_rename.clone();
        changed.rules[0].condition = Some("old.frozen AND old.id > 0".into());
        changed.rules.remove(1);
        let after_change = save_table_design(&pool, Some(&after_rename), &changed.normalized()).await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_rules_test CASCADE").execute(&pool).await.unwrap();

        assert_eq!(after_change.rules.len(), 1);
        assert_eq!(after_change.rules[0].condition.as_deref(), Some("old.frozen AND (old.id > 0)"));
        assert_eq!(after_change.rules[0].comment.as_deref(), Some("locked docs stay"));
        assert!(generate_table_ddl(Some(&after_change), &after_change.normalized()).is_empty());
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
