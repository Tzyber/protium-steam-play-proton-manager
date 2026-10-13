// Write-Gate für Steam-Config-Dateien (INV-1): Pfadprüfung, Lock, gedeckelter
// Read, Backup und descriptorgebundener atomarer Write. Die Aufrufer in
// steam.rs liefern nur ihren Patch.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use crate::commands::errcode;
use crate::commands::fd;
#[cfg(target_os = "linux")]
use crate::commands::fd::{
    open_absolute_dir, open_bound_root_fd, open_file_at, open_or_create_dir_at, read_fd_text,
    sync_dir_fd,
};
use crate::commands::path::{is_safe_path, random_suffix};
use crate::commands::steam::WriteResult;

/// Gedeckelter Text-Read für Steam-Config-Dateien im Write-Gate (16 MiB).
/// Eine präparierte oder aufgeblähte Datei darf keinen Speicherversuch
/// in eine Voll-Allokation (OOM) treiben.
pub(super) const MAX_CONFIG_VDF_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

/// Das Write-Gate schreibt nur Text, den es anschließend selbst wieder lesen
/// kann: ein gepatchter Text über der Lesegrenze erzeugte sonst eine dauerhaft
/// unlesbare Config.
pub(super) fn ensure_size(text: &str, limit: u64, label: &str) -> Result<(), String> {
    if text.len() as u64 > limit {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
    }
    Ok(())
}

/// r-01: der read läuft wie der harte lesepfad in fs_ops über eine gebundene
/// no-follow-deskriptorkette: der parent wird identitätsgeprüft gebunden, die
/// datei per `open_file_at` (O_NOFOLLOW) daraus geöffnet. ein im fenster
/// zwischen pfadprüfung und open getauschter symlink würde sonst fremden
/// inhalt ins backup und durch den patch lassen.
#[cfg(target_os = "linux")]
fn read_config_text_bounded(path: &Path, label: &str) -> Result<String, String> {
    let parent = path.parent().ok_or_else(|| {
        errcode::with_detail(errcode::UNREADABLE, format!("{label}: no parent directory"))
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        errcode::with_detail(errcode::UNREADABLE, format!("{label}: no file name"))
    })?;
    let parent_fd = open_bound_root_fd(parent, &mut || {})
        .map_err(|error| errcode::with_context(label, &error))?;
    let mut file = open_file_at(parent_fd.as_raw_fd(), file_name).map_err(|error| {
        errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
    })?;
    read_fd_text(&mut file, label, MAX_CONFIG_VDF_BYTES)
}

#[cfg(not(target_os = "linux"))]
fn read_config_text_bounded(path: &Path, label: &str) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|error| format!("{label}: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("{label}: {error}"))?
        .len();
    if length > MAX_CONFIG_VDF_BYTES {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
    }
    let mut text = String::new();
    file.take(MAX_CONFIG_VDF_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if text.len() as u64 > MAX_CONFIG_VDF_BYTES {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
    }
    Ok(text)
}

/// Erlaubt nur `config/config.vdf` und `userdata/<digits>/config/localconfig.vdf`
/// unter genau diesem kanonischen Steam-Root (INV-1). Der Root kommt aus dem
/// Snapshot, nicht aus einer zweiten fest kodierten Wurzelliste: Discovery
/// kennt fünf Kandidaten und kanonisiert `$HOME`, das Write-Gate folgt dem.
fn is_steam_config_path(file: &Path, steam_root: &Path) -> bool {
    if file == steam_root.join("config").join("config.vdf") {
        return true;
    }
    let Ok(rel) = file.strip_prefix(steam_root.join("userdata")) else {
        return false;
    };
    let comps: Vec<_> = rel.components().collect();
    comps.len() == 3
        && comps[0]
            .as_os_str()
            .to_string_lossy()
            .chars()
            .all(|c| c.is_ascii_digit())
        && comps[1].as_os_str() == "config"
        && comps[2].as_os_str() == "localconfig.vdf"
}

/// Bindet den angeforderten Steam-Root an den schon kanonischen Snapshot-Root,
/// wie `delete_ops::ensure_current_steam_root`. Der gespeicherte Root wird
/// nicht noch einmal aufgelöst: sonst folgt das Gate einem Symlink, der den
/// Snapshot-Ordner nach der Discovery ersetzt hat.
pub(super) fn canonical_allowed_steam_root(
    steam_root: &str,
    allowed_steam_root: &Path,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(steam_root).map_err(|error| {
        errcode::with_detail(
            errcode::NOT_FOUND,
            format!("steam root canonicalize: {error}"),
        )
    })?;
    if root != allowed_steam_root {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            "steam root is not the current environment root",
        ));
    }
    Ok(root)
}

/// Öffnet das Backup-Ziel exklusiv und symlinkfrei entlang gebundener
/// Deskriptoren. Die Datei selbst legt `fd::create_exclusive_at` an, damit es
/// nur eine Stelle mit diesen Flags gibt.
#[cfg(target_os = "linux")]
fn open_backup_target_no_follow(
    relative: &Path,
    backup_dir: &Path,
) -> io::Result<(std::fs::File, OwnedFd, OsString)> {
    let mut components = relative.components().peekable();
    let file_name = match components.next_back() {
        Some(std::path::Component::Normal(name)) => name.to_os_string(),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "backup relative path must end in a normal file name",
            ))
        }
    };

    let mut current_dir = open_absolute_dir(backup_dir)?;

    for component in components {
        let name = match component {
            std::path::Component::Normal(name) => name,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "backup relative path contains non-normal component",
                ))
            }
        };
        current_dir = open_or_create_dir_at(current_dir.as_raw_fd(), name)?;
    }

    let file = fd::create_exclusive_at(current_dir.as_raw_fd(), &file_name)?;
    Ok((file, current_dir, file_name))
}

#[cfg(target_os = "linux")]
fn unlink_backup_entry(dir_fd: RawFd, file_name: &OsStr) {
    let _ = fd::unlink_at(dir_fd, file_name);
}

#[cfg(target_os = "linux")]
fn write_backup_no_follow_with_sync<F>(
    relative: &Path,
    backup_dir: &Path,
    original: &str,
    sync_directory: &mut F,
) -> Result<(), String>
where
    F: FnMut(RawFd) -> io::Result<()>,
{
    let (mut file, dir_fd, file_name) = open_backup_target_no_follow(relative, backup_dir)
        .map_err(|e| {
            errcode::with_detail(errcode::UNREADABLE, format!("backup open (no-follow): {e}"))
        })?;
    if let Err(e) = file
        .write_all(original.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        unlink_backup_entry(dir_fd.as_raw_fd(), &file_name);
        let _ = sync_directory(dir_fd.as_raw_fd());
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("backup write: {e}"),
        ));
    }
    drop(file);
    if let Err(e) = sync_directory(dir_fd.as_raw_fd()) {
        unlink_backup_entry(dir_fd.as_raw_fd(), &file_name);
        let _ = sync_directory(dir_fd.as_raw_fd());
        // Anders als beim Ziel-rename bleibt hier keine mögliche Mutation
        // zurück: das unvollständige backup wird verworfen und das Ziel nicht
        // angefasst. `write-may-have-applied` wäre deshalb falsch; kodiert
        // wird das unbrauchbare backup als `unreadable`.
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("backup directory sync: {e}"),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn write_backup_no_follow(
    relative: &Path,
    backup_dir: &Path,
    original: &str,
) -> Result<(), String> {
    let mut sync_directory = sync_dir_fd;
    write_backup_no_follow_with_sync(relative, backup_dir, original, &mut sync_directory)
}

#[cfg(not(target_os = "linux"))]
fn write_backup_no_follow(
    _relative: &Path,
    _backup_dir: &Path,
    _original: &str,
) -> Result<(), String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "backup write without no-follow descriptors",
    ))
}

#[derive(Debug, PartialEq, Eq)]
enum PersistAtomicError {
    /// Vor dem rename abgebrochen (z. B. Steam gestartet): das Ziel ist
    /// byteidentisch, der Fehler trägt einen kanonischen Code.
    Aborted(String),
    BeforeRename(String),
    AfterRename(String),
}

impl std::fmt::Display for PersistAtomicError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Aborted(error) => write!(formatter, "{error}"),
            // der bindefehler des parents traegt (target-changed) bereits einen
            // code; with_context haelt ihn im leitfeld, sonst waere der code
            // hinter dem kontext verborgen
            Self::BeforeRename(error) => {
                formatter.write_str(&errcode::with_context("write not applied", error))
            }
            // Der Code muss bis in die Oberfläche durchkommen: dieser Fall ist
            // kein "nichts verändert" (SECURITY.md).
            Self::AfterRename(error) => {
                write!(formatter, "{}: {error}", errcode::WRITE_UNCERTAIN)
            }
        }
    }
}

// Testhaken der descriptorgebundenen Sequenz: im Bindefenster (zwischen Stat
// und Open des Parents), unmittelbar vor der Temp-Anlage und unmittelbar vor
// dem Rename. Produktionsbuilds enthalten sie nicht, damit es dort keinen
// Aufsatzpunkt gibt, über den sich der Pfad austauschen ließe.
#[cfg(test)]
type PersistProbe = Box<dyn FnMut()>;
#[cfg(test)]
type PersistTempProbe = Box<dyn FnMut(&OsStr)>;

#[cfg(test)]
thread_local! {
    static PERSIST_BIND_PROBE: std::cell::RefCell<Option<PersistProbe>> =
        const { std::cell::RefCell::new(None) };
    static PERSIST_TEMP_PROBE: std::cell::RefCell<Option<PersistTempProbe>> =
        const { std::cell::RefCell::new(None) };
    static PERSIST_RENAME_PROBE: std::cell::RefCell<Option<PersistProbe>> =
        const { std::cell::RefCell::new(None) };
}

/// Die fehler-injizierbaren Schritte der Sequenz. Produktiv sind sie die
/// echten Deskriptor-Operationen; Fehlerpfadtests ersetzen einzelne davon.
struct PersistOps<'a> {
    sync_file: &'a mut dyn FnMut(&mut fs::File) -> io::Result<()>,
    before_rename: &'a mut dyn FnMut() -> Result<(), String>,
    rename: &'a mut dyn FnMut(RawFd, &OsStr, RawFd, &OsStr) -> io::Result<()>,
    sync_parent: &'a mut dyn FnMut(RawFd) -> io::Result<()>,
}

/// Crash-durable Sequenz über den gebundenen Parent-Deskriptor: exklusive und
/// symlinkfreie Temp-Anlage, Daten-fsync, Prüfung unmittelbar vor der
/// irreversiblen Mutation, `renameat` auf denselben Deskriptor und Parent-fsync
/// über denselben Deskriptor. Ein Fehler vor dem Rename lässt das Ziel
/// unverändert und räumt die Temp-Datei auf; nach dem Rename meldet ein
/// Parent-fsync-Fehler eine mögliche Mutation.
fn persist_atomic_with_ops(
    dir_fd: RawFd,
    tmp_name: &OsStr,
    target_name: &OsStr,
    bytes: &[u8],
    ops: &mut PersistOps<'_>,
) -> Result<(), PersistAtomicError> {
    let mut file = match fd::create_exclusive_at(dir_fd, tmp_name) {
        Ok(file) => file,
        Err(error) => {
            return Err(PersistAtomicError::BeforeRename(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("atomic write: {error}"),
            )))
        }
    };
    if let Err(error) = file
        .write_all(bytes)
        .and_then(|()| (ops.sync_file)(&mut file))
    {
        drop(file);
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::BeforeRename(errcode::with_detail(
            errcode::code_for_io(&error),
            format!("atomic write: {error}"),
        )));
    }
    drop(file);
    if let Err(error) = (ops.before_rename)() {
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::Aborted(error));
    }
    if let Err(error) = (ops.rename)(dir_fd, tmp_name, dir_fd, target_name) {
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::BeforeRename(errcode::with_detail(
            errcode::code_for_io(&error),
            format!("atomic write: {error}"),
        )));
    }
    if let Err(error) = (ops.sync_parent)(dir_fd) {
        return Err(PersistAtomicError::AfterRename(format!(
            "atomic write (parent sync): {error}"
        )));
    }
    Ok(())
}

/// Bindet den Parent-Deskriptor des Ziels und führt die Sequenz mit den
/// produktiven Operationen aus. `process_reader` wird unmittelbar vor dem
/// Rename ein letztes Mal befragt: startet Steam in diesem Fenster, endet der
/// Vorgang ohne Mutation.
fn persist_atomic<F>(
    target: &Path,
    bytes: &[u8],
    process_reader: &mut F,
) -> Result<(), PersistAtomicError>
where
    F: FnMut() -> Result<bool, String>,
{
    let parent = target.parent().ok_or_else(|| {
        PersistAtomicError::BeforeRename(errcode::with_detail(
            errcode::UNREADABLE,
            "atomic write: no parent dir",
        ))
    })?;
    let target_name = target.file_name().ok_or_else(|| {
        PersistAtomicError::BeforeRename(errcode::with_detail(
            errcode::UNREADABLE,
            "atomic write: no file name",
        ))
    })?;
    let dir = open_bound_root_fd(parent, &mut || {
        #[cfg(test)]
        PERSIST_BIND_PROBE.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook();
            }
        });
    })
    .map_err(PersistAtomicError::BeforeRename)?;
    let tmp_name = OsString::from(format!(
        ".{}.{}.tmp",
        target_name.to_string_lossy(),
        random_suffix()
    ));
    #[cfg(test)]
    PERSIST_TEMP_PROBE.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(&tmp_name);
        }
    });
    let mut sync_file = |file: &mut fs::File| file.sync_all();
    let mut before_rename = || {
        if process_reader()? {
            return Err(errcode::STEAM_RUNNING.to_string());
        }
        #[cfg(test)]
        PERSIST_RENAME_PROBE.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook();
            }
        });
        Ok(())
    };
    let mut rename = |from_dir: RawFd, from: &OsStr, to_dir: RawFd, to: &OsStr| {
        fd::rename_at(from_dir, from, to_dir, to)
    };
    let mut sync_parent = fd::sync_dir_fd;
    let mut ops = PersistOps {
        sync_file: &mut sync_file,
        before_rename: &mut before_rename,
        rename: &mut rename,
        sync_parent: &mut sync_parent,
    };
    persist_atomic_with_ops(dir.as_raw_fd(), &tmp_name, target_name, bytes, &mut ops)
}

/// Serialisiert den Read–Modify–Write-vorgang pro zieldatei (INV-1): zwei
/// gleichzeitige speichervorgänge auf derselben config (zwei AppIDs in
/// `localconfig.vdf`, zwei Compat-zuordnungen in `config.vdf`) dürfen einander
/// nicht mit einem veralteten zwischenstand überschreiben.
static TARGET_WRITE_LOCKS: std::sync::Mutex<
    Option<std::collections::HashMap<std::path::PathBuf, &'static std::sync::Mutex<()>>>,
> = std::sync::Mutex::new(None);

/// Registrierte sperren werden nie entfernt (`Box::leak`), damit derselbe pfad
/// in jedem aufruf dieselbe sperre trifft (INV-1).
fn write_lock_for_target(canon: &Path) -> &'static std::sync::Mutex<()> {
    let mut registry = TARGET_WRITE_LOCKS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let locks = registry.get_or_insert_with(std::collections::HashMap::new);
    if let Some(lock) = locks.get(canon) {
        return lock;
    }
    let lock: &'static std::sync::Mutex<()> = Box::leak(Box::new(std::sync::Mutex::new(())));
    locks.insert(canon.to_path_buf(), lock);
    lock
}

/// Erwirbt den write-lock für `canon`; der aufrufer hält den guard bis zum ende
/// des Read–Modify–Write-vorgangs (INV-1).
fn lock_write_target(canon: &Path) -> std::sync::MutexGuard<'static, ()> {
    write_lock_for_target(canon)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Streng steigender Millisekunden-Stempel je Prozess: zwei Writes in
/// derselben Millisekunde oder nach einem Uhrsprung zurück bekämen sonst
/// denselben Backup-Namen, und `O_EXCL` bräche den zweiten Write ab.
fn next_backup_timestamp() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let previous = LAST
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |last| {
            Some(now.max(last.saturating_add(1)))
        })
        .unwrap_or(0);
    u128::from(now.max(previous.saturating_add(1)))
}

/// Gemeinsames Grundgerüst beider Steam-Config-Schreibpfade (INV-1):
/// Pfadprüfung, Lock, gedeckelter Read, Patch, Größenprüfung,
/// Steam-Läuft-Nachprüfung, Backup und atomarer Write. Die Aufrufer liefern
/// nur ihren Patch; die Reihenfolge bleibt genau die des bisherigen Gates.
/// `patch` liefert `None`, wenn nichts zu ändern ist.
///
/// Die Präambel (sanitize, Argumentprüfung, Eingabegröße, Prozess-Vorprüfung,
/// Auflösung von Root und Ziel) bleibt bewusst beim Aufrufer: sie ist nicht
/// gleich (Account-ID nur im Launch-Pfad, Bindung des Steam-Roots vor der
/// Zielauflösung nur im Compat-Pfad, andere Limits und Labels). Ein Helfer
/// dafür bräuchte mehrere Schalter und zwei Closures und wäre schwerer zu
/// prüfen als die sechs ausgeschriebenen Zeilen (R-04, bewusster Schnitt).
pub(super) fn apply_write_gate<F, P>(
    canon: &Path,
    steam_root: &Path,
    backup_dir: &Path,
    backup_name: impl Fn(u128) -> String,
    process_reader: &mut F,
    patch: P,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
    P: FnOnce(&str) -> Result<Option<String>, String>,
{
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }
    if !is_steam_config_path(canon, steam_root) {
        return Err(errcode::NOT_A_STEAM_CONFIG.into());
    }
    // der guard deckt read, patch, backup und target-write ab (INV-1)
    let _write_guard = lock_write_target(canon);
    #[cfg(test)]
    WRITE_LOCK_ENTRY_PROBE.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() {
            let _ = sender.send(());
        }
    });

    let original = read_config_text_bounded(canon, "read target")?;
    let Some(patched) = patch(&original)? else {
        return Ok(WriteResult::Unchanged);
    };
    if patched == original {
        return Ok(WriteResult::Unchanged);
    }
    ensure_size(&patched, MAX_CONFIG_VDF_BYTES, "patched config")?;

    let backup_rel = Path::new("backups").join(backup_name(next_backup_timestamp()));
    if process_reader()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    write_backup_no_follow(&backup_rel, backup_dir, &original)?;

    let write_result = persist_atomic(canon, patched.as_bytes(), process_reader);
    if let Err(e) = write_result {
        return Err(e.to_string());
    }

    Ok(WriteResult::Written)
}

// test-naht: meldet den erwerb des ziel-locks, damit ein regressionstest die
// serialisierung deterministisch beobachten kann. im produktionsbuild entfällt
// der gesamte block (F2).
#[cfg(test)]
thread_local! {
    static WRITE_LOCK_ENTRY_PROBE: std::cell::RefCell<Option<std::sync::mpsc::Sender<()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) struct WriteLockProbeGuard;

#[cfg(test)]
impl Drop for WriteLockProbeGuard {
    fn drop(&mut self) {
        WRITE_LOCK_ENTRY_PROBE.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}

#[cfg(test)]
pub(super) fn set_write_lock_entry_probe(
    sender: std::sync::mpsc::Sender<()>,
) -> WriteLockProbeGuard {
    WRITE_LOCK_ENTRY_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(sender);
    });
    WriteLockProbeGuard
}

#[cfg(test)]
#[path = "write_gate_tests.rs"]
mod tests;
