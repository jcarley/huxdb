//! Object tree: lazily lists databases, schemas, and schema objects for a saved
//! connection. The frontend side is `src/stores/explorer.ts`.

mod postgres;
pub mod sessions;

use postgres::{SchemaObjects, TableInfo, ViewInfo};
use sessions::SessionManager;
use sqlx::PgPool;
use tauri::State;

use crate::connections::postgres::initial_database;
use crate::connections::store::ConnectionStore;

/// Pool for a saved connection; `database` defaults to the connection's initial database.
pub(crate) fn pool_for(
    store: &ConnectionStore,
    sessions: &SessionManager,
    connection_id: &str,
    database: Option<&str>,
) -> Result<PgPool, String> {
    let config = store
        .get(connection_id)
        .ok_or("That connection no longer exists.")?;
    let database = database.unwrap_or_else(|| initial_database(&config));
    Ok(sessions.pool(&config, database))
}

/// Connects (via the initial database) and lists the server's databases.
#[tauri::command]
pub async fn open_connection(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, None)?;
    postgres::list_databases(&pool).await
}

#[tauri::command]
pub fn close_connection(sessions: State<'_, SessionManager>, connection_id: String) {
    sessions.close(&connection_id);
}

#[tauri::command]
pub async fn list_schemas(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_schemas(&pool).await
}

#[tauri::command]
pub async fn list_schema_objects(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<SchemaObjects, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_schema_objects(&pool, &schema).await
}

/// Tables in a schema with the details pane's columns.
#[tauri::command]
pub async fn list_tables(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<TableInfo>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_tables(&pool, &schema).await
}

/// Views in a schema with the details pane's columns.
#[tauri::command]
pub async fn list_views(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<ViewInfo>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_views(&pool, &schema).await
}
