//! PostgreSQL-specific connection code. Other engines will get sibling modules.

use std::time::Duration;

use sqlx::Connection;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgSslMode};

use super::model::{ConnectionConfig, SslMode};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn connect_options(config: &ConnectionConfig) -> PgConnectOptions {
    let ssl_mode = match config.ssl_mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    };
    let mut options = PgConnectOptions::new_without_pgpass()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(&config.password)
        .ssl_mode(ssl_mode)
        .application_name("huxdb");
    if let Some(db) = &config.database {
        options = options.database(db);
    }
    options
}

/// Opens a connection, asks the server for its version, and closes it again.
pub async fn test_connection(config: &ConnectionConfig) -> Result<String, String> {
    let options = connect_options(config);
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
