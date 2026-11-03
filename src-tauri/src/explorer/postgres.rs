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
             CREATE PROCEDURE huxdb_tree_test.p() LANGUAGE sql AS 'SELECT 1';",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(list_databases(&pool).await.unwrap().contains(&"postgres".to_string()));
        let schemas = list_schemas(&pool).await.unwrap();
        assert!(schemas.contains(&"huxdb_tree_test".to_string()));
        assert!(schemas.contains(&"pg_catalog".to_string()));

        let objects = list_schema_objects(&pool, "huxdb_tree_test").await.unwrap();
        sqlx::raw_sql("DROP SCHEMA huxdb_tree_test CASCADE").execute(&pool).await.unwrap();

        assert_eq!(objects.tables, ["a_table", "b_table"]);
        assert_eq!(objects.views, ["a_view"]);
        assert_eq!(objects.materialized_views, ["a_matview"]);
        let fns: Vec<_> = objects.functions.iter().map(|f| format!("{}({})", f.name, f.arguments)).collect();
        assert_eq!(fns, ["f(a integer)", "f(a integer, b text)", "p()"]);
    }
}
