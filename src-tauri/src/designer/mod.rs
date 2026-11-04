//! Object designer: loads a table's or view's design, previews the DDL for an
//! edit and saves it. The frontend side is `src/stores/tableDesigner.ts` and
//! `src/stores/viewDesigner.ts`.

mod model;
mod postgres;
mod view;
mod view_postgres;

use model::TableDesign;
use view::ViewDesign;
use view_postgres::QueryResult;
use tauri::State;

use crate::connections::store::ConnectionStore;
use crate::explorer::pool_for;
use crate::explorer::sessions::SessionManager;

#[tauri::command]
pub async fn load_table_design(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<TableDesign, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::load_table_design(&pool, &schema, &table).await
}

/// Column names of a table, for a foreign key's referenced fields.
#[tauri::command]
pub async fn list_table_columns(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_columns(&pool, &schema, &table).await
}

/// Roles, for the Owner option.
#[tauri::command]
pub async fn list_roles(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_roles(&pool).await
}

/// Tablespaces, for the Tablespace option.
#[tauri::command]
pub async fn list_tablespaces(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_tablespaces(&pool).await
}

/// Functions a trigger can call (they return `trigger`).
#[tauri::command]
pub async fn list_trigger_functions(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<model::QualifiedName>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_trigger_functions(&pool).await
}

/// Normalizes and validates both designs; the original is only normalized,
/// since it came from the server.
fn prepare(original: Option<TableDesign>, edited: TableDesign) -> Result<(Option<TableDesign>, TableDesign), String> {
    let edited = edited.normalized();
    edited.validate()?;
    Ok((original.map(|o| o.normalized()), edited))
}

/// The statements Save would run, for the SQL Preview tab.
#[tauri::command]
pub fn preview_table_ddl(original: Option<TableDesign>, edited: TableDesign) -> Result<Vec<String>, String> {
    let (original, edited) = prepare(original, edited)?;
    Ok(postgres::generate_table_ddl(original.as_ref(), &edited))
}

/// Creates or alters the table in one transaction and returns it as reloaded.
#[tauri::command]
pub async fn save_table_design(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    original: Option<TableDesign>,
    edited: TableDesign,
) -> Result<TableDesign, String> {
    let (original, edited) = prepare(original, edited)?;
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::save_table_design(&pool, original.as_ref(), &edited).await
}

// View designer ----------------------------------------------------------------

#[tauri::command]
pub async fn load_view_design(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    schema: String,
    view: String,
) -> Result<ViewDesign, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    view_postgres::load_view_design(&pool, &schema, &view).await
}

fn prepare_view(original: Option<ViewDesign>, edited: ViewDesign) -> Result<(Option<ViewDesign>, ViewDesign), String> {
    let edited = edited.normalized();
    edited.validate()?;
    Ok((original.map(|o| o.normalized()), edited))
}

/// The statements Save would run, for the SQL Preview tab.
#[tauri::command]
pub fn preview_view_ddl(original: Option<ViewDesign>, edited: ViewDesign, recreate: bool) -> Result<Vec<String>, String> {
    let (original, edited) = prepare_view(original, edited)?;
    Ok(view_postgres::generate_view_ddl(original.as_ref(), &edited, recreate))
}

/// Creates, replaces or (with `recreate`) drops and re-creates the view in one
/// transaction. A column change that needs `recreate` fails with an error
/// starting with `[recreate] `.
#[tauri::command]
pub async fn save_view_design(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    original: Option<ViewDesign>,
    edited: ViewDesign,
    recreate: bool,
) -> Result<ViewDesign, String> {
    let (original, edited) = prepare_view(original, edited)?;
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    view_postgres::save_view_design(&pool, original.as_ref(), &edited, recreate).await
}

/// Runs an unsaved view definition read-only and returns its first rows.
#[tauri::command]
pub async fn preview_view_rows(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    definition: String,
) -> Result<QueryResult, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    view_postgres::preview_rows(&pool, &definition).await
}

/// EXPLAIN (without ANALYZE) of an unsaved view definition.
#[tauri::command]
pub async fn explain_view(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    definition: String,
) -> Result<Vec<String>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    view_postgres::explain(&pool, &definition).await
}
