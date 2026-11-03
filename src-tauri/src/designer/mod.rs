//! Object designer: loads a table's design, previews the DDL for an edit and
//! saves it. The frontend side is `src/stores/tableDesigner.ts`.

mod model;
mod postgres;

use model::TableDesign;
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
