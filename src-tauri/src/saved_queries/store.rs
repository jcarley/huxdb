//! Saved queries on disk, one directory per connection id:
//!
//! ```text
//! queries/<connection id>/<query id>.sql    the text, and nothing else
//! queries/<connection id>/<query id>.json   name, database, schema
//! ```
//!
//! A query's name lives only in the sidecar, so any name works on any file
//! system and a rename is one atomic write. The `.sql` file decides whether a
//! query exists: one with a missing or corrupt sidecar is still listed, under
//! its file name, and a sidecar with no `.sql` is ignored. That also means a
//! `.sql` file dropped into the directory shows up as a query.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::CHANGED_MARKER;
use crate::fsutil::{modified_ms, write_atomic};

const MAX_NAME_CHARS: usize = 200;

/// What the list shows about a query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryInfo {
    pub id: String,
    pub name: String,
    /// The default target. Empty when the sidecar is missing.
    pub database: String,
    pub schema: String,
    /// Milliseconds since the epoch.
    pub modified_ms: Option<u64>,
    pub size: u64,
}

/// A query with its text, for opening it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    #[serde(flatten)]
    pub info: SavedQueryInfo,
    pub sql: String,
}

/// What deleting a connection would affect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuerySummary {
    pub count: usize,
    pub dir: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Sidecar {
    name: String,
    database: String,
    schema: String,
}

pub struct SavedQueryStore {
    root: PathBuf,
    /// One operation at a time, so a name can't be taken between its check and its write.
    lock: Mutex<()>,
}

/// Ids become path parts, and come from the frontend or a file name. A colon
/// would make a Windows path absolute, or name an NTFS stream.
fn path_part(id: &str) -> Result<&str, String> {
    let bad = id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':', '\0']);
    if bad { Err("Invalid query or connection id.".into()) } else { Ok(id) }
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name for the query.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A query name can have at most {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

/// `<name> copy`, then `<name> copy 2` and so on, whichever is free.
fn copy_name(name: &str, taken: &[String]) -> String {
    let is_taken = |candidate: &str| taken.iter().any(|t| t.to_lowercase() == candidate.to_lowercase());
    let first = format!("{name} copy");
    if !is_taken(&first) {
        return first;
    }
    (2..).map(|n| format!("{name} copy {n}")).find(|c| !is_taken(c)).expect("a free number")
}

fn io_error(action: &str) -> impl Fn(io::Error) -> String {
    move |e| format!("Could not {action}: {e}")
}

impl SavedQueryStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root, lock: Mutex::new(()) }
    }

    fn dir(&self, connection_id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join(path_part(connection_id)?))
    }

    /// The query's two files, for an id that is safe to join.
    fn paths(&self, connection_id: &str, id: &str) -> Result<(PathBuf, PathBuf), String> {
        let dir = self.dir(connection_id)?;
        let id = path_part(id)?;
        Ok((dir.join(format!("{id}.sql")), dir.join(format!("{id}.json"))))
    }

    /// The sidecar, if there's a good one. A corrupt one is moved aside, so it
    /// is never silently overwritten, and the query lives on under its file name.
    fn read_sidecar(path: &Path) -> Option<Sidecar> {
        let text = fs::read_to_string(path).ok()?;
        match serde_json::from_str(&text) {
            Ok(sidecar) => Some(sidecar),
            Err(err) => {
                let backup = path.with_extension("json.corrupt");
                eprintln!("huxdb: could not parse {} ({err}); moving it to {}", path.display(), backup.display());
                let _ = fs::rename(path, &backup);
                None
            }
        }
    }

    fn write_sidecar(path: &Path, sidecar: &Sidecar) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(sidecar).map_err(|e| e.to_string())?;
        write_atomic(path, &json, None).map_err(io_error("save the query"))
    }

    /// The query's details; `None` when its text file is gone.
    fn info(&self, connection_id: &str, id: &str) -> Result<Option<SavedQueryInfo>, String> {
        let (sql_path, sidecar_path) = self.paths(connection_id, id)?;
        let Ok(metadata) = fs::metadata(&sql_path) else { return Ok(None) };
        let sidecar = Self::read_sidecar(&sidecar_path).unwrap_or_else(|| Sidecar { name: id.to_string(), ..Sidecar::default() });
        let modified_ms = modified_ms(&metadata);
        Ok(Some(SavedQueryInfo {
            id: id.to_string(),
            name: sidecar.name,
            database: sidecar.database,
            schema: sidecar.schema,
            modified_ms,
            size: metadata.len(),
        }))
    }

    fn require_info(&self, connection_id: &str, id: &str) -> Result<SavedQueryInfo, String> {
        self.info(connection_id, id)?.ok_or_else(|| "That query no longer exists.".to_string())
    }

    fn list_unlocked(&self, connection_id: &str) -> Result<Vec<SavedQueryInfo>, String> {
        let dir = self.dir(connection_id)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(format!("Could not read the saved queries: {err}")),
        };
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "sql") {
                continue;
            }
            // A name that isn't text can't be addressed from the frontend.
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
            if let Ok(Some(info)) = self.info(connection_id, id) {
                list.push(info);
            }
        }
        list.sort_by_cached_key(|q| (q.name.to_lowercase(), q.name.clone()));
        Ok(list)
    }

    /// Names differ by more than case, as connection names do.
    fn check_free(&self, connection_id: &str, name: &str, except: Option<&str>) -> Result<(), String> {
        let taken = self
            .list_unlocked(connection_id)?
            .iter()
            .any(|q| Some(q.id.as_str()) != except && q.name.to_lowercase() == name.to_lowercase());
        if taken { Err(format!("A query named \"{name}\" already exists.")) } else { Ok(()) }
    }

    /// Text first: a crash between the two leaves a query under its id, not a
    /// name without text.
    fn write_new(&self, connection_id: &str, sidecar: &Sidecar, sql: &str) -> Result<SavedQueryInfo, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sql_path, sidecar_path) = self.paths(connection_id, &id)?;
        write_atomic(&sql_path, sql.as_bytes(), None).map_err(io_error("save the query"))?;
        Self::write_sidecar(&sidecar_path, sidecar)?;
        self.require_info(connection_id, &id)
    }

    pub fn list(&self, connection_id: &str) -> Result<Vec<SavedQueryInfo>, String> {
        let _guard = self.lock.lock().unwrap();
        self.list_unlocked(connection_id)
    }

    pub fn summary(&self, connection_id: &str) -> Result<SavedQuerySummary, String> {
        let _guard = self.lock.lock().unwrap();
        Ok(SavedQuerySummary {
            count: self.list_unlocked(connection_id)?.len(),
            dir: self.dir(connection_id)?.display().to_string(),
        })
    }

    pub fn load(&self, connection_id: &str, id: &str) -> Result<SavedQuery, String> {
        let _guard = self.lock.lock().unwrap();
        let info = self.require_info(connection_id, id)?;
        let (sql_path, _) = self.paths(connection_id, id)?;
        let sql = fs::read_to_string(&sql_path).map_err(io_error("read the query"))?;
        Ok(SavedQuery { info, sql })
    }

    pub fn create(&self, connection_id: &str, name: &str, database: &str, schema: &str, sql: &str) -> Result<SavedQueryInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let name = clean_name(name)?;
        self.check_free(connection_id, &name, None)?;
        let sidecar = Sidecar { name, database: database.to_string(), schema: schema.to_string() };
        self.write_new(connection_id, &sidecar, sql)
    }

    /// Saves over a query, keeping its name. A query whose files were both
    /// removed behind our back is an error, since there's no name left to save under.
    /// With `expected_modified_ms`, a text file changed since then is refused
    /// with `CHANGED_MARKER`, so the user can choose to overwrite it.
    pub fn update(&self, connection_id: &str, id: &str, database: &str, schema: &str, sql: &str, expected_modified_ms: Option<u64>) -> Result<SavedQueryInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let (sql_path, sidecar_path) = self.paths(connection_id, id)?;
        let name = match self.info(connection_id, id)? {
            Some(info) => info.name,
            None => Self::read_sidecar(&sidecar_path).ok_or("That query no longer exists.")?.name,
        };
        let current = fs::metadata(&sql_path).ok().as_ref().and_then(modified_ms);
        if current.is_some() && expected_modified_ms.is_some() && current != expected_modified_ms {
            return Err(format!("{CHANGED_MARKER}This query's file changed on disk since it was opened."));
        }
        write_atomic(&sql_path, sql.as_bytes(), None).map_err(io_error("save the query"))?;
        Self::write_sidecar(&sidecar_path, &Sidecar { name, database: database.to_string(), schema: schema.to_string() })?;
        self.require_info(connection_id, id)
    }

    pub fn rename(&self, connection_id: &str, id: &str, name: &str) -> Result<SavedQueryInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let name = clean_name(name)?;
        let info = self.require_info(connection_id, id)?;
        self.check_free(connection_id, &name, Some(id))?;
        let (_, sidecar_path) = self.paths(connection_id, id)?;
        Self::write_sidecar(&sidecar_path, &Sidecar { name, database: info.database, schema: info.schema })?;
        self.require_info(connection_id, id)
    }

    pub fn duplicate(&self, connection_id: &str, id: &str) -> Result<SavedQueryInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let info = self.require_info(connection_id, id)?;
        let (sql_path, _) = self.paths(connection_id, id)?;
        // Bytes, so a copy of a file we can't decode is still a copy.
        let sql = fs::read(&sql_path).map_err(io_error("read the query"))?;
        let taken: Vec<_> = self.list_unlocked(connection_id)?.into_iter().map(|q| q.name).collect();
        let copy = uuid::Uuid::new_v4().to_string();
        let (copy_sql, copy_sidecar) = self.paths(connection_id, &copy)?;
        write_atomic(&copy_sql, &sql, None).map_err(io_error("save the query"))?;
        let name = copy_name(&info.name, &taken);
        Self::write_sidecar(&copy_sidecar, &Sidecar { name, database: info.database, schema: info.schema })?;
        self.require_info(connection_id, &copy)
    }

    /// Text first, because the `.sql` file is what makes a query exist.
    pub fn delete(&self, connection_id: &str, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let (sql_path, sidecar_path) = self.paths(connection_id, id)?;
        for path in [sql_path, sidecar_path] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("Could not delete the query: {err}")),
            }
        }
        Ok(())
    }

    /// Removes every query of a connection that is being deleted.
    pub fn delete_connection(&self, connection_id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        match fs::remove_dir_all(self.dir(connection_id)?) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not delete the saved queries: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    const CONN: &str = "conn-1";

    fn store_in(dir: &tempfile::TempDir) -> SavedQueryStore {
        SavedQueryStore::new(dir.path().join("queries"))
    }

    fn names(store: &SavedQueryStore) -> Vec<String> {
        store.list(CONN).unwrap().into_iter().map(|q| q.name).collect()
    }

    #[test]
    fn a_query_round_trips_through_plain_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "  Monthly: report/é?  ", "sales", "public", "SELECT 1;\n").unwrap();
        assert_eq!(saved.name, "Monthly: report/é?");
        assert_eq!(saved.size, 10);
        assert!(saved.modified_ms.is_some());

        let text = fs::read_to_string(dir.path().join("queries").join(CONN).join(format!("{}.sql", saved.id))).unwrap();
        assert_eq!(text, "SELECT 1;\n");

        let loaded = store.load(CONN, &saved.id).unwrap();
        assert_eq!(loaded.sql, "SELECT 1;\n");
        assert_eq!((loaded.info.database.as_str(), loaded.info.schema.as_str()), ("sales", "public"));
        assert_eq!(store_in(&dir).list(CONN).unwrap(), vec![saved]);
    }

    #[test]
    fn a_connection_without_queries_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(store_in(&dir).list("never-saved").unwrap().is_empty());
    }

    #[test]
    fn queries_list_by_name_ignoring_case() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        for name in ["beta", "Alpha", "gamma"] {
            store.create(CONN, name, "d", "", "").unwrap();
        }
        assert_eq!(names(&store), ["Alpha", "beta", "gamma"]);
    }

    #[test]
    fn names_are_unique_ignoring_case_and_per_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.create(CONN, "Report", "d", "", "").unwrap();
        let other = store.create(CONN, "Other", "d", "", "").unwrap();
        assert!(store.create(CONN, "report", "d", "", "").unwrap_err().contains("already exists"));
        assert!(store.rename(CONN, &other.id, "REPORT").is_err());
        assert!(store.create("conn-2", "Report", "d", "", "").is_ok());
        // Changing only the case of its own name is fine.
        assert_eq!(store.rename(CONN, &other.id, "OTHER").unwrap().name, "OTHER");
    }

    #[test]
    fn rejects_blank_and_overlong_names_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert!(store.create(CONN, "   ", "d", "", "").is_err());
        assert!(store.create(CONN, &"x".repeat(MAX_NAME_CHARS + 1), "d", "", "").is_err());
        assert!(store.list(CONN).unwrap().is_empty());
    }

    #[test]
    fn update_keeps_the_name_and_moves_the_default_target() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "one", "", "a").unwrap();
        let updated = store.update(CONN, &saved.id, "two", "s", "ab", None).unwrap();
        assert_eq!((updated.name.as_str(), updated.database.as_str(), updated.schema.as_str(), updated.size), ("Report", "two", "s", 2));
    }

    #[test]
    fn rename_leaves_the_text_and_target_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Old", "d", "s", "SELECT 2").unwrap();
        let renamed = store.rename(CONN, &saved.id, "New").unwrap();
        assert_eq!((renamed.id.as_str(), renamed.database.as_str()), (saved.id.as_str(), "d"));
        assert_eq!(store.load(CONN, &saved.id).unwrap().sql, "SELECT 2");
    }

    #[test]
    fn duplicates_take_the_next_free_copy_name() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "s", "SELECT 3").unwrap();
        let first = store.duplicate(CONN, &saved.id).unwrap();
        let second = store.duplicate(CONN, &saved.id).unwrap();
        assert_eq!((first.name.as_str(), second.name.as_str()), ("Report copy", "Report copy 2"));
        assert_eq!(store.load(CONN, &second.id).unwrap().sql, "SELECT 3");
        assert_eq!(second.database, "d");
    }

    #[test]
    fn delete_removes_both_files_and_tolerates_a_second_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "x").unwrap();
        store.delete(CONN, &saved.id).unwrap();
        store.delete(CONN, &saved.id).unwrap();
        assert_eq!(fs::read_dir(dir.path().join("queries").join(CONN)).unwrap().count(), 0);
        assert!(store.load(CONN, &saved.id).unwrap_err().contains("no longer exists"));
    }

    #[test]
    fn a_missing_sidecar_lists_the_file_under_its_own_name() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let conn_dir = dir.path().join("queries").join(CONN);
        fs::create_dir_all(&conn_dir).unwrap();
        fs::write(conn_dir.join("dropped in.sql"), "SELECT 4").unwrap();
        fs::write(conn_dir.join("notes.txt"), "not a query").unwrap();

        let list = store.list(CONN).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id.as_str(), list[0].name.as_str(), list[0].database.as_str()), ("dropped in", "dropped in", ""));

        // Saving gives it a sidecar and renaming a real name.
        store.update(CONN, "dropped in", "d", "", "SELECT 4", None).unwrap();
        assert_eq!(store.rename(CONN, "dropped in", "Named").unwrap().database, "d");
    }

    #[test]
    fn a_corrupt_sidecar_is_moved_aside_and_the_query_survives() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "x").unwrap();
        let conn_dir = dir.path().join("queries").join(CONN);
        fs::write(conn_dir.join(format!("{}.json", saved.id)), "not json").unwrap();

        assert_eq!(names(&store), [saved.id.as_str()]);
        assert!(conn_dir.join(format!("{}.json.corrupt", saved.id)).exists());
        assert_eq!(store.load(CONN, &saved.id).unwrap().sql, "x");
    }

    #[test]
    fn a_sidecar_without_text_is_not_a_query() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "x").unwrap();
        fs::remove_file(dir.path().join("queries").join(CONN).join(format!("{}.sql", saved.id))).unwrap();
        assert!(store.list(CONN).unwrap().is_empty());
        // Saving an open tab puts the text back under the same name.
        assert_eq!(store.update(CONN, &saved.id, "d", "", "y", None).unwrap().name, "Report");
    }

    #[test]
    fn saving_a_query_with_no_files_left_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "x").unwrap();
        store.delete(CONN, &saved.id).unwrap();
        assert!(store.update(CONN, &saved.id, "d", "", "y", None).is_err());
    }

    #[test]
    fn a_text_file_that_is_not_utf8_lists_but_fails_to_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let conn_dir = dir.path().join("queries").join(CONN);
        fs::create_dir_all(&conn_dir).unwrap();
        fs::write(conn_dir.join("latin1.sql"), [0xE9, 0x20, 0xFF]).unwrap();
        assert_eq!(store.list(CONN).unwrap().len(), 1);
        assert!(store.load(CONN, "latin1").is_err());
    }

    #[test]
    fn ids_cannot_leave_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let outside = dir.path().join("secret.sql");
        fs::write(&outside, "keep").unwrap();
        for id in ["../../secret", "..", ".", "", "a/b", "a\\b", "a\0b", "C:secret", "a:stream"] {
            assert!(store.load(CONN, id).is_err(), "load {id:?}");
            assert!(store.delete(CONN, id).is_err(), "delete {id:?}");
            assert!(store.delete_connection(id).is_err(), "delete connection {id:?}");
            assert!(store.list(id).is_err(), "list {id:?}");
        }
        assert!(outside.exists());
    }

    #[test]
    fn deleting_a_connection_removes_only_its_queries() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.create(CONN, "A", "d", "", "").unwrap();
        store.create("conn-2", "B", "d", "", "").unwrap();
        assert_eq!(store.summary(CONN).unwrap().count, 1);
        store.delete_connection(CONN).unwrap();
        store.delete_connection(CONN).unwrap();
        assert_eq!(store.summary(CONN).unwrap().count, 0);
        assert_eq!(store.summary("conn-2").unwrap().count, 1);
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "A", "d", "", "").unwrap();
        let conn_dir = dir.path().join("queries").join(CONN);
        for ext in ["sql", "json"] {
            let mode = fs::metadata(conn_dir.join(format!("{}.{ext}", saved.id))).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{ext}");
        }
    }

    #[test]
    fn a_save_is_refused_when_the_file_changed_since_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "mine").unwrap();
        let path = dir.path().join("queries").join(CONN).join(format!("{}.sql", saved.id));
        fs::write(&path, "theirs").unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_modified(UNIX_EPOCH + Duration::from_secs(1)).unwrap();

        let err = store.update(CONN, &saved.id, "d", "", "mine again", saved.modified_ms).unwrap_err();
        assert!(err.starts_with(CHANGED_MARKER), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "theirs");

        // Without a stamp it's the user's Overwrite.
        store.update(CONN, &saved.id, "d", "", "mine again", None).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine again");
    }

    #[test]
    fn a_save_with_the_current_stamp_goes_through_and_returns_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "Report", "d", "", "a").unwrap();
        let next = store.update(CONN, &saved.id, "d", "", "ab", saved.modified_ms).unwrap();
        store.update(CONN, &saved.id, "d", "", "abc", next.modified_ms).unwrap();
    }

    #[test]
    fn copy_names_compare_ignoring_case() {
        assert_eq!(copy_name("A", &[]), "A copy");
        assert_eq!(copy_name("A", &["a COPY".into(), "A copy 2".into()]), "A copy 3");
    }
}
