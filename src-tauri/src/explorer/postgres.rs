//! PostgreSQL catalog queries behind the object tree.

use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjects {
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub materialized_views: Vec<String>,
    pub functions: Vec<FunctionInfo>,
}

/// A function or procedure. `arguments` (identity argument types, e.g. `integer, text`)
/// tells overloads apart.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub arguments: String,
}

/// One row of the details pane's tables list.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// Planner estimate (`pg_class.reltuples`); `None` if never analyzed or partitioned.
    pub rows: Option<i64>,
    pub oid: i64,
    pub owner: String,
    /// Created by initdb (OID below `FirstNormalObjectId`, 16384).
    pub system_table: bool,
    pub comment: Option<String>,
}

/// One row of the details pane's views list.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub name: String,
    pub oid: i64,
    pub owner: String,
    /// Created by initdb (OID below `FirstNormalObjectId`, 16384).
    pub system_view: bool,
    pub comment: Option<String>,
}

fn err(e: sqlx::Error) -> String {
    e.to_string()
}

pub async fn list_databases(pool: &PgPool) -> Result<Vec<String>, String> {
    sqlx::query_scalar(
        "SELECT datname::text FROM pg_database
         WHERE datallowconn AND NOT datistemplate
         ORDER BY datname",
    )
    .fetch_all(pool)
    .await
    .map_err(err)
}

/// All schemas, including system ones (pg_catalog, information_schema, pg_toast…).
pub async fn list_schemas(pool: &PgPool) -> Result<Vec<String>, String> {
    sqlx::query_scalar("SELECT nspname::text FROM pg_namespace ORDER BY nspname")
        .fetch_all(pool)
        .await
        .map_err(err)
}

pub async fn list_schema_objects(pool: &PgPool, schema: &str) -> Result<SchemaObjects, String> {
    let relations: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.relname::text, c.relkind::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
         ORDER BY c.relname",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let functions: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.proname::text, pg_get_function_identity_arguments(p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         ORDER BY p.proname, 2",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut objects = SchemaObjects::default();
    for (name, kind) in relations {
        match kind.as_str() {
            "r" | "p" => objects.tables.push(name),
            "v" => objects.views.push(name),
            "m" => objects.materialized_views.push(name),
            _ => {}
        }
    }
    objects.functions = functions
        .into_iter()
        .map(|(name, arguments)| FunctionInfo { name, arguments })
        .collect();
    Ok(objects)
}

/// Columns of `list_tables`' query, in `TableInfo` field order.
type TableRow = (String, Option<i64>, i64, String, bool, Option<String>);

/// Ordinary and partitioned tables in `schema`, the same set the tree's Tables group shows.
pub async fn list_tables(pool: &PgPool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let rows: Vec<TableRow> = sqlx::query_as(
        "SELECT c.relname::text,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END,
                c.oid::int8,
                pg_get_userbyid(c.relowner)::text,
                c.oid < 16384,
                obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         ORDER BY c.relname",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, rows, oid, owner, system_table, comment)| TableInfo {
            name,
            rows,
            oid,
            owner,
            system_table,
            comment,
        })
        .collect())
}

/// Columns of `list_views`' query, in `ViewInfo` field order.
type ViewRow = (String, i64, String, bool, Option<String>);

/// Plain views in `schema`, the same set the tree's Views group shows.
pub async fn list_views(pool: &PgPool, schema: &str) -> Result<Vec<ViewInfo>, String> {
    let rows: Vec<ViewRow> = sqlx::query_as(
        "SELECT c.relname::text,
                c.oid::int8,
                pg_get_userbyid(c.relowner)::text,
                c.oid < 16384,
                obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'v'
         ORDER BY c.relname",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    Ok(rows
        .into_iter()
        .map(|(name, oid, owner, system_view, comment)| ViewInfo {
            name,
            oid,
            owner,
            system_view,
            comment,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::sample;
    use crate::explorer::sessions::SessionManager;

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn lists_catalog_objects_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig {
            id: "live".into(),
            port,
            ..sample("live")
        };
        let sessions = SessionManager::default();
        let pool = sessions.pool(&config, "postgres");

        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS huxdb_tree_test CASCADE;
             CREATE SCHEMA huxdb_tree_test;
             CREATE TABLE huxdb_tree_test.b_table (id int);
             CREATE TABLE huxdb_tree_test.a_table (id int);
             CREATE VIEW huxdb_tree_test.a_view AS SELECT 1 AS x;
             CREATE MATERIALIZED VIEW huxdb_tree_test.a_matview AS SELECT 1 AS x;
             CREATE FUNCTION huxdb_tree_test.f(a int) RETURNS int LANGUAGE sql AS 'SELECT a';
             CREATE FUNCTION huxdb_tree_test.f(a int, b text) RETURNS int LANGUAGE sql AS 'SELECT a';
             CREATE PROCEDURE huxdb_tree_test.p() LANGUAGE sql AS 'SELECT 1';
             CREATE VIEW huxdb_tree_test.b_view AS SELECT 2 AS y;
             COMMENT ON TABLE huxdb_tree_test.a_table IS 'hello';
             COMMENT ON VIEW huxdb_tree_test.a_view IS 'a view';",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(list_databases(&pool).await.unwrap().contains(&"postgres".to_string()));
        let schemas = list_schemas(&pool).await.unwrap();
        assert!(schemas.contains(&"huxdb_tree_test".to_string()));
        assert!(schemas.contains(&"pg_catalog".to_string()));

        let objects = list_schema_objects(&pool, "huxdb_tree_test").await.unwrap();
        let tables = list_tables(&pool, "huxdb_tree_test").await.unwrap();
        let catalog = list_tables(&pool, "pg_catalog").await.unwrap();
        let views = list_views(&pool, "huxdb_tree_test").await.unwrap();
        let catalog_views = list_views(&pool, "pg_catalog").await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_tree_test CASCADE").execute(&pool).await.unwrap();

        assert_eq!(objects.tables, ["a_table", "b_table"]);
        assert_eq!(objects.views, ["a_view", "b_view"]);
        assert_eq!(objects.materialized_views, ["a_matview"]);
        let fns: Vec<_> = objects.functions.iter().map(|f| format!("{}({})", f.name, f.arguments)).collect();
        assert_eq!(fns, ["f(a integer)", "f(a integer, b text)", "p()"]);

        let names: Vec<_> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a_table", "b_table"]);
        let a = &tables[0];
        assert_eq!(a.comment.as_deref(), Some("hello"));
        assert_eq!(a.owner, "postgres");
        assert!(!a.system_table);
        assert_eq!(a.rows, None, "never analyzed");
        assert_eq!(tables[1].comment, None);

        let pg_class = catalog.iter().find(|t| t.name == "pg_class").unwrap();
        assert!(pg_class.system_table);

        let names: Vec<_> = views.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, ["a_view", "b_view"], "matviews are excluded");
        let a = &views[0];
        assert_eq!(a.comment.as_deref(), Some("a view"));
        assert_eq!(a.owner, "postgres");
        assert!(!a.system_view);
        assert_eq!(views[1].comment, None);

        let pg_roles = catalog_views.iter().find(|v| v.name == "pg_roles").unwrap();
        assert!(pg_roles.system_view);
    }
}
