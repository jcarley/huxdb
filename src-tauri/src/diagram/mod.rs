//! Diagrams: reads a database's structure for the canvas. Read-only: nothing here changes the
//! database. The frontend side is `src/stores/diagram.ts`.

mod postgres;

use postgres::{DiagramCandidate, DiagramStructure};
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
