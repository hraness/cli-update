use crate::{Error, ErrorCode, Result};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::{Component, Path};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};

const JSON_LIMIT: u64 = 64 * 1024;
pub(crate) const BINARY_LIMIT: u64 = 1024 * 1024 * 1024;
#[cfg(unix)]
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub(crate) fn supported() -> bool {
    cfg!(unix)
}

#[cfg(not(unix))]
fn unsupported() -> Error {
    Error::new(ErrorCode::Unsupported, "Native updater state ownership and running-executable replacement are not yet supported on this platform; use the product's verified installer.")
}

pub(crate) fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(Error::new(
            ErrorCode::UnsafePath,
            "Updater paths must be absolute and contain no dot components",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn c_name(name: &std::ffi::OsStr) -> Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes())
        .map_err(|_| Error::new(ErrorCode::UnsafePath, "Path contains NUL"))
}

#[cfg(unix)]
fn check_owner(file: &File, directory: bool, private: bool) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .map_err(|e| Error::io("Inspect updater path", e))?;
    // SAFETY: geteuid takes no arguments and has no side effects.
    let uid = unsafe { libc::geteuid() };
    if (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(Error::new(
            ErrorCode::UnsafePath,
            "Updater path has the wrong file type",
        ));
    }
    let root_sticky = directory && meta.uid() == 0 && meta.mode() & 0o1000 != 0;
    if (meta.uid() != uid && !(directory && !private && meta.uid() == 0))
        || (!root_sticky && meta.mode() & 0o022 != 0)
        || (private && meta.mode() & 0o077 != 0)
        || (!directory && meta.nlink() != 1)
    {
        return Err(Error::new(
            ErrorCode::UnsafePath,
            "Updater paths must be owned by the current user, unshared, and not writable by others",
        ));
    }
    Ok(())
}

/// Traverse with directory descriptors and O_NOFOLLOW, including every parent.
/// A rename of a checked directory cannot redirect a later write through a symlink.
#[cfg(unix)]
pub(crate) fn open_dir(path: &Path, create: bool, private: bool) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    absolute(path)?;
    let mut dir = File::open("/").map_err(|e| Error::io("Open filesystem root", e))?;
    check_owner(&dir, true, false)?;
    let components: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n),
            _ => None,
        })
        .collect();
    for (i, component) in components.iter().enumerate() {
        let name = c_name(component)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: dir and the NUL-terminated name stay alive during openat.
        let mut fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0
            && create
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            // SAFETY: same checked parent descriptor as openat; fixed private mode.
            let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
            if rc != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(Error::io(
                    "Create private updater directory",
                    std::io::Error::last_os_error(),
                ));
            }
            fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        }
        if fd < 0 {
            return Err(Error::io(
                "Open updater directory without symlinks",
                std::io::Error::last_os_error(),
            ));
        }
        // SAFETY: fd is newly opened and is transferred to its unique owner.
        dir = unsafe { File::from_raw_fd(fd) };
        check_owner(&dir, true, private && i + 1 == components.len())?;
    }
    if components.is_empty() && private {
        return Err(Error::new(
            ErrorCode::UnsafePath,
            "Filesystem root cannot be updater state",
        ));
    }
    Ok(dir)
}

#[cfg(not(unix))]
pub(crate) fn open_dir(_path: &Path, _create: bool, _private: bool) -> Result<File> {
    Err(unsupported())
}

#[cfg(unix)]
pub(crate) fn open_file(
    dir: &File,
    name: &std::ffi::OsStr,
    create: bool,
    private: bool,
) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    if Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err(Error::new(
            ErrorCode::UnsafePath,
            "Expected a single updater filename",
        ));
    }
    let name = c_name(name)?;
    let flags = libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if create {
            libc::O_RDWR | libc::O_CREAT
        } else {
            libc::O_RDONLY
        };
    // SAFETY: checked parent fd and valid C filename; no symlink traversal.
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    if fd < 0 {
        return Err(Error::io(
            "Open updater file without symlinks",
            std::io::Error::last_os_error(),
        ));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    check_owner(&file, false, private)?;
    Ok(file)
}

#[cfg(not(unix))]
pub(crate) fn open_file(
    _dir: &File,
    _name: &std::ffi::OsStr,
    _create: bool,
    _private: bool,
) -> Result<File> {
    Err(unsupported())
}

pub(crate) fn open_path(path: &Path, private: bool) -> Result<File> {
    absolute(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::new(ErrorCode::UnsafePath, "Missing parent directory"))?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::new(ErrorCode::UnsafePath, "Missing filename"))?;
    open_file(&open_dir(parent, false, false)?, name, false, private)
}

pub(crate) fn read_json<T: DeserializeOwned>(mut file: File) -> Result<T> {
    if file
        .metadata()
        .map_err(|e| Error::io("Inspect JSON", e))?
        .len()
        > JSON_LIMIT
    {
        return Err(Error::new(ErrorCode::Limit, "Updater JSON exceeds 64 KiB"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io("Read updater JSON", e))?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err(Error::new(ErrorCode::Limit, "Updater JSON exceeds 64 KiB"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(ErrorCode::InvalidState, "Invalid updater JSON"))
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    let mut file = open_path(path, false)?;
    let before = file
        .metadata()
        .map_err(|e| Error::io("Inspect executable", e))?;
    if before.len() > BINARY_LIMIT {
        return Err(Error::new(
            ErrorCode::Limit,
            "Executable exceeds hashing limit",
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| Error::io("Hash executable", e))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > BINARY_LIMIT {
            return Err(Error::new(
                ErrorCode::Limit,
                "Executable exceeds hashing limit",
            ));
        }
        hash.update(&buffer[..count]);
    }
    let after = file
        .metadata()
        .map_err(|e| Error::io("Reinspect executable", e))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(Error::new(
            ErrorCode::Ownership,
            "Executable changed while checking its digest",
        ));
    }
    // Re-open the name to detect replacement while the original descriptor was read.
    if !same_file(&file, &open_path(path, false)?)? {
        return Err(Error::new(
            ErrorCode::Ownership,
            "Executable was replaced while checking its digest",
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn verify_executable_mode(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mode = open_path(path, false)?
            .metadata()
            .map_err(|e| Error::io("Inspect executable mode", e))?
            .mode();
        if mode & 0o100 == 0 || mode & 0o6000 != 0 {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Native updater requires an executable without setuid or setgid privileges",
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(unsupported())
    }
}

#[cfg(unix)]
pub(crate) fn same_file(a: &File, b: &File) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let a = a
        .metadata()
        .map_err(|e| Error::io("Inspect open file", e))?;
    let b = b
        .metadata()
        .map_err(|e| Error::io("Inspect named file", e))?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}

#[cfg(not(unix))]
pub(crate) fn same_file(_a: &File, _b: &File) -> Result<bool> {
    Err(unsupported())
}

#[cfg(unix)]
pub(crate) fn write_atomic<T: Serialize>(dir: &File, name: &str, value: &T) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let bytes = serde_json::to_vec(value)
        .map_err(|_| Error::new(ErrorCode::InvalidState, "Cannot serialize updater state"))?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err(Error::new(ErrorCode::Limit, "Updater state exceeds 64 KiB"));
    }
    let target = c_name(std::ffi::OsStr::new(name))?;
    let temporary = c_name(std::ffi::OsStr::new(&format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )))?;
    // SAFETY: exclusive creation in a checked private directory.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(Error::io(
            "Create atomic updater state",
            std::io::Error::last_os_error(),
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|e| Error::io("Write updater state", e))?;
        file.sync_all()
            .map_err(|e| Error::io("Sync updater state", e))?;
        // renameat replaces only the directory entry itself, never a symlink target.
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(Error::io(
                "Publish updater state",
                std::io::Error::last_os_error(),
            ));
        }
        dir.sync_all()
            .map_err(|e| Error::io("Sync updater directory", e))?;
        Ok(())
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    result
}

#[cfg(not(unix))]
pub(crate) fn write_atomic<T: Serialize>(_dir: &File, _name: &str, _value: &T) -> Result<()> {
    Err(unsupported())
}

pub(crate) fn path_exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Error::io("Inspect updater path", e)),
    }
}
