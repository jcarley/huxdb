//! Diagrams: reads a database's structure for the canvas, and keeps saved diagrams as files.
//! Nothing here changes the database. The frontend side is `src/stores/diagram.ts` and
//! `src/stores/savedDiagrams.ts`.

mod postgres;
pub mod store;

use postgres::{DiagramCandidate, DiagramStructure};
use store::{DiagramContent, DiagramInfo, DiagramStore, DiagramSummary, SavedDiagram};
use tauri::State;

use crate::connections::store::ConnectionStore;
use crate::explorer::pool_for;
use crate::explorer::sessions::SessionManager;

/// The tables a diagram of this database can hold, for the picker.
#[tauri::command]
pub async fn diagram_candidates(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<DiagramCandidate>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::list_candidates(&pool).await
}

/// The chosen tables and the foreign keys between them.
#[tauri::command]
pub async fn diagram_structure(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    oids: Vec<i64>,
) -> Result<DiagramStructure, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::load_structure(&pool, &oids).await
}

/// Tables one foreign key away from these, for Add Related Tables.
#[tauri::command]
pub async fn diagram_related(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    database: String,
    oids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    postgres::related_tables(&pool, &oids).await
}

#[tauri::command]
pub fn list_diagrams(store: State<'_, DiagramStore>, connection_id: String) -> Result<Vec<DiagramInfo>, String> {
    store.list(&connection_id)
}

/// For the prompt when deleting a connection.
#[tauri::command]
pub fn diagram_summary(store: State<'_, DiagramStore>, connection_id: String) -> Result<DiagramSummary, String> {
    store.summary(&connection_id)
}

#[tauri::command]
pub fn load_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<SavedDiagram, String> {
    store.load(&connection_id, &id)
}

#[tauri::command]
pub fn create_diagram(store: State<'_, DiagramStore>, connection_id: String, name: String, database: String, content: DiagramContent) -> Result<DiagramInfo, String> {
    store.create(&connection_id, &name, &database, content)
}

/// With `expected_modified_ms`, a file changed since then is refused with `CHANGED_MARKER`.
#[tauri::command]
pub fn update_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String, content: DiagramContent, expected_modified_ms: Option<u64>) -> Result<DiagramInfo, String> {
    store.update(&connection_id, &id, content, expected_modified_ms)
}

#[tauri::command]
pub fn rename_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String, name: String) -> Result<DiagramInfo, String> {
    store.rename(&connection_id, &id, &name)
}

#[tauri::command]
pub fn duplicate_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<DiagramInfo, String> {
    store.duplicate(&connection_id, &id)
}

#[tauri::command]
pub fn delete_diagram(store: State<'_, DiagramStore>, connection_id: String, id: String) -> Result<(), String> {
    store.delete(&connection_id, &id)
}
