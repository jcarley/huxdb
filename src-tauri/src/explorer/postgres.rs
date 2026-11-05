//! PostgreSQL catalog queries behind the object tree.

use std::collections::HashMap;

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
    /// Before PostgreSQL 14 "never analyzed" was 0 rows in 0 pages rather than -1,
    /// so on those servers an analyzed empty table shows as unknown too.
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

/// What code completion knows about a database.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCatalog {
    /// `current_schemas(true)` on a fresh connection, in search order.
    pub search_path: Vec<String>,
    pub schemas: Vec<CatalogSchema>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSchema {
    pub name: String,
    /// See [`CatalogColumn::quoted`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted: Option<String>,
    pub relations: Vec<CatalogRelation>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRelation {
    pub name: String,
    /// See [`CatalogColumn::quoted`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted: Option<String>,
    pub kind: RelationKind,
    pub columns: Vec<CatalogColumn>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    Table,
    View,
    MaterializedView,
}

impl RelationKind {
    fn from_relkind(relkind: &str) -> Self {
        match relkind {
            "v" => Self::View,
            "m" => Self::MaterializedView,
            _ => Self::Table,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogColumn {
    pub name: String,
    /// `quote_ident` of the name, when that isn't the name: it knows the
    /// reserved words, which the frontend doesn't.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted: Option<String>,
    pub data_type: String,
}

/// A relation row: oid, schema, name, `quoted`, relkind.
type RelationRow = (i64, String, String, Option<String>, String);
/// A column row: relation oid, name, `quoted`, type.
type ColumnRow = (i64, String, Option<String>, String);

/// Hangs the rows off their schemas. Rows with no parent are dropped: a query
/// can see an object the one before it didn't, and other sessions' temp schemas
/// aren't listed.
fn assemble_catalog(
    search_path: Vec<String>,
    schemas: Vec<(String, Option<String>)>,
    relations: Vec<RelationRow>,
    columns: Vec<ColumnRow>,
) -> CompletionCatalog {
    let mut by_relation: HashMap<i64, Vec<CatalogColumn>> = HashMap::new();
    for (oid, name, quoted, data_type) in columns {
        by_relation.entry(oid).or_default().push(CatalogColumn { name, quoted, data_type });
    }
    let mut by_schema: HashMap<String, Vec<CatalogRelation>> = HashMap::new();
    for (oid, schema, name, quoted, relkind) in relations {
        by_schema.entry(schema).or_default().push(CatalogRelation {
            name,
            quoted,
            kind: RelationKind::from_relkind(&relkind),
            columns: by_relation.remove(&oid).unwrap_or_default(),
        });
    }
    let schemas = schemas
        .into_iter()
        .map(|(name, quoted)| {
            let relations = by_schema.remove(&name).unwrap_or_default();
            CatalogSchema { name, quoted, relations }
        })
        .collect();
    CompletionCatalog { search_path, schemas }
}

/// Schemas, relations and columns, in three reads through the pool, so it never
/// touches a query tab's session. Skips TOAST and temp schemas, dropped columns
/// and system columns.
pub async fn completion_catalog(pool: &PgPool) -> Result<CompletionCatalog, String> {
    let search_path = sqlx::query_scalar("SELECT current_schemas(true)::text[]").fetch_one(pool).await.map_err(err)?;
    let schemas = sqlx::query_as(
        "SELECT nspname::text, NULLIF(quote_ident(nspname), nspname::text)
         FROM pg_namespace
         WHERE nspname !~ '^pg_(toast|temp_|toast_temp_)'
         ORDER BY nspname",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    let relations = sqlx::query_as(
        "SELECT c.oid::int8, n.nspname::text, c.relname::text,
                NULLIF(quote_ident(c.relname), c.relname::text), c.relkind::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
         ORDER BY c.relname",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    let columns = sqlx::query_as(
        "SELECT a.attrelid::int8, a.attname::text, NULLIF(quote_ident(a.attname), a.attname::text),
                format_type(a.atttypid, a.atttypmod)
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
         ORDER BY a.attrelid, a.attnum",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    Ok(assemble_catalog(search_path, schemas, relations, columns))
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
                CASE WHEN c.reltuples < 0
                       OR (current_setting('server_version_num')::int < 140000
                           AND c.reltuples = 0 AND c.relpages = 0)
                     THEN NULL ELSE c.reltuples::int8 END,
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

    #[test]
    fn assembles_the_catalog_and_drops_orphans() {
        let catalog = assemble_catalog(
            vec!["pg_catalog".into(), "public".into()],
            vec![("Odd".into(), Some("\"Odd\"".into())), ("public".into(), None)],
            vec![
                (1, "public".into(), "users".into(), None, "r".into()),
                (2, "public".into(), "v".into(), None, "v".into()),
                (3, "Odd".into(), "m".into(), None, "m".into()),
                (4, "pg_temp_3".into(), "gone".into(), None, "r".into()),
            ],
            vec![(1, "id".into(), None, "integer".into()), (1, "order".into(), Some("\"order\"".into()), "text".into()), (9, "gone".into(), None, "text".into())],
        );
        assert_eq!(catalog.schemas.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Odd", "public"]);
        assert_eq!(catalog.schemas[0].relations[0].kind, RelationKind::MaterializedView);
        let users = &catalog.schemas[1].relations[0];
        assert_eq!(users.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "order"]);
        assert_eq!(catalog.schemas[1].relations[1].kind, RelationKind::View);
        assert!(catalog.schemas[1].relations[1].columns.is_empty());
    }

    #[test]
    fn the_catalog_leaves_out_what_it_needn_t_send() {
        let column = CatalogColumn { name: "id".into(), quoted: None, data_type: "integer".into() };
        let json = serde_json::to_value(&column).unwrap();
        assert_eq!(json, serde_json::json!({ "name": "id", "dataType": "integer" }));
        assert_eq!(serde_json::to_value(RelationKind::MaterializedView).unwrap(), "materialized-view");
    }

    /// Needs a live server; see `connections::postgres::tests::connects_to_live_server`.
    #[tokio::test]
    #[ignore]
    async fn builds_the_completion_catalog_on_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = crate::connections::model::ConnectionConfig { id: "live".into(), port, ..sample("live") };
        let sessions = SessionManager::default();
        let pool = sessions.pool(&config, "postgres");

        sqlx::raw_sql(
            "DROP SCHEMA IF EXISTS \"Huxdb Catalog\" CASCADE;
             CREATE SCHEMA \"Huxdb Catalog\";
             CREATE TABLE \"Huxdb Catalog\".\"order\" (id int, \"Mixed\" varchar(10), gone text, \"user\" numeric(10,2));
             ALTER TABLE \"Huxdb Catalog\".\"order\" DROP COLUMN gone;
             CREATE VIEW \"Huxdb Catalog\".plain_view AS SELECT 1 AS x;
             CREATE MATERIALIZED VIEW \"Huxdb Catalog\".a_matview AS SELECT 1 AS x;
             CREATE TEMP TABLE huxdb_temp_catalog (a int);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let catalog = completion_catalog(&pool).await.unwrap();
        sqlx::raw_sql("DROP SCHEMA \"Huxdb Catalog\" CASCADE").execute(&pool).await.unwrap();

        assert!(catalog.search_path.iter().any(|s| s == "pg_catalog"));
        assert!(catalog.schemas.iter().all(|s| !s.name.starts_with("pg_toast") && !s.name.starts_with("pg_temp")));
        assert!(catalog.schemas.iter().any(|s| s.name == "pg_catalog" && s.relations.iter().any(|r| r.name == "pg_class" && !r.columns.is_empty())));

        let schema = catalog.schemas.iter().find(|s| s.name == "Huxdb Catalog").expect("the schema");
        assert_eq!(schema.quoted.as_deref(), Some("\"Huxdb Catalog\""));
        let names: Vec<_> = schema.relations.iter().map(|r| (r.name.as_str(), r.kind, r.quoted.as_deref())).collect();
        assert_eq!(
            names,
            [
                ("a_matview", RelationKind::MaterializedView, None),
                ("order", RelationKind::Table, Some("\"order\"")),
                ("plain_view", RelationKind::View, None),
            ]
        );
        let columns: Vec<_> = schema.relations[1].columns.iter().map(|c| (c.name.as_str(), c.quoted.as_deref(), c.data_type.as_str())).collect();
        assert_eq!(
            columns,
            [
                ("id", None, "integer"),
                ("Mixed", Some("\"Mixed\""), "character varying(10)"),
                ("user", Some("\"user\""), "numeric(10,2)"),
            ]
        );
    }

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
