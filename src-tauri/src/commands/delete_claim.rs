// Claim-Typen, Claim-Pfad und Rückweg der Lösch-Pipeline (Audit 3.11).

use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use crate::commands::delete_ops::{
    bound_parent, delete_handle_identity, generate_os_random_128, open_delete_child_handle,
    renameat2_no_replace, PendingDelete,
};
#[cfg(not(target_os = "linux"))]
use crate::commands::delete_ops::{renameat2_no_replace, PendingDelete};
use crate::commands::errcode;

/// Ein Claim-Versuch endet mit EEXIST, wenn der Zufallsname kollidiert; vier
/// Versuche deckeln die Schleife (r-11: die Zahl war ein magisches Literal).
#[cfg(target_os = "linux")]
const CLAIM_NAME_ATTEMPTS: u32 = 4;

/// Ergebnis eines erfolgreichen Claims: gebundener Handle, privater Name und
/// der `/proc/self/fd`-Pfad für die Mutation. Existiert nur unter Linux, weil
/// der Nicht-Linux-Stummel fail-closed ohne Claim zurückkehrt (r-18: die
/// Struktur war unter zwei cfg-Zweigen byteidentisch doppelt definiert).
#[cfg(target_os = "linux")]
pub(super) struct ClaimedDeleteTarget {
    pub(super) path: PathBuf,
    pub(super) handle: fs::File,
    pub(super) name: OsString,
}

#[cfg(target_os = "linux")]
pub(super) fn claim_delete_target(pending: &PendingDelete) -> Result<ClaimedDeleteTarget, String> {
    use std::os::fd::AsRawFd;

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
                let path = PathBuf::from(format!(
                    "/proc/self/fd/{}/{}",
                    parent.as_raw_fd(),
                    claim_name.to_string_lossy()
                ));
                return Ok(ClaimedDeleteTarget {
                    path,
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

#[cfg(test)]
#[path = "delete_claim_tests.rs"]
mod tests;
