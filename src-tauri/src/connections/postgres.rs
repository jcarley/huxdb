//! PostgreSQL-specific connection code. Other engines will get sibling modules.

use std::time::Duration;

use sqlx::Connection;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgSslMode};

use super::model::{ConnectionConfig, SslMode};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Database to connect to when the user hasn't set an Initial Database. Like Navicat,
/// use `postgres` rather than libpq's default of a database named after the user,
/// which often doesn't exist.
const DEFAULT_DATABASE: &str = "postgres";

pub(crate) fn initial_database(config: &ConnectionConfig) -> &str {
    config.database.as_deref().unwrap_or(DEFAULT_DATABASE)
}

/// Connect options for `config`, targeting `database` (a connection can't switch
/// databases once open, so each database needs its own options/pool).
pub(crate) fn connect_options(config: &ConnectionConfig, database: &str) -> PgConnectOptions {
    let ssl_mode = match config.ssl_mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    };
    PgConnectOptions::new_without_pgpass()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(&config.password)
        .ssl_mode(ssl_mode)
        .application_name("huxdb")
        .database(database)
}

/// Opens a connection, asks the server for its version, and closes it again.
pub async fn test_connection(config: &ConnectionConfig) -> Result<String, String> {
    let options = connect_options(config, initial_database(config));
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect_with(&options))
        .await
        .map_err(|_| format!("Timed out after {} seconds.", CONNECT_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;

    let version: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let _ = conn.close().await;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::sample;

    /// Needs a live server: `HUXDB_TEST_PG_PORT=5432 cargo test -- --ignored`
    /// (expects user `postgres`, password `secret` on localhost).
    #[tokio::test]
    #[ignore]
    async fn connects_to_live_server() {
        let port: u16 = std::env::var("HUXDB_TEST_PG_PORT").unwrap().parse().unwrap();
        let config = ConnectionConfig { port, ..sample("live") };
        let version = test_connection(&config).await.unwrap();
        assert!(version.starts_with("PostgreSQL"), "{version}");

        let bad = ConnectionConfig { password: "wrong".into(), ..config };
        assert!(test_connection(&bad).await.is_err());
    }
}
