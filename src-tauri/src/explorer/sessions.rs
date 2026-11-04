use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::connections::model::ConnectionConfig;
use crate::connections::postgres::{CONNECT_TIMEOUT, connect_options};

/// Each data editor tab with an open transaction keeps one connection, and
/// Stop needs a spare to send its cancel request, so leave room beyond the
/// tree's and designers' short queries.
const MAX_CONNECTIONS: u32 = 8;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Open connection pools, one per (saved connection id, database). PostgreSQL
/// connections are bound to a single database, so browsing another database in the
/// tree needs its own pool.
#[derive(Default)]
pub struct SessionManager {
    /// Each pool remembers the settings it was built from (see [`pool`](Self::pool)).
    pools: Mutex<HashMap<(String, String), (ConnectionConfig, PgPool)>>,
}

impl SessionManager {
    /// Returns the pool for `config` + `database`, creating it if needed. Pools connect
    /// lazily, so bad credentials surface as an error on the first query. A cached pool
    /// built from different settings (the connection was edited) is replaced, so a request
    /// racing with a save can't leave a stale-credential pool behind.
    /// Must be called inside a Tokio runtime.
    pub fn pool(&self, config: &ConnectionConfig, database: &str) -> PgPool {
        let key = (config.id.clone(), database.to_string());
        let mut pools = self.pools.lock().unwrap();
        if let Some((built_from, pool)) = pools.get(&key) {
            if built_from == config {
                return pool.clone();
            }
            close_in_background(pool.clone());
        }
        let pool = PgPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(CONNECT_TIMEOUT)
            .idle_timeout(IDLE_TIMEOUT)
            .connect_lazy_with(connect_options(config, database));
        pools.insert(key, (config.clone(), pool.clone()));
        pool
    }

    /// Removes every pool belonging to `connection_id` and closes them in the background.
    pub fn close(&self, connection_id: &str) {
        let mut pools = self.pools.lock().unwrap();
        pools.retain(|(id, _), (_, pool)| {
            let keep = id != connection_id;
            if !keep {
                close_in_background(pool.clone());
            }
            keep
        });
    }

    #[cfg(test)]
    fn keys(&self) -> Vec<(String, String)> {
        let mut keys: Vec<_> = self.pools.lock().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }
}

fn close_in_background(pool: PgPool) {
    tauri::async_runtime::spawn(async move { pool.close().await });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::sample;

    fn with_id(id: &str) -> ConnectionConfig {
        ConnectionConfig { id: id.into(), ..sample(id) }
    }

    #[tokio::test]
    async fn pools_are_reused_per_database_and_closed_per_connection() {
        let sessions = SessionManager::default();
        let (a, b) = (with_id("a"), with_id("b"));

        sessions.pool(&a, "db1");
        sessions.pool(&a, "db1");
        sessions.pool(&a, "db2");
        sessions.pool(&b, "db1");
        assert_eq!(sessions.keys().len(), 3);

        sessions.close("a");
        assert_eq!(sessions.keys(), vec![("b".to_string(), "db1".to_string())]);
    }

    #[tokio::test]
    async fn edited_settings_replace_the_cached_pool() {
        let sessions = SessionManager::default();
        let old = with_id("a");
        let first = sessions.pool(&old, "db");
        assert!(!first.is_closed());

        let edited = ConnectionConfig { password: "new".into(), ..old.clone() };
        sessions.pool(&edited, "db");
        // Closing runs on Tauri's runtime; give it a moment.
        for _ in 0..100 {
            if first.is_closed() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(first.is_closed());
        assert_eq!(sessions.keys().len(), 1);
    }
}
