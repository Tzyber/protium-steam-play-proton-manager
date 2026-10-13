// Die eine fd-gebundene Lesekette für `libraryfolders.vdf` (r-06): Suche,
// Parser, gedeckelter no-follow-Read, Kanonisierung und (dev,ino)-Dedup der
// gelisteten Libraries. Die Autorisierung des Environments bleibt in scope.rs.

use crate::commands::errcode;
use crate::commands::path::{is_safe_path, sanitize_path};
use crate::commands::vdf_patch;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use crate::commands::fd::{open_bound_root_fd, open_dir_at, open_file_at};
use crate::commands::scope::{
    reject_symlink_components, LibraryUnavailable, LibraryUnavailableReason, MAX_VDF_READ_BYTES,
};
#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};

fn libraryfolders_path(steam_root: &Path) -> Result<Option<PathBuf>, String> {
    for relative in ["config/libraryfolders.vdf", "steamapps/libraryfolders.vdf"] {
        let path = steam_root.join(relative);
        reject_symlink_components(&path, true, "libraryfolders.vdf")?;
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(Some(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("libraryfolders.vdf: {error}"),
                ))
            }
        }
    }
    Ok(None)
}

pub(super) fn parse_library_folder_paths(text: &str) -> Result<Vec<PathBuf>, String> {
    let tokens = vdf_patch::tokenize(text)
        .map_err(|error| errcode::with_context("cannot parse libraryfolders.vdf", &error))?;
    let entries = vdf_patch::scan_entries(&tokens, 0, tokens.len())
        .map_err(|error| errcode::with_context("scan libraryfolders entries", &error))?;
    let root_entry = entries
        .into_iter()
        .find(|entry| {
            matches!(&entry.key.kind, vdf_patch::TokenKind::String(key) if key.eq_ignore_ascii_case("libraryfolders"))
        })
        .ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "missing libraryfolders root block in libraryfolders.vdf",
        )
    })?;
    let (from, to) = root_entry.block.ok_or_else(|| {
        errcode::with_detail(errcode::UNREADABLE, "libraryfolders is not a block")
    })?;
    let children = vdf_patch::scan_entries(&tokens, from, to)
        .map_err(|error| errcode::with_context("scan libraryfolders children", &error))?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for child in children {
        let vdf_patch::TokenKind::String(key) = &child.key.kind else {
            continue;
        };
        if !key.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let Some((child_from, child_to)) = child.block else {
            continue;
        };
        for entry in vdf_patch::scan_entries(&tokens, child_from, child_to)
            .map_err(|error| errcode::with_context("scan library entry", &error))?
        {
            let vdf_patch::TokenKind::String(entry_key) = &entry.key.kind else {
                continue;
            };
            if !entry_key.eq_ignore_ascii_case("path") {
                continue;
            }
            if let vdf_patch::TokenKind::String(value) = &entry.value.kind {
                let path = PathBuf::from(value);
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }
    }
    Ok(paths)
}

/// Zeitpunkte der fd-gebundenen `libraryfolders.vdf`-Lesekette (r-06). Beide
/// Aufrufer (Discovery in `scope`, Valve-Autorität in `compat_auth`) bilden
/// ihre bisherigen Testhaken darauf ab, ohne die Zeitpunkte zu verschieben.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LibraryFoldersStage {
    /// ein Kandidatenverzeichnis (config/steamapps) ist am Deskriptor offen
    DirectoryOpened,
    /// `libraryfolders.vdf` ist am Deskriptor offen, vor dem Lesen
    FileOpened,
}

/// Die eine fd-gebundene Lesekette für `libraryfolders.vdf` (r-06): dieselbe
/// Suchreihenfolge `config`/`steamapps`, dieselbe no-follow-Deskriptorkette und
/// derselbe Cap wie die Discovery. Suchreihenfolge und Parser
/// `parse_library_folder_paths` sind hier verankert, der Cap
/// `MAX_VDF_READ_BYTES` in `scope`; `compat_auth` ist nur ein Konsument
/// derselben Datei.
///
/// Rückgabeform für beide Aufrufer: `Ok(Some(text))` = Datei gelesen,
/// `Ok(None)` = keine Datei, aber `steamapps` vorhanden (Root-Fallback), `Err`
/// = harter Fehler (weder config noch steamapps, oder unlesbar).
#[cfg(target_os = "linux")]
pub(super) fn libraryfolders_contents_from_root_fd(
    root_fd: &OwnedFd,
    hook: &mut dyn FnMut(LibraryFoldersStage),
) -> Result<Option<String>, String> {
    const NAME: &str = "libraryfolders.vdf";
    const LABEL: &str = "libraryfolders.vdf";

    for directory in ["config", "steamapps"] {
        let parent_fd = match open_dir_at(root_fd.as_raw_fd(), OsStr::new(directory)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("{LABEL}: {error}"),
                ))
            }
        };
        hook(LibraryFoldersStage::DirectoryOpened);
        let mut file = match open_file_at(parent_fd.as_raw_fd(), OsStr::new(NAME)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(libraryfolders_open_error(error)),
        };
        hook(LibraryFoldersStage::FileOpened);
        let content = crate::commands::fd::read_fd_text(&mut file, LABEL, MAX_VDF_READ_BYTES)?;
        return Ok(Some(content));
    }
    if open_dir_at(root_fd.as_raw_fd(), OsStr::new("steamapps")).is_err() {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("{LABEL}: no config or steamapps directory"),
        ));
    }
    Ok(None)
}

/// Liest `libraryfolders.vdf` über die gebundene no-follow-Deskriptorkette
/// (S-2): Root und Unterverzeichnis werden als Deskriptor gebunden, die Datei
/// per `openat(O_NOFOLLOW|O_NONBLOCK)` geöffnet und erst am Deskriptor auf
/// regulären Typ und Größe geprüft. Ein Pfad-`fs::read` hinge sonst an einem
/// FIFO, der zwischen Prüfung und Open untergeschoben wird. Der Hook sitzt
/// genau in dieser Lücke, damit ein Test den Tausch dort erzwingen kann.
#[cfg(target_os = "linux")]
fn libraryfolders_contents_with_hook<F>(
    steam_root: &Path,
    hook: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(),
{
    let root_fd = open_bound_root_fd(steam_root, &mut || {})?;
    libraryfolders_contents_from_root_fd(&root_fd, &mut |stage| {
        if stage == LibraryFoldersStage::DirectoryOpened {
            hook();
        }
    })
}

#[cfg(target_os = "linux")]
fn libraryfolders_open_error(error: io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR) => errcode::with_detail(
            errcode::UNREADABLE,
            format!("libraryfolders.vdf is not a regular file: {error}"),
        ),
        _ => errcode::with_detail(
            errcode::UNREADABLE,
            format!("cannot open libraryfolders.vdf: {error}"),
        ),
    }
}

/// Nicht-Linux baut nicht (Linux-only-App); fail-closed statt Pfad-Read.
#[cfg(not(target_os = "linux"))]
fn libraryfolders_contents_with_hook<F>(
    _steam_root: &Path,
    _hook: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(),
{
    Err("libraryfolders.vdf requires Linux no-follow descriptors".into())
}

fn read_library_paths_with_hook<F>(steam_root: &Path, hook: &mut F) -> Result<Vec<PathBuf>, String>
where
    F: FnMut(),
{
    if libraryfolders_path(steam_root)?.is_none() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    let Some(content) = libraryfolders_contents_with_hook(steam_root, hook)? else {
        return Ok(vec![steam_root.to_path_buf()]);
    };
    let paths = parse_library_folder_paths(&content)?;
    if paths.is_empty() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    Ok(paths)
}

/// kanonisiert eine gelistete library und klassifiziert andernfalls den grund,
/// warum sie nicht nutzbar ist (INV-2). `NotFound` ist belegte abwesenheit,
/// ablehnungen der pfad-validierung sind strukturschäden; echte io-fehler
/// dürfen nicht als abwesenheit gelten, sonst würde ein zugriffsfehler still
/// übersprungen.
fn canonical_library(path: &Path) -> Result<PathBuf, (LibraryUnavailableReason, String)> {
    let raw = path.to_string_lossy();
    sanitize_path(&raw, "library path").map_err(|message| {
        (
            LibraryUnavailableReason::ScopeFailed,
            format!("library path rejected: {message}"),
        )
    })?;
    // Ein Pfad, den die Blocklist ablehnt, darf nie in `libraries` landen: die
    // liste ist das scope-gate für lese- und löschpfade, und `canonicalize_safe`
    // würde ihn ablehnen, ohne dass der aufrufer den grund sehen könnte.
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        #[cfg(unix)]
        Err(error) => {
            let reason = match error.raw_os_error() {
                Some(libc::ENOENT) => LibraryUnavailableReason::PathMissing,
                // ein symlink-loop besteht `lstat`, scheitert erst beim
                // auflösen; `ErrorKind::FilesystemLoop` ist instabil, deshalb
                // der rohe errno auf unix.
                Some(libc::ELOOP | libc::ENOTDIR | libc::EACCES) => {
                    LibraryUnavailableReason::ReadFailed
                }
                _ => LibraryUnavailableReason::ScopeFailed,
            };
            return Err((reason, format!("library path: {error}")));
        }
        #[cfg(not(unix))]
        Err(error) => {
            let reason = match error.kind() {
                io::ErrorKind::NotFound => LibraryUnavailableReason::PathMissing,
                io::ErrorKind::PermissionDenied => LibraryUnavailableReason::ReadFailed,
                _ => LibraryUnavailableReason::ScopeFailed,
            };
            return Err((reason, format!("library path: {error}")));
        }
    };

    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err((
            LibraryUnavailableReason::ScopeFailed,
            errcode::with_detail(errcode::BLOCKED_LOCATION, format!("{path:?}")),
        ));
    }

    let steamapps = canonical.join("steamapps");
    let metadata = fs::symlink_metadata(&steamapps).map_err(|error| {
        let reason = if error.kind() == io::ErrorKind::NotFound {
            LibraryUnavailableReason::PathMissing
        } else {
            LibraryUnavailableReason::ReadFailed
        };
        (reason, format!("library steamapps: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err((
            LibraryUnavailableReason::ScopeFailed,
            format!("library path has no regular steamapps: {path:?}"),
        ));
    }
    Ok(canonical)
}

/// Nur für Tests, die den alten rückgabewert ohne fehlerliste festhalten.
/// Produktionspfade nehmen `read_library_folders_with_failures`: eine hier
/// verworfene fehlerliste wäre genau der F1-verlust (INV-2).
#[cfg(test)]
pub(super) fn read_library_folders(steam_root: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(read_library_folders_with_failures(steam_root)?.0)
}

/// Snapshot-variante: nicht erreichbare libraries werden als grund gesammelt
/// statt verworfen (INV-2, F1). Der Steam-Root selbst bleibt hart.
pub(super) fn read_library_folders_with_failures(
    steam_root: &Path,
) -> Result<(Vec<PathBuf>, Vec<LibraryUnavailable>), String> {
    read_library_folders_with_hook(steam_root, &mut || {})
}

/// Hook-Variante für die Tausch-Regression: der Hook läuft nach der
/// Pfad-Vorprüfung und vor dem Deskriptor-Open, also in der TOCTOU-Lücke von
/// S-2. Produktionsaufrufer nutzen `read_library_folders_with_failures` ohne Hook.
fn read_library_folders_with_hook<F>(
    steam_root: &Path,
    hook: &mut F,
) -> Result<(Vec<PathBuf>, Vec<LibraryUnavailable>), String>
where
    F: FnMut(),
{
    let mut libraries = vec![canonical_library(steam_root).map_err(|(_, message)| message)?];
    let mut unavailable = Vec::new();
    for path in read_library_paths_with_hook(steam_root, hook)? {
        match canonical_library(&path) {
            Ok(canonical) => {
                if !libraries.contains(&canonical) {
                    libraries.push(canonical);
                }
            }
            Err((reason, _)) => unavailable.push(LibraryUnavailable {
                path: path.to_string_lossy().into_owned(),
                reason,
            }),
        }
    }

    let unique = deduplicate_libraries_by_identity(libraries, &mut unavailable);
    Ok((unique, unavailable))
}

/// (dev,ino)-dedup der kanonisierten libraries. Ein fehlschlag des
/// identitäts-stats degradiert die betroffene library in `unavailable`
/// (INV-2: skip + warning) statt die gesamte discovery abzubrechen: zwischen
/// `canonical_library` und diesem stat kann eine library abgehängt werden
/// (adversatives review, befund 2). `NotFound` bleibt wie in `canonical_library`
/// belegte abwesenheit, jeder andere fehler ist ein zugriffsschaden.
fn deduplicate_libraries_by_identity(
    libraries: Vec<PathBuf>,
    unavailable: &mut Vec<LibraryUnavailable>,
) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    let mut identities = HashSet::new();
    for library in libraries {
        let metadata = match fs::metadata(&library) {
            Ok(metadata) => metadata,
            Err(error) => {
                unavailable.push(LibraryUnavailable {
                    path: library.to_string_lossy().into_owned(),
                    reason: if error.kind() == std::io::ErrorKind::NotFound {
                        LibraryUnavailableReason::PathMissing
                    } else {
                        LibraryUnavailableReason::ReadFailed
                    },
                });
                continue;
            }
        };
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(unix)]
        let identity = (metadata.dev(), metadata.ino());
        #[cfg(not(unix))]
        let identity = (0, metadata.len());
        if identities.insert(identity) {
            unique.push(library);
        }
    }
    unique
}

#[cfg(test)]
#[path = "libraryfolders_tests.rs"]
mod tests;
