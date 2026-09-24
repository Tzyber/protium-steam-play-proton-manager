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

/// Serialisiert Rotation, Append und Tail-Read derselben Logdatei: Rename und
/// Append sind sonst nicht atomar zueinander, und ein Tail-Read könnte während
/// der Rotation einen halben Zustand sehen. Der Panic-Hook nimmt die Sperre mit
/// `into_inner`, damit eine Panik im geschützten Abschnitt ihn nicht blockiert.
static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_log() -> std::sync::MutexGuard<'static, ()> {
    LOG_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

/// Kaskadiert die Loggenerationen. Muss unter `LOG_LOCK` laufen; die Sperre
/// nehmen die Aufrufer, damit Rotation und Append ein kritischer Abschnitt
/// bleiben (kein verschachteltes Lock).
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
    let _guard = lock_log();
    write_log_line(log_dir, level, message, true)
}

/// Pfad des Panic-Hooks: blockiert nie, denn der abstürzende Thread kann die
/// Sperre selbst halten (`std::sync::Mutex` ist nicht reentrant) und würde
/// sonst im Hook hängen bleiben. Ohne Rotation, reines Best effort.
fn append_panic_entry(log_dir: &Path, message: &str) {
    let _guard = LOG_LOCK.try_lock().ok();
    let _ = write_log_line(log_dir, "error", message, false);
}

/// Ersetzt vollständige Home-Pfade durch `~`. Das lokale Protokoll wird bei
/// einer Fehlermeldung weitergereicht; die Aussage der Zeile bleibt erhalten,
/// der Benutzername nicht.
fn redact_home(text: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if !home.is_empty() => text.replace(home, "~"),
        _ => text.to_string(),
    }
}

fn write_log_line(log_dir: &Path, level: &str, message: &str, rotate: bool) -> Result<(), String> {
    if !log_dir.exists() {
        fs::create_dir_all(log_dir).map_err(|e| format!("unavailable: {e}"))?;
    }
    if rotate {
        rotate_logs_if_needed(log_dir).map_err(|e| format!("unavailable: {e}"))?;
    }
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
    let clean_msg = redact_home(&clean_msg, std::env::var("HOME").ok().as_deref());
    writeln!(file, "[{now}] [{clean_level}] {clean_msg}")
        .map_err(|e| format!("cannot write to log file: {e}"))?;
    Ok(())
}

/// Obergrenze fuer die angezeigte Logdatei; es wird nur der Schluss gelesen.
pub const MAX_LOG_TAIL_BYTES: u64 = 32 * 1024;

/// Liest den Schluss der aktuellen Logdatei. Fehlt sie, ist das leer (noch
/// nichts passiert), kein Fehler; ein Symlink oder Nicht-Datei ist blockiert.
/// Der Start liegt auf einer beliebigen Byteposition: begonnene Zeilen werden
/// verworfen, statt mitten in einer UTF-8-Sequenz zu scheitern.
pub fn read_log_tail_from_dir(log_dir: &Path) -> Result<String, String> {
    let _guard = lock_log();
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
    let mut bytes = Vec::new();
    file.take(MAX_LOG_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    let slice = if start > 0 {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(newline) => &bytes[newline + 1..],
            None => &[][..],
        }
    } else {
        &bytes[..]
    };
    Ok(String::from_utf8_lossy(slice).into_owned())
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

/// Panic-Hook: schreibt in dieselbe rotierende Datei, aber nie blockierend
/// (siehe `append_panic_entry`). Eigene Fehler werden geschluckt.
pub fn install_panic_hook(log_dir: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let message = info.to_string();
        append_panic_entry(&log_dir, &format!("panic: {message}"));
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
        Err(errcode::UNSUPPORTED_PLATFORM.into())
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
    fn log_tail_startet_nicht_mitten_in_einer_utf8_sequenz() {
        // Die tail-grenze liegt auf einer beliebigen byteposition. Beginnt sie
        // im zweiten byte eines mehrbytezeichens, darf der read nicht scheitern.
        let root = wsg_fixture("test_log_tail_utf8");
        let log_dir = root.join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let tail_bytes = usize::try_from(MAX_LOG_TAIL_BYTES).unwrap();
        let rest = format!("\n{}\n", "y".repeat(tail_bytes - 3));
        assert_eq!(rest.len(), tail_bytes - 1);
        let mut content = "x".repeat(10);
        content.push('ä');
        content.push_str(&rest);
        fs::write(log_dir.join("protium.log"), &content).unwrap();

        let start = content.len() - tail_bytes;
        assert_eq!(
            start, 11,
            "die grenze muss in der mitte des mehrbytezeichens liegen"
        );

        let tail = read_log_tail_from_dir(&log_dir).unwrap();
        assert!(tail.starts_with('y'), "tail beginnt mitten im zeichen");
        assert!(!tail.contains('\u{FFFD}'));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_hinterlaesst_auch_beim_wechselnden_aufrufer_genau_eine_zeile() {
        // Serialisierung: parallele Appends duerfen sich nicht verzahnen.
        let root = wsg_fixture("test_log_serialized");
        let log_dir = root.join("logs");
        let mut handles = Vec::new();
        for index in 0..4 {
            let dir = log_dir.clone();
            handles.push(std::thread::spawn(move || {
                append_log_entry(&dir, "info", &format!("zeile-{index}")).unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
        assert_eq!(content.lines().count(), 4);
        for index in 0..4 {
            assert!(content.contains(&format!("[INFO] zeile-{index}")));
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn panic_pfad_blockiert_nicht_wenn_die_sperre_gehalten_wird() {
        // Der Hook laeuft im panischen Thread; haelt der die Sperre, darf er
        // nicht darauf warten. try_lock schreibt die zeile trotzdem.
        let root = wsg_fixture("test_log_panic_lock");
        let log_dir = root.join("logs");
        let guard = lock_log();
        append_panic_entry(&log_dir, "panic: test");
        drop(guard);

        let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
        assert!(content.contains("panic: test"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn log_redigiert_home_pfade_und_laesst_den_rest_stehen() {
        let with_home = redact_home(
            "unreadable: /home/nutzer/.local/share/Steam/config/config.vdf: Permission denied",
            Some("/home/nutzer"),
        );
        assert!(with_home.starts_with("unreadable: ~/.local/share/Steam"));
        assert!(with_home.ends_with("Permission denied"));
        assert!(!with_home.contains("/home/nutzer"));

        // ohne bekanntes home bleibt die zeile unverändert
        let without_home = redact_home("unreadable: /srv/steam/x", None);
        assert_eq!(without_home, "unreadable: /srv/steam/x");
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
