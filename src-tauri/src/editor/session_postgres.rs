//! A tab's database session: an optional user transaction held on one pooled
//! connection across commands, and Stop for whatever the tab is running.
//!
//! Not specific to table data, so a SQL query editor can reuse it.

use sqlx::pool::PoolConnection;
use sqlx::{PgConnection, PgPool, Postgres};
use tokio::sync::{Mutex, MutexGuard};

/// The error text of a statement stopped with Stop. The UI shows it as a
/// notice rather than an error.
pub const CANCELLED: &str = "Cancelled";

/// Like the designer's error text, but a cancelled statement becomes [`CANCELLED`].
pub fn err(e: sqlx::Error) -> String {
    if let Some(db) = e.as_database_error() {
        // 57014 is also a statement timeout; only Stop says "user request".
        if db.code().as_deref() == Some("57014") && db.message().contains("user request") {
            return CANCELLED.to_string();
        }
    }
    e.to_string()
}

async fn execute(conn: &mut PgConnection, sql: &'static str) -> Result<(), String> {
    sqlx::raw_sql(sql).execute(conn).await.map(drop).map_err(err)
}

async fn backend_pid(conn: &mut PgConnection) -> Result<i32, String> {
    sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(conn).await.map_err(err)
}

/// The connection an open transaction runs on.
struct Held {
    conn: PoolConnection<Postgres>,
    pid: i32,
    /// The transaction was ended, so the connection can go back to the pool.
    ended: bool,
}

impl Drop for Held {
    fn drop(&mut self) {
        // Never hand a connection that may still be in a transaction to the
        // pool; closing it makes the server roll back.
        if !self.ended {
            self.conn.close_on_drop();
        }
    }
}

/// One tab's session. Operations on it run one at a time.
pub struct HeldSession {
    pub connection_id: String,
    held: Mutex<Option<Held>>,
    /// Backend pid of the statement in progress, readable without `held`
    /// (which the running operation holds) so Stop can cancel it.
    running: std::sync::Mutex<Option<i32>>,
}

impl HeldSession {
    pub fn new(connection_id: &str) -> Self {
        Self { connection_id: connection_id.to_string(), held: Mutex::new(None), running: Default::default() }
    }

    /// Begins a transaction on a connection the session keeps until [`end`](Self::end).
    pub async fn begin(&self, pool: &PgPool) -> Result<(), String> {
        let mut held = self.held.lock().await;
        if held.is_some() {
            return Err("A transaction is already open.".into());
        }
        let mut conn = pool.acquire().await.map_err(err)?;
        let pid = backend_pid(&mut conn).await?;
        execute(&mut conn, "BEGIN").await?;
        *held = Some(Held { conn, pid, ended: false });
        Ok(())
    }

    /// Commits or rolls back the open transaction and releases its connection.
    /// The transaction is gone afterwards even if COMMIT fails.
    pub async fn end(&self, commit: bool) -> Result<(), String> {
        let mut held = self.held.lock().await;
        let Some(mut h) = held.take() else {
            return Err("No transaction is open.".into());
        };
        execute(&mut h.conn, if commit { "COMMIT" } else { "ROLLBACK" }).await?;
        h.ended = true;
        Ok(())
    }

    /// A connection for one operation: the transaction's, if one is open,
    /// otherwise one from `pool`. Waits for the session's previous operation.
    pub async fn lease(&self, pool: &PgPool) -> Result<Lease<'_>, String> {
        let guard = self.held.lock().await;
        let (pooled, pid) = match guard.as_ref() {
            Some(h) => (None, h.pid),
            None => {
                let mut conn = pool.acquire().await.map_err(err)?;
                let pid = backend_pid(&mut conn).await?;
                (Some(conn), pid)
            }
        };
        *self.running.lock().unwrap() = Some(pid);
        Ok(Lease { guard, pooled, running: &self.running, scope_open: false })
    }

    /// Cancels the statement the session is running, if any (Stop). It fails
    /// with [`CANCELLED`]; the transaction, if any, stays usable.
    pub async fn cancel(&self, pool: &PgPool) -> Result<(), String> {
        let pid = *self.running.lock().unwrap();
        if let Some(pid) = pid {
            sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(pool).await.map_err(err)?;
        }
        Ok(())
    }
}

/// A connection leased by [`HeldSession::lease`]. Work runs inside a scope
/// (a savepoint inside the user's transaction, otherwise a transaction of
/// its own) so a failed or cancelled operation never aborts the user's
/// transaction.
pub struct Lease<'a> {
    guard: MutexGuard<'a, Option<Held>>,
    pooled: Option<PoolConnection<Postgres>>,
    running: &'a std::sync::Mutex<Option<i32>>,
    scope_open: bool,
}

impl Lease<'_> {
    /// Whether the user's transaction is open.
    pub fn in_transaction(&self) -> bool {
        self.pooled.is_none()
    }

    pub fn conn(&mut self) -> &mut PgConnection {
        match &mut self.pooled {
            Some(conn) => conn,
            None => &mut self.guard.as_mut().expect("lease without a connection").conn,
        }
    }

    pub async fn open_scope(&mut self) -> Result<(), String> {
        let sql = if self.in_transaction() { "SAVEPOINT huxdb_op" } else { "BEGIN" };
        execute(self.conn(), sql).await?;
        self.scope_open = true;
        Ok(())
    }

    /// A scope that can't write, for anything that may run the user's SQL. It
    /// has to be set before the scope's first query. Closing the scope undoes
    /// it, also in a savepoint, so the user's transaction stays read-write.
    pub async fn open_read_scope(&mut self) -> Result<(), String> {
        self.open_scope().await?;
        let read_only = execute(self.conn(), "SET TRANSACTION READ ONLY").await;
        if read_only.is_err() {
            self.close_scope(false).await?;
        }
        read_only
    }

    /// Ends the scope, keeping its work or undoing it.
    pub async fn close_scope(&mut self, keep: bool) -> Result<(), String> {
        let sql = match (self.in_transaction(), keep) {
            (true, true) => "RELEASE SAVEPOINT huxdb_op",
            (true, false) => "ROLLBACK TO SAVEPOINT huxdb_op; RELEASE SAVEPOINT huxdb_op",
            (false, true) => "COMMIT",
            (false, false) => "ROLLBACK",
        };
        execute(self.conn(), sql).await?;
        self.scope_open = false;
        Ok(())
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        *self.running.lock().unwrap() = None;
        // A scope left open (its close failed) may leave a pooled connection
        // mid-transaction; don't return it to the pool.
        if self.scope_open
            && let Some(conn) = &mut self.pooled
        {
            conn.close_on_drop();
        }
    }
}
