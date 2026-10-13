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
pub fn rotate_logs_if_needed(log_dir: &Path) {
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

fn maskable_user(user: &str) -> bool {
    // `/media/..` wäre kein Benutzername, würde aber Elternpfade umschreiben.
    !user.is_empty()
        && user != "."
        && user != ".."
        && !user.contains('/')
        && !user.contains('\\')
        && !user.contains('\0')
}

fn canonical_home_path(home: Option<&str>) -> Option<String> {
    std::fs::canonicalize(home?)
        .ok()?
        .into_os_string()
        .into_string()
        .ok()
}

fn is_segment_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.')
}

fn at_segment_start(text: &str, index: usize) -> bool {
    index == 0
        || text[..index]
            .chars()
            .next_back()
            .is_none_or(|ch| !is_segment_char(ch))
}

/// Punkte direkt vor einem Nicht-Segmentzeichen oder dem Textende sind
/// Satzzeichen (`… unter /home/name.`), `/home/name.alt` bleibt ein Segment.
fn at_segment_end(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .find(|ch| *ch != '.')
        .is_none_or(|ch| !is_segment_char(ch))
}

/// Ersetzt nur ein ganzes Pfadsegment an beiden Enden. `nutzer` darf
/// `nutzer2` nicht treffen, `/root` nicht `/run/media/root`.
fn replace_bounded(text: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative) = text[cursor..].find(needle) {
        let start = cursor + relative;
        let end = start + needle.len();
        if at_segment_start(text, start) && at_segment_end(text, end) {
            out.push_str(&text[cursor..start]);
            out.push_str(replacement);
            cursor = end;
        } else {
            let next = start + text[start..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&text[cursor..next]);
            cursor = next;
        }
    }
    out.push_str(&text[cursor..]);
    out
}

fn mask_media_user(text: &str, user: Option<&str>) -> String {
    let Some(user) = user.filter(|value| maskable_user(value)) else {
        return text.to_string();
    };
    // `/run/media/$USER` enthält den Teilstring `/media/$USER`. Der längere
    // Präfix muss zuerst weg, sonst wird `/run/media/name` zu `/run~`.
    let with_run = replace_bounded(text, &format!("/run/media/{user}"), "/run/media/~");
    replace_bounded(&with_run, &format!("/media/{user}"), "/media/~")
}

fn redact_userdata_ids(text: &str) -> String {
    const MARKER: &str = "userdata/";
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative) = text[cursor..].find(MARKER) {
        let start = cursor + relative;
        let id_at = start + MARKER.len();
        let id_len = text[id_at..].bytes().take_while(u8::is_ascii_digit).count();
        let id_end = id_at + id_len;
        if id_len > 0 && at_segment_start(text, start) && at_segment_end(text, id_end) {
            out.push_str(&text[cursor..start]);
            out.push_str("userdata/<redacted>");
            cursor = id_end;
        } else {
            let next = start + text[start..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&text[cursor..next]);
            cursor = next;
        }
    }
    out.push_str(&text[cursor..]);
    out
}

/// `/` als Home würde jeden absoluten Pfad zu `~` machen.
fn maskable_home(home: Option<&str>) -> Option<&str> {
    home.filter(|value| value.starts_with('/'))
        .map(|value| value.trim_end_matches('/'))
        .filter(|value| !value.is_empty())
}

/// Ersetzt Home, Medien-Mount und Steam-Account in einer Diagnosezeile.
/// Das lokale Protokoll wird weitergereicht; die Aussage bleibt, Benutzername
/// und Account-ID nicht. `$HOME` kann ein Symlink-Pfad sein, deshalb wird auch
/// das kanonisierte Home maskiert.
fn redact_log_text(
    text: &str,
    home: Option<&str>,
    canonical_home: Option<&str>,
    user: Option<&str>,
) -> String {
    let mut homes: Vec<&str> = [home, canonical_home]
        .into_iter()
        .filter_map(maskable_home)
        .collect();
    // Kürzeres `$HOME` kann im kanonisierten Pfad stecken (`/home/name` in
    // `/var/home/name`). Zuerst der längere Präfix, sonst bleibt `/var~`.
    homes.sort_by_key(|prefix| std::cmp::Reverse(prefix.len()));
    homes.dedup();
    let mut masked = text.to_string();
    for prefix in homes {
        masked = replace_bounded(&masked, prefix, "~");
    }
    redact_userdata_ids(&mask_media_user(&masked, user))
}

/// Erst redigieren, dann kürzen: ein an der Grenze abgeschnittenes
/// `/home/na` träfe keine Maske mehr. Webview-Nachrichten sind unbegrenzt,
/// deshalb vorher großzügig vorkürzen; die Reserve deckt Masken, die beim
/// Redigieren schrumpfen.
fn clean_log_message(
    message: &str,
    home: Option<&str>,
    canonical_home: Option<&str>,
    user: Option<&str>,
) -> String {
    let bounded = message
        .char_indices()
        .nth(16 * MAX_LOG_MESSAGE_CHARS)
        .map_or(message, |(end, _)| &message[..end]);
    redact_log_text(bounded, home, canonical_home, user)
        .chars()
        .take(MAX_LOG_MESSAGE_CHARS)
        .collect::<String>()
        .replace('\n', " ")
}

fn write_log_line(log_dir: &Path, level: &str, message: &str, rotate: bool) -> Result<(), String> {
    // r-14: die codes kommen als konstante aus errcode, nicht handgeformt
    // als praefix im format-string.
    if !log_dir.exists() {
        fs::create_dir_all(log_dir)
            .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, error))?;
    }
    if rotate {
        rotate_logs_if_needed(log_dir);
    }
    let main_log = log_dir.join("protium.log");
    let mut file = open_log_file(&main_log)
        .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err(errcode::BLOCKED.into());
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
    let home = std::env::var("HOME").ok();
    let user = std::env::var("USER").ok();
    let canonical_home = canonical_home_path(home.as_deref());
    let clean_msg = clean_log_message(
        message,
        home.as_deref(),
        canonical_home.as_deref(),
        user.as_deref(),
    );
    writeln!(file, "[{now}] [{clean_level}] {clean_msg}").map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("cannot write to log file: {error}"),
        )
    })?;
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
#[path = "diagnostics_tests.rs"]
mod tests;
