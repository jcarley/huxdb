//! Reading and writing `.sql` files outside the app's own directory.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::CHANGED_MARKER;
use crate::fsutil::{modified_ms, write_atomic};

/// CodeMirror can't hold much more than this comfortably, and a dump opened by
/// mistake shouldn't take the app down.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// A file the user picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFile {
    pub path: String,
    /// The file's name, for the tab.
    pub name: String,
    /// Passed back on the next write, to notice a change made elsewhere.
    pub modified_ms: Option<u64>,
}

/// A file the user picked to open, with its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSql {
    #[serde(flatten)]
    pub file: ExternalFile,
    pub sql: String,
}

/// Paths the user chose in a file dialog. Writing needs one of these, so the
/// webview can't name an arbitrary path.
#[derive(Default)]
pub struct ExternalFiles {
    granted: Mutex<HashSet<PathBuf>>,
}

impl ExternalFiles {
    pub fn grant(&self, path: &Path) {
        self.granted.lock().unwrap().insert(path.to_path_buf());
    }

    pub fn is_granted(&self, path: &Path) -> bool {
        self.granted.lock().unwrap().contains(path)
    }
}

pub fn describe(path: &Path) -> ExternalFile {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    let modified_ms = fs::metadata(path).ok().as_ref().and_then(modified_ms);
    ExternalFile { path: path.display().to_string(), name, modified_ms }
}

pub fn read(path: &Path) -> Result<String, String> {
    let fail = |e: std::io::Error| format!("Could not read {}: {e}", path.display());
    if fs::metadata(path).map_err(fail)?.len() > MAX_FILE_BYTES {
        return Err(format!("{} is larger than 64 MiB.", path.display()));
    }
    let bytes = fs::read(path).map_err(fail)?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{} isn't UTF-8 text.", path.display()))?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

/// Replaces the file atomically. It's the user's file: a symlink keeps pointing
/// where it did, and an existing file keeps its permissions. With
/// `expected_modified_ms`, a file changed since then is refused with `CHANGED_MARKER`.
pub fn write(path: &Path, sql: &str, expected_modified_ms: Option<u64>) -> Result<(), String> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let metadata = fs::metadata(&target).ok();
    let current = metadata.as_ref().and_then(modified_ms);
    if current.is_some() && expected_modified_ms.is_some() && current != expected_modified_ms {
        return Err(format!("{CHANGED_MARKER}{} changed on disk since it was opened.", path.display()));
    }
    let permissions = metadata.map(|m| m.permissions());
    write_atomic(&target, sql.as_bytes(), permissions).map_err(|e| format!("Could not save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_drops_a_byte_order_mark() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.sql");
        fs::write(&path, "\u{feff}SELECT 1").unwrap();
        assert_eq!(read(&path).unwrap(), "SELECT 1");
    }

    #[test]
    fn a_file_that_is_not_utf8_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.sql");
        fs::write(&path, [0xE9, 0xFF]).unwrap();
        assert!(read(&path).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn a_huge_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.sql");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read(&path).unwrap_err().contains("64 MiB"));
    }

    #[test]
    fn describe_names_the_file() {
        let file = describe(Path::new("/tmp/some dir/report.sql"));
        assert_eq!((file.name.as_str(), file.path.as_str()), ("report.sql", "/tmp/some dir/report.sql"));
    }

    #[test]
    fn only_granted_paths_are_granted() {
        let files = ExternalFiles::default();
        files.grant(Path::new("/a.sql"));
        assert!(files.is_granted(Path::new("/a.sql")));
        assert!(!files.is_granted(Path::new("/b.sql")));
    }

    #[cfg(unix)]
    #[test]
    fn writing_keeps_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sql");
        let link = dir.path().join("link.sql");
        fs::write(&real, "old").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write(&link, "new", None).unwrap();

        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[test]
    fn writing_is_refused_when_the_file_changed_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.sql");
        fs::write(&path, "theirs").unwrap();
        let stale = describe(&path).modified_ms.unwrap() - 1000;

        let err = write(&path, "mine", Some(stale)).unwrap_err();
        assert!(err.starts_with(CHANGED_MARKER), "{err}");
        assert_eq!(read(&path).unwrap(), "theirs");

        write(&path, "mine", None).unwrap();
        assert_eq!(read(&path).unwrap(), "mine");
    }

    #[test]
    fn writing_creates_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.sql");
        write(&path, "SELECT 1", Some(1)).unwrap();
        assert_eq!(read(&path).unwrap(), "SELECT 1");
    }
}
