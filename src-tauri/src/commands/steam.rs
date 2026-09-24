// Steam-Write-Gate für Konfigurationsdateien und Compat-Tools.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use tauri::Manager;

use crate::commands::compat_auth::is_authorized_compat_tool;
use crate::commands::errcode;
use crate::commands::fd;
#[cfg(target_os = "linux")]
use crate::commands::fd::{
    open_absolute_dir, open_bound_root_fd, open_file_at, open_or_create_dir_at, read_fd_text,
    sync_dir_fd,
};
use crate::commands::fs_ops::is_process_running_sync;
use crate::commands::path::{is_safe_path, random_suffix, sanitize_path};
use crate::commands::spawn_blocking_io;
use crate::commands::vdf_patch;

/// steam-schreibweise der compat-tool-priority im mapping.
const STEAM_COMPAT_PRIORITY: &str = "250";

/// Gedeckelter Text-Read für Steam-Config-Dateien im Write-Gate (16 MiB).
/// Eine präparierte oder aufgeblähte Datei darf keinen Speicherversuch
/// in eine Voll-Allokation (OOM) treiben.
const MAX_CONFIG_VDF_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

/// Gedeckelter Eingabewert des Write-Gate-IPC. Der Wert wird gepatcht,
/// mehrfach kopiert und landet in der Config; ein beliebig großer String ist
/// weder ein realistischer Startoptionen-Wert noch ein realistischer Toolname.
const MAX_PATCH_VALUE_BYTES: u64 = 16 * 1024;

/// Das Write-Gate schreibt nur Text, den es anschließend selbst wieder lesen
/// kann: ein gepatchter Text über der Lesegrenze erzeugte sonst eine dauerhaft
/// unlesbare Config.
fn ensure_size(text: &str, limit: u64, label: &str) -> Result<(), String> {
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
        let code = if error.kind() == io::ErrorKind::NotFound {
            errcode::NOT_FOUND
        } else {
            errcode::UNREADABLE
        };
        errcode::with_detail(code, format!("{label}: {error}"))
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

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum WriteResult {
    Written,
    Unchanged,
}

/// Prüft, ob ein kanonischer Pfad eine
/// der legitimen steam-config-dateien ist: drei canonicalisierte root-
/// varianten (nativ/flatpak/snap). Die fünf Discovery-Kandidaten liegen in
/// `scope.rs`; `.steam/steam` und `.steam/root` sind Symlinks und kollabieren
/// per canonicalize auf die native variante. Erlaubt sind `config/config.vdf`
/// und `userdata/<digits>/config/localconfig.vdf`.
fn is_steam_config_path(file: &Path, home: &Path) -> bool {
    let roots = [
        home.join(".local/share/Steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
        home.join("snap/steam/common/.local/share/Steam"),
    ];
    for root in &roots {
        if file == root.join("config").join("config.vdf") {
            return true;
        }
        if let Ok(rel) = file.strip_prefix(root.join("userdata")) {
            let comps: Vec<_> = rel.components().collect();
            if comps.len() == 3
                && comps[0]
                    .as_os_str()
                    .to_string_lossy()
                    .chars()
                    .all(|c| c.is_ascii_digit())
                && comps[1].as_os_str() == "config"
                && comps[2].as_os_str() == "localconfig.vdf"
            {
                return true;
            }
        }
    }
    false
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
            return Err(PersistAtomicError::BeforeRename(format!(
                "atomic write: {error}"
            )))
        }
    };
    if let Err(error) = file
        .write_all(bytes)
        .and_then(|()| (ops.sync_file)(&mut file))
    {
        drop(file);
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::BeforeRename(format!(
            "atomic write: {error}"
        )));
    }
    drop(file);
    if let Err(error) = (ops.before_rename)() {
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::Aborted(error));
    }
    if let Err(error) = (ops.rename)(dir_fd, tmp_name, dir_fd, target_name) {
        let _ = fd::unlink_at(dir_fd, tmp_name);
        return Err(PersistAtomicError::BeforeRename(format!(
            "atomic write: {error}"
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
    let parent = target
        .parent()
        .ok_or_else(|| PersistAtomicError::BeforeRename("atomic write: no parent dir".into()))?;
    let target_name = target
        .file_name()
        .ok_or_else(|| PersistAtomicError::BeforeRename("atomic write: no file name".into()))?;
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
fn apply_write_gate<F, P>(
    canon: &Path,
    home: &Path,
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
    if !is_steam_config_path(canon, home) {
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

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_rel = Path::new("backups").join(backup_name(timestamp));
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

pub(super) fn save_launch_options_inner<F>(
    steam_root: &str,
    account_id: &str,
    app_id: u32,
    launch_options: &str,
    backup_dir: &Path,
    home: &Path,
    process_reader: &mut F,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
{
    sanitize_path(steam_root, "steam root")?;
    if account_id.parse::<u64>().map_or(true, |value| value == 0) {
        return Err(errcode::INVALID_ACCOUNT.into());
    }
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|error| errcode::with_detail(errcode::INVALID_APPID, error))?;
    ensure_size(launch_options, MAX_PATCH_VALUE_BYTES, "launch options")?;
    if process_reader()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| {
        errcode::with_detail(errcode::NOT_FOUND, format!("steam root canonicalize: {e}"))
    })?;
    let target = root
        .join("userdata")
        .join(account_id)
        .join("config")
        .join("localconfig.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| {
        errcode::with_detail(
            errcode::NOT_FOUND,
            format!("write target canonicalize: {e}"),
        )
    })?;
    let app_id_str = app_id.to_string();
    apply_write_gate(
        &canon,
        home,
        backup_dir,
        |timestamp| format!("localconfig-{account_id}-{timestamp}.vdf"),
        process_reader,
        |original| {
            let path = [
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "Apps",
                &app_id_str,
                "LaunchOptions",
            ];
            let current_val = vdf_patch::get_vdf_value(original, &path)?;

            if launch_options.trim().is_empty() {
                if current_val.is_none() {
                    return Ok(None);
                }
                return Ok(Some(vdf_patch::remove_vdf_entry(original, &path)?));
            }
            if current_val.as_deref() == Some(launch_options) {
                return Ok(None);
            }
            Ok(Some(vdf_patch::set_vdf_value(
                original,
                &path,
                launch_options,
            )?))
        },
    )
}

pub(super) fn save_compat_tool_inner<F>(
    steam_root: &str,
    app_id: u32,
    tool_name: Option<&str>,
    backup_dir: &Path,
    home: &Path,
    process_reader: &mut F,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
{
    sanitize_path(steam_root, "steam root")?;
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|error| errcode::with_detail(errcode::INVALID_APPID, error))?;
    ensure_size(
        tool_name.unwrap_or_default(),
        MAX_PATCH_VALUE_BYTES,
        "compat tool name",
    )?;
    if process_reader()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| {
        errcode::with_detail(errcode::NOT_FOUND, format!("steam root canonicalize: {e}"))
    })?;
    #[cfg(target_os = "linux")]
    let steam_root_fd = open_bound_root_fd(&root, &mut || {})?;
    let target = root.join("config").join("config.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| {
        errcode::with_detail(
            errcode::NOT_FOUND,
            format!("write target canonicalize: {e}"),
        )
    })?;
    let app_id_str = app_id.to_string();
    apply_write_gate(
        &canon,
        home,
        backup_dir,
        |timestamp| format!("config-{app_id}-{timestamp}.vdf"),
        process_reader,
        |original| {
            let base = [
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                &app_id_str,
            ];
            let name_path = [base[0], base[1], base[2], base[3], base[4], base[5], "name"];
            let current_name = vdf_patch::get_vdf_value(original, &name_path)?;

            match tool_name {
                None | Some("default") => {
                    if current_name.is_none() {
                        return Ok(None);
                    }
                    Ok(Some(vdf_patch::remove_vdf_entry(original, &base)?))
                }
                Some(tool) => {
                    if !is_authorized_compat_tool(
                        &root,
                        #[cfg(target_os = "linux")]
                        Some(&steam_root_fd),
                        tool,
                    )? {
                        return Err(errcode::UNKNOWN_TOOL.into());
                    }
                    if current_name.as_deref() == Some(tool) {
                        return Ok(None);
                    }
                    let mut p = vdf_patch::set_vdf_value(original, &name_path, tool)?;
                    p = vdf_patch::set_vdf_value(
                        &p,
                        &[
                            base[0], base[1], base[2], base[3], base[4], base[5], "config",
                        ],
                        "",
                    )?;
                    p = vdf_patch::set_vdf_value(
                        &p,
                        &[
                            base[0], base[1], base[2], base[3], base[4], base[5], "priority",
                        ],
                        STEAM_COMPAT_PRIORITY,
                    )?;
                    Ok(Some(p))
                }
            }
        },
    )
}

/// Prüft alle vorhandenen App-Manifeste und bricht bei unklaren Live-Daten ab.
/// Some(name) = app installiert (name aus dem manifest, evtl. leer),
/// None = app in keiner library gefunden.
#[tauri::command]
pub async fn save_launch_options(
    app: tauri::AppHandle,
    steam_root: String,
    account_id: String,
    app_id: u32,
    launch_options: String,
) -> Result<WriteResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    spawn_blocking_io(move || {
        let mut process_reader = || is_process_running_sync("steam");
        save_launch_options_inner(
            &steam_root,
            &account_id,
            app_id,
            &launch_options,
            &backup_dir,
            &home,
            &mut process_reader,
        )
    })
    .await
}

#[tauri::command]
pub async fn save_compat_tool(
    app: tauri::AppHandle,
    steam_root: String,
    app_id: u32,
    tool_name: Option<String>,
) -> Result<WriteResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    spawn_blocking_io(move || {
        let mut process_reader = || is_process_running_sync("steam");
        save_compat_tool_inner(
            &steam_root,
            app_id,
            tool_name.as_deref(),
            &backup_dir,
            &home,
            &mut process_reader,
        )
    })
    .await
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupEntry {
    pub file_name: String,
    pub kind: String,
    pub target_id: String,
    pub timestamp_ms: u64,
    pub size_bytes: u64,
}

pub(super) fn parse_backup_file_name(name: &str) -> Option<(String, String, u64)> {
    let stem = name.strip_suffix(".vdf")?;
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let kind = parts[0];
    if kind != "localconfig" && kind != "config" {
        return None;
    }
    let target_id = parts[1];
    if target_id.is_empty() || !target_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let timestamp_ms = parts[2].parse::<u64>().ok()?;
    Some((kind.to_string(), target_id.to_string(), timestamp_ms))
}

pub(super) fn list_config_backups_in_dir(
    backup_dir: &Path,
) -> Result<Vec<ConfigBackupEntry>, String> {
    // WARUM eigene Pruefung statt prepare_app_dir: die Liste darf nichts
    // anlegen (fehlender Ordner heisst "keine Backups") und muss einen
    // symlinkten Ordner als Blockade melden.
    match fs::symlink_metadata(backup_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(errcode::with_detail(errcode::UNAVAILABLE, error)),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(errcode::BLOCKED.into());
        }
        Ok(_) => {}
    }
    let entries =
        fs::read_dir(backup_dir).map_err(|e| errcode::with_detail(errcode::UNREADABLE, e))?;
    let mut results = Vec::new();
    for entry in entries.flatten() {
        // Ein defekter Eintrag darf die Liste nicht als Ganzes verhindern.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if let Some((kind, target_id, timestamp_ms)) = parse_backup_file_name(&file_name) {
            results.push(ConfigBackupEntry {
                file_name,
                kind,
                target_id,
                timestamp_ms,
                size_bytes: metadata.len(),
            });
        }
    }
    results.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp_ms));
    Ok(results)
}

#[tauri::command]
pub async fn list_config_backups(app: tauri::AppHandle) -> Result<Vec<ConfigBackupEntry>, String> {
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?
        .join("backups");
    spawn_blocking_io(move || list_config_backups_in_dir(&backup_dir)).await
}

#[tauri::command]
pub async fn open_backups_folder(app: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("unavailable: {e}"))?;
    // WARUM prepare_app_dir und nicht der Environment-Snapshot: die Backups
    // gehoeren der App, die Anzeige muss auch ohne Steam-Installation
    // funktionieren. prepare_app_dir bringt dieselbe Haertung (keine
    // Symlink-Komponenten, regulaeres Verzeichnis, kanonischer Pfad).
    let backup_dir =
        crate::commands::scope::prepare_app_dir(&cache_dir.join("backups"), "app backups")?;
    #[cfg(target_os = "linux")]
    {
        spawn_blocking_io(move || {
            crate::commands::external::open_directory_with_handler(
                &mut crate::commands::external::spawn_detached_os,
                &backup_dir,
            )
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = backup_dir;
        Err(errcode::UNSUPPORTED_PLATFORM.into())
    }
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
struct WriteLockProbeGuard;

#[cfg(test)]
impl Drop for WriteLockProbeGuard {
    fn drop(&mut self) {
        WRITE_LOCK_ENTRY_PROBE.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}

#[cfg(test)]
fn set_write_lock_entry_probe(sender: std::sync::mpsc::Sender<()>) -> WriteLockProbeGuard {
    WRITE_LOCK_ENTRY_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(sender);
    });
    WriteLockProbeGuard
}

#[cfg(test)]
#[path = "steam_tests.rs"]
mod tests;
