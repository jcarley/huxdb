//! Saved connection profiles: model, on-disk store, and the Tauri commands the
//! frontend calls (see `src/lib/api.ts`).

pub mod model;
pub(crate) mod postgres;
pub mod store;

use model::ConnectionConfig;
use store::ConnectionStore;
use tauri::State;

use crate::explorer::sessions::SessionManager;

#[tauri::command]
pub fn list_connections(store: State<'_, ConnectionStore>) -> Vec<ConnectionConfig> {
    store.list()
}

/// Creates the connection when `config.id` is empty, otherwise updates it.
#[tauri::command]
pub fn save_connection(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    config: ConnectionConfig,
) -> Result<ConnectionConfig, String> {
    let saved = store.save(config)?;
    // Open pools were built from the old settings; drop them.
    sessions.close(&saved.id);
    Ok(saved)
}

#[tauri::command]
pub fn delete_connection(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    store.delete(&id)?;
    sessions.close(&id);
    Ok(())
}

/// Tests the given (possibly unsaved) settings; returns the server version string.
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<String, String> {
    let config = config.normalized();
    config.validate()?;
    postgres::test_connection(&config).await
}
