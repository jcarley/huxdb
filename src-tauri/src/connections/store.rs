use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::model::ConnectionConfig;

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

/// Writes to a temp file in the same directory, then renames it over the target
/// so a crash mid-write can't leave a truncated file. The file holds plaintext
/// passwords, so on Unix it is created readable by the owner only.
fn write_atomic(path: &Path, list: &[ConnectionConfig]) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("Could not save connections: {e}");
    let dir = path.parent().ok_or("Invalid connections file path.")?;
    fs::create_dir_all(dir).map_err(fail)?;

    let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(fail)?;
    file.write_all(&json).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    drop(file);

    fs::rename(&tmp, path).map_err(fail)
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
