//! A query tab's session: its own connection, outside the pool, because `SET`,
//! temp tables and locks belong to a connection. It opens on the first Run and
//! closes with the tab.
//!
//! User SQL runs as typed, a statement at a time, with no scopes around it: a
//! failed statement inside the user's transaction aborts it, as in psql.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgDatabaseError, PgSeverity};
use sqlx::{AssertSqlSafe, Column, Connection, Either, Executor, Row, SqlSafeStr, Statement, ValueRef};
use tokio::sync::watch;
use tracing::instrument::WithSubscriber;

use super::model::{QueryError, QueryEvent, ResultSet, StatementOutcome, TextRange};
use super::scanner::{self, Info, Offsets, Outcome, Scope, TxState};
use crate::connections::postgres::CONNECT_TIMEOUT;
use crate::designer::quote_ident;
use crate::editor::session_postgres::CANCELLED;

/// The most rows a statement keeps. A judgment call, as is the byte limit,
/// which is there because one row can be huge.
pub const MAX_ROWS: usize = 10_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_NOTICES: usize = 1_000;

/// A dead peer shouldn't hold up a Run for long.
const PING_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

const QUERY_CANCELED: &str = "57014";

/// The connection a tab's statements run on.
struct Live {
    conn: PgConnection,
    pid: i32,
    database: String,
    tx: TxState,
    /// What `search_path` was last set to; empty for the server's default.
    schema: String,
    notices: NoticeCollector,
    /// Subscribes `notices`, for the length of each statement.
    dispatch: tracing::Dispatch,
}

/// The Run in progress, for Stop.
#[derive(Clone)]
struct Running {
    run_id: u64,
    pid: i32,
    options: PgConnectOptions,
}

/// What a Run needs to know.
pub struct RunRequest<'a> {
    pub run_id: u64,
    pub options: PgConnectOptions,
    pub database: &'a str,
    pub schema: &'a str,
    pub sql: &'a str,
    pub scope: Scope,
    pub continue_on_error: bool,
}

/// One tab's session. Runs on it go one at a time.
pub struct QuerySession {
    pub connection_id: String,
    live: tokio::sync::Mutex<Option<Live>>,
    running: Mutex<Option<Running>>,
    /// Stop was pressed. The cancel only reaches a running statement, so this
    /// is checked between statements.
    stop: AtomicBool,
    /// Held while a Stop's cancel is on its way, so it can't hit the next Run.
    cancelling: tokio::sync::Mutex<()>,
    /// The tab closed: whatever the session is waiting for no longer matters.
    closed: watch::Sender<bool>,
}

/// Connects without the statement cache's stale columns: capacity 1, cleared
/// after each `prepare`. (Capacity 0 would leave every prepared statement open.)
async fn connect(options: &PgConnectOptions) -> Result<PgConnection, String> {
    let options = options.clone().statement_cache_capacity(1);
    tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect_with(&options))
        .await
        .map_err(|_| format!("Timed out after {} seconds.", CONNECT_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())
}

/// Cancels `pid` over a connection of its own, as the pool may be full, or
/// closing because the connection was just edited.
async fn cancel_backend(options: &PgConnectOptions, pid: i32) -> Result<(), String> {
    let mut conn = connect(options).await?;
    let result = sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(&mut conn).await;
    let _ = conn.close().await;
    result.map(drop).map_err(|e| e.to_string())
}

async fn is_alive(conn: &mut PgConnection) -> bool {
    matches!(tokio::time::timeout(PING_TIMEOUT, conn.ping()).await, Ok(Ok(())))
}

async fn apply_schema(conn: &mut PgConnection, schema: &str) -> Result<(), String> {
    let sql = match schema {
        "" => "RESET search_path".to_string(),
        "public" => "SET search_path = public".to_string(),
        // Extensions usually live in public, so their functions keep working.
        _ => format!("SET search_path = {}, public", quote_ident(schema)),
    };
    sqlx::raw_sql(AssertSqlSafe(sql)).execute(conn).await.map(drop).map_err(|e| e.to_string())
}

/// What went with a session that died, given the transaction state it had.
fn lost_message(tx: TxState) -> &'static str {
    match tx {
        TxState::Idle => "The connection was lost. Session settings and temp tables are gone.",
        _ => "The connection was lost. The open transaction was rolled back, and session settings and temp tables are gone.",
    }
}

impl QuerySession {
    pub fn new(connection_id: &str) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            live: Default::default(),
            running: Default::default(),
            stop: AtomicBool::new(false),
            cancelling: Default::default(),
            closed: watch::Sender::new(false),
        }
    }

    fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    async fn open(&self, options: &PgConnectOptions, database: &str) -> Result<Live, String> {
        let mut conn = connect(options).await?;
        if self.is_closed() {
            let _ = conn.close().await;
            return Err(CANCELLED.to_string());
        }
        // Not persistent, so no prepared statement of ours shows in the user's session.
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()").persistent(false).fetch_one(&mut conn).await.map_err(|e| e.to_string())?;
        let notices = NoticeCollector::default();
        let dispatch = tracing::Dispatch::new(notices.clone());
        Ok(Live { conn, pid, database: database.to_string(), tx: TxState::Idle, schema: String::new(), notices, dispatch })
    }

    /// Runs what `request` selects, reporting through `emit`. An `Err` means
    /// nothing ran and no events were sent; otherwise `RunDone` comes last.
    pub async fn run(&self, request: RunRequest<'_>, emit: impl Fn(QueryEvent)) -> Result<(), String> {
        let statements = scanner::select(request.sql, request.scope);
        if statements.is_empty() {
            return Err("There's no SQL to run here.".into());
        }
        let mut live = self.live.try_lock().map_err(|_| "A query is already running in this tab.")?;
        drop(self.cancelling.lock().await);
        self.stop.store(false, Ordering::SeqCst);

        if let Some(existing) = live.as_mut()
            && !is_alive(&mut existing.conn).await
        {
            let lost = lost_message(existing.tx);
            *live = None;
            let lost = match self.open(&request.options, request.database).await {
                Ok(reopened) => {
                    *live = Some(reopened);
                    format!("{lost} It has been reopened, but nothing was run. Run again to continue.")
                }
                Err(e) => format!("{lost} Nothing was run, and reconnecting failed: {e}"),
            };
            emit(QueryEvent::RunDone { tx: TxState::Idle, stopped: false, session_lost: Some(lost) });
            return Ok(());
        }
        if let Some(existing) = live.as_ref()
            && existing.database != request.database
        {
            if existing.tx != TxState::Idle {
                return Err("End the transaction before changing database.".into());
            }
            *live = None;
        }
        if live.is_none() {
            *live = Some(self.open(&request.options, request.database).await?);
        }
        let session = live.as_mut().expect("just opened");

        // Inside a transaction the selector is locked, and a rollback would undo the SET.
        if session.schema != request.schema && session.tx == TxState::Idle {
            apply_schema(&mut session.conn, request.schema).await?;
            session.schema = request.schema.to_string();
        }

        *self.running.lock().unwrap() = Some(Running { run_id: request.run_id, pid: session.pid, options: request.options.clone() });
        let offsets = Offsets::new(request.sql);
        let utf16 = |start: usize, end: usize| TextRange { from: offsets.to_utf16(start), to: offsets.to_utf16(end) };
        let total = statements.len();
        let mut stopped = false;
        let mut session_lost = None;

        for (index, statement) in statements.iter().enumerate() {
            if self.stop.load(Ordering::SeqCst) {
                stopped = true;
                break;
            }
            let range = utf16(statement.range.start, statement.range.end);
            emit(QueryEvent::StatementStarted { index, total, range });
            let text = &request.sql[statement.range.clone()];
            let began = Instant::now();
            let before = session.tx;

            let run = if let Some(reason) = statement.info.refused {
                Executed { failure: Some(Failure::Refused(reason)), ..Default::default() }
            } else {
                let dispatch = session.dispatch.clone();
                self.execute(session, text, statement.info, &request.options).with_subscriber(dispatch).await
            };

            let mut outcome = StatementOutcome {
                index,
                range,
                sql: text.to_string(),
                elapsed_ms: began.elapsed().as_millis() as u64,
                rows_affected: run.rows_affected,
                result: run.result,
                error: None,
                cancelled: false,
                notices: session.notices.take(),
                note: None,
                tx: session.tx,
            };

            let mut failed = true;
            match run.failure {
                None => {
                    failed = false;
                    let result = Outcome::Success;
                    if scanner::rolled_back_instead(before, statement.info.tx, result) {
                        outcome.note = Some("The transaction had failed, so it was rolled back.".into());
                    }
                    session.tx = scanner::next_state(before, statement.info.tx, result);
                }
                Some(Failure::Refused(reason)) => {
                    outcome.error = Some(QueryError { message: reason.to_string(), code: None, detail: None, hint: None, position: None });
                }
                Some(Failure::Stopped) => {
                    stopped = true;
                    outcome.cancelled = true;
                    session.tx = scanner::next_state(before, statement.info.tx, Outcome::Failed { code: Some(QUERY_CANCELED) });
                }
                Some(Failure::Database(error)) => {
                    let mut error = *error;
                    session.tx = scanner::next_state(before, statement.info.tx, Outcome::Failed { code: error.code.as_deref() });
                    // The server counts characters within the statement.
                    error.position = error.position.map(|p| offsets.to_utf16(statement.range.start + scanner::position_to_byte(text, p)));
                    outcome.error = Some(error);
                }
                Some(Failure::Lost(error)) => {
                    session_lost = Some(format!("{} The last statement's outcome is unknown.", lost_message(before)));
                    session.tx = TxState::Idle;
                    outcome.error = Some(*error);
                }
                Some(Failure::Closed) => {
                    self.clear_running();
                    *live = None;
                    return Ok(());
                }
            }
            outcome.tx = session.tx;
            emit(QueryEvent::StatementFinished { outcome: Box::new(outcome) });

            if session_lost.is_some() || stopped || (failed && !request.continue_on_error) {
                break;
            }
        }

        let tx = session.tx;
        self.clear_running();
        if session_lost.is_some() {
            *live = None;
        }
        emit(QueryEvent::RunDone { tx, stopped, session_lost });
        Ok(())
    }

    fn clear_running(&self) {
        *self.running.lock().unwrap() = None;
    }

    /// Runs one statement, always reading its stream to the end: a dropped
    /// stream would leave its error waiting for the next statement.
    async fn execute(&self, session: &mut Live, text: &str, info: Info, options: &PgConnectOptions) -> Executed {
        let mut closed = self.closed.subscribe();
        let in_transaction = session.tx != TxState::Idle;
        let pid = session.pid;
        let mut out = Executed::default();
        let mut result = ResultSet::default();
        let mut kept_bytes = 0;
        let mut seen_rows = false;
        let mut limit_cancel = false;
        let mut affected = None;
        let mut failure = None;

        let mut stream = sqlx::raw_sql(AssertSqlSafe(text)).fetch_many(&mut session.conn);
        loop {
            let item = tokio::select! {
                biased;
                _ = closed.wait_for(|closed| *closed) => {
                    out.failure = Some(Failure::Closed);
                    return out;
                }
                item = stream.next() => item,
            };
            match item {
                None => break,
                Some(Ok(Either::Left(done))) => *affected.get_or_insert(0) += done.rows_affected(),
                Some(Ok(Either::Right(row))) => {
                    if !seen_rows {
                        seen_rows = true;
                        result.columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if result.truncated {
                        continue;
                    }
                    if result.rows.len() < MAX_ROWS && kept_bytes < MAX_BYTES {
                        let values = row_text(&row);
                        kept_bytes += values.iter().flatten().map(String::len).sum::<usize>();
                        result.rows.push(values);
                        continue;
                    }
                    result.truncated = true;
                    // A cancel fails the statement, which would abort a
                    // transaction or undo a write. Those read on instead.
                    if info.plain_read && !in_transaction {
                        limit_cancel = cancel_backend(options, pid).await.is_ok();
                    }
                }
                Some(Err(e)) => {
                    failure = Some(e);
                    // The error ends the stream; keep reading to be sure of it.
                }
            }
        }
        drop(stream);

        out.rows_affected = affected;
        match failure {
            None => {}
            Some(sqlx::Error::Database(e)) => {
                let db = e.downcast_ref::<PgDatabaseError>();
                let error = query_error(db);
                let fatal = matches!(db.severity(), PgSeverity::Fatal | PgSeverity::Panic);
                if fatal {
                    out.failure = Some(Failure::Lost(Box::new(error)));
                } else if error.code.as_deref() == Some(QUERY_CANCELED) && limit_cancel {
                    // Our own cancel: this is the end of the rows we wanted.
                    result.cancelled_at_limit = true;
                } else if error.code.as_deref() == Some(QUERY_CANCELED) && self.stop.load(Ordering::SeqCst) {
                    out.failure = Some(Failure::Stopped);
                } else {
                    out.failure = Some(Failure::Database(Box::new(error)));
                }
            }
            Some(other) => {
                out.failure = Some(Failure::Lost(Box::new(QueryError { message: other.to_string(), code: None, detail: None, hint: None, position: None })));
            }
        }

        if out.failure.is_none() && !seen_rows && info.may_return_rows {
            result.columns = columns_of(session, text).await;
        }
        if !result.columns.is_empty() {
            out.result = Some(result);
        }
        out
    }

    /// Stop: ends the Run after its current statement, which is cancelled.
    /// `run_id` guards against a Stop that arrives after its Run ended.
    pub async fn cancel(&self, run_id: u64) -> Result<(), String> {
        self.cancel_if(|running| running.run_id == run_id).await
    }

    /// Holds `cancelling` throughout, so a Run that starts meanwhile waits and
    /// then clears `stop`, and this can't reach it.
    async fn cancel_if(&self, wanted: impl Fn(&Running) -> bool) -> Result<(), String> {
        let _cancelling = self.cancelling.lock().await;
        let running = self.running.lock().unwrap().clone().filter(wanted);
        let Some(running) = running else { return Ok(()) };
        self.stop.store(true, Ordering::SeqCst);
        cancel_backend(&running.options, running.pid).await
    }

    /// Commits or rolls back the open transaction, for the close prompt. The
    /// transaction is over afterwards either way.
    pub async fn end(&self, commit: bool) -> Result<(), String> {
        let mut live = self.live.try_lock().map_err(|_| "A query is running in this tab.")?;
        let Some(session) = live.as_mut() else { return Ok(()) };
        let before = session.tx;
        if before == TxState::Idle {
            return Ok(());
        }
        let sql = if commit && before == TxState::Open { "COMMIT" } else { "ROLLBACK" };
        let result = sqlx::raw_sql(sql).execute(&mut session.conn).await;
        match result {
            Ok(_) => session.tx = TxState::Idle,
            Err(e) => {
                let dead = e.as_database_error().is_none();
                session.tx = TxState::Idle;
                if dead {
                    *live = None;
                }
                return Err(e.to_string());
            }
        }
        if commit && before == TxState::Aborted {
            return Err("The transaction had failed, so it was rolled back.".into());
        }
        Ok(())
    }

    /// The tab closed: stops what's running and closes the connection, which
    /// rolls back any transaction.
    pub async fn close(&self) {
        self.closed.send_replace(true);
        let _ = self.cancel_if(|_| true).await;
        if let Some(session) = self.live.lock().await.take() {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, session.conn.close()).await;
        }
    }
}

/// What one statement did.
#[derive(Default)]
struct Executed {
    rows_affected: Option<u64>,
    result: Option<ResultSet>,
    failure: Option<Failure>,
}

enum Failure {
    /// huxdb didn't send it.
    Refused(&'static str),
    Stopped,
    Database(Box<QueryError>),
    /// The connection is gone.
    Lost(Box<QueryError>),
    /// The tab closed.
    Closed,
}

fn row_text(row: &sqlx::postgres::PgRow) -> Vec<Option<String>> {
    (0..row.len())
        .map(|i| {
            let value = row.try_get_raw(i).ok()?;
            if value.is_null() {
                return None;
            }
            // Lossy: users can `SET client_encoding`.
            value.as_bytes().ok().map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        })
        .collect()
}

fn query_error(db: &PgDatabaseError) -> QueryError {
    use sqlx::postgres::PgErrorPosition;
    QueryError {
        message: db.message().to_string(),
        code: Some(db.code().to_string()),
        detail: db.detail().map(str::to_string),
        hint: db.hint().map(str::to_string),
        position: match db.position() {
            Some(PgErrorPosition::Original(position)) => Some(position),
            _ => None,
        },
    }
}

/// A statement with no rows sends its columns only in a message sqlx keeps to
/// itself, so ask again without running it. A Parse that fails (a lock timeout,
/// say) would abort the user's transaction, so inside one it gets a savepoint.
/// Failing just means no columns to show.
async fn columns_of(session: &mut Live, text: &str) -> Vec<String> {
    let in_transaction = session.tx == TxState::Open;
    let conn = &mut session.conn;
    if in_transaction && sqlx::raw_sql("SAVEPOINT huxdb_columns").execute(&mut *conn).await.is_err() {
        return Vec::new();
    }
    let prepared = conn.prepare(AssertSqlSafe(text.to_string()).into_sql_str()).await;
    let columns = prepared.as_ref().map_or_else(|_| Vec::new(), |s| s.columns().iter().map(|c| c.name().to_string()).collect());
    if in_transaction {
        let end = if prepared.is_ok() { "RELEASE SAVEPOINT huxdb_columns" } else { "ROLLBACK TO SAVEPOINT huxdb_columns; RELEASE SAVEPOINT huxdb_columns" };
        let _ = sqlx::raw_sql(end).execute(&mut *conn).await;
    }
    let _ = conn.clear_cached_statements().await;
    columns
}

/// Collects the server's notices. sqlx sends them only to `tracing`, so this
/// subscribes for the length of a statement's future, which ties them to it
/// with no global state.
#[derive(Clone, Default)]
struct NoticeCollector {
    notices: Arc<Mutex<Vec<String>>>,
}

const NOTICE_TARGET: &str = "sqlx::postgres::notice";

impl NoticeCollector {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut self.notices.lock().unwrap())
    }
}

struct NoticeText<'a> {
    label: &'static str,
    notices: &'a mut Vec<String>,
}

impl tracing::field::Visit for NoticeText<'_> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.notices.push(format!("{}: {value}", self.label));
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.record_str(field, &format!("{value:?}"));
    }
}

impl tracing::Subscriber for NoticeCollector {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target() == NOTICE_TARGET
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::TRACE)
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let label = match *event.metadata().level() {
            tracing::Level::ERROR | tracing::Level::WARN => "WARNING",
            tracing::Level::INFO => "NOTICE",
            tracing::Level::DEBUG => "DEBUG",
            tracing::Level::TRACE => "INFO",
        };
        let mut notices = self.notices.lock().unwrap();
        if notices.len() < MAX_NOTICES {
            event.record(&mut NoticeText { label, notices: &mut notices });
        }
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::{ConnectionConfig, sample};
    use crate::connections::postgres::connect_options;

    /// Needs a live server: see `connects_to_live_server` in `connections/postgres.rs`.
    fn options() -> PgConnectOptions {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        connect_options(&ConnectionConfig { port, ..sample("live") }, "postgres")
    }

    #[derive(Default)]
    struct Done {
        outcomes: Vec<StatementOutcome>,
        tx: Option<TxState>,
        stopped: bool,
        lost: Option<String>,
    }

    impl Done {
        fn last(&self) -> &StatementOutcome {
            self.outcomes.last().expect("a statement ran")
        }

        fn rows(&self, index: usize) -> &Vec<Vec<Option<String>>> {
            &self.outcomes[index].result.as_ref().expect("a result").rows
        }
    }

    struct Tab {
        session: QuerySession,
        options: PgConnectOptions,
    }

    impl Tab {
        fn new() -> Self {
            Self { session: QuerySession::new("c"), options: options() }
        }

        async fn run_in(&self, schema: &str, sql: &str, continue_on_error: bool) -> Result<Done, String> {
            let done = Mutex::new(Done::default());
            let request = RunRequest { run_id: 1, options: self.options.clone(), database: "postgres", schema, sql, scope: Scope::All, continue_on_error };
            self.session
                .run(request, |event| {
                    let mut done = done.lock().unwrap();
                    match event {
                        QueryEvent::StatementStarted { .. } => {}
                        QueryEvent::StatementFinished { outcome } => done.outcomes.push(*outcome),
                        QueryEvent::RunDone { tx, stopped, session_lost } => {
                            done.tx = Some(tx);
                            done.stopped = stopped;
                            done.lost = session_lost;
                        }
                    }
                })
                .await?;
            Ok(done.into_inner().unwrap())
        }

        async fn run(&self, sql: &str) -> Done {
            self.run_in("", sql, false).await.unwrap()
        }

        async fn pid(&self) -> i32 {
            self.session.live.lock().await.as_ref().unwrap().pid
        }

        /// What the server says, to compare with what the tab tracked.
        async fn server_tx(&self) -> TxState {
            let mut live = self.session.live.lock().await;
            let conn = &mut live.as_mut().unwrap().conn;
            match sqlx::raw_sql("SAVEPOINT huxdb_probe").execute(&mut *conn).await {
                Ok(_) => {
                    sqlx::raw_sql("RELEASE SAVEPOINT huxdb_probe").execute(&mut *conn).await.unwrap();
                    TxState::Open
                }
                Err(e) if e.as_database_error().unwrap().code().as_deref() == Some("25P02") => TxState::Aborted,
                Err(_) => TxState::Idle,
            }
        }

        async fn assert_tx(&self, sql: &str, expected: TxState) {
            let done = self.run_in("", sql, true).await.unwrap();
            assert_eq!(done.tx, Some(expected), "tracked after {sql}");
            assert_eq!(self.server_tx().await, expected, "server after {sql}");
        }
    }

    fn text(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    #[tokio::test]
    #[ignore]
    async fn runs_a_script_and_reports_each_statement() {
        let tab = Tab::new();
        let done = tab.run("create temp table t (a int); insert into t values (1), (null); select a, a as a from t order by 1;").await;
        assert_eq!(done.outcomes.len(), 3);
        assert!(done.outcomes[0].result.is_none());
        assert_eq!(done.outcomes[1].rows_affected, Some(2));
        let result = done.outcomes[2].result.as_ref().unwrap();
        assert_eq!(result.columns, ["a", "a"]);
        assert_eq!(result.rows, vec![vec![text("1"), text("1")], vec![None, None]]);
        assert_eq!(done.tx, Some(TxState::Idle));
    }

    #[tokio::test]
    #[ignore]
    async fn empty_results_still_have_columns() {
        let tab = Tab::new();
        tab.run("create temp table t (a int, b text)").await;
        let done = tab.run("select * from t; delete from t returning b; update t set a = 1; select a from t where false").await;
        assert_eq!(done.outcomes[0].result.as_ref().unwrap().columns, ["a", "b"]);
        assert_eq!(done.outcomes[1].result.as_ref().unwrap().columns, ["b"]);
        assert!(done.outcomes[2].result.is_none());
        assert_eq!(done.outcomes[3].result.as_ref().unwrap().columns, ["a"]);

        // Columns aren't cached across a table change, and nothing stays prepared.
        tab.run("alter table t add c int").await;
        let done = tab.run("select * from t").await;
        assert_eq!(done.last().result.as_ref().unwrap().columns, ["a", "b", "c"]);
        let done = tab.run("select count(*) from pg_prepared_statements").await;
        assert_eq!(done.rows(0)[0][0], text("0"));

        // Inside a transaction it stays usable.
        let done = tab.run("begin; select * from t; select 1").await;
        assert_eq!(done.tx, Some(TxState::Open));
        assert_eq!(tab.server_tx().await, TxState::Open);
        tab.run("rollback").await;
    }

    #[tokio::test]
    #[ignore]
    async fn a_plain_read_stops_at_the_limit() {
        let tab = Tab::new();
        let done = tab.run("select count(*) from pg_prepared_statements").await;
        assert_eq!(done.rows(0)[0][0], text("0"));
        // In the select list it streams; in FROM the server builds it all first.
        let began = Instant::now();
        let done = tab.run("select generate_series(1, 100000000); select 42").await;
        println!("capped read took {:?}", began.elapsed());
        let result = done.outcomes[0].result.as_ref().unwrap();
        assert_eq!(result.rows.len(), MAX_ROWS);
        assert!(result.truncated && result.cancelled_at_limit);
        assert!(done.outcomes[0].error.is_none());
        assert_eq!(done.rows(1)[0][0], text("42"));
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    #[ignore]
    async fn exactly_the_limit_is_not_truncated() {
        let tab = Tab::new();
        let done = tab.run(&format!("select generate_series(1, {MAX_ROWS})")).await;
        let result = done.last().result.as_ref().unwrap();
        assert_eq!(result.rows.len(), MAX_ROWS);
        assert!(!result.truncated && !result.cancelled_at_limit);
        assert_eq!(done.last().rows_affected, Some(MAX_ROWS as u64));

        // One more is: the rows kept stay at the limit, and the statement is stopped.
        let done = tab.run(&format!("select generate_series(1, {})", MAX_ROWS + 1)).await;
        let result = done.last().result.as_ref().unwrap();
        assert_eq!(result.rows.len(), MAX_ROWS);
        assert!(result.truncated);
    }

    #[tokio::test]
    #[ignore]
    async fn a_read_inside_a_transaction_reads_on_and_keeps_it() {
        let tab = Tab::new();
        let done = tab.run("begin; select g from generate_series(1, 12000) g").await;
        let result = done.last().result.as_ref().unwrap();
        assert_eq!(result.rows.len(), MAX_ROWS);
        assert!(result.truncated && !result.cancelled_at_limit);
        assert_eq!(done.last().rows_affected, Some(12000));
        assert_eq!(done.tx, Some(TxState::Open));
        assert_eq!(tab.server_tx().await, TxState::Open);
        tab.run("rollback").await;
    }

    #[tokio::test]
    #[ignore]
    async fn a_write_past_the_limit_is_kept() {
        let tab = Tab::new();
        tab.run("create temp table t as select g as a from generate_series(1, 12000) g").await;
        let done = tab.run("update t set a = -a returning a").await;
        assert!(done.last().result.as_ref().unwrap().truncated);
        assert_eq!(tab.run("select count(*) from t where a < 0").await.rows(0)[0][0], text("12000"));
        tab.run("with d as (delete from t returning a) select * from d").await;
        assert_eq!(tab.run("select count(*) from t").await.rows(0)[0][0], text("0"));
    }

    #[tokio::test]
    #[ignore]
    async fn tracked_transaction_state_matches_the_server() {
        use TxState::*;
        let tab = Tab::new();
        tab.assert_tx("create temp table d (a int primary key, b int references d deferrable initially deferred)", Idle).await;
        tab.assert_tx("select 1/0", Idle).await;
        tab.assert_tx("begin", Open).await;
        tab.assert_tx("select 1", Open).await;
        tab.assert_tx("select 1/0", Aborted).await;
        tab.assert_tx("select 1", Aborted).await;
        let done = tab.run("commit").await;
        assert!(done.last().note.is_some(), "commit of a failed transaction says it rolled back");
        assert_eq!(tab.server_tx().await, Idle);

        tab.assert_tx("begin; savepoint s; select 1/0", Aborted).await;
        tab.assert_tx("rollback to nope", Aborted).await;
        tab.assert_tx("rollback to s", Open).await;
        tab.assert_tx("rollback and chain", Open).await;
        tab.assert_tx("commit and chain", Open).await;
        tab.assert_tx("insert into d values (1, 99)", Open).await;
        tab.assert_tx("commit", Idle).await; // Failed on the deferred constraint.
        tab.assert_tx("begin; prepare transaction 'x'", Idle).await; // Disabled by default, which fails.
        tab.assert_tx("do $$ begin insert into d values (2); commit; end $$", Idle).await;
        tab.assert_tx("begin; do $$ begin commit; end $$", Aborted).await;
        tab.assert_tx("abort", Idle).await;
    }

    #[tokio::test]
    #[ignore]
    async fn stops_at_the_first_error_unless_told_otherwise() {
        let tab = Tab::new();
        let done = tab.run("select 1/0; select 1").await;
        assert_eq!(done.outcomes.len(), 1);
        assert_eq!(done.last().error.as_ref().unwrap().code.as_deref(), Some("22012"));
        let done = tab.run_in("", "select 1/0; select 1", true).await.unwrap();
        assert_eq!(done.outcomes.len(), 2);
        assert!(done.last().error.is_none());
    }

    #[tokio::test]
    #[ignore]
    async fn refuses_what_the_connection_cannot_carry() {
        let tab = Tab::new();
        let done = tab.run_in("", "copy pg_class to stdout; listen ch; select 1", true).await.unwrap();
        assert!(done.outcomes[0].error.as_ref().unwrap().code.is_none());
        assert!(done.outcomes[1].error.as_ref().unwrap().code.is_none());
        assert_eq!(done.rows(2)[0][0], text("1"));
    }

    #[tokio::test]
    #[ignore]
    async fn error_positions_are_offsets_into_the_text() {
        let tab = Tab::new();
        let sql = "select '😀';\nselect 'é😀', nope";
        let done = tab.run(sql).await;
        let position = done.last().error.as_ref().unwrap().position.unwrap();
        assert_eq!(position, sql.encode_utf16().count() - "nope".len());
    }

    #[tokio::test]
    #[ignore]
    async fn notices_belong_to_their_statement() {
        let tab = Tab::new();
        let done = tab.run("do $$ begin raise notice 'one'; raise warning 'two'; end $$; select 1; do $$ begin raise notice 'three'; end $$").await;
        assert_eq!(done.outcomes[0].notices, ["NOTICE: one", "WARNING: two"]);
        assert!(done.outcomes[1].notices.is_empty());
        assert_eq!(done.outcomes[2].notices, ["NOTICE: three"]);
    }

    #[tokio::test]
    #[ignore]
    async fn the_schema_sets_the_search_path() {
        let tab = Tab::new();
        let show = "show search_path";
        let server_default = tab.run(show).await.rows(0)[0][0].clone();
        let done = tab.run_in("pg_catalog", show, false).await.unwrap();
        assert_eq!(done.rows(0)[0][0], text("pg_catalog, public"));
        let done = tab.run_in("public", show, false).await.unwrap();
        assert_eq!(done.rows(0)[0][0], text("public"));
        assert_eq!(tab.run(show).await.rows(0)[0][0], server_default);
    }

    #[tokio::test]
    #[ignore]
    async fn stop_cancels_and_ends_the_run() {
        let tab = Tab::new();
        tab.run("begin").await;
        let (done, _) = tokio::join!(tab.run("select pg_sleep(30); select 1"), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tab.session.cancel(1).await.unwrap();
        });
        assert!(done.stopped);
        assert_eq!(done.outcomes.len(), 1);
        assert!(done.last().cancelled && done.last().error.is_none());
        // As in psql, a cancel inside a transaction aborts it.
        assert_eq!(done.tx, Some(TxState::Aborted));
        assert_eq!(tab.server_tx().await, TxState::Aborted);
        tab.run("rollback").await;

        // A stale Stop does nothing.
        tab.session.cancel(99).await.unwrap();
        assert_eq!(tab.run("select 1").await.outcomes.len(), 1);
    }

    #[tokio::test]
    #[ignore]
    async fn a_dead_connection_runs_nothing_and_says_so() {
        let tab = Tab::new();
        tab.run("set work_mem = '7MB'; begin").await;
        let pid = tab.pid().await;
        let other = Tab::new();
        other.run(&format!("select pg_terminate_backend({pid})")).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let done = tab.run("create temp table should_not_exist (a int)").await;
        assert!(done.outcomes.is_empty());
        assert!(done.lost.unwrap().contains("transaction was rolled back"));
        assert_eq!(done.tx, Some(TxState::Idle));

        let done = tab.run("select count(*) from pg_class where relname = 'should_not_exist'; show work_mem").await;
        assert_eq!(done.rows(0)[0][0], text("0"));
        assert_ne!(done.rows(1)[0][0], text("7MB"));
    }

    #[tokio::test]
    #[ignore]
    async fn a_failed_reconnect_still_says_what_was_lost() {
        let mut tab = Tab::new();
        tab.run("begin").await;
        let pid = tab.pid().await;
        Tab::new().run(&format!("select pg_terminate_backend({pid})")).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let working = std::mem::replace(&mut tab.options, options().port(1));
        let done = tab.run("select 1").await;
        assert!(done.outcomes.is_empty());
        let lost = done.lost.unwrap();
        assert!(lost.contains("transaction was rolled back") && lost.contains("reconnecting failed"), "{lost}");
        assert_eq!(done.tx, Some(TxState::Idle));

        tab.options = working;
        assert_eq!(tab.run("select 1").await.outcomes.len(), 1);
    }

    #[tokio::test]
    #[ignore]
    async fn a_connection_dying_during_a_run_ends_it() {
        let tab = Tab::new();
        tab.run("select 1").await;
        let pid = tab.pid().await;
        let other = Tab::new();
        let (done, _) = tokio::join!(tab.run("select pg_sleep(30); select 1"), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            other.run(&format!("select pg_terminate_backend({pid})")).await;
        });
        assert_eq!(done.outcomes.len(), 1);
        assert!(done.lost.is_some());
        assert_eq!(done.tx, Some(TxState::Idle));
        assert_eq!(tab.run("select 1").await.outcomes.len(), 1);
    }

    #[tokio::test]
    #[ignore]
    async fn closing_ends_a_running_statement() {
        let tab = Tab::new();
        let began = Instant::now();
        let (_, _) = tokio::join!(tab.session.run(
            RunRequest { run_id: 1, options: tab.options.clone(), database: "postgres", schema: "", sql: "select pg_sleep(30)", scope: Scope::All, continue_on_error: false },
            |_| {},
        ), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tab.session.close().await;
        });
        assert!(began.elapsed() < Duration::from_secs(10));
        assert!(tab.session.live.lock().await.is_none());
    }

    #[tokio::test]
    #[ignore]
    async fn the_close_prompt_ends_the_transaction() {
        let tab = Tab::new();
        tab.run("create temp table t (a int); begin; insert into t values (1)").await;
        tab.session.end(true).await.unwrap();
        assert_eq!(tab.server_tx().await, TxState::Idle);
        assert_eq!(tab.run("select count(*) from t").await.rows(0)[0][0], text("1"));

        tab.run("begin; insert into t values (2)").await;
        tab.session.end(false).await.unwrap();
        assert_eq!(tab.run("select count(*) from t").await.rows(0)[0][0], text("1"));

        tab.run_in("", "begin; select 1/0", true).await.unwrap();
        assert!(tab.session.end(true).await.unwrap_err().contains("rolled back"));
        assert_eq!(tab.server_tx().await, TxState::Idle);
    }
}
