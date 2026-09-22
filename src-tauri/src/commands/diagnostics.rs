use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use tauri::Manager;

use crate::commands::errcode;
use crate::commands::external::{open_directory_with_handler, spawn_detached_os};
use crate::commands::scope::prepare_app_dir;
use crate::commands::spawn_blocking_io;

pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024; // 2 MB
pub const MAX_LOG_GENERATIONS: usize = 3;
/// Eine einzelne Diagnosezeile bleibt kurz; eine riesige Nachricht darf die
/// Rotation nicht bis zum naechsten Aufruf aushebeln.
pub const MAX_LOG_MESSAGE_CHARS: usize = 2000;

pub fn rotate_logs_if_needed(log_dir: &Path) -> std::io::Result<()> {
    let main_log = log_dir.join("protium.log");
    if let Ok(metadata) = fs::metadata(&main_log) {
        if metadata.len() >= MAX_LOG_BYTES {
            for i in (1..MAX_LOG_GENERATIONS).rev() {
                let from = if i == 1 {
                    main_log.clone()
                } else {
                    log_dir.join(format!("protium.log.{}", i - 1))
                };
                let to = log_dir.join(format!("protium.log.{i}"));
                if from.exists() {
                    let _ = fs::rename(&from, &to);
                }
            }
        }
    }
    Ok(())
}

/// Logfile ohne Symlink-Verfolgung oeffnen (No-follow wie im Write-Gate).
#[cfg(unix)]
fn open_log_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .create(true)
        .append(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_log_file(path: &Path) -> std::io::Result<std::fs::File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Nur lesend oeffnen; ein Append-Handle laesst sich nicht lesen.
#[cfg(unix)]
fn open_log_file_for_read(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_log_file_for_read(path: &Path) -> std::io::Result<std::fs::File> {
    OpenOptions::new().read(true).open(path)
}

pub fn append_log_entry(log_dir: &Path, level: &str, message: &str) -> Result<(), String> {
    if !log_dir.exists() {
        fs::create_dir_all(log_dir).map_err(|e| format!("unavailable: {e}"))?;
    }
    rotate_logs_if_needed(log_dir).map_err(|e| format!("unavailable: {e}"))?;
    let main_log = log_dir.join("protium.log");
    let mut file = open_log_file(&main_log).map_err(|e| format!("unreadable: {e}"))?;
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err("blocked".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let clean_level = match level.to_ascii_lowercase().as_str() {
        "warn" | "warning" => "WARN",
        "error" => "ERROR",
        _ => "INFO",
    };
    let clean_msg: String = message
        .chars()
        .take(MAX_LOG_MESSAGE_CHARS)
        .collect::<String>()
        .replace('\n', " ");
    writeln!(file, "[{now}] [{clean_level}] {clean_msg}")
        .map_err(|e| format!("cannot write to log file: {e}"))?;
    Ok(())
}

/// Obergrenze fuer die angezeigte Logdatei; es wird nur der Schluss gelesen.
pub const MAX_LOG_TAIL_BYTES: u64 = 32 * 1024;

/// Liest den Schluss der aktuellen Logdatei. Fehlt sie, ist das leer (noch
/// nichts passiert), kein Fehler; ein Symlink oder Nicht-Datei ist blockiert.
pub fn read_log_tail_from_dir(log_dir: &Path) -> Result<String, String> {
    let main_log = log_dir.join("protium.log");
    let metadata = match fs::symlink_metadata(&main_log) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(errcode::with_detail(errcode::UNREADABLE, error)),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(errcode::BLOCKED.into());
        }
        Ok(metadata) => metadata,
    };

    let mut file = open_log_file_for_read(&main_log)
        .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    let length = metadata.len();
    let start = length.saturating_sub(MAX_LOG_TAIL_BYTES);
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    }
    let mut text = String::new();
    file.take(MAX_LOG_TAIL_BYTES)
        .read_to_string(&mut text)
        .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    Ok(text)
}

#[tauri::command]
pub async fn read_log_tail(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, error))?;
    let log_dir = prepare_app_dir(&data_dir.join("logs"), "app logs")?;
    spawn_blocking_io(move || read_log_tail_from_dir(&log_dir)).await
}

/// Panic-Hook: schreibt in dieselbe rotierende Datei. Kein Lock und kein
/// zusaetzlicher Zustand, damit der Hook auch dann laeuft, wenn der Panic
/// einen Write-Gate-Lock haelt; eigene Fehler werden geschluckt.
pub fn install_panic_hook(log_dir: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let message = info.to_string();
        let _ = append_log_entry(&log_dir, "error", &format!("panic: {message}"));
    }));
}

#[tauri::command]
pub async fn log_diagnostic(
    app: tauri::AppHandle,
    level: String,
    message: String,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("unavailable: {e}"))?;
    let log_dir = prepare_app_dir(&data_dir.join("logs"), "app logs")?;
    spawn_blocking_io(move || append_log_entry(&log_dir, &level, &message)).await
}

#[tauri::command]
pub async fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("unavailable: {e}"))?;
    let log_dir = prepare_app_dir(&data_dir.join("logs"), "app logs")?;
    #[cfg(target_os = "linux")]
    {
        spawn_blocking_io(move || open_directory_with_handler(&mut spawn_detached_os, &log_dir))
            .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = log_dir;
        Err("unsupported-platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;

    #[test]
    fn test_append_log_entry() {
        let root = wsg_fixture("test_append_log");
        let log_dir = root.join("logs");

        append_log_entry(&log_dir, "info", "App gestartet").unwrap();
        append_log_entry(&log_dir, "error", "Fehler aufgetreten").unwrap();

        let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
        assert!(content.contains("[INFO] App gestartet"));
        assert!(content.contains("[ERROR] Fehler aufgetreten"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rotate_logs() {
        let root = wsg_fixture("test_rotate_log");
        let log_dir = root.join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let main_log = log_dir.join("protium.log");
        // Erzeuge Datei ueber MAX_LOG_BYTES (z. B. Dummy)
        let large_data = vec![b'a'; (MAX_LOG_BYTES + 10) as usize];
        fs::write(&main_log, large_data).unwrap();

        rotate_logs_if_needed(&log_dir).unwrap();
        assert!(!main_log.exists());
        assert!(log_dir.join("protium.log.1").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rotation_kaskadiert_ueber_zwei_generationen() {
        let root = wsg_fixture("test_rotate_chain");
        let log_dir = root.join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(log_dir.join("protium.log.1"), b"alt1").unwrap();
        fs::write(
            log_dir.join("protium.log"),
            vec![b'a'; (MAX_LOG_BYTES + 1) as usize],
        )
        .unwrap();

        rotate_logs_if_needed(&log_dir).unwrap();
        assert!(log_dir.join("protium.log.1").exists());
        assert_eq!(fs::read(log_dir.join("protium.log.2")).unwrap(), b"alt1");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn log_tail_liest_den_schluss_und_ist_bei_fehlender_datei_leer() {
        let root = wsg_fixture("test_log_tail");
        let log_dir = root.join("logs");
        assert_eq!(read_log_tail_from_dir(&log_dir).unwrap(), "");

        fs::create_dir_all(&log_dir).unwrap();
        append_log_entry(&log_dir, "info", "erste zeile").unwrap();
        append_log_entry(&log_dir, "error", "zweite zeile").unwrap();

        let tail = read_log_tail_from_dir(&log_dir).unwrap();
        assert!(tail.contains("erste zeile"));
        assert!(tail.contains("zweite zeile"));

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn log_tail_lehnt_symlink_ab() {
        let root = wsg_fixture("test_log_tail_symlink");
        let log_dir = root.join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(root.join("echt.log"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("echt.log"), log_dir.join("protium.log")).unwrap();

        assert_eq!(read_log_tail_from_dir(&log_dir).unwrap_err(), "blocked");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unbekanntes_level_wird_info_und_nachricht_gekuerzt() {
        let root = wsg_fixture("test_log_level");
        let log_dir = root.join("logs");
        let lang = format!("{}\nzweite zeile", "x".repeat(MAX_LOG_MESSAGE_CHARS + 50));

        append_log_entry(&log_dir, "verbose", &lang).unwrap();

        let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
        assert!(content.contains("[INFO]"));
        assert_eq!(content.lines().count(), 1);
        assert!(content.chars().count() <= MAX_LOG_MESSAGE_CHARS + 40);

        let _ = fs::remove_dir_all(&root);
    }
}
