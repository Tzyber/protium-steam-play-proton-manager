// Generische, plattformgebundene Dateideskriptor-Helfer der Rust-Schicht.
// Geteilt von Write-Gate (steam.rs), Delete-Inspektion (delete_inspect.rs),
// Read-only-Environment (fs_ops.rs) und Extract (extract.rs). steam.rs war
// die historische Heimat; die Trennung hält das Write-Gate-Modul fachlich
// schmal. Alle Helfer sind Linux-no-follow-Deskriptor-Ketten; die Aufrufer
// steuern ihre eigenen cfg-Fallbacks.

#![cfg(target_os = "linux")]

use std::ffi::CString;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

#[cfg(target_os = "linux")]
extern "C" {
    fn openat(dirfd: RawFd, pathname: *const i8, flags: i32, mode: u32) -> i32;
}

#[cfg(target_os = "linux")]
pub(super) fn component_name(component: &OsStr) -> io::Result<CString> {
    CString::new(component.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL"))
}

#[cfg(target_os = "linux")]
pub(super) fn open_dir_at(parent_fd: RawFd, component: &OsStr) -> io::Result<OwnedFd> {
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let component = component_name(component)?;
    let fd = unsafe {
        openat(
            parent_fd,
            component.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
#[cfg(target_os = "linux")]
pub(super) fn open_absolute_dir(path: &Path) -> io::Result<OwnedFd> {
    const AT_FDCWD: RawFd = -100;
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let fd = unsafe {
        openat(
            AT_FDCWD,
            path.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
pub(super) fn open_bound_root_fd<F>(canonical: &Path, hook: &mut F) -> Result<OwnedFd, String>
where
    F: FnMut() + ?Sized,
{
    let metadata = fs::metadata(canonical)
        .map_err(|error| format!("cannot stat Steam root before open: {error}"))?;
    if !metadata.is_dir() {
        return Err("Steam root is not a directory".into());
    }
    use std::os::unix::fs::MetadataExt;
    let expected = FdIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    };
    hook();
    let fd = open_absolute_dir(canonical)
        .map_err(|error| format!("steam root descriptor open: {error}"))?;
    let actual = fd_identity(fd.as_raw_fd())
        .map_err(|error| format!("cannot stat Steam root descriptor: {error}"))?;
    if actual != expected {
        return Err("Steam root changed while opening descriptor".into());
    }
    Ok(fd)
}

#[cfg(target_os = "linux")]
pub(super) fn open_file_at(parent_fd: RawFd, name: &OsStr) -> io::Result<std::fs::File> {
    const O_RDONLY: i32 = 0;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let name = component_name(name)?;
    let fd = unsafe {
        openat(
            parent_fd,
            name.as_ptr(),
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FdIdentity {
    pub dev: u64,
    pub ino: u64,
}

#[cfg(target_os = "linux")]
pub(super) fn fd_identity(fd: RawFd) -> io::Result<FdIdentity> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(FdIdentity {
        dev: stat.st_dev,
        ino: stat.st_ino,
    })
}

#[cfg(target_os = "linux")]
pub(super) fn ensure_regular_fd(file: &std::fs::File, label: &str) -> Result<u64, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot stat {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    Ok(metadata.len())
}

#[cfg(target_os = "linux")]
pub(super) fn read_fd_text(
    file: &mut std::fs::File,
    label: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let length = ensure_regular_fd(file, label)?;
    if length > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} read limit overflows"))?;
    let mut text = String::new();
    file.take(read_limit)
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if text.len() as u64 > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    Ok(text)
}
