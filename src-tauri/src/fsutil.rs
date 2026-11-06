//! File writing shared by the stores in the app config dir.

use std::ffi::OsString;
use std::fs::{self, File, Metadata, Permissions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Ids become path parts, and come from the frontend or a file name. A colon
/// would make a Windows path absolute, or name an NTFS stream.
pub fn path_part(id: &str) -> Result<&str, String> {
    let bad = id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':', '\0']);
    if bad { Err("Invalid id.".into()) } else { Ok(id) }
}

/// `<name> copy`, then `<name> copy 2` and so on, whichever is free.
pub fn copy_name(name: &str, taken: &[String]) -> String {
    let is_taken = |candidate: &str| taken.iter().any(|t| t.to_lowercase() == candidate.to_lowercase());
    let first = format!("{name} copy");
    if !is_taken(&first) {
        return first;
    }
    (2..).map(|n| format!("{name} copy {n}")).find(|c| !is_taken(c)).expect("a free number")
}

/// Writes to a temp file in the same directory, then renames it over the target
/// so a crash mid-write can't leave a truncated file. On Unix a new file is
/// readable by the owner only, because these files can hold passwords;
/// `permissions` replaces that for a file that already has its own. The temp
/// name is unique because this also runs in the user's own folders.
pub fn write_atomic(path: &Path, bytes: &[u8], permissions: Option<Permissions>) -> io::Result<()> {
    write_atomic_with(path, permissions, |file| file.write_all(bytes))
}

/// `write_atomic` for content that is produced as it is written, such as a large
/// image streamed through an encoder. If `write` fails the target is untouched.
pub fn write_atomic_with(path: &Path, permissions: Option<Permissions>, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid file path."))?;
    fs::create_dir_all(dir)?;
    let tmp = tmp_path(path);
    let written = write_file(&tmp, permissions, write).and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn write_file(tmp: &Path, permissions: Option<Permissions>, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(tmp)?;
    write(&mut file)?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    file.sync_all()
}

/// A file's modification time in milliseconds since the epoch, which is how a
/// tab notices that its file changed behind it.
pub fn modified_ms(metadata: &Metadata) -> Option<u64> {
    let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(elapsed.as_millis() as u64)
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(OsString::from).unwrap_or_default();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_neighbouring_tmp_file_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.sql");
        let neighbour = dir.path().join("report.sql.tmp");
        fs::write(&neighbour, "the user's own notes").unwrap();

        write_atomic(&path, b"SELECT 1", None).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "SELECT 1");
        assert_eq!(fs::read_to_string(&neighbour).unwrap(), "the user's own notes");
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target");
        // Renaming a file over a non-empty directory fails.
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inside"), "x").unwrap();

        assert!(write_atomic(&path, b"SELECT 1", None).is_err());

        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_write_leaves_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target");
        fs::write(&path, "old").unwrap();

        let result = write_atomic_with(&path, None, |file| {
            file.write_all(b"half")?;
            Err(io::Error::other("boom"))
        });

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_with_keeps_write_atomics_behaviour() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new");
        write_atomic_with(&path, None, |file| file.write_all(b"x")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "x");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
