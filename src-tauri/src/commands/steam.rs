// Steam-Config-Commands: Startoptionen und Compat-Tool über das Write-Gate
// (write_gate.rs) sowie die Backup-Liste.

use std::fs;
use std::path::Path;

use tauri::Manager;

use crate::commands::compat_auth::is_authorized_compat_tool;
use crate::commands::errcode;
#[cfg(target_os = "linux")]
use crate::commands::fd::open_bound_root_fd;
use crate::commands::fs_ops::is_steam_running_sync;
use crate::commands::path::sanitize_path;
use crate::commands::scope::EnvironmentState;
use crate::commands::spawn_blocking_io;
use crate::commands::vdf_patch;
use crate::commands::write_gate::{apply_write_gate, canonical_allowed_steam_root, ensure_size};

/// steam-schreibweise der compat-tool-priority im mapping.
const STEAM_COMPAT_PRIORITY: &str = "250";

/// Gedeckelter Eingabewert des Write-Gate-IPC. Der Wert wird gepatcht,
/// mehrfach kopiert und landet in der Config; ein beliebig großer String ist
/// weder ein realistischer Startoptionen-Wert noch ein realistischer Toolname.
const MAX_PATCH_VALUE_BYTES: u64 = 16 * 1024;

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum WriteResult {
    Written,
    Unchanged,
}

pub(super) fn save_launch_options_inner<F>(
    steam_root: &str,
    account_id: &str,
    app_id: u32,
    launch_options: &str,
    backup_dir: &Path,
    allowed_steam_root: &Path,
    process_reader: &mut F,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
{
    sanitize_path(steam_root, "steam root")?;
    if account_id.parse::<u64>().map_or(true, |value| value == 0) {
        return Err(errcode::INVALID_ACCOUNT_ID.into());
    }
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|error| errcode::with_detail(errcode::INVALID_APPID, error))?;
    ensure_size(launch_options, MAX_PATCH_VALUE_BYTES, "launch options")?;
    if process_reader()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    let root = canonical_allowed_steam_root(steam_root, allowed_steam_root)?;
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
        &root,
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
    allowed_steam_root: &Path,
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
    let root = canonical_allowed_steam_root(steam_root, allowed_steam_root)?;
    let target = root.join("config").join("config.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| {
        errcode::with_detail(
            errcode::NOT_FOUND,
            format!("write target canonicalize: {e}"),
        )
    })?;
    // INV-7: die tool-autorität wird am schreibziel gebunden, nicht am
    // übergebenen root. ein präpariertes root mit eigenem compatibilitytools.d
    // und einem config-symlink aufs echte verzeichnis würde sonst beliebige
    // tool-namen autorisieren, während die echte config.vdf geschrieben wird.
    let auth_root = canon
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| String::from(errcode::NOT_A_STEAM_CONFIG))?;
    #[cfg(target_os = "linux")]
    let steam_root_fd = open_bound_root_fd(auth_root, &mut || {})?;
    let app_id_str = app_id.to_string();
    apply_write_gate(
        &canon,
        &root,
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
            let mut name_path = base.to_vec();
            name_path.push("name");
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
                        auth_root,
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
                    let mut config_path = base.to_vec();
                    config_path.push("config");
                    p = vdf_patch::set_vdf_value(&p, &config_path, "")?;
                    let mut priority_path = base.to_vec();
                    priority_path.push("priority");
                    p = vdf_patch::set_vdf_value(&p, &priority_path, STEAM_COMPAT_PRIORITY)?;
                    Ok(Some(p))
                }
            }
        },
    )
}

/// Meldung für eine fehlgeschlagene pfadbeschaffung der tauri-commands
/// (home/app-cache). Der code `unavailable` ist der belegte präzedenzfall aus
/// `open_backups_folder`; der rohe satz der runtime ist kein vertrag (A-04).
fn path_resolution_error(label: &str, error: impl std::fmt::Display) -> String {
    errcode::with_detail(
        errcode::UNAVAILABLE,
        format!("cannot resolve {label}: {error}"),
    )
}

/// Schreibt die startoptionen der app über das write-gate in die
/// `localconfig.vdf` des accounts.
#[tauri::command]
pub async fn save_launch_options(
    app: tauri::AppHandle,
    env: tauri::State<'_, EnvironmentState>,
    steam_root: String,
    account_id: String,
    app_id: u32,
    launch_options: String,
) -> Result<WriteResult, String> {
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| path_resolution_error("app cache dir", e))?;
    let env = env.inner().clone();
    spawn_blocking_io(move || {
        let allowed_root = env.current()?.steam_root;
        let mut process_reader = || Ok(is_steam_running_sync());
        save_launch_options_inner(
            &steam_root,
            &account_id,
            app_id,
            &launch_options,
            &backup_dir,
            &allowed_root,
            &mut process_reader,
        )
    })
    .await
}

#[tauri::command]
pub async fn save_compat_tool(
    app: tauri::AppHandle,
    env: tauri::State<'_, EnvironmentState>,
    steam_root: String,
    app_id: u32,
    tool_name: Option<String>,
) -> Result<WriteResult, String> {
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| path_resolution_error("app cache dir", e))?;
    let env = env.inner().clone();
    spawn_blocking_io(move || {
        let allowed_root = env.current()?.steam_root;
        let mut process_reader = || Ok(is_steam_running_sync());
        save_compat_tool_inner(
            &steam_root,
            app_id,
            tool_name.as_deref(),
            &backup_dir,
            &allowed_root,
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
        .map_err(|e| path_resolution_error("app cache dir", e))?
        .join("backups");
    spawn_blocking_io(move || list_config_backups_in_dir(&backup_dir)).await
}

#[tauri::command]
pub async fn open_backups_folder(app: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| errcode::with_detail(errcode::UNAVAILABLE, e))?;
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

#[cfg(test)]
#[path = "steam_tests.rs"]
mod tests;
