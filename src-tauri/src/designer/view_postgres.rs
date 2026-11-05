//! PostgreSQL side of the view designer: loading a view, generating its DDL,
//! and running its definition read-only for Preview and Explain.

use serde::Serialize;
use sqlx::{Column, Executor, PgPool, Postgres, Row, SqlSafeStr, Statement, Transaction};

use super::postgres::{comment_sql, err, execute_all, qualified, quote_ident};
use super::view::{CheckOption, ViewDesign};

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

type ViewRow = (String, String, Option<String>, Option<String>, Option<String>, Option<String>, bool);

/// A boolean reloption: PostgreSQL accepts true/on/yes/1 and their opposites.
fn reloption_true(value: Option<&str>) -> bool {
    matches!(value.map(str::to_ascii_lowercase).as_deref(), Some("true" | "on" | "yes" | "1"))
}

pub async fn load_view_design(pool: &PgPool, schema: &str, view: &str) -> Result<ViewDesign, String> {
    let row: Option<ViewRow> = sqlx::query_as(
        "SELECT pg_get_viewdef(c.oid, true),
                pg_get_userbyid(c.relowner)::text,
                obj_description(c.oid, 'pg_class'),
                (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'check_option'),
                (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_barrier'),
                (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'),
                current_setting('server_version_num')::int >= 150000
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
    )
    .bind(schema)
    .bind(view)
    .fetch_optional(pool)
    .await
    .map_err(err)?;
    let Some((definition, owner, comment, check_option, barrier, invoker, supports_invoker)) = row else {
        return Err(format!("View \"{schema}\".\"{view}\" no longer exists."));
    };
    Ok(ViewDesign {
        schema: schema.to_string(),
        name: view.to_string(),
        definition: definition.trim().trim_end_matches(';').trim_end().to_string(),
        owner: Some(owner),
        comment,
        check_option: match check_option.as_deref() {
            Some("local") => Some(CheckOption::Local),
            Some("cascaded") => Some(CheckOption::Cascaded),
            _ => None,
        },
        security_barrier: reloption_true(barrier.as_deref()),
        security_invoker: reloption_true(invoker.as_deref()),
        supports_security_invoker: supports_invoker,
    })
}

/// Marks errors that a drop and re-create would get past, so the UI can offer it.
pub const RECREATE_MARKER: &str = "[recreate] ";

/// PostgreSQL's messages for column changes CREATE OR REPLACE VIEW can't make.
fn needs_recreate(message: &str) -> bool {
    [
        "cannot drop columns from view",
        "cannot change name of view column",
        "cannot change data type of view column",
        "cannot change collation of view column",
    ]
    .iter()
    .any(|m| message.contains(m))
}

/// Creates or replaces the view (or drops and re-creates it) in one
/// transaction, and returns it as reloaded. A column change that needs a
/// re-create fails with an error starting with `RECREATE_MARKER`.
pub async fn save_view_design(
    pool: &PgPool,
    original: Option<&ViewDesign>,
    edited: &ViewDesign,
    recreate: bool,
) -> Result<ViewDesign, String> {
    let statements = generate_view_ddl(original, edited, recreate);
    if let Err(message) = execute_all(pool, &statements).await {
        let offer = original.is_some() && !recreate && needs_recreate(&message);
        return Err(if offer { format!("{RECREATE_MARKER}{message}") } else { message });
    }
    let name = original.map_or(&edited.name, |o| &o.name);
    load_view_design(pool, &edited.schema, name).await
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/// The options as `name = value` pairs, for WITH (…) and ALTER VIEW SET.
fn view_options(v: &ViewDesign) -> Vec<String> {
    let mut options = Vec::new();
    if let Some(check) = v.check_option {
        let value = match check {
            CheckOption::Local => "local",
            CheckOption::Cascaded => "cascaded",
        };
        options.push(format!("check_option = {value}"));
    }
    if v.security_barrier {
        options.push("security_barrier = true".into());
    }
    if v.security_invoker {
        options.push("security_invoker = true".into());
    }
    options
}

fn with_clause(v: &ViewDesign) -> String {
    let options = view_options(v);
    if options.is_empty() { String::new() } else { format!(" WITH ({})", options.join(", ")) }
}

fn create_view(v: &ViewDesign) -> Vec<String> {
    let view = qualified(&v.schema, &v.name);
    let mut statements = vec![format!("CREATE VIEW {view}{} AS\n{}", with_clause(v), v.definition)];
    if let Some(owner) = &v.owner {
        statements.push(format!("ALTER VIEW {view} OWNER TO {}", quote_ident(owner)));
    }
    if v.comment.is_some() {
        statements.push(comment_sql(&format!("VIEW {view}"), &v.comment));
    }
    statements
}

/// The statements that turn `original` into `edited`, or create it. With
/// `recreate`, an existing view is dropped and created again (for column
/// changes CREATE OR REPLACE can't make). Both designs must be normalized.
/// The view keeps its original name: renaming happens in the tree.
pub fn generate_view_ddl(original: Option<&ViewDesign>, edited: &ViewDesign, recreate: bool) -> Vec<String> {
    let Some(original) = original else {
        return create_view(edited);
    };
    let view = qualified(&original.schema, &original.name);
    let edited = &ViewDesign { schema: original.schema.clone(), name: original.name.clone(), ..edited.clone() };
    if recreate {
        let mut statements = vec![format!("DROP VIEW {view}")];
        statements.extend(create_view(edited));
        return statements;
    }

    let mut statements = Vec::new();
    if original.definition != edited.definition {
        // CREATE OR REPLACE replaces the options with exactly those listed.
        statements.push(format!("CREATE OR REPLACE VIEW {view}{} AS\n{}", with_clause(edited), edited.definition));
    } else {
        let (mut set, mut reset) = (Vec::new(), Vec::new());
        if original.check_option != edited.check_option {
            match edited.check_option {
                Some(_) => set.extend(view_options(edited).into_iter().filter(|o| o.starts_with("check_option"))),
                None => reset.push("check_option"),
            }
        }
        for (name, old, new) in [
            ("security_barrier", original.security_barrier, edited.security_barrier),
            ("security_invoker", original.security_invoker, edited.security_invoker),
        ] {
            if old != new {
                if new {
                    set.push(format!("{name} = true"));
                } else {
                    reset.push(name);
                }
            }
        }
        if !set.is_empty() {
            statements.push(format!("ALTER VIEW {view} SET ({})", set.join(", ")));
        }
        if !reset.is_empty() {
            statements.push(format!("ALTER VIEW {view} RESET ({})", reset.join(", ")));
        }
    }
    if let Some(owner) = &edited.owner
        && original.owner.as_ref() != Some(owner)
    {
        statements.push(format!("ALTER VIEW {view} OWNER TO {}", quote_ident(owner)));
    }
    if original.comment != edited.comment {
        statements.push(comment_sql(&format!("VIEW {view}"), &edited.comment));
    }
    statements
}

// ---------------------------------------------------------------------------
// Preview and Explain
// ---------------------------------------------------------------------------

/// Rows of a Preview, every value as text (`None` for NULL).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// More rows exist than were returned.
    pub truncated: bool,
}

pub const PREVIEW_ROWS: usize = 100;

/// A read-only transaction with a statement timeout; callers roll it back.
async fn read_only(pool: &PgPool) -> Result<Transaction<'static, Postgres>, String> {
    let mut tx = pool.begin().await.map_err(err)?;
    sqlx::raw_sql("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s'")
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    Ok(tx)
}

/// The definition without a trailing semicolon. Wrapping it in a subquery (or
/// preparing it) rejects anything but a single query.
pub(crate) fn query_text(definition: &str) -> &str {
    let d = definition.trim();
    d.strip_suffix(';').unwrap_or(d).trim_end()
}

/// Runs an unsaved definition and returns its first rows. It runs in a
/// read-only transaction with a 30 s timeout that is always rolled back.
pub async fn preview_rows(pool: &PgPool, definition: &str) -> Result<QueryResult, String> {
    let query = query_text(definition);
    let mut tx = read_only(pool).await?;
    // The newline keeps a trailing `-- comment` from swallowing the parenthesis.
    let probe = sqlx::AssertSqlSafe(format!("SELECT * FROM ({query}\n) AS q")).into_sql_str();
    let columns: Vec<String> = (&mut *tx)
        .prepare(probe)
        .await
        .map_err(err)?
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    // Cast each column to text so any type can be shown.
    let select: Vec<_> = columns.iter().map(|c| format!("q.{}::text", quote_ident(c))).collect();
    let sql = format!("SELECT {} FROM ({query}\n) AS q LIMIT {}", select.join(", "), PREVIEW_ROWS + 1);
    let fetched = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(&mut *tx).await.map_err(err)?;
    tx.rollback().await.map_err(err)?;

    let truncated = fetched.len() > PREVIEW_ROWS;
    let rows = fetched
        .iter()
        .take(PREVIEW_ROWS)
        .map(|row| (0..columns.len()).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect())
        .collect();
    Ok(QueryResult { columns, rows, truncated })
}

/// The query plan of an unsaved definition (EXPLAIN without ANALYZE, so the
/// query itself doesn't run), one line per entry.
pub async fn explain(pool: &PgPool, definition: &str) -> Result<Vec<String>, String> {
    let mut tx = read_only(pool).await?;
    let sql = sqlx::AssertSqlSafe(format!("EXPLAIN {}", query_text(definition)));
    let rows = sqlx::query(sql).fetch_all(&mut *tx).await.map_err(err)?;
    tx.rollback().await.map_err(err)?;
    rows.iter().map(|r| r.try_get::<String, _>(0).map_err(err)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> ViewDesign {
        ViewDesign {
            schema: "public".into(),
            name: "active_items".into(),
            definition: "SELECT id, name FROM items WHERE active".into(),
            owner: Some("app".into()),
            comment: Some("Items on sale".into()),
            check_option: Some(CheckOption::Cascaded),
            security_barrier: true,
            ..Default::default()
        }
    }

    fn diff(edit: impl FnOnce(&mut ViewDesign)) -> Vec<String> {
        let original = view();
        let mut edited = original.clone();
        edit(&mut edited);
        generate_view_ddl(Some(&original), &edited.normalized(), false)
    }

    const V: &str = "\"public\".\"active_items\"";

    #[test]
    fn creates_a_view_with_options_owner_and_comment() {
        let new = ViewDesign { security_invoker: true, definition: "SELECT 1;  ".into(), ..view() }.normalized();
        assert_eq!(
            generate_view_ddl(None, &new, false),
            [
                format!("CREATE VIEW {V} WITH (check_option = cascaded, security_barrier = true, security_invoker = true) AS\nSELECT 1"),
                format!("ALTER VIEW {V} OWNER TO \"app\""),
                format!("COMMENT ON VIEW {V} IS 'Items on sale'"),
            ]
        );
        let plain = ViewDesign { owner: None, comment: None, check_option: None, security_barrier: false, ..view() };
        assert_eq!(generate_view_ddl(None, &plain, false), [format!("CREATE VIEW {V} AS\nSELECT id, name FROM items WHERE active")]);
    }

    #[test]
    fn unchanged_view_needs_no_statements() {
        assert!(diff(|_| {}).is_empty());
        assert!(diff(|v| v.definition = "  SELECT id, name FROM items WHERE active;\n".into()).is_empty());
    }

    #[test]
    fn definition_changes_replace_with_all_options() {
        assert_eq!(
            diff(|v| {
                v.definition = "SELECT id, name, price FROM items WHERE active".into();
                v.security_barrier = false;
            }),
            [format!("CREATE OR REPLACE VIEW {V} WITH (check_option = cascaded) AS\nSELECT id, name, price FROM items WHERE active")]
        );
    }

    #[test]
    fn option_changes_set_and_reset() {
        assert_eq!(
            diff(|v| {
                v.check_option = Some(CheckOption::Local);
                v.security_barrier = false;
                v.security_invoker = true;
            }),
            [
                format!("ALTER VIEW {V} SET (check_option = local, security_invoker = true)"),
                format!("ALTER VIEW {V} RESET (security_barrier)"),
            ]
        );
        assert_eq!(diff(|v| v.check_option = None), [format!("ALTER VIEW {V} RESET (check_option)")]);
    }

    #[test]
    fn owner_and_comment_changes() {
        assert_eq!(
            diff(|v| {
                v.owner = Some("reporting".into());
                v.comment = None;
            }),
            [format!("ALTER VIEW {V} OWNER TO \"reporting\""), format!("COMMENT ON VIEW {V} IS NULL")]
        );
        assert!(diff(|v| v.owner = None).is_empty(), "a blank owner changes nothing");
    }

    #[test]
    fn recreate_drops_and_restores_everything() {
        let original = view();
        let edited = ViewDesign { definition: "SELECT id FROM items".into(), ..view() };
        assert_eq!(
            generate_view_ddl(Some(&original), &edited, true),
            [
                format!("DROP VIEW {V}"),
                format!("CREATE VIEW {V} WITH (check_option = cascaded, security_barrier = true) AS\nSELECT id FROM items"),
                format!("ALTER VIEW {V} OWNER TO \"app\""),
                format!("COMMENT ON VIEW {V} IS 'Items on sale'"),
            ]
        );
    }

    #[test]
    fn validation_and_error_marking() {
        assert_eq!(view().normalized().validate(), Ok(()));
        assert!(ViewDesign { name: " ".into(), ..view() }.normalized().validate().is_err());
        assert!(ViewDesign { definition: " ; ".into(), ..view() }.normalized().validate().is_err());
        assert!(needs_recreate("cannot drop columns from view"));
        assert!(needs_recreate("error returned from database: cannot change name of view column \"a\" to \"b\""));
        assert!(!needs_recreate("syntax error at or near \"FORM\""));
        assert!(reloption_true(Some("ON")) && !reloption_true(Some("false")) && !reloption_true(None));
        assert_eq!(query_text("  SELECT 1;\n"), "SELECT 1");
    }

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn round_trips_views_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..crate::connections::model::sample("live")
        };
        let sessions = crate::explorer::sessions::SessionManager::default();
        let pool = sessions.pool(&config, "postgres");
        let schema = "huxdb_views_test";
        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_views_test CASCADE;
             CREATE SCHEMA huxdb_views_test;
             CREATE SEQUENCE huxdb_views_test.seq;
             CREATE TABLE huxdb_views_test.items (id int, name text, price numeric, active bool);
             INSERT INTO huxdb_views_test.items
               SELECT g, CASE WHEN g % 2 = 0 THEN 'item ' || g END, g * 1.5, true FROM generate_series(1, 150) g;",
        )
        .execute(&pool)
        .await
        .unwrap();
        let supports_invoker: bool = sqlx::query_scalar("SELECT current_setting('server_version_num')::int >= 150000")
            .fetch_one(&pool)
            .await
            .unwrap();

        let created = ViewDesign {
            schema: schema.into(),
            name: "active_items".into(),
            definition: "SELECT id, name FROM huxdb_views_test.items WHERE active;".into(),
            comment: Some("on sale".into()),
            check_option: Some(CheckOption::Cascaded),
            security_barrier: true,
            security_invoker: supports_invoker,
            ..Default::default()
        }
        .normalized();
        let loaded = save_view_design(&pool, None, &created, false).await.unwrap();
        assert_eq!(loaded.check_option, Some(CheckOption::Cascaded));
        assert!(loaded.security_barrier);
        assert_eq!(loaded.security_invoker, supports_invoker);
        assert_eq!(loaded.supports_security_invoker, supports_invoker);
        assert_eq!(loaded.comment.as_deref(), Some("on sale"));
        assert_eq!(loaded.owner.as_deref(), Some("postgres"));
        assert!(loaded.definition.starts_with("SELECT ") && loaded.definition.contains("FROM huxdb_views_test.items"), "{}", loaded.definition);
        assert!(generate_view_ddl(Some(&loaded), &loaded.normalized(), false).is_empty(), "a loaded design round-trips");

        // Appending a column works with CREATE OR REPLACE and keeps the options.
        let mut appended = loaded.clone();
        appended.definition = "SELECT id, name, price FROM huxdb_views_test.items WHERE active".into();
        let appended = save_view_design(&pool, Some(&loaded), &appended.normalized(), false).await.unwrap();
        assert!(appended.definition.contains("price"));
        assert_eq!((appended.check_option, appended.security_barrier), (Some(CheckOption::Cascaded), true));

        // Option-only changes.
        let mut toggled = appended.clone();
        toggled.security_barrier = false;
        toggled.check_option = Some(CheckOption::Local);
        let toggled = save_view_design(&pool, Some(&appended), &toggled.normalized(), false).await.unwrap();
        assert_eq!((toggled.check_option, toggled.security_barrier), (Some(CheckOption::Local), false));

        // Dropping a column needs a re-create, which restores the comment and options.
        let mut dropped = toggled.clone();
        dropped.definition = "SELECT id, price FROM huxdb_views_test.items WHERE active".into();
        let error = save_view_design(&pool, Some(&toggled), &dropped.normalized(), false).await.unwrap_err();
        assert!(error.starts_with(RECREATE_MARKER), "{error}");
        let recreated = save_view_design(&pool, Some(&toggled), &dropped.normalized(), true).await.unwrap();
        assert!(!recreated.definition.contains("name"));
        assert_eq!(recreated.comment.as_deref(), Some("on sale"));
        assert_eq!(recreated.check_option, Some(CheckOption::Local));

        // With a dependent view the re-create fails and nothing changes.
        sqlx::raw_sql("CREATE VIEW huxdb_views_test.cheap AS SELECT id FROM huxdb_views_test.active_items WHERE price < 10")
            .execute(&pool)
            .await
            .unwrap();
        let mut narrower = recreated.clone();
        narrower.definition = "SELECT id FROM huxdb_views_test.items".into();
        let error = save_view_design(&pool, Some(&recreated), &narrower.normalized(), true).await.unwrap_err();
        assert!(error.contains("depend"), "{error}");
        let unchanged = load_view_design(&pool, schema, "active_items").await.unwrap();
        assert_eq!(unchanged, recreated);

        // Preview and Explain run read-only.
        let preview = preview_rows(&pool, "SELECT id, name, price FROM huxdb_views_test.items ORDER BY id -- note").await.unwrap();
        assert_eq!(preview.columns, ["id", "name", "price"]);
        assert_eq!(preview.rows.len(), PREVIEW_ROWS);
        assert!(preview.truncated);
        assert_eq!(preview.rows[0], [Some("1".to_string()), None, Some("1.5".to_string())]);
        assert_eq!(preview.rows[1][1].as_deref(), Some("item 2"));
        let few = preview_rows(&pool, "SELECT 1 AS one;").await.unwrap();
        assert_eq!((few.rows.len(), few.truncated), (1, false));
        let write = preview_rows(&pool, "SELECT nextval('huxdb_views_test.seq')").await.unwrap_err();
        assert!(write.contains("read-only"), "{write}");
        let multi = preview_rows(&pool, "SELECT 1; DROP TABLE huxdb_views_test.items").await;
        assert!(multi.is_err());
        let plan = explain(&pool, "SELECT * FROM huxdb_views_test.items WHERE id = 1").await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_views_test CASCADE").execute(&pool).await.unwrap();

        assert!(plan[0].contains("Seq Scan on items"), "{plan:?}");
    }
}
