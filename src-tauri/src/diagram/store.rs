//! Saved diagrams on disk, one JSON file each:
//!
//! ```text
//! diagrams/<connection id>/<diagram id>.json
//! ```
//!
//! The file holds its name, database and object count, which this module reads, and
//! `content`, which only the frontend understands: layout, the schema snapshot drift is
//! compared against, and the tables the database had when it was saved. It isn't engine-specific.
//!
//! A file that can't be parsed moves to `.json.corrupt` and is never overwritten. A file from
//! a newer `formatVersion` is listed but refused, and nothing rewrites it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil::{copy_name, modified_ms, path_part, write_atomic};
use crate::saved_queries::CHANGED_MARKER;

/// Raise this when `content` changes in a way older code can't read.
pub const FORMAT_VERSION: u32 = 2;
const MAX_NAME_CHARS: usize = 200;

/// What the list shows about a diagram.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramInfo {
    pub id: String,
    pub name: String,
    pub database: String,
    pub objects: usize,
    /// Milliseconds since the epoch.
    pub modified_ms: Option<u64>,
}

/// The frontend's part of the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramContent {
    pub objects: usize,
    pub layout: Value,
    pub snapshot: Value,
    pub known: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDiagram {
    #[serde(flatten)]
    pub info: DiagramInfo,
    #[serde(flatten)]
    pub content: DiagramContent,
}

/// What deleting a connection would affect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramSummary {
    pub count: usize,
    pub dir: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagramFile {
    format_version: u32,
    name: String,
    database: String,
    #[serde(flatten)]
    content: DiagramContent,
}

/// The file without its content, which can run to megabytes, for listing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format_version: u32,
    name: String,
    database: String,
    objects: usize,
}

pub struct DiagramStore {
    root: PathBuf,
    /// One operation at a time, so a name can't be taken between its check and its write.
    lock: Mutex<()>,
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name for the diagram.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A diagram name can have at most {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

fn io_error(action: &str) -> impl Fn(io::Error) -> String {
    move |e| format!("Could not {action}: {e}")
}

fn refuse_newer(version: u32) -> Result<(), String> {
    if version > FORMAT_VERSION {
        return Err("This diagram was saved by a newer version of huxdb. Update huxdb to open it.".into());
    }
    Ok(())
}

impl DiagramStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root, lock: Mutex::new(()) }
    }

    fn dir(&self, connection_id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join(path_part(connection_id)?))
    }

    fn path(&self, connection_id: &str, id: &str) -> Result<PathBuf, String> {
        Ok(self.dir(connection_id)?.join(format!("{}.json", path_part(id)?)))
    }

    /// The file's header. A file that can't be parsed moves aside, and is `None` from then on.
    fn read_header(path: &Path) -> Option<Header> {
        let text = fs::read(path).ok()?;
        match serde_json::from_slice(&text) {
            Ok(header) => Some(header),
            Err(err) => {
                let backup = path.with_extension("json.corrupt");
                eprintln!("huxdb: could not parse {} ({err}); moving it to {}", path.display(), backup.display());
                let _ = fs::rename(path, &backup);
                None
            }
        }
    }

    fn info(&self, connection_id: &str, id: &str) -> Result<Option<DiagramInfo>, String> {
        let path = self.path(connection_id, id)?;
        let Ok(metadata) = fs::metadata(&path) else { return Ok(None) };
        let Some(header) = Self::read_header(&path) else { return Ok(None) };
        Ok(Some(DiagramInfo { id: id.to_string(), name: header.name, database: header.database, objects: header.objects, modified_ms: modified_ms(&metadata) }))
    }

    fn require_info(&self, connection_id: &str, id: &str) -> Result<DiagramInfo, String> {
        self.info(connection_id, id)?.ok_or_else(|| "That diagram no longer exists.".to_string())
    }

    fn read_file(&self, connection_id: &str, id: &str) -> Result<DiagramFile, String> {
        let path = self.path(connection_id, id)?;
        // Checked first, because a newer file's content may not parse as this version's.
        let header = Self::read_header(&path).ok_or("That diagram no longer exists.")?;
        refuse_newer(header.format_version)?;
        let text = fs::read(&path).map_err(io_error("read the diagram"))?;
        serde_json::from_slice(&text).map_err(|e| format!("Could not read the diagram: {e}"))
    }

    fn write_file(path: &Path, file: &DiagramFile) -> Result<(), String> {
        let json = serde_json::to_vec(file).map_err(|e| e.to_string())?;
        write_atomic(path, &json, None).map_err(io_error("save the diagram"))
    }

    fn list_unlocked(&self, connection_id: &str) -> Result<Vec<DiagramInfo>, String> {
        let dir = self.dir(connection_id)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(format!("Could not read the saved diagrams: {err}")),
        };
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
            if let Ok(Some(info)) = self.info(connection_id, id) {
                list.push(info);
            }
        }
        list.sort_by_cached_key(|d| (d.name.to_lowercase(), d.name.clone()));
        Ok(list)
    }

    fn check_free(&self, connection_id: &str, name: &str, except: Option<&str>) -> Result<(), String> {
        let taken = self
            .list_unlocked(connection_id)?
            .iter()
            .any(|d| Some(d.id.as_str()) != except && d.name.to_lowercase() == name.to_lowercase());
        if taken { Err(format!("A diagram named \"{name}\" already exists.")) } else { Ok(()) }
    }

    fn write_new(&self, connection_id: &str, file: &DiagramFile) -> Result<DiagramInfo, String> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::write_file(&self.path(connection_id, &id)?, file)?;
        self.require_info(connection_id, &id)
    }

    pub fn list(&self, connection_id: &str) -> Result<Vec<DiagramInfo>, String> {
        let _guard = self.lock.lock().unwrap();
        self.list_unlocked(connection_id)
    }

    pub fn summary(&self, connection_id: &str) -> Result<DiagramSummary, String> {
        let _guard = self.lock.lock().unwrap();
        Ok(DiagramSummary { count: self.list_unlocked(connection_id)?.len(), dir: self.dir(connection_id)?.display().to_string() })
    }

    pub fn load(&self, connection_id: &str, id: &str) -> Result<SavedDiagram, String> {
        let _guard = self.lock.lock().unwrap();
        let file = self.read_file(connection_id, id)?;
        Ok(SavedDiagram { info: self.require_info(connection_id, id)?, content: file.content })
    }

    pub fn create(&self, connection_id: &str, name: &str, database: &str, content: DiagramContent) -> Result<DiagramInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let name = clean_name(name)?;
        self.check_free(connection_id, &name, None)?;
        self.write_new(connection_id, &DiagramFile { format_version: FORMAT_VERSION, name, database: database.to_string(), content })
    }

    /// Saves over a diagram, keeping its name and database. With `expected_modified_ms`, a
    /// file changed since then is refused with `CHANGED_MARKER`, so the user can choose.
    pub fn update(&self, connection_id: &str, id: &str, content: DiagramContent, expected_modified_ms: Option<u64>) -> Result<DiagramInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let path = self.path(connection_id, id)?;
        let header = Self::read_header(&path).ok_or("That diagram no longer exists.")?;
        refuse_newer(header.format_version)?;
        let current = fs::metadata(&path).ok().as_ref().and_then(modified_ms);
        if current.is_some() && expected_modified_ms.is_some() && current != expected_modified_ms {
            return Err(format!("{CHANGED_MARKER}This diagram's file changed on disk since it was opened."));
        }
        Self::write_file(&path, &DiagramFile { format_version: FORMAT_VERSION, name: header.name, database: header.database, content })?;
        self.require_info(connection_id, id)
    }

    pub fn rename(&self, connection_id: &str, id: &str, name: &str) -> Result<DiagramInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let name = clean_name(name)?;
        let mut file = self.read_file(connection_id, id)?;
        self.check_free(connection_id, &name, Some(id))?;
        file.name = name;
        Self::write_file(&self.path(connection_id, id)?, &file)?;
        self.require_info(connection_id, id)
    }

    pub fn duplicate(&self, connection_id: &str, id: &str) -> Result<DiagramInfo, String> {
        let _guard = self.lock.lock().unwrap();
        let mut file = self.read_file(connection_id, id)?;
        let taken: Vec<_> = self.list_unlocked(connection_id)?.into_iter().map(|d| d.name).collect();
        file.name = copy_name(&file.name, &taken);
        self.write_new(connection_id, &file)
    }

    pub fn delete(&self, connection_id: &str, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        match fs::remove_file(self.path(connection_id, id)?) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not delete the diagram: {err}")),
        }
    }

    /// Removes every diagram of a connection that is being deleted.
    pub fn delete_connection(&self, connection_id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        match fs::remove_dir_all(self.dir(connection_id)?) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not delete the saved diagrams: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const CONN: &str = "conn-1";

    fn store_in(dir: &tempfile::TempDir) -> DiagramStore {
        DiagramStore::new(dir.path().join("diagrams"))
    }

    fn content(objects: usize) -> DiagramContent {
        DiagramContent { objects, layout: json!({ "tables": { "a": { "x": 1, "y": 2 } } }), snapshot: json!({ "tables": [] }), known: json!(["a"]) }
    }

    fn file_path(dir: &tempfile::TempDir, id: &str) -> PathBuf {
        dir.path().join("diagrams").join(CONN).join(format!("{id}.json"))
    }

    fn set_mtime(path: &Path, ms: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms)).unwrap();
    }

    #[test]
    fn a_diagram_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "  Billing  ", "sales", content(3)).unwrap();
        assert_eq!((saved.name.as_str(), saved.database.as_str(), saved.objects), ("Billing", "sales", 3));
        assert!(saved.modified_ms.is_some());

        let loaded = store.load(CONN, &saved.id).unwrap();
        assert_eq!(loaded.content, content(3));
        assert_eq!(store_in(&dir).list(CONN).unwrap(), vec![saved]);
    }

    #[test]
    fn writes_the_format_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "a", "db", content(1)).unwrap();
        let text: Value = serde_json::from_slice(&fs::read(file_path(&dir, &saved.id)).unwrap()).unwrap();
        assert_eq!(text["formatVersion"], FORMAT_VERSION);
        assert_eq!(text["name"], "a");
    }

    #[test]
    fn names_are_unique_ignoring_case_and_sorted() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.create(CONN, "beta", "db", content(1)).unwrap();
        let alpha = store.create(CONN, "Alpha", "db", content(1)).unwrap();
        assert!(store.create(CONN, "ALPHA", "db", content(1)).unwrap_err().contains("already exists"));
        assert!(store.create(CONN, "   ", "db", content(1)).is_err());
        assert_eq!(store.list(CONN).unwrap().iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["Alpha", "beta"]);
        assert!(store.rename(CONN, &alpha.id, "BETA").is_err());
        assert_eq!(store.rename(CONN, &alpha.id, "alpha").unwrap().name, "alpha");
    }

    #[test]
    fn update_keeps_the_name_and_refuses_a_changed_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "a", "db", content(1)).unwrap();
        let path = file_path(&dir, &saved.id);
        set_mtime(&path, 1000);

        let refused = store.update(CONN, &saved.id, content(2), Some(5)).unwrap_err();
        assert!(refused.starts_with(CHANGED_MARKER));
        assert_eq!(store.load(CONN, &saved.id).unwrap().content, content(1));

        let updated = store.update(CONN, &saved.id, content(2), Some(1000)).unwrap();
        assert_eq!((updated.name.as_str(), updated.objects), ("a", 2));
        store.update(CONN, &saved.id, content(3), None).unwrap();
        assert_eq!(store.load(CONN, &saved.id).unwrap().info.objects, 3);
    }

    #[test]
    fn a_corrupt_file_moves_aside_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "a", "db", content(1)).unwrap();
        let path = file_path(&dir, &saved.id);
        fs::write(&path, "{ not json").unwrap();

        assert!(store.list(CONN).unwrap().is_empty());
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(path.with_extension("json.corrupt")).unwrap(), "{ not json");
        assert!(store.update(CONN, &saved.id, content(2), None).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn a_newer_file_is_listed_but_refused_and_stays_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "a", "db", content(1)).unwrap();
        let path = file_path(&dir, &saved.id);
        let future = json!({ "formatVersion": FORMAT_VERSION + 1, "name": "future", "database": "db", "objects": 7, "somethingNew": true }).to_string();
        fs::write(&path, &future).unwrap();

        assert_eq!(store.list(CONN).unwrap()[0].name, "future");
        for error in [
            store.load(CONN, &saved.id).unwrap_err(),
            store.update(CONN, &saved.id, content(2), None).unwrap_err(),
            store.rename(CONN, &saved.id, "b").unwrap_err(),
            store.duplicate(CONN, &saved.id).unwrap_err(),
        ] {
            assert!(error.contains("newer version"), "{error}");
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), future);
        assert_eq!(store.list(CONN).unwrap().len(), 1);
    }

    #[test]
    fn duplicate_finds_a_free_name_and_copies_the_content() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.create(CONN, "a", "db", content(4)).unwrap();
        let first = store.duplicate(CONN, &saved.id).unwrap();
        let second = store.duplicate(CONN, &saved.id).unwrap();
        assert_eq!((first.name.as_str(), second.name.as_str()), ("a copy", "a copy 2"));
        assert_eq!(store.load(CONN, &first.id).unwrap().content, content(4));
    }

    #[test]
    fn delete_removes_one_or_all() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let a = store.create(CONN, "a", "db", content(1)).unwrap();
        store.create(CONN, "b", "db", content(1)).unwrap();
        store.delete(CONN, &a.id).unwrap();
        store.delete(CONN, &a.id).unwrap();
        assert_eq!(store.summary(CONN).unwrap().count, 1);
        store.delete_connection(CONN).unwrap();
        store.delete_connection(CONN).unwrap();
        assert!(store.list(CONN).unwrap().is_empty());
    }

    #[test]
    fn rejects_ids_that_could_leave_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        for id in ["..", "a/b", "a\\b", "c:x", ""] {
            assert!(store.load(CONN, id).is_err());
            assert!(store.delete(CONN, id).is_err());
            assert!(store.list(id).is_err());
        }
    }
}
