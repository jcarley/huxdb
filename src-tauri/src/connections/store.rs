use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::model::ConnectionConfig;
use crate::fsutil;

/// Saved connections, kept in memory and mirrored to a JSON file.
pub struct ConnectionStore {
    path: PathBuf,
    connections: Mutex<Vec<ConnectionConfig>>,
}

impl ConnectionStore {
    /// Loads the store from `path`. A missing file means no connections yet.
    /// A file that can't be parsed is renamed aside (so it is never silently
    /// overwritten) and the store starts empty.
    pub fn load(path: PathBuf) -> Self {
        let connections = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(list) => list,
                Err(err) => {
                    let backup = path.with_extension("json.corrupt");
                    eprintln!(
                        "huxdb: could not parse {} ({err}); moving it to {}",
                        path.display(),
                        backup.display()
                    );
                    let _ = fs::rename(&path, &backup);
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self {
            path,
            connections: Mutex::new(connections),
        }
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.connections.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionConfig> {
        self.connections.lock().unwrap().iter().find(|c| c.id == id).cloned()
    }

    /// Creates (empty `id`) or updates (existing `id`) a connection and persists
    /// the whole list. Returns the saved connection with its id filled in.
    pub fn save(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        let mut config = config.normalized();
        config.validate()?;

        let mut list = self.connections.lock().unwrap();
        let name_taken = list
            .iter()
            .any(|c| c.id != config.id && c.name.eq_ignore_ascii_case(&config.name));
        if name_taken {
            return Err(format!("A connection named \"{}\" already exists.", config.name));
        }

        let mut next = list.clone();
        if config.id.is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
            next.push(config.clone());
        } else {
            let slot = next
                .iter_mut()
                .find(|c| c.id == config.id)
                .ok_or("That connection no longer exists.")?;
            *slot = config.clone();
        }

        write_atomic(&self.path, &next)?;
        *list = next;
        Ok(config)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut list = self.connections.lock().unwrap();
        let next: Vec<_> = list.iter().filter(|c| c.id != id).cloned().collect();
        if next.len() == list.len() {
            return Err("That connection no longer exists.".into());
        }
        write_atomic(&self.path, &next)?;
        *list = next;
        Ok(())
    }
}

/// Saves the list. It holds plaintext passwords, which `write_atomic`'s owner-only
/// default covers.
fn write_atomic(path: &Path, list: &[ConnectionConfig]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    fsutil::write_atomic(path, &json, None).map_err(|e| format!("Could not save connections: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::model::sample;
    use super::*;

    fn store_in(dir: &tempfile::TempDir) -> ConnectionStore {
        ConnectionStore::load(dir.path().join("connections.json"))
    }

    #[test]
    fn create_update_delete_round_trip_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);

        let saved = store.save(sample("local")).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(store.get(&saved.id), Some(saved.clone()));

        let renamed = store
            .save(ConnectionConfig { name: "local-dev".into(), ..saved.clone() })
            .unwrap();
        assert_eq!(renamed.id, saved.id);

        let reloaded = store_in(&dir).list();
        assert_eq!(reloaded, vec![renamed.clone()]);

        store.delete(&renamed.id).unwrap();
        assert!(store_in(&dir).list().is_empty());
    }

    #[test]
    fn rejects_duplicate_names_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save(sample("Prod")).unwrap();
        assert!(store.save(sample("prod")).is_err());
    }

    #[test]
    fn rejects_invalid_config_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert!(store.save(sample("  ")).is_err());
        assert!(!dir.path().join("connections.json").exists());
    }

    #[test]
    fn unknown_ids_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert!(store.delete("nope").is_err());
        assert!(store
            .save(ConnectionConfig { id: "nope".into(), ..sample("x") })
            .is_err());
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        fs::write(&path, "not json").unwrap();
        let store = ConnectionStore::load(path.clone());
        assert!(store.list().is_empty());
        assert!(dir.path().join("connections.json.corrupt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save(sample("local")).unwrap();
        let mode = fs::metadata(dir.path().join("connections.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
