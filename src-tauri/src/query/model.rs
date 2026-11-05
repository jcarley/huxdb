//! What the query editor sends over IPC. Offsets are UTF-16, as CodeMirror's are.

use serde::{Deserialize, Serialize};

use super::scanner::TxState;

/// Where a tab's SQL runs. An empty `schema` leaves the server's `search_path`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTarget {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
}

/// Which part of the text a Run covers.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RunScope {
    All,
    Selection { from: usize, to: usize },
    Cursor { pos: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TextRange {
    pub from: usize,
    pub to: usize,
}

/// A statement's rows, as text. Columns go by position, as names can repeat.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// A limit was reached, so some rows aren't here.
    pub truncated: bool,
    /// The limit stopped the statement, rather than it running to the end.
    pub cancelled_at_limit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub message: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// Where in the text the server says it went wrong.
    pub position: Option<usize>,
}

/// How one statement went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub index: usize,
    pub range: TextRange,
    pub sql: String,
    pub elapsed_ms: u64,
    /// Rows the server reports, also past a limit. Null if it didn't finish.
    pub rows_affected: Option<u64>,
    pub result: Option<ResultSet>,
    pub error: Option<QueryError>,
    /// Stop ended it.
    pub cancelled: bool,
    /// The server's NOTICE and WARNING messages, in order.
    pub notices: Vec<String>,
    /// Something the outcome alone doesn't show.
    pub note: Option<String>,
    /// The transaction state after it.
    pub tx: TxState,
    /// It may have changed what code completion knows about.
    pub changes_catalog: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum QueryEvent {
    StatementStarted { index: usize, total: usize, range: TextRange },
    StatementFinished { outcome: Box<StatementOutcome> },
    /// Always the last event of a Run. Channel messages can arrive after the
    /// command returns, so this is what ends the run in the UI.
    RunDone {
        tx: TxState,
        stopped: bool,
        /// The connection died, and what went with it.
        session_lost: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scopes_read_the_frontends_shape() {
        assert!(matches!(serde_json::from_value(json!({ "kind": "all" })).unwrap(), RunScope::All));
        assert!(matches!(serde_json::from_value(json!({ "kind": "cursor", "pos": 3 })).unwrap(), RunScope::Cursor { pos: 3 }));
        assert!(matches!(serde_json::from_value(json!({ "kind": "selection", "from": 1, "to": 2 })).unwrap(), RunScope::Selection { from: 1, to: 2 }));
    }

    #[test]
    fn events_have_the_frontends_shape() {
        let started = QueryEvent::StatementStarted { index: 1, total: 2, range: TextRange { from: 3, to: 4 } };
        assert_eq!(serde_json::to_value(started).unwrap(), json!({ "event": "statement-started", "index": 1, "total": 2, "range": { "from": 3, "to": 4 } }));

        let done = QueryEvent::RunDone { tx: TxState::Aborted, stopped: true, session_lost: None };
        assert_eq!(serde_json::to_value(done).unwrap(), json!({ "event": "run-done", "tx": "aborted", "stopped": true, "sessionLost": null }));

        let outcome = StatementOutcome {
            index: 0,
            range: TextRange { from: 0, to: 1 },
            sql: "x".into(),
            elapsed_ms: 5,
            rows_affected: Some(1),
            result: Some(ResultSet { columns: vec!["a".into()], rows: vec![vec![None]], truncated: true, cancelled_at_limit: false }),
            error: None,
            cancelled: false,
            notices: vec![],
            note: None,
            tx: TxState::Open,
            changes_catalog: true,
        };
        let finished = serde_json::to_value(QueryEvent::StatementFinished { outcome: Box::new(outcome) }).unwrap();
        assert_eq!(finished["event"], "statement-finished");
        assert_eq!(finished["outcome"]["elapsedMs"], 5);
        assert_eq!(finished["outcome"]["changesCatalog"], true);
        assert_eq!(finished["outcome"]["rowsAffected"], 1);
        assert_eq!(finished["outcome"]["result"]["cancelledAtLimit"], false);
        assert_eq!(finished["outcome"]["tx"], "open");
    }
}
