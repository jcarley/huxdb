//! Query editor: runs the SQL typed in a query tab on that tab's own
//! connection. The frontend side is `src/stores/queryEditor.ts`.

mod model;
mod scanner;
mod session_postgres;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use model::{QueryEvent, QueryTarget, RunScope, TextRange};
use scanner::{Offsets, Scope};
use session_postgres::{QuerySession, RunRequest};
use tauri::State;
use tauri::ipc::Channel;

use crate::connections::postgres::connect_options;
use crate::connections::store::ConnectionStore;

/// Each query tab's session, keyed by tab id.
#[derive(Default)]
pub struct QuerySessions {
    sessions: Mutex<HashMap<String, Arc<QuerySession>>>,
}

impl QuerySessions {
    fn get(&self, tab_id: &str, connection_id: &str) -> Arc<QuerySession> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.entry(tab_id.to_string()).or_insert_with(|| Arc::new(QuerySession::new(connection_id))).clone()
    }

    fn find(&self, tab_id: &str) -> Option<Arc<QuerySession>> {
        self.sessions.lock().unwrap().get(tab_id).cloned()
    }

    fn remove(&self, tab_id: &str) -> Option<Arc<QuerySession>> {
        self.sessions.lock().unwrap().remove(tab_id)
    }

    /// Closes the sessions of a connection that was edited or deleted (its
    /// tabs close too). Closing a connection in the tree leaves them, as it
    /// leaves the tabs open.
    pub fn close_connection(&self, connection_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, session| {
            let keep = session.connection_id != connection_id;
            if !keep {
                let session = session.clone();
                tauri::async_runtime::spawn(async move { session.close().await });
            }
            keep
        });
    }
}

/// Bytes to the frontend's offsets, for a scope it sent.
fn byte_scope(sql: &str, scope: RunScope) -> Scope {
    let offsets = Offsets::new(sql);
    match scope {
        RunScope::All => Scope::All,
        RunScope::Selection { from, to } => {
            let (from, to) = (offsets.to_byte(from, sql), offsets.to_byte(to, sql));
            Scope::Selection { from: from.min(to), to: from.max(to) }
        }
        RunScope::Cursor { pos } => Scope::Cursor { pos: offsets.to_byte(pos, sql) },
    }
}

/// The statements in `sql`, for highlighting the one under the cursor.
#[tauri::command]
pub fn query_split(sql: String) -> Vec<TextRange> {
    let offsets = Offsets::new(&sql);
    scanner::split(&sql)
        .into_iter()
        .map(|s| TextRange { from: offsets.to_utf16(s.range.start), to: offsets.to_utf16(s.range.end) })
        .collect()
}

/// Runs the part of `sql` that `scope` covers, reporting over `on_event`. An
/// error means nothing ran; otherwise a `run-done` event ends the Run.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn query_run(
    store: State<'_, ConnectionStore>,
    queries: State<'_, QuerySessions>,
    tab_id: String,
    run_id: u64,
    target: QueryTarget,
    sql: String,
    scope: RunScope,
    continue_on_error: bool,
    on_event: Channel<QueryEvent>,
) -> Result<(), String> {
    let config = store.get(&target.connection_id).ok_or("That connection no longer exists.")?;
    let session = queries.get(&tab_id, &target.connection_id);
    let request = RunRequest {
        run_id,
        options: connect_options(&config, &target.database),
        database: &target.database,
        schema: &target.schema,
        sql: &sql,
        scope: byte_scope(&sql, scope),
        continue_on_error,
    };
    session
        .run(request, |event| {
            // Fails only if the webview went away.
            let _ = on_event.send(event);
        })
        .await
}

/// Stop: cancels the Run `run_id`, if it's still going.
#[tauri::command]
pub async fn query_cancel(queries: State<'_, QuerySessions>, tab_id: String, run_id: u64) -> Result<(), String> {
    match queries.find(&tab_id) {
        Some(session) => session.cancel(run_id).await,
        None => Ok(()),
    }
}

/// Commits or rolls back the tab's transaction, for the close prompt.
#[tauri::command]
pub async fn query_end(queries: State<'_, QuerySessions>, tab_id: String, commit: bool) -> Result<(), String> {
    match queries.find(&tab_id) {
        Some(session) => session.end(commit).await,
        None => Ok(()),
    }
}

/// The tab was closed: stops it and closes its connection.
#[tauri::command]
pub async fn query_close(queries: State<'_, QuerySessions>, tab_id: String) -> Result<(), String> {
    if let Some(session) = queries.remove(&tab_id) {
        session.close().await;
    }
    Ok(())
}
