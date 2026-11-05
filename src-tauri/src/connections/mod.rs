//! Saved connection profiles: model, on-disk store, and the Tauri commands the
//! frontend calls (see `src/lib/api.ts`).

pub mod model;
pub(crate) mod postgres;
pub mod store;

use model::ConnectionConfig;
use store::ConnectionStore;
use tauri::State;

use crate::diagram::store::DiagramStore;
use crate::editor::EditorSessions;
use crate::explorer::sessions::SessionManager;
use crate::query::QuerySessions;
use crate::saved_queries::store::SavedQueryStore;

#[tauri::command]
pub fn list_connections(store: State<'_, ConnectionStore>) -> Vec<ConnectionConfig> {
    store.list()
}

/// Creates the connection when `config.id` is empty, otherwise updates it.
#[tauri::command]
pub fn save_connection(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    queries: State<'_, QuerySessions>,
    config: ConnectionConfig,
) -> Result<ConnectionConfig, String> {
    let saved = store.save(config)?;
    // Open pools were built from the old settings; drop them.
    editors.close_connection(&saved.id);
    queries.close_connection(&saved.id);
    sessions.close(&saved.id);
    Ok(saved)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn delete_connection(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    queries: State<'_, QuerySessions>,
    saved: State<'_, SavedQueryStore>,
    diagrams: State<'_, DiagramStore>,
    id: String,
    delete_files: bool,
) -> Result<(), String> {
    store.delete(&id)?;
    editors.close_connection(&id);
    queries.close_connection(&id);
    sessions.close(&id);
    if delete_files {
        // The connection is gone either way, and files left behind harm nothing.
        if let Err(err) = saved.delete_connection(&id) {
            eprintln!("huxdb: could not delete the saved queries of connection {id}: {err}");
        }
        if let Err(err) = diagrams.delete_connection(&id) {
            eprintln!("huxdb: could not delete the diagrams of connection {id}: {err}");
        }
    }
    Ok(())
}

/// Tests the given (possibly unsaved) settings; returns the server version string.
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<String, String> {
    let config = config.normalized();
    config.validate()?;
    postgres::test_connection(&config).await
}
