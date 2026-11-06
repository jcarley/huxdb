//! Saved queries and external `.sql` files. Rust owns all of these files: the
//! frontend sees ids, text and the paths the user picked. The file dialogs run
//! from here too, so the webview needs no filesystem or dialog permission.

mod external;
pub mod store;

use std::path::{Path, PathBuf};

pub use external::ExternalFiles;
use external::{ExternalFile, ExternalSql};
use store::{SavedQuery, SavedQueryInfo, SavedQueryStore, SavedQuerySummary};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::FilePath;
use tokio::sync::oneshot;

/// Starts the error of a save refused because the file changed since this tab
/// read it. The frontend (`CHANGED_MARKER` in `lib/api.ts`) offers to overwrite.
pub const CHANGED_MARKER: &str = "[changed] ";

#[tauri::command]
pub fn list_saved_queries(store: State<'_, SavedQueryStore>, connection_id: String) -> Result<Vec<SavedQueryInfo>, String> {
    store.list(&connection_id)
}

/// For the prompt when deleting a connection.
#[tauri::command]
pub fn saved_query_summary(store: State<'_, SavedQueryStore>, connection_id: String) -> Result<SavedQuerySummary, String> {
    store.summary(&connection_id)
}

#[tauri::command]
pub fn load_saved_query(store: State<'_, SavedQueryStore>, connection_id: String, id: String) -> Result<SavedQuery, String> {
    store.load(&connection_id, &id)
}

#[tauri::command]
pub fn create_saved_query(
    store: State<'_, SavedQueryStore>,
    connection_id: String,
    name: String,
    database: String,
    schema: String,
    sql: String,
) -> Result<SavedQueryInfo, String> {
    store.create(&connection_id, &name, &database, &schema, &sql)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_saved_query(
    store: State<'_, SavedQueryStore>,
    connection_id: String,
    id: String,
    database: String,
    schema: String,
    sql: String,
    expected_modified_ms: Option<u64>,
) -> Result<SavedQueryInfo, String> {
    store.update(&connection_id, &id, &database, &schema, &sql, expected_modified_ms)
}

#[tauri::command]
pub fn rename_saved_query(store: State<'_, SavedQueryStore>, connection_id: String, id: String, name: String) -> Result<SavedQueryInfo, String> {
    store.rename(&connection_id, &id, &name)
}

#[tauri::command]
pub fn duplicate_saved_query(store: State<'_, SavedQueryStore>, connection_id: String, id: String) -> Result<SavedQueryInfo, String> {
    store.duplicate(&connection_id, &id)
}

#[tauri::command]
pub fn delete_saved_query(store: State<'_, SavedQueryStore>, connection_id: String, id: String) -> Result<(), String> {
    store.delete(&connection_id, &id)
}

/// What a file dialog answered; `None` if it was cancelled.
pub(crate) async fn picked(receiver: oneshot::Receiver<Option<FilePath>>) -> Result<Option<PathBuf>, String> {
    let picked = receiver.await.map_err(|_| "The file dialog closed unexpectedly.".to_string())?;
    picked.map(|file| file.into_path().map_err(|e| e.to_string())).transpose()
}

/// Open External File: asks for a file and returns its text; `None` if cancelled.
#[tauri::command]
pub async fn open_external_sql(app: AppHandle, files: State<'_, ExternalFiles>) -> Result<Option<ExternalSql>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().add_filter("SQL files", &["sql"]).pick_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = picked(receiver).await? else { return Ok(None) };
    let sql = external::read(&path)?;
    files.grant(&path);
    Ok(Some(ExternalSql { file: external::describe(&path), sql }))
}

/// Save As External File: asks where and writes `sql` there; `None` if cancelled.
#[tauri::command]
pub async fn save_external_sql_as(app: AppHandle, files: State<'_, ExternalFiles>, suggested_name: String, sql: String) -> Result<Option<ExternalFile>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().add_filter("SQL files", &["sql"]).set_file_name(format!("{suggested_name}.sql")).save_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = picked(receiver).await? else { return Ok(None) };
    external::write(&path, &sql, None)?;
    files.grant(&path);
    Ok(Some(external::describe(&path)))
}

/// Save on a tab bound to an external file. The path must have come from a
/// dialog. Resolves to the file's new modification time.
#[tauri::command]
pub fn write_external_sql(files: State<'_, ExternalFiles>, path: String, sql: String, expected_modified_ms: Option<u64>) -> Result<Option<u64>, String> {
    let path = Path::new(&path);
    if !files.is_granted(path) {
        return Err("That file wasn't opened in this session.".into());
    }
    external::write(path, &sql, expected_modified_ms)?;
    Ok(external::describe(path).modified_ms)
}
