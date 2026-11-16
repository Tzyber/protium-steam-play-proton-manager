// Claim-Typen, Claim-Pfad und Rückweg der Lösch-Pipeline (Audit 3.11).

use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
use std::fs;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::RawFd;
#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
use crate::commands::delete_ops::{
    bound_parent, delete_handle_identity, generate_os_random_128, open_delete_child_handle,
    renameat2_no_replace, PendingDelete,
};
#[cfg(not(target_os = "linux"))]
use crate::commands::delete_ops::{renameat2_no_replace, PendingDelete};
use crate::commands::errcode;
#[cfg(target_os = "linux")]
use crate::commands::fd::{
    entry_snapshot_at, fd_identity, open_dir_at, unlink_at, unlink_dir_at, DirEntryKind,
};

/// Ein Claim-Versuch endet mit EEXIST, wenn der Zufallsname kollidiert; vier
/// Versuche deckeln die Schleife (r-11: die Zahl war ein magisches Literal).
#[cfg(target_os = "linux")]
const CLAIM_NAME_ATTEMPTS: u32 = 4;

/// Ergebnis eines erfolgreichen Claims: gebundener Handle und privater Name im
/// gebundenen Parent. Existiert nur unter Linux, weil der Nicht-Linux-Stummel
/// fail-closed ohne Claim zurückkehrt (r-18: die Struktur war unter zwei
/// cfg-Zweigen byteidentisch doppelt definiert).
#[cfg(target_os = "linux")]
pub(super) struct ClaimedDeleteTarget {
    pub(super) handle: fs::File,
    pub(super) name: OsString,
}

#[cfg(target_os = "linux")]
pub(super) fn claim_delete_target(pending: &PendingDelete) -> Result<ClaimedDeleteTarget, String> {
    let parent = bound_parent(pending)?;
    let source_name = pending.target_name.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target name",
        )
    })?;
    let expected = pending.target_handle.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target identity",
        )
    })?;
    let expected_identity = delete_handle_identity(expected)?;

    for _ in 0..CLAIM_NAME_ATTEMPTS {
        let claim_name = OsString::from(format!(
            ".protium-delete-claim-{}",
            generate_os_random_128()?
        ));
        match renameat2_no_replace(parent, source_name, parent, &claim_name) {
            Ok(()) => {
                // Guard direkt nach dem eigenen Rename armen: scheitern das
                // Öffnen oder der Identity-Check, wird der Claim best-effort
                // per NOREPLACE auf den Originalnamen zurückbenannt, statt
                // fremde Daten unter .protium-delete-claim-* liegen zu lassen.
                let mut restore = ClaimRestoreGuard {
                    parent,
                    claim_name: &claim_name,
                    original_name: source_name,
                    armed: true,
                };
                let handle = open_delete_child_handle(parent, &claim_name)
                    .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
                let observed = delete_handle_identity(&handle)
                    .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
                if observed != expected_identity {
                    return Err(if restore.restore() {
                        errcode::with_detail(
                            errcode::TARGET_CHANGED,
                            "target changed before mutation; claim restored to its original name",
                        )
                    } else {
                        errcode::with_detail(
                            errcode::WRITE_UNCERTAIN,
                            "target changed before mutation; claim restore failed or not durable",
                        )
                    });
                }
                restore.disarm();
                drop(restore); // borrow auf claim_name endet vor dem move in das ergebnis
                return Ok(ClaimedDeleteTarget {
                    handle,
                    name: claim_name,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => return Err(errcode::with_detail(errcode::UNREADABLE, error)),
        }
    }
    Err(errcode::with_detail(
        errcode::UNAVAILABLE,
        "unique claim name",
    ))
}

#[cfg(not(target_os = "linux"))]
pub(super) fn claim_delete_target(_pending: &PendingDelete) -> Result<(), String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "delete target claim",
    ))
}

/// Rückweg für einen geclaimten, aber noch nicht mutierten Löschvorgang.
///
/// `claim_delete_target` benennt das Ziel vor der Mutation auf einen privaten
/// Namen um. Scheitert ein Schritt VOR dem destruktiven Aufruf (EACCES, EBUSY,
/// kein Platz im Trash-Ziel, Panik), läge das Verzeichnis sonst dauerhaft unter
/// `.protium-delete-claim-*`: unsichtbar für Steam UND für Protium, weil
/// `findOrphans` auf numerische Namen filtert. Bei compatdata bedeutet
/// unsichtbar = Savegames verloren.
///
/// Der Rückweg gilt nur vor begonnener Mutation. Nach einem `remove_dir_all`
/// ist das Ziel teilweise oder ganz weg; dann bleibt der Claim liegen und der
/// Aufrufer meldet `write-may-have-applied` (Audit 5.1). Ein `NotFound` beim
/// Remove ist kein Erfolg: das Kind kann mitten im Abbau verschwunden sein oder
/// eine zweite Instanz hat den Claim zurückbenannt.
///
/// Der Rückweg ist NOREPLACE: ist am Originalnamen inzwischen etwas Neues
/// entstanden, bleibt der Claim liegen, statt das Neue zu überschreiben.
/// Best effort: ein fehlgeschlagener Rückweg darf den ursprünglichen Fehler
/// nicht verdecken.
///
/// Nicht abgedeckt (per Konstruktion unerreichbar für In-Process-Code):
/// SIGKILL oder Stromausfall im Fenster zwischen Claim und Mutation.
pub(super) struct ClaimRestoreGuard<'a> {
    pub(super) parent: &'a fs::File,
    pub(super) claim_name: &'a OsStr,
    pub(super) original_name: &'a OsStr,
    pub(super) armed: bool,
}

impl ClaimRestoreGuard<'_> {
    /// Nach erfolgreicher Mutation existiert der Claim-Name nicht mehr
    /// (gelöscht oder in den Trash verschoben); es gibt nichts zurückzuholen.
    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }

    /// Benennt den Claim auf den Originalnamen zurück. `true` nur bei
    /// erfolgreichem Rename UND Verzeichnis-fsync: ohne fsync ist der Rückweg
    /// nach einem Absturz nicht belegt, der Zustand bleibt dann unsicher.
    pub(super) fn restore(&mut self) -> bool {
        if !self.armed {
            return false;
        }
        if renameat2_no_replace(
            self.parent,
            self.claim_name,
            self.parent,
            self.original_name,
        )
        .is_err()
        {
            // Ein zweiter Versuch im `Drop` könnte einen zwischenzeitlich
            // untergeschobenen Fremdeintrag treffen; pro Guard genau ein
            // Rückweg, auch wenn er scheitert.
            self.armed = false;
            return false;
        }
        // `armed` fällt unabhängig vom fsync: der Claim-Name ist weg, ein
        // zweiter Rename könnte nur noch einen fremden Namen treffen.
        self.armed = false;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            if crate::commands::fd::sync_dir_fd(self.parent.as_raw_fd()).is_err() {
                return false;
            }
        }
        // Der Nicht-Linux-Stummel kann nicht umbenennen; dort ist der Zweig oben
        // unerreichbar und es gibt keinen fsync-Zweig.
        true
    }
}

impl Drop for ClaimRestoreGuard<'_> {
    fn drop(&mut self) {
        // Best effort wie der Rückweg selbst; der fsync liegt in `restore`,
        // damit es genau eine Stelle für Rename und Sync gibt.
        let _ = self.restore();
    }
}

/// Nach dem Claim: ein Fehlschlag VOR der destruktiven Mutation ist nur dann
/// harmlos, wenn der Originalname wieder steht. Gelingt der Rückweg nicht,
/// bleibt der Claim liegen; dann ist der Zustand unsicher und darf nicht als
/// der ursprüngliche Fehler (etwa „unlesbar, nichts passiert") zurückgehen
/// (Audit 5.1).
#[cfg(target_os = "linux")]
pub(super) fn restore_or_write_uncertain(
    restore: &mut ClaimRestoreGuard<'_>,
    error: String,
) -> String {
    if restore.restore() {
        return error;
    }
    errcode::with_detail(
        errcode::WRITE_UNCERTAIN,
        format!("claim restore failed: {error}"),
    )
}

#[cfg(target_os = "linux")]
const MAX_DELETE_WALK_DEPTH: usize = 256;

/// Liest die Namen aller direkten Kinder eines offenen Verzeichnis-Deskriptors
/// über `/proc/self/fd` ein, damit der `ReadDir`-Stream vor einer Rekursion
/// geschlossen wird und nur geprüfte `dir_fd` + Name weiterlaufen.
#[cfg(target_os = "linux")]
fn read_dir_entry_names(dir_fd: RawFd, max_entries: usize) -> io::Result<Vec<OsString>> {
    let proc_path = Path::new("/proc/self/fd").join(dir_fd.to_string());
    fs::read_dir(&proc_path)?
        .take(max_entries.saturating_add(1))
        .map(|entry| entry.map(|item| item.file_name()))
        .collect()
}

/// Öffnet ein bereits per `entry_snapshot_at` klassifiziertes Unterverzeichnis
/// relativ zu `dir_fd` mit `O_DIRECTORY | O_NOFOLLOW`, prüft dieselbe `(dev, ino)`-
/// Identität gegen Tausch und verifiziert per `dev_of` die Mount-Grenze.
#[cfg(target_os = "linux")]
fn open_verified_subdir(
    dir_fd: RawFd,
    name: &OsStr,
    expected: crate::commands::fd::FdIdentity,
    root_dev: u64,
    dev_of: &mut dyn FnMut(&OsStr, u64) -> u64,
) -> Result<std::os::fd::OwnedFd, DeleteSubdirError> {
    use std::os::fd::AsRawFd;

    let child_fd = open_dir_at(dir_fd, name).map_err(DeleteSubdirError::Io)?;
    let opened = fd_identity(child_fd.as_raw_fd()).map_err(DeleteSubdirError::Io)?;
    if opened != expected {
        return Err(DeleteSubdirError::TargetChanged);
    }
    if dev_of(name, opened.dev) != root_dev {
        return Err(DeleteSubdirError::CrossDevice);
    }
    Ok(child_fd)
}

#[cfg(target_os = "linux")]
enum DeleteSubdirError {
    Io(io::Error),
    TargetChanged,
    CrossDevice,
}

#[cfg(target_os = "linux")]
impl DeleteSubdirError {
    fn into_precheck_error(self) -> String {
        match self {
            Self::Io(error) => errcode::with_detail(
                errcode::code_for_io(&error),
                format!("open delete subdir: {error}"),
            ),
            Self::TargetChanged => errcode::with_detail(
                errcode::TARGET_CHANGED,
                "delete subdir changed during precheck",
            ),
            Self::CrossDevice => errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                "cross-device mount inside delete target",
            ),
        }
    }

    fn into_io_error(self) -> io::Error {
        match self {
            Self::Io(error) => error,
            Self::TargetChanged => io::Error::other("delete subdir changed during removal"),
            Self::CrossDevice => io::Error::from_raw_os_error(libc::EXDEV),
        }
    }
}

/// S-05 Vorprüfung vor der ersten Mutation: stellt sicher, dass alle Einträge
/// im geclaimten Baum auf demselben Dateisystem (`st_dev`) wie `handle` liegen,
/// damit ein Bind-Mount vor dem ersten `unlink` fail-closed zurückgerollt wird.
#[cfg(target_os = "linux")]
pub(super) fn verify_claimed_tree_no_crossdev(handle: &fs::File) -> Result<(), String> {
    verify_claimed_tree_no_crossdev_with_dev_fn(handle, &mut |_, dev| dev)
}

#[cfg(target_os = "linux")]
pub(super) fn verify_claimed_tree_no_crossdev_with_dev_fn(
    handle: &fs::File,
    dev_of: &mut dyn FnMut(&OsStr, u64) -> u64,
) -> Result<(), String> {
    use std::os::fd::AsRawFd;

    let root_dev = delete_handle_identity(handle)?.dev;
    let mut entries = 0usize;
    verify_no_crossdev_at(handle.as_raw_fd(), root_dev, 0, &mut entries, dev_of)
}

#[cfg(target_os = "linux")]
fn verify_no_crossdev_at(
    dir_fd: RawFd,
    root_dev: u64,
    depth: usize,
    entries: &mut usize,
    dev_of: &mut dyn FnMut(&OsStr, u64) -> u64,
) -> Result<(), String> {
    use std::os::fd::AsRawFd;

    if depth > MAX_DELETE_WALK_DEPTH {
        return Err(errcode::with_detail(
            errcode::SIZE_LIMIT,
            "delete walk depth",
        ));
    }
    let remaining = crate::commands::limits::MAX_ENTRIES.saturating_sub(*entries);
    let names = read_dir_entry_names(dir_fd, remaining).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("read delete tree: {error}"),
        )
    })?;
    for name in names {
        *entries += 1;
        if *entries > crate::commands::limits::MAX_ENTRIES {
            return Err(errcode::with_detail(
                errcode::SIZE_LIMIT,
                "delete walk entries",
            ));
        }
        let snap = entry_snapshot_at(dir_fd, &name).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("stat delete entry: {error}"),
            )
        })?;
        if dev_of(&name, snap.identity.dev) != root_dev {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                "cross-device entry inside delete target",
            ));
        }
        if snap.kind == DirEntryKind::Directory {
            let child_fd = open_verified_subdir(dir_fd, &name, snap.identity, root_dev, dev_of)
                .map_err(DeleteSubdirError::into_precheck_error)?;
            verify_no_crossdev_at(child_fd.as_raw_fd(), root_dev, depth + 1, entries, dev_of)?;
        }
    }
    Ok(())
}

/// Leert ein per `dir_fd` gebundenes Verzeichnis rekursiv ohne Symlink-Verfolgung
/// und ohne Überschreiten der Dateisystemgrenze (`st_dev != root_dev` -> `EXDEV`).
#[cfg(target_os = "linux")]
pub(super) fn empty_dir_no_crossdev_with_dev_fn(
    dir_fd: RawFd,
    root_dev: u64,
    depth: usize,
    dev_of: &mut dyn FnMut(&OsStr, u64) -> u64,
) -> io::Result<()> {
    let mut entries = 0usize;
    empty_dir_no_crossdev_inner(dir_fd, root_dev, depth, &mut entries, dev_of)
}

#[cfg(target_os = "linux")]
fn empty_dir_no_crossdev_inner(
    dir_fd: RawFd,
    root_dev: u64,
    depth: usize,
    entries: &mut usize,
    dev_of: &mut dyn FnMut(&OsStr, u64) -> u64,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    if depth > MAX_DELETE_WALK_DEPTH {
        return Err(io::Error::other("delete walk depth exceeded"));
    }
    let remaining = crate::commands::limits::MAX_ENTRIES.saturating_sub(*entries);
    for name in read_dir_entry_names(dir_fd, remaining)? {
        *entries += 1;
        if *entries > crate::commands::limits::MAX_ENTRIES {
            return Err(io::Error::other("delete walk entries exceeded"));
        }
        let snap = entry_snapshot_at(dir_fd, &name)?;
        if dev_of(&name, snap.identity.dev) != root_dev {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if snap.kind == DirEntryKind::Directory {
            {
                let child_fd = open_verified_subdir(dir_fd, &name, snap.identity, root_dev, dev_of)
                    .map_err(DeleteSubdirError::into_io_error)?;
                empty_dir_no_crossdev_inner(
                    child_fd.as_raw_fd(),
                    root_dev,
                    depth + 1,
                    entries,
                    dev_of,
                )?;
            }
            unlink_dir_at(dir_fd, &name)?;
        } else {
            unlink_at(dir_fd, &name)?;
        }
    }
    Ok(())
}

/// S-05: Löscht den geclaimten Baum über offene Verzeichnisdeskriptoren ohne
/// `std::fs::remove_dir_all` und bricht bei fremdem `st_dev` ab.
#[cfg(target_os = "linux")]
pub(super) fn remove_claimed_tree_linux(
    claimed: &ClaimedDeleteTarget,
    parent: &fs::File,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let root_dev = fd_identity(claimed.handle.as_raw_fd())?.dev;
    empty_dir_no_crossdev_with_dev_fn(claimed.handle.as_raw_fd(), root_dev, 0, &mut |_, dev| dev)?;
    unlink_dir_at(parent.as_raw_fd(), &claimed.name)
}

#[cfg(test)]
#[path = "delete_claim_tests.rs"]
mod tests;
