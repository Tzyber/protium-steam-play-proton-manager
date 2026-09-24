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

use crate::commands::errcode;

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
        libc::openat(
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

/// fsync auf einem bereits geöffneten Deskriptor. Ein pfadbasiertes
/// Nachöffnen würde genau die Identität verlieren, die die Deskriptorkette
/// belegt (INV-1).
#[cfg(target_os = "linux")]
pub(super) fn sync_dir_fd(fd: RawFd) -> io::Result<()> {
    loop {
        let result = unsafe { libc::fsync(fd) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Öffnet oder erzeugt ein Unterverzeichnis relativ zu einem gebundenen
/// Parent-Deskriptor. Anlegen und Öffnen bleiben damit an derselben
/// Verzeichnisidentität; ein neu angelegtes Verzeichnis wird sofort
/// synchronisiert.
#[cfg(target_os = "linux")]
pub(super) fn open_or_create_dir_at(parent_fd: RawFd, component: &OsStr) -> io::Result<OwnedFd> {
    match open_dir_at(parent_fd, component) {
        Ok(dir) => Ok(dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            const MODE_700: u32 = 0o700;
            let component_name = component_name(component)?;
            let created = unsafe { libc::mkdirat(parent_fd, component_name.as_ptr(), MODE_700) };
            if created < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            } else {
                sync_dir_fd(parent_fd)?;
            }
            open_dir_at(parent_fd, component)
        }
        Err(error) => Err(error),
    }
}

/// Legt eine Datei exklusiv und symlinkfrei relativ zu einem gebundenen
/// Parent-Deskriptor an. `O_EXCL` verhindert das Truncaten einer vorbereiteten
/// Datei oder eines Symlinks, `O_NOFOLLOW` das Folgen eines solchen.
#[cfg(target_os = "linux")]
pub(super) fn create_exclusive_at(dir_fd: RawFd, name: &OsStr) -> io::Result<fs::File> {
    const O_WRONLY: i32 = 1;
    const O_CREAT: i32 = 0o100;
    const O_EXCL: i32 = 0o200;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    const MODE_600: u32 = 0o600;
    let name = component_name(name)?;
    let fd = unsafe {
        libc::openat(
            dir_fd,
            name.as_ptr(),
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            MODE_600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

/// Benennt einen Eintrag relativ zu gebundenen Deskriptoren um. Beide Seiten
/// bleiben an der geprüften Verzeichnisidentität; das Ziel wird ersetzt, ihm
/// aber nicht gefolgt.
#[cfg(target_os = "linux")]
pub(super) fn rename_at(
    from_dir_fd: RawFd,
    from: &OsStr,
    to_dir_fd: RawFd,
    to: &OsStr,
) -> io::Result<()> {
    let from = component_name(from)?;
    let to = component_name(to)?;
    let result = unsafe { libc::renameat(from_dir_fd, from.as_ptr(), to_dir_fd, to.as_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Entfernt einen Eintrag relativ zu einem gebundenen Deskriptor.
#[cfg(target_os = "linux")]
pub(super) fn unlink_at(dir_fd: RawFd, name: &OsStr) -> io::Result<()> {
    let name = component_name(name)?;
    let result = unsafe { libc::unlinkat(dir_fd, name.as_ptr(), 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
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
        libc::openat(
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
    let metadata = fs::metadata(canonical).map_err(|error| {
        // belegte abwesenheit ist not-found, jeder andere stat-fehler unreadable.
        let code = match error.kind() {
            io::ErrorKind::NotFound => errcode::NOT_FOUND,
            _ => errcode::UNREADABLE,
        };
        errcode::with_detail(
            code,
            format!("cannot stat {} before open: {error}", canonical.display()),
        )
    })?;
    if !metadata.is_dir() {
        return Err(errcode::with_detail(
            errcode::NOT_A_DIRECTORY,
            format!("{} is not a directory", canonical.display()),
        ));
    }
    use std::os::unix::fs::MetadataExt;
    let expected = FdIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    };
    hook();
    let fd = open_absolute_dir(canonical).map_err(|error| {
        errcode::with_detail(
            errcode::UNREADABLE,
            format!("{} descriptor open: {error}", canonical.display()),
        )
    })?;
    let actual = fd_identity(fd.as_raw_fd()).map_err(|error| {
        errcode::with_detail(
            errcode::UNREADABLE,
            format!(
                "cannot stat descriptor for {}: {error}",
                canonical.display()
            ),
        )
    })?;
    if actual != expected {
        return Err(errcode::with_detail(
            errcode::TARGET_CHANGED,
            format!("{} changed while opening descriptor", canonical.display()),
        ));
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
        libc::openat(
            parent_fd,
            name.as_ptr(),
            // FIFOs dürfen nicht schon vor der regulären Dateiprüfung blockieren.
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC | libc::O_NONBLOCK,
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
    let metadata = file.metadata().map_err(|error| {
        errcode::with_detail(errcode::UNREADABLE, format!("cannot stat {label}: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(errcode::with_detail(
            errcode::NOT_A_DIRECTORY,
            format!("{label} is not a regular file"),
        ));
    }
    Ok(metadata.len())
}

/// Gedeckelter Read über einen bereits geöffneten Deskriptor: Längenprüfung,
/// `before_read` unmittelbar vor dem Lesen, `take(max+1)` und Nachprüfung.
/// Die eine Stelle für alle Cap-Reads (Write-Gate, Delete-Inspektion,
/// Read-only-Environment, Library-Discovery).
#[cfg(target_os = "linux")]
pub(super) fn read_fd_bytes(
    file: &mut std::fs::File,
    label: &str,
    max_bytes: u64,
    before_read: &mut dyn FnMut(&mut std::fs::File),
) -> Result<Vec<u8>, String> {
    let length = ensure_regular_fd(file, label)?;
    if length > max_bytes {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
    }
    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        errcode::with_detail(errcode::INVALID_ID, format!("{label} read limit overflows"))
    })?;
    before_read(file);
    let mut bytes = Vec::new();
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            errcode::with_detail(errcode::UNREADABLE, format!("cannot read {label}: {error}"))
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub(super) fn read_fd_text(
    file: &mut std::fs::File,
    label: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let bytes = read_fd_bytes(file, label, max_bytes, &mut |_| {})?;
    String::from_utf8(bytes).map_err(|error| {
        errcode::with_detail(errcode::UNREADABLE, format!("cannot read {label}: {error}"))
    })
}

/// Bytes als kleingeschriebener Hex-String. Drei Stellen (Token-Generierung,
/// Stream-Hash, Diskhash) brauchten dieselbe Umwandlung.
#[cfg(target_os = "linux")]
pub(super) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // schreiben in einen String kann nicht fehlschlagen
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
