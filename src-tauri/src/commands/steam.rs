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
const MAX_CONFIG_VDF_BYTES: u64 = 16 * 1024 * 1024;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;

    fn wsg_env(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let home = root.join("fakehome");
        let steam = home.join(".local/share/Steam");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
        let config_vdf = r#""InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"620"
					{
						"name"		"GE-Proton9-27"
					}
				}
			}
		}
	}
}
"#;
        let local_vdf = r#""UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
					}
				}
			}
		}
	}
}
"#;
        std::fs::write(steam.join("config/config.vdf"), config_vdf).unwrap();
        std::fs::write(steam.join("userdata/123/config/localconfig.vdf"), local_vdf).unwrap();
        for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
            let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
            std::fs::create_dir_all(&tool_dir).unwrap();
            let tool_vdf = format!(
                "\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}"
            );
            std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
        }
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        (home, cache, steam)
    }

    #[test]
    fn save_launch_options_steam_laeuft_abgelehnt() {
        let (home, cache, steam) = wsg_env("launch-running");
        std::fs::remove_file(steam.join("userdata/123/config/localconfig.vdf")).unwrap();
        let mut reader = || Ok(true);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
        let (home, cache, steam) = wsg_env("launch-process-race");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut states = [false, true].into_iter();
        let mut reader = || Ok(states.next().expect("process reader call"));

        let result = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );

        assert!(result.unwrap_err().contains("steam is running"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_happy_write_and_backup() {
        let (home, cache, steam) = wsg_env("launch-happy");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let mut reader = || Ok(false);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("\"-novid\""));

        let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
        assert!(backup_content.contains("\"gamemoderun %command%\""));

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_empty_removes_entry() {
        let (home, cache, steam) = wsg_env("launch-empty");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let mut reader = || Ok(false);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(!content.contains("LaunchOptions"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_no_op_unchanged() {
        let (home, cache, steam) = wsg_env("launch-noop");
        let mut states = [false].into_iter();
        let mut reader = || Ok(states.next().expect("no-op must check once"));
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "gamemoderun %command%",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Unchanged);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_invalid_account_or_app_id() {
        let (home, cache, steam) = wsg_env("launch-invalid");
        let mut reader = || Ok(false);
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "abc",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "0",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            0,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_steuerzeichen_werden_abgelehnt_ohne_seiteneffekt() {
        let (home, cache, steam) = wsg_env("launch-control");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut reader = || Ok(false);

        for evil in ["gamemoderun %command%\0evil", "\u{7}evil", "\u{1}"] {
            let res = save_launch_options_inner(
                steam.to_str().unwrap(),
                "123",
                620,
                evil,
                &cache,
                &home,
                &mut reader,
            );
            assert!(res.is_err(), "wert {evil:?} muss abgelehnt werden");
        }

        // zieldatei byte-identisch, kein backup, keine temp-datei
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        let parent = target.parent().unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "keine temp-datei darf liegenbleiben");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_tool_name_mit_steuerzeichen_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-control");
        let target = steam.join("config/config.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut reader = || Ok(false);

        // tool_name läuft durch is_authorized_compat_tool; ein name mit NUL
        // ist kein backendgelesener name und muss fail-closed abgelehnt werden
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-27\0x"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_uebergroesse_lehnt_ab_ohne_seiteneffekt() {
        let (home, cache, steam) = wsg_env("launch-oversize");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        std::fs::File::create(&target)
            .unwrap()
            .set_len(MAX_CONFIG_VDF_BYTES + 1)
            .unwrap();
        let mut reader = || Ok(false);

        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        let err = res.unwrap_err();
        assert!(err.contains("read limit"), "unexpected error: {err}");
        // zieldatei unverändert (länge bleibt), kein backup, keine temp-datei
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            MAX_CONFIG_VDF_BYTES + 1
        );
        assert!(!cache.join("backups").exists());
        let parent = target.parent().unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "keine temp-datei darf liegenbleiben");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_exakt_an_der_lesegrenze_kein_read_limit_fehler() {
        let (home, cache, steam) = wsg_env("launch-boundary");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        std::fs::File::create(&target)
            .unwrap()
            .set_len(MAX_CONFIG_VDF_BYTES)
            .unwrap();
        let mut reader = || Ok(false);

        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        // die 16-MiB-grenze selbst ist kein read-limit-fehler (der strukturbruch
        // durch das nul-padding ist erwartbar und getrennt)
        let err = res.unwrap_err();
        assert!(!err.contains("read limit"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_uebergroesse_lehnt_ab_ohne_seiteneffekt() {
        let (home, cache, steam) = wsg_env("compat-oversize");
        let target = steam.join("config/config.vdf");
        std::fs::File::create(&target)
            .unwrap()
            .set_len(MAX_CONFIG_VDF_BYTES + 1)
            .unwrap();
        let mut reader = || Ok(false);

        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        let err = res.unwrap_err();
        assert!(err.contains("read limit"), "unexpected error: {err}");
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            MAX_CONFIG_VDF_BYTES + 1
        );
        assert!(!cache.join("backups").exists());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_bleibt_crash_durable_gesichert() {
        // statischer schutz: die dokumentierte write-gate-garantie (atomarer
        // rename PLUS durable inhalte) darf nicht still auf temp+rename
        // ohne fsync zurückfallen.
        let source = include_str!("steam.rs");
        // der test-import steht als eigenes #[cfg(test)] vor dem modul; erst
        // die modul-grenze schneidet den test-code ab
        let production = source
            .split("#[cfg(test)]\nmod tests {")
            .next()
            .expect("test module boundary must exist");
        let persist_body = production
            .split("fn persist_atomic(")
            .nth(1)
            .expect("persist_atomic must exist in production source")
            .split("pub(super) fn save_launch_options_inner")
            .next()
            .expect("persist_atomic must be defined before the write paths");

        let tmp_sync = persist_body.find("file.sync_all()");
        let rename = persist_body.find("fs::rename");
        assert!(
            tmp_sync.is_some() && rename.is_some() && tmp_sync.unwrap() < rename.unwrap(),
            "temp-sync muss vor dem rename laufen"
        );
        let parent_sync = persist_body.find("File::open(parent)");
        assert!(parent_sync.is_some(), "parent-fsync nach rename fehlt");
        assert!(
            persist_body.matches("sync_all()").count() >= 2,
            "tmp- und parent-sync müssen beide vorhanden sein"
        );
        // beide write-pfade nutzen die gemeinsame funktion
        assert_eq!(
            production
                .matches("persist_atomic(&tmp, &canon, patched.as_bytes())")
                .count(),
            2,
            "beide write-pfade müssen persist_atomic nutzen"
        );
        // backup ist ebenfalls sync_alled (darf den stromausfall nicht als leere kopie überleben)
        assert!(
            production.contains("and_then(|()| file.sync_all())"),
            "backup-write muss sync_all enthalten"
        );
        assert!(
            production.contains("sync_directory(dir_fd.as_raw_fd())"),
            "backup-directory-entry muss über den gebundenen descriptor synchronisiert werden"
        );
        assert!(
            production.contains("let mut sync_directory = sync_dir_fd"),
            "produktiver backup-pfad muss den echten descriptor-fsync verwenden"
        );
        assert!(
            production.contains("sync_dir_fd(parent_fd)"),
            "neu angelegte backup-verzeichnisse müssen ihren parent synchronisieren"
        );
        assert!(
            production.contains("libc::fsync(fd)"),
            "directory-fsync darf nicht auf einem pfad-basierten follow-open beruhen"
        );
        let backup_call = production
            .find("write_backup_no_follow(&backup_rel, backup_dir, &original)?;")
            .expect("backup muss vor dem target-write abgeschlossen werden");
        let target_call = production
            .find("let write_result = persist_atomic(&tmp, &canon, patched.as_bytes());")
            .expect("target-write muss im write-gate vorhanden sein");
        assert!(
            backup_call < target_call,
            "ein backup-fehler darf keinen nachfolgenden target-write erreichen"
        );
    }

    #[test]
    fn persist_atomic_temp_sync_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
        let root = wsg_fixture("persist-temp-sync-error");
        let target = root.join("config.vdf");
        let temp = root.join(".config.vdf.tmp");
        std::fs::write(&target, "alt").unwrap();

        let mut sync_file =
            |_file: &mut std::fs::File| Err(std::io::Error::other("injected temp sync failure"));
        let mut rename = |_from: &std::path::Path, _to: &std::path::Path| {
            panic!("rename darf vor temp-sync nicht erreicht werden")
        };
        let mut sync_parent =
            |_parent: &std::path::Path| panic!("parent-sync darf vor rename nicht erreicht werden");

        let error = persist_atomic_with_ops(
            &temp,
            &target,
            b"neu",
            &mut sync_file,
            &mut rename,
            &mut sync_parent,
        )
        .unwrap_err();

        assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn persist_atomic_rename_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
        let root = wsg_fixture("persist-rename-error");
        let target = root.join("config.vdf");
        let temp = root.join(".config.vdf.tmp");
        std::fs::write(&target, "alt").unwrap();

        let mut sync_file = |file: &mut std::fs::File| file.sync_all();
        let mut rename = |_from: &std::path::Path, _to: &std::path::Path| {
            Err(std::io::Error::other("injected rename failure"))
        };
        let mut sync_parent = |_parent: &std::path::Path| {
            panic!("parent-sync darf nach fehlgeschlagenem rename nicht erreicht werden")
        };

        let error = persist_atomic_with_ops(
            &temp,
            &target,
            b"neu",
            &mut sync_file,
            &mut rename,
            &mut sync_parent,
        )
        .unwrap_err();

        assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn persist_atomic_parent_sync_fehler_signalisiert_moegliche_mutation() {
        let root = wsg_fixture("persist-parent-sync-error");
        let target = root.join("config.vdf");
        let temp = root.join(".config.vdf.tmp");
        std::fs::write(&target, "alt").unwrap();

        let mut sync_file = |file: &mut std::fs::File| file.sync_all();
        let mut rename = |from: &std::path::Path, to: &std::path::Path| std::fs::rename(from, to);
        let mut sync_parent =
            |_parent: &std::path::Path| Err(std::io::Error::other("injected parent sync failure"));

        let error = persist_atomic_with_ops(
            &temp,
            &target,
            b"neu",
            &mut sync_file,
            &mut rename,
            &mut sync_parent,
        )
        .unwrap_err();

        assert!(matches!(error, PersistAtomicError::AfterRename(_)));
        assert!(error.to_string().contains("write may have been applied"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn write_backup_directory_sync_fehler_raeumt_backup_auf() {
        let root = wsg_fixture("backup-directory-sync-error");
        let backup_dir = root.join("cache");
        let backup_path = backup_dir.join("backups/original.vdf");
        let target = root.join("steam-config.vdf");
        std::fs::create_dir_all(&backup_dir).unwrap();
        std::fs::write(&target, "ziel-unveraendert").unwrap();

        let mut sync_calls = 0;
        let mut sync_directory = |_fd: RawFd| {
            sync_calls += 1;
            if sync_calls == 1 {
                Err(std::io::Error::other(
                    "injected backup directory sync failure",
                ))
            } else {
                Ok(())
            }
        };
        let error = write_backup_no_follow_with_sync(
            Path::new("backups/original.vdf"),
            &backup_dir,
            "backup-inhalt",
            &mut sync_directory,
        )
        .unwrap_err();

        assert!(error.contains("backup directory sync"));
        assert_eq!(
            sync_calls, 2,
            "cleanup muss den directory-entry erneut syncen"
        );
        assert!(!backup_path.exists());
        assert!(
            std::fs::read_dir(backup_path.parent().unwrap())
                .unwrap()
                .next()
                .is_none(),
            "nach einem backup-fsync-fehler darf kein backup-rest liegenbleiben"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "ziel-unveraendert"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_compat_tool_steam_laeuft_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-running");
        std::fs::remove_file(steam.join("config/config.vdf")).unwrap();
        let mut reader = || Ok(true);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
        let (home, cache, steam) = wsg_env("compat-process-race");
        let target = steam.join("config/config.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut states = [false, true].into_iter();
        let mut reader = || Ok(states.next().expect("process reader call"));

        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );

        assert!(result.unwrap_err().contains("steam is running"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_unbekannter_name_und_leerer_wert_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-invalid-name");
        for tool_name in [Some("unknown-tool"), Some("")] {
            let mut reader = || Ok(false);
            let result = save_compat_tool_inner(
                steam.to_str().unwrap(),
                620,
                tool_name,
                &cache,
                &home,
                &mut reader,
            );
            assert!(result.is_err(), "{tool_name:?} muss abgelehnt werden");
        }
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_erlaubt_valve_builtin_nur_mit_installiertem_manifest() {
        let (home, cache, steam) = wsg_env("compat-valve-installed");
        let steamapps = steam.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::write(
            steamapps.join("appmanifest_1493710.acf"),
            "\"AppState\" { \"appid\" \"1493710\" }",
        )
        .unwrap();
        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("proton_experimental"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(result.unwrap(), WriteResult::Written);

        let mut reader = || Ok(false);
        let missing = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("proton_11"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(missing.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_symlinkendes_custom_tool() {
        let (home, cache, steam) = wsg_env("compat-symlink-tool");
        let external = home.parent().unwrap().join("external-tool");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(
            external.join("compatibilitytool.vdf"),
            "\"compatibilitytools\" { \"compat_tools\" { \"evil-tool\" {} } }",
        )
        .unwrap();
        std::os::unix::fs::symlink(&external, steam.join("compatibilitytools.d/evil-tool"))
            .unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("evil-tool"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_symlinkendes_custom_root() {
        let (home, cache, steam) = wsg_env("compat-symlink-root");
        let external = home.parent().unwrap().join("external-compat-root");
        std::fs::create_dir_all(external.join("CustomTool")).unwrap();
        std::fs::write(
            external.join("CustomTool/compatibilitytool.vdf"),
            "\"compatibilitytools\" { \"compat_tools\" { \"CustomTool\" {} } }",
        )
        .unwrap();
        let compat_root = steam.join("compatibilitytools.d");
        std::fs::remove_dir_all(&compat_root).unwrap();
        std::os::unix::fs::symlink(&external, &compat_root).unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("CustomTool"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_defekte_custom_vdf() {
        let (home, cache, steam) = wsg_env("compat-broken-vdf");
        let vdf_path = steam
            .join("compatibilitytools.d")
            .join("GE-Proton9-27")
            .join("compatibilitytool.vdf");
        std::fs::write(vdf_path, "broken {").unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-27"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_happy_write_and_backup() {
        let (home, cache, steam) = wsg_env("compat-happy");
        let target = steam.join("config/config.vdf");
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("\"GE-Proton9-28\""));
        assert!(content.contains("\"config\"\t\t\"\""));
        assert!(content.contains("\"priority\"\t\t\"250\""));

        let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
        assert!(backup_content.contains("\"GE-Proton9-27\""));

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_none_or_default_removes_entry() {
        let (home, cache, steam) = wsg_env("compat-remove");
        let target = steam.join("config/config.vdf");
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            None,
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(!content.contains("\"620\""));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_no_op_unchanged() {
        let (home, cache, steam) = wsg_env("compat-noop");
        let mut states = [false].into_iter();
        let mut reader = || Ok(states.next().expect("no-op must check once"));
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-27"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Unchanged);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_fehlende_zieldatei_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-fehlt");
        let target = steam.join("config/config.vdf");
        std::fs::remove_file(&target).unwrap();
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_fremder_root_abgelehnt() {
        let (home, cache, _steam) = wsg_env("compat-fremdroot");
        let fremd = home.join(".local/share/Other");
        std::fs::create_dir_all(fremd.join("config")).unwrap();
        std::fs::write(fremd.join("config/config.vdf"), "x").unwrap();
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            fremd.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not a steam config file"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_backup_zwischenpfad_symlink_abgelehnt_ohne_zielveraenderung() {
        let (home, cache, steam) = wsg_env("backup-intermediate-symlink");
        let target = steam.join("config/config.vdf");
        let external_dir = home.parent().unwrap().join("externes-backup-dir");
        let external_file = external_dir.join("1.vdf");
        std::fs::create_dir_all(&external_dir).unwrap();
        std::fs::write(&external_file, "extern-unveraendert").unwrap();

        let backup_parent = cache.join("backups");
        let backup = backup_parent.join("1.vdf");
        std::fs::create_dir_all(&backup_parent).unwrap();
        std::fs::remove_dir(&backup_parent).unwrap();
        std::os::unix::fs::symlink(&external_dir, &backup_parent).unwrap();

        let relative = backup.strip_prefix(&cache).unwrap();
        let res = write_backup_no_follow(relative, &cache, "neu");

        assert!(
            res.is_err(),
            "zwischenpfad-symlink muss abgelehnt werden: {res:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&external_file).unwrap(),
            "extern-unveraendert"
        );
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("GE-Proton9-27"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_backup_root_swap_auf_symlink_abgelehnt_ohne_zielveraenderung() {
        let (home, cache, steam) = wsg_env("backup-root-swap");
        let target = steam.join("config/config.vdf");
        let external_dir = home.parent().unwrap().join("externes-backup-root");
        let external_file = external_dir.join("1.vdf");
        std::fs::create_dir_all(&external_dir).unwrap();
        std::fs::write(&external_file, "extern-unveraendert").unwrap();

        let backup_parent = cache.join("backups");
        let backup = backup_parent.join("1.vdf");
        std::fs::create_dir_all(&backup_parent).unwrap();
        std::fs::remove_dir_all(&cache).unwrap();
        std::os::unix::fs::symlink(&external_dir, &cache).unwrap();

        let relative = backup.strip_prefix(&cache).unwrap();
        let res = write_backup_no_follow(relative, &cache, "neu");

        assert!(
            res.is_err(),
            "geswapte backup-root symlink muss abgelehnt werden: {res:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&external_file).unwrap(),
            "extern-unveraendert"
        );
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("GE-Proton9-27"));
        let _ = std::fs::remove_file(&cache);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_muster_erkennung_flatpak_und_snap() {
        let root = wsg_fixture("muster");
        let home = root.join("fakehome");
        let flatpak =
            home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam/config/config.vdf");
        let snap = home.join("snap/steam/common/.local/share/Steam/config/config.vdf");
        assert!(is_steam_config_path(&flatpak, &home));
        assert!(is_steam_config_path(&snap, &home));
        assert!(!is_steam_config_path(&home.join("etc/evil"), &home));
        assert!(!is_steam_config_path(
            &home.join(".local/share/Steam/userdata/abc/config/localconfig.vdf"),
            &home
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn write_gate_akzeptiert_kanonisierten_steam_symlink_alias() {
        use std::os::unix::fs::symlink;

        let root = wsg_fixture("symlink-alias");
        let home = root.join("fakehome");
        let native_root = home.join(".local/share/Steam");
        let config = native_root.join("config/config.vdf");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "\"InstallConfigStore\" {}\n").unwrap();
        std::fs::create_dir_all(home.join(".steam")).unwrap();
        let alias = home.join(".steam/steam");
        symlink(&native_root, &alias).unwrap();

        let canonical = std::fs::canonicalize(alias.join("config/config.vdf")).unwrap();
        assert!(is_steam_config_path(&canonical, &home));

        let _ = std::fs::remove_dir_all(&root);
    }
}
