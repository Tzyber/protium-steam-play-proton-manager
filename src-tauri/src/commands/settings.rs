// Persistenz fuer App-Settings (`ui-settings.json`) und Fenstergroesse
// (`protium-window`) im bestehenden 0700-`$APPCONFIG`.

#[cfg(target_os = "linux")]
use std::ffi::{OsStr, OsString};
#[cfg(target_os = "linux")]
use std::io::{self, Write};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::path::Path;

use tauri::Manager;

use crate::commands::errcode;
#[cfg(target_os = "linux")]
use crate::commands::fd;
#[cfg(target_os = "linux")]
use crate::commands::path::random_suffix;
#[cfg(target_os = "linux")]
use crate::commands::scope::prepare_app_dir;
#[cfg(target_os = "linux")]
use crate::commands::spawn_blocking_io;
#[cfg(target_os = "linux")]
use crate::commands::write_gate::ensure_size;

pub(crate) const DEFAULT_WINDOW_SIZE: (u32, u32) = (1280, 800);
pub(crate) const MIN_WINDOW_SIZE: (u32, u32) = (960, 600);

#[cfg(target_os = "linux")]
const SETTINGS_FILE_NAME: &str = "ui-settings.json";
#[cfg(target_os = "linux")]
const WINDOW_FILE_NAME: &str = "protium-window";
#[cfg(target_os = "linux")]
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
#[cfg(target_os = "linux")]
const MAX_WINDOW_BYTES: u64 = 64;

pub(super) fn parse_window_size(raw: &str) -> Option<(u32, u32)> {
    let (width, height) = raw.trim().split_once('x')?;
    if !width.bytes().all(|byte| byte.is_ascii_digit())
        || !height.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

pub(crate) fn physical_to_logical(physical: (u32, u32), scale: f64) -> (u32, u32) {
    let effective_scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = (f64::from(physical.0) / effective_scale).round() as u32;
    let height = (f64::from(physical.1) / effective_scale).round() as u32;
    (width, height)
}

pub(crate) fn format_window_size(physical: (u32, u32), scale: f64) -> String {
    let (width, height) = physical_to_logical(physical, scale);
    format!("{width}x{height}")
}

pub(crate) fn clamp_window_size(
    size: (u32, u32),
    min: (u32, u32),
    monitor: Option<(u32, u32)>,
) -> (u32, u32) {
    // WARUM kein `Ord::clamp(min, max)`: auf kleinen oder hochskalierten Displays
    // (z. B. Steam Deck 1280x800 bei 1,5x = 853x533 logisch) ist `monitor < min`,
    // worauf `u32::clamp` beim Start paniken wuerde. Erst deckeln, dann Mindestgroesse.
    let capped = match monitor {
        Some((max_w, max_h)) => (size.0.min(max_w), size.1.min(max_h)),
        None => size,
    };
    (capped.0.max(min.0), capped.1.max(min.1))
}

#[cfg(target_os = "linux")]
fn write_atomic_at(
    dir: &Path,
    target_name: &str,
    content: &[u8],
    label: &str,
) -> Result<(), String> {
    let dir_fd = fd::open_absolute_dir(dir).map_err(|error| errcode::label_error(label, &error))?;
    let tmp_name = OsString::from(format!(".{target_name}.{}.tmp", random_suffix()));
    let mut file = fd::create_exclusive_at(dir_fd.as_raw_fd(), &tmp_name)
        .map_err(|error| errcode::label_error(label, &error))?;

    let write_result = file.write_all(content).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fd::unlink_at(dir_fd.as_raw_fd(), &tmp_name);
        return Err(errcode::label_error(label, &error));
    }

    if let Err(error) = fd::rename_at(
        dir_fd.as_raw_fd(),
        &tmp_name,
        dir_fd.as_raw_fd(),
        OsStr::new(target_name),
    ) {
        let _ = fd::unlink_at(dir_fd.as_raw_fd(), &tmp_name);
        return Err(errcode::label_error(label, &error));
    }

    fd::sync_dir_fd(dir_fd.as_raw_fd()).map_err(|error| errcode::label_error(label, &error))?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn read_window_setting_at(dir: &Path) -> (u32, u32) {
    let Ok(dir_fd) = fd::open_absolute_dir(dir) else {
        return DEFAULT_WINDOW_SIZE;
    };
    let Ok(mut file) = fd::open_file_at(dir_fd.as_raw_fd(), OsStr::new(WINDOW_FILE_NAME)) else {
        return DEFAULT_WINDOW_SIZE;
    };
    let Ok(raw) = fd::read_fd_text(&mut file, "window size", MAX_WINDOW_BYTES) else {
        return DEFAULT_WINDOW_SIZE;
    };
    parse_window_size(&raw).unwrap_or(DEFAULT_WINDOW_SIZE)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn read_window_setting_at(_dir: &Path) -> (u32, u32) {
    DEFAULT_WINDOW_SIZE
}

pub(crate) fn read_window_setting(app: &tauri::AppHandle) -> (u32, u32) {
    match app.path().app_config_dir() {
        Ok(dir) => read_window_setting_at(&dir),
        Err(_) => DEFAULT_WINDOW_SIZE,
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn save_window_setting_at(
    dir: &Path,
    physical: (u32, u32),
    scale: f64,
) -> Result<(), String> {
    if physical.0 == 0 || physical.1 == 0 {
        return Ok(());
    }
    let formatted = format_window_size(physical, scale);
    write_atomic_at(dir, WINDOW_FILE_NAME, formatted.as_bytes(), "window size")
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn save_window_setting_at(
    _dir: &Path,
    _physical: (u32, u32),
    _scale: f64,
) -> Result<(), String> {
    Err(errcode::UNSUPPORTED_PLATFORM.into())
}

#[cfg(target_os = "linux")]
pub(super) fn load_settings_at(dir: &Path) -> Result<Option<String>, String> {
    let dir_fd =
        fd::open_absolute_dir(dir).map_err(|error| errcode::label_error("app settings", &error))?;
    let mut file = match fd::open_file_at(dir_fd.as_raw_fd(), OsStr::new(SETTINGS_FILE_NAME)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(errcode::label_error("app settings", &error)),
    };
    fd::read_fd_text(&mut file, "app settings", MAX_SETTINGS_BYTES).map(Some)
}

#[cfg(target_os = "linux")]
pub(super) fn save_settings_at(dir: &Path, value: &str) -> Result<(), String> {
    ensure_size(value, MAX_SETTINGS_BYTES, "app settings")?;
    write_atomic_at(dir, SETTINGS_FILE_NAME, value.as_bytes(), "app settings")
}

#[tauri::command]
pub async fn load_app_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, error))?;
    #[cfg(target_os = "linux")]
    {
        spawn_blocking_io(move || {
            let config_root = config_dir.parent().ok_or_else(|| {
                errcode::with_detail(errcode::UNAVAILABLE, "app config: no parent root")
            })?;
            let prepared = prepare_app_dir(&config_dir, config_root, "app config")?;
            load_settings_at(&prepared)
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config_dir;
        Err(errcode::UNSUPPORTED_PLATFORM.into())
    }
}

#[tauri::command]
pub async fn save_app_settings(app: tauri::AppHandle, value: String) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, error))?;
    #[cfg(target_os = "linux")]
    {
        spawn_blocking_io(move || {
            let config_root = config_dir.parent().ok_or_else(|| {
                errcode::with_detail(errcode::UNAVAILABLE, "app config: no parent root")
            })?;
            let prepared = prepare_app_dir(&config_dir, config_root, "app config")?;
            save_settings_at(&prepared, &value)
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (config_dir, value);
        Err(errcode::UNSUPPORTED_PLATFORM.into())
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
