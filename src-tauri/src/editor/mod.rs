//! Data editor: pages through a table's rows and applies the grid's edits,
//! optionally inside a transaction the user begins and ends. The frontend
//! side is `src/stores/dataEditor.ts`.
//!
//! `session_*` commands work on a tab's session (transaction, Stop) and don't
//! depend on what the tab shows; `data_*` commands are the table grid's.

mod model;
mod postgres;
mod session_postgres;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use model::{DataPage, DataSpec, EditBatch};
use session_postgres::HeldSession;
use tauri::State;

use crate::connections::store::ConnectionStore;
use crate::explorer::pool_for;
use crate::explorer::sessions::SessionManager;

/// Each editor tab's session, keyed by tab id.
#[derive(Default)]
pub struct EditorSessions {
    sessions: Mutex<HashMap<String, Arc<HeldSession>>>,
}

impl EditorSessions {
    fn get(&self, tab_id: &str, connection_id: &str) -> Arc<HeldSession> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(HeldSession::new(connection_id)))
            .clone()
    }

    fn find(&self, tab_id: &str) -> Option<Arc<HeldSession>> {
        self.sessions.lock().unwrap().get(tab_id).cloned()
    }

    fn remove(&self, tab_id: &str) -> Option<Arc<HeldSession>> {
        self.sessions.lock().unwrap().remove(tab_id)
    }

    /// Drops the sessions of a connection that was edited or deleted (its tabs
    /// close too), rolling back their transactions in the background. Closing
    /// a connection in the tree leaves them alone, as it leaves the tabs open.
    pub fn close_connection(&self, connection_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, session| {
            let keep = session.connection_id != connection_id;
            if !keep {
                let session = session.clone();
                tauri::async_runtime::spawn(async move { session.end(false).await });
            }
            keep
        });
    }
}

// Sessions ---------------------------------------------------------------------

/// Begin Transaction: the tab's later commands run in it until `session_end`.
#[tauri::command]
pub async fn session_begin(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    tab_id: String,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    editors.get(&tab_id, &connection_id).begin(&pool).await
}

/// Commits or rolls back the tab's transaction.
#[tauri::command]
pub async fn session_end(editors: State<'_, EditorSessions>, tab_id: String, commit: bool) -> Result<(), String> {
    let session = editors.find(&tab_id).ok_or("No transaction is open.")?;
    session.end(commit).await
}

/// Stop: cancels the statement the tab is running.
#[tauri::command]
pub async fn session_cancel(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    tab_id: String,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    let Some(session) = editors.find(&tab_id) else { return Ok(()) };
    let pool = pool_for(&store, &sessions, &connection_id, Some(&database))?;
    session.cancel(&pool).await
}

/// The tab was closed: rolls back its transaction, if any, and forgets it.
#[tauri::command]
pub async fn session_close(editors: State<'_, EditorSessions>, tab_id: String) -> Result<(), String> {
    if let Some(session) = editors.remove(&tab_id) {
        // Not an error if there was no transaction to roll back.
        let _ = session.end(false).await;
    }
    Ok(())
}

// Table data -------------------------------------------------------------------

/// The table a data tab shows.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTarget {
    connection_id: String,
    database: String,
    schema: String,
    table: String,
}

/// Which rows of the selection one page holds.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRange {
    offset: u64,
    limit: u64,
}

/// The table's columns and one page of the rows `spec` selects (with the tab's
/// transaction's uncommitted changes, if one is open).
#[tauri::command]
pub async fn data_fetch_page(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    tab_id: String,
    target: DataTarget,
    spec: DataSpec,
    range: PageRange,
) -> Result<DataPage, String> {
    let pool = pool_for(&store, &sessions, &target.connection_id, Some(&target.database))?;
    let session = editors.get(&tab_id, &target.connection_id);
    let mut lease = session.lease(&pool).await?;
    postgres::fetch_page(&mut lease, &target.schema, &target.table, &spec, range.offset, range.limit).await
}

/// How many rows `spec` selects, or null if counting took too long.
#[tauri::command]
pub async fn data_count(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    tab_id: String,
    target: DataTarget,
    spec: DataSpec,
) -> Result<Option<i64>, String> {
    let pool = pool_for(&store, &sessions, &target.connection_id, Some(&target.database))?;
    let session = editors.get(&tab_id, &target.connection_id);
    let mut lease = session.lease(&pool).await?;
    postgres::count_rows(&mut lease, &target.schema, &target.table, &spec).await
}

/// Applies the grid's pending edits all or nothing; returns the rows changed.
#[tauri::command]
pub async fn data_apply(
    store: State<'_, ConnectionStore>,
    sessions: State<'_, SessionManager>,
    editors: State<'_, EditorSessions>,
    tab_id: String,
    target: DataTarget,
    batch: EditBatch,
) -> Result<u64, String> {
    let pool = pool_for(&store, &sessions, &target.connection_id, Some(&target.database))?;
    let session = editors.get(&tab_id, &target.connection_id);
    let mut lease = session.lease(&pool).await?;
    postgres::apply_edits(&mut lease, &target.schema, &target.table, &batch).await
}
