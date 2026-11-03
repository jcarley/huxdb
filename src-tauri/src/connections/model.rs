use serde::{Deserialize, Serialize};

/// SSL negotiation mode, mirroring libpq's `sslmode` values.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// A saved PostgreSQL connection profile.
///
/// Serialized with camelCase keys so the same shape is used on disk and over the
/// Tauri IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    /// Empty for a connection that has not been saved yet; the store assigns one.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Stored in plaintext in the connections file (user decision for v1).
    #[serde(default)]
    pub password: String,
    /// Initial database; when absent PostgreSQL defaults to the username.
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Hex color tag shown in the sidebar, e.g. `#ef4444`.
    #[serde(default)]
    pub color: Option<String>,
}

impl ConnectionConfig {
    /// Trims text fields and turns blank optional fields into `None`.
    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self.host = self.host.trim().to_string();
        self.username = self.username.trim().to_string();
        self.database = self
            .database
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        self.color = self.color.filter(|c| !c.trim().is_empty());
        self
    }

    /// Checks the fields that must be present for a usable connection.
    /// Expects a value that has already been through [`normalized`](Self::normalized).
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("Connection name is required.".into());
        }
        if self.host.is_empty() {
            return Err("Host is required.".into());
        }
        if self.port == 0 {
            return Err("Port must be between 1 and 65535.".into());
        }
        if self.username.is_empty() {
            return Err("User name is required.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn sample(name: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: name.into(),
        host: "localhost".into(),
        port: 5432,
        username: "postgres".into(),
        password: "secret".into(),
        database: None,
        ssl_mode: SslMode::Prefer,
        color: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_trims_and_drops_blank_optionals() {
        let mut c = sample("  prod  ");
        c.database = Some("   ".into());
        c.color = Some("".into());
        let c = c.normalized();
        assert_eq!(c.name, "prod");
        assert_eq!(c.database, None);
        assert_eq!(c.color, None);
    }

    #[test]
    fn validate_rejects_missing_required_fields() {
        assert!(sample("ok").validate().is_ok());
        assert!(sample("").validate().is_err());
        assert!(ConnectionConfig { host: "".into(), ..sample("a") }.validate().is_err());
        assert!(ConnectionConfig { port: 0, ..sample("a") }.validate().is_err());
        assert!(ConnectionConfig { username: "".into(), ..sample("a") }.validate().is_err());
    }

    #[test]
    fn ssl_mode_uses_libpq_spelling() {
        let json = serde_json::to_string(&SslMode::VerifyFull).unwrap();
        assert_eq!(json, "\"verify-full\"");
    }
}
