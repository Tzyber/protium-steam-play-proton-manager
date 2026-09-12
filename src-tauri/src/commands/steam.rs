// Steam-Write-Gate für Konfigurationsdateien und Compat-Tools.

use std::ffi::{CString, OsStr};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;

use tauri::Manager;

use crate::commands::compat_auth::is_authorized_compat_tool;
#[cfg(target_os = "linux")]
use crate::commands::fd::{component_name, open_bound_root_fd, open_dir_at, read_fd_text};
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

#[cfg(target_os = "linux")]
fn read_config_text_bounded(path: &Path, label: &str) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| format!("{label}: {error}"))?;
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
        return Err(format!("{label} exceeds read limit"));
    }
    let mut text = String::new();
    file.take(MAX_CONFIG_VDF_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if text.len() as u64 > MAX_CONFIG_VDF_BYTES {
        return Err(format!("{label} exceeds read limit"));
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

#[cfg(target_os = "linux")]
fn sync_dir_fd(fd: RawFd) -> io::Result<()> {
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

#[cfg(target_os = "linux")]
fn open_or_create_dir_at(parent_fd: RawFd, component: &OsStr) -> io::Result<OwnedFd> {
    match open_dir_at(parent_fd, component) {
        Ok(dir) => Ok(dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            const MODE_700: u32 = 0o700;
            let component_name = component_name(component)?;
            let created = unsafe { mkdirat(parent_fd, component_name.as_ptr(), MODE_700) };
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

#[cfg(target_os = "linux")]
extern "C" {
    fn openat(dirfd: RawFd, pathname: *const i8, flags: i32, mode: u32) -> i32;
    fn mkdirat(dirfd: RawFd, pathname: *const i8, mode: u32) -> i32;
    fn unlinkat(dirfd: RawFd, pathname: *const i8, flags: i32) -> i32;
}

#[cfg(target_os = "linux")]
fn open_backup_target_no_follow(
    relative: &Path,
    backup_dir: &Path,
) -> io::Result<(std::fs::File, OwnedFd, CString)> {
    const O_WRONLY: i32 = 1;
    const O_CREAT: i32 = 0o100;
    const O_EXCL: i32 = 0o200;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    const MODE_600: u32 = 0o600;

    let mut components = relative.components().peekable();
    let file_name = match components.next_back() {
        Some(std::path::Component::Normal(name)) => component_name(name)?,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "backup relative path must end in a normal file name",
            ))
        }
    };

    let backup_dir_c = CString::new(backup_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "backup_dir contains NUL byte"))?;
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    let root_fd = unsafe {
        openat(
            -100, // AT_FDCWD
            backup_dir_c.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut current_dir = unsafe { OwnedFd::from_raw_fd(root_fd) };

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

    let raw_fd = unsafe {
        openat(
            current_dir.as_raw_fd(),
            file_name.as_ptr(),
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            MODE_600,
        )
    };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { std::fs::File::from_raw_fd(raw_fd) };
    Ok((file, current_dir, file_name))
}

#[cfg(target_os = "linux")]
fn unlink_backup_entry(dir_fd: RawFd, file_name: &CString) {
    unsafe {
        let _ = unlinkat(dir_fd, file_name.as_ptr(), 0);
    }
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
        .map_err(|e| format!("backup open (no-follow): {e}"))?;
    if let Err(e) = file
        .write_all(original.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        unlink_backup_entry(dir_fd.as_raw_fd(), &file_name);
        let _ = sync_directory(dir_fd.as_raw_fd());
        return Err(format!("backup write: {e}"));
    }
    drop(file);
    if let Err(e) = sync_directory(dir_fd.as_raw_fd()) {
        unlink_backup_entry(dir_fd.as_raw_fd(), &file_name);
        let _ = sync_directory(dir_fd.as_raw_fd());
        return Err(format!("backup directory sync: {e}"));
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
    Err("backup write: no-follow open unsupported on this platform".into())
}

#[derive(Debug, PartialEq, Eq)]
enum PersistAtomicError {
    BeforeRename(String),
    AfterRename(String),
}

impl std::fmt::Display for PersistAtomicError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforeRename(error) => write!(formatter, "write not applied: {error}"),
            Self::AfterRename(error) => {
                write!(formatter, "write may have been applied: {error}")
            }
        }
    }
}

fn persist_atomic_with_ops<S, R, D>(
    tmp: &Path,
    canon: &Path,
    bytes: &[u8],
    sync_file: &mut S,
    rename: &mut R,
    sync_parent: &mut D,
) -> Result<(), PersistAtomicError>
where
    S: FnMut(&mut fs::File) -> io::Result<()>,
    R: FnMut(&Path, &Path) -> io::Result<()>,
    D: FnMut(&Path) -> io::Result<()>,
{
    let parent = canon
        .parent()
        .ok_or_else(|| PersistAtomicError::BeforeRename("atomic write: no parent dir".into()))?;
    let mut file = match fs::File::create(tmp) {
        Ok(file) => file,
        Err(error) => {
            return Err(PersistAtomicError::BeforeRename(format!(
                "atomic write: {error}"
            )))
        }
    };
    if let Err(error) = file.write_all(bytes).and_then(|()| sync_file(&mut file)) {
        drop(file);
        let _ = fs::remove_file(tmp);
        return Err(PersistAtomicError::BeforeRename(format!(
            "atomic write: {error}"
        )));
    }
    drop(file);
    if let Err(error) = rename(tmp, canon) {
        let _ = fs::remove_file(tmp);
        return Err(PersistAtomicError::BeforeRename(format!(
            "atomic write: {error}"
        )));
    }
    if let Err(error) = sync_parent(parent) {
        return Err(PersistAtomicError::AfterRename(format!(
            "atomic write (parent sync): {error}"
        )));
    }
    Ok(())
}

/// Schreibt die gepatchte Config crash-durable: Daten-fsync vor dem Rename,
/// fsync des Parent-Verzeichnisses danach. Ein Fehler vor dem Rename lässt
/// das Ziel unverändert und räumt die Temp-Datei auf. Nach dem Rename wird
/// ein Parent-fsync-Fehler als mögliche Mutation gemeldet.
fn persist_atomic(tmp: &Path, canon: &Path, bytes: &[u8]) -> Result<(), PersistAtomicError> {
    let mut sync_file = |file: &mut fs::File| file.sync_all();
    let mut rename = |from: &Path, to: &Path| fs::rename(from, to);
    let mut sync_parent =
        |parent: &Path| fs::File::open(parent).and_then(|directory| directory.sync_all());
    persist_atomic_with_ops(
        tmp,
        canon,
        bytes,
        &mut sync_file,
        &mut rename,
        &mut sync_parent,
    )
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
        return Err("invalid account id".into());
    }
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|_| "invalid app id".to_string())?;
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| format!("steam root canonicalize: {e}"))?;
    let target = root
        .join("userdata")
        .join(account_id)
        .join("config")
        .join("localconfig.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| format!("write target canonicalize: {e}"))?;
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err("write target in blocked location".into());
    }
    if !is_steam_config_path(&canon, home) {
        return Err("write target is not a steam config file".into());
    }
    // der guard deckt read, patch, backup und target-write ab (INV-1)
    let _write_guard = lock_write_target(&canon);
    #[cfg(test)]
    WRITE_LOCK_ENTRY_PROBE.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() {
            let _ = sender.send(());
        }
    });

    let original = read_config_text_bounded(&canon, "read target")?;
    let app_id_str = app_id.to_string();
    let path = [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Apps",
        &app_id_str,
        "LaunchOptions",
    ];

    let current_val = vdf_patch::get_vdf_value(&original, &path)?;
    let trimmed = launch_options.trim();

    let patched = if trimmed.is_empty() {
        if current_val.is_none() {
            return Ok(WriteResult::Unchanged);
        }
        vdf_patch::remove_vdf_entry(&original, &path)?
    } else {
        if current_val.as_deref() == Some(launch_options) {
            return Ok(WriteResult::Unchanged);
        }
        vdf_patch::set_vdf_value(&original, &path, launch_options)?
    };

    if patched == original {
        return Ok(WriteResult::Unchanged);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_rel =
        Path::new("backups").join(format!("localconfig-{}-{}.vdf", account_id, timestamp));
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    write_backup_no_follow(&backup_rel, backup_dir, &original)?;

    let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
    let name = canon
        .file_name()
        .ok_or_else(|| "no file name".to_string())?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        random_suffix()
    ));
    let write_result = persist_atomic(&tmp, &canon, patched.as_bytes());
    if let Err(e) = write_result {
        return Err(e.to_string());
    }

    Ok(WriteResult::Written)
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
        .map_err(|_| "invalid app id".to_string())?;
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| format!("steam root canonicalize: {e}"))?;
    #[cfg(target_os = "linux")]
    let steam_root_fd = open_bound_root_fd(&root, &mut || {})?;
    let target = root.join("config").join("config.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| format!("write target canonicalize: {e}"))?;
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err("write target in blocked location".into());
    }
    if !is_steam_config_path(&canon, home) {
        return Err("write target is not a steam config file".into());
    }
    // der guard deckt read, patch, backup und target-write ab (INV-1)
    let _write_guard = lock_write_target(&canon);
    #[cfg(test)]
    WRITE_LOCK_ENTRY_PROBE.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() {
            let _ = sender.send(());
        }
    });

    let original = read_config_text_bounded(&canon, "read target")?;
    let app_id_str = app_id.to_string();
    let name_path = [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        &app_id_str,
        "name",
    ];
    let current_name = vdf_patch::get_vdf_value(&original, &name_path)?;

    let patched = match tool_name {
        None | Some("default") => {
            if current_name.is_none() {
                return Ok(WriteResult::Unchanged);
            }
            let path = [
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                &app_id_str,
            ];
            vdf_patch::remove_vdf_entry(&original, &path)?
        }
        Some(tool) => {
            if !is_authorized_compat_tool(
                &root,
                #[cfg(target_os = "linux")]
                Some(&steam_root_fd),
                tool,
            )? {
                return Err("compat tool is not currently installed or backend-authorized".into());
            }
            if current_name.as_deref() == Some(tool) {
                return Ok(WriteResult::Unchanged);
            }
            let base = [
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                &app_id_str,
            ];
            let mut p = vdf_patch::set_vdf_value(
                &original,
                &[base[0], base[1], base[2], base[3], base[4], base[5], "name"],
                tool,
            )?;
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
            p
        }
    };

    if patched == original {
        return Ok(WriteResult::Unchanged);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_rel = Path::new("backups").join(format!("config-{}-{}.vdf", app_id, timestamp));
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    write_backup_no_follow(&backup_rel, backup_dir, &original)?;

    let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
    let name = canon
        .file_name()
        .ok_or_else(|| "no file name".to_string())?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        random_suffix()
    ));
    let write_result = persist_atomic(&tmp, &canon, patched.as_bytes());
    if let Err(e) = write_result {
        return Err(e.to_string());
    }

    Ok(WriteResult::Written)
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
