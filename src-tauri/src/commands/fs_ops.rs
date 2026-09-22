#[cfg(target_os = "linux")]
use crate::commands::errcode;
use crate::commands::fd::{ensure_regular_fd, open_bound_root_fd, open_dir_at, open_file_at};
use crate::commands::scope::{EnvironmentState, MAX_ENVIRONMENT_READ_BYTES};
use crate::commands::spawn_blocking_io;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::State;

// Verzeichnisgrößen und Pfadidentität über `(dev, ino)`.

const MAX_BATCH_DIR_SIZE_PATHS: usize = 4096;
/// Maximale Walk-Tiefe für die Größenmessung: echte Steam-Bäume sind flach,
/// ohne Cap liesse ein künstlich tiefer Baum den rekursiven Walker den
/// Blocking-Thread-Stack überlaufen lassen (abort).
const MAX_DIRECTORY_WALK_DEPTH: usize = 256;
const MAX_ENVIRONMENT_DIR_ENTRIES: usize = 8192;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum DirectorySize {
    Measured {
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Missing,
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_symlink: bool,
}

fn read_environment_file(
    state: &EnvironmentState,
    path: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    read_environment_file_with_hook(state, path, label, &mut || {}, &mut |_| {})
}

/// Liest eine autorisierte Datei unter Linux über eine gebundene no-follow-
/// Deskriptorkette: Der Parent wird als Root gebunden (dev/ino-Check gegen
/// Tausch zwischen stat und open), die Datei per `openat(O_NOFOLLOW)` aus dem
/// gebundenen Parent geöffnet. Größenlimit und Read beziehen sich auf den
/// geöffneten Deskriptor (`cap + 1`-Read), nicht auf einen zuvor geprüften
/// Pfad. Nicht-Linux verweigert fail-closed, weil dieselbe Grenze dort nicht
/// belegbar ist.
#[cfg(target_os = "linux")]
fn read_environment_file_with_hook(
    state: &EnvironmentState,
    path: &str,
    label: &str,
    before_open: &mut dyn FnMut(),
    after_open: &mut dyn FnMut(&mut std::fs::File),
) -> Result<Vec<u8>, String> {
    state.with_authorized_existing(path, label, |real| {
        let parent = real
            .parent()
            .ok_or_else(|| format!("{label}: no parent directory"))?;
        let file_name = real
            .file_name()
            .ok_or_else(|| format!("{label}: no file name"))?;
        let parent_fd =
            open_bound_root_fd(parent, before_open).map_err(|error| format!("{label}: {error}"))?;
        let mut file = open_file_at(parent_fd.as_raw_fd(), file_name)
            .map_err(|error| format!("{label}: {error}"))?;
        after_open(&mut file);
        let length = ensure_regular_fd(&file, label)?;
        if length > MAX_ENVIRONMENT_READ_BYTES {
            return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
        }
        let read_limit = MAX_ENVIRONMENT_READ_BYTES
            .checked_add(1)
            .ok_or_else(|| format!("{label}: read limit overflows"))?;
        let mut bytes = Vec::new();
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("{label}: {error}"))?;
        if bytes.len() as u64 > MAX_ENVIRONMENT_READ_BYTES {
            return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
        }
        Ok(bytes)
    })
}

#[cfg(not(target_os = "linux"))]
fn read_environment_file_with_hook(
    _state: &EnvironmentState,
    _path: &str,
    label: &str,
    _before_open: &mut dyn FnMut(),
    _after_open: &mut dyn FnMut(&mut std::fs::File),
) -> Result<Vec<u8>, String> {
    Err(errcode::with_detail(errcode::UNSUPPORTED_PLATFORM, label))
}

#[tauri::command]
pub async fn environment_exists(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || state.environment_exists(&path)).await
}

#[tauri::command]
pub async fn environment_read_text(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        let bytes = read_environment_file(&state, &path, "environment read text")?;
        String::from_utf8(bytes).map_err(|error| format!("environment read text: {error}"))
    })
    .await
}

#[tauri::command]
pub async fn environment_read_binary(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    let bytes =
        spawn_blocking_io(move || read_environment_file(&state, &path, "environment read binary"))
            .await?;
    // binäre ipc-response statt serde-json-zahlen-array: cover-bytes (~100 KB)
    // wären als json-array 3-5× so groß und müssten im webview geparst werden.
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn environment_read_dir(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<Vec<EnvironmentDirEntry>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        read_environment_dir_with_hook(&state, &path, "environment read dir", &mut || {})
    })
    .await
}

/// Liest eine autorisierte Verzeichnisliste unter Linux über einen gebundenen
/// no-follow-Deskriptor (Tausch zwischen stat und open bricht ab). Das
/// Entry-Limit gilt für die Liste des geöffneten Deskriptors. Nicht-Linux
/// verweigert fail-closed.
#[cfg(target_os = "linux")]
fn read_environment_dir_with_hook(
    state: &EnvironmentState,
    path: &str,
    label: &str,
    before_open: &mut dyn FnMut(),
) -> Result<Vec<EnvironmentDirEntry>, String> {
    state.with_authorized_existing(path, label, |real| {
        let dir_fd =
            open_bound_root_fd(&real, before_open).map_err(|error| format!("{label}: {error}"))?;
        let proc_path = Path::new("/proc/self/fd").join(dir_fd.as_raw_fd().to_string());
        let mut entries = Vec::new();
        for (index, entry) in fs::read_dir(&proc_path)
            .map_err(|error| format!("{label}: {error}"))?
            .enumerate()
        {
            if index >= MAX_ENVIRONMENT_DIR_ENTRIES {
                return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
            }
            let entry = entry.map_err(|error| format!("{label}: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("{label}: {error}"))?;
            entries.push(EnvironmentDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_directory: file_type.is_dir(),
                is_symlink: file_type.is_symlink(),
            });
        }
        Ok(entries)
    })
}

#[cfg(not(target_os = "linux"))]
fn read_environment_dir_with_hook(
    _state: &EnvironmentState,
    _path: &str,
    label: &str,
    _before_open: &mut dyn FnMut(),
) -> Result<Vec<EnvironmentDirEntry>, String> {
    Err(errcode::with_detail(errcode::UNSUPPORTED_PLATFORM, label))
}

fn checked_size_add(total: u64, next: u64) -> Result<u64, String> {
    let total = total
        .checked_add(next)
        .ok_or_else(|| "directory size sum overflow".to_string())?;
    if total > MAX_SAFE_JS_INTEGER {
        return Err(errcode::with_detail(
            errcode::SIZE_LIMIT,
            "javascript safe integer",
        ));
    }
    Ok(total)
}

/// fd-gebundener Verzeichnis-Walk: Der Root wurde bereits als Deskriptor
/// gebunden; jeder Unterbaum wird per `openat(O_NOFOLLOW)` aus dem
/// Parent-Deskriptor geöffnet. Ein Tausch des Roots oder eines Kindes nach
/// der Bindung misst den gebundenen alten Stand, nie einen fremden Baum.
/// Symlinks zählen weder als Verzeichnis noch als Datei und werden
/// übersprungen. `relative` ist der Pfad vom Root (für Fehlermeldungen und
/// Test-Hooks). Die Tiefe ist gedeckelt, damit eine künstlich tiefe
/// Verschachtelung den Blocking-Thread-Stack nicht überlaufen lässt
/// (fail-closed wie beim binären VDF-Parser).
#[cfg(target_os = "linux")]
fn walk_directory_fd(
    dir_fd: &std::os::unix::io::OwnedFd,
    relative: &Path,
    depth: usize,
    before_read: &mut dyn FnMut(&Path) -> Result<(), String>,
    total: &mut u64,
) -> Result<(), String> {
    if depth > MAX_DIRECTORY_WALK_DEPTH {
        return Err(errcode::with_detail(errcode::INCOMPLETE, "walk depth"));
    }
    let proc_path = Path::new("/proc/self/fd").join(dir_fd.as_raw_fd().to_string());
    let rd = fs::read_dir(&proc_path).map_err(|error| format!("read_dir {relative:?}: {error}"))?;
    for entry in rd {
        let entry = entry.map_err(|error| format!("read_dir entry {relative:?}: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("file_type {relative:?}: {error}"))?;
        let name = entry.file_name();
        let child = relative.join(&name);
        if file_type.is_dir() {
            before_read(&child)?;
            let child_fd = open_dir_at(dir_fd.as_raw_fd(), name.as_os_str())
                .map_err(|error| format!("open_dir {child:?}: {error}"))?;
            walk_directory_fd(&child_fd, &child, depth + 1, before_read, total)?;
        } else if file_type.is_file() {
            before_read(&child)?;
            let file = open_file_at(dir_fd.as_raw_fd(), name.as_os_str())
                .map_err(|error| format!("open_file {child:?}: {error}"))?;
            let length = ensure_regular_fd(&file, &child.to_string_lossy())?;
            *total = checked_size_add(*total, length)?;
        }
    }
    Ok(())
}

/// Misst ein Verzeichnis fd-gebunden. `before_metadata` läuft vor dem ersten
/// Stat des Roots (fehlender Root bleibt `missing`), `before_bind` zwischen
/// Stat und Open der Root-Bindung (Root-Tausch wird erkannt), `before_read`
/// vor jedem Open mit dem Pfad relativ zum Root ("" = Root selbst).
#[cfg(target_os = "linux")]
fn measure_directory_with_hook(
    path: &Path,
    before_metadata: &mut dyn FnMut(&Path) -> Result<(), String>,
    before_bind: &mut dyn FnMut(),
    before_read: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> Result<DirectorySize, String> {
    before_metadata(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DirectorySize::Missing);
        }
        Err(error) => {
            return Ok(DirectorySize::Failed {
                detail: Some(format!("directory size: {error}")),
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    let root_fd = open_bound_root_fd(path, before_bind)
        .map_err(|error| format!("directory size: {error}"))?;
    let mut total = 0u64;
    before_read(Path::new(""))?;
    match walk_directory_fd(&root_fd, Path::new(""), 0, before_read, &mut total) {
        Ok(()) => Ok(DirectorySize::Measured { size_bytes: total }),
        Err(detail) => Ok(DirectorySize::Failed {
            detail: Some(detail),
        }),
    }
}

#[cfg(target_os = "linux")]
fn measure_directory(path: &Path) -> Result<DirectorySize, String> {
    measure_directory_with_hook(path, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()))
}

#[cfg(not(target_os = "linux"))]
fn measure_directory(path: &Path) -> Result<DirectorySize, String> {
    let _ = path;
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "directory size",
    ))
}

/// Kanonischer Pfad und `(dev, ino)` zur Library-Deduplizierung.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub(crate) struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
}

/// Prüft ausschließlich den Prozessnamen `steam`.
/// bewusst kein generisches process-enumeration-werkzeug für die webview.
/// async + spawn_blocking: sync commands laufen bei tauri v2 auf dem main-thread,
/// und dieser check steht vor JEDEM write-gate.
pub(super) fn is_process_running_sync(name: &str) -> Result<bool, String> {
    if name.to_lowercase() != "steam" {
        return Err(errcode::BLOCKED.into());
    }
    // Substring-Match schließt absichtlich Steam-Helper wie steamwebhelper ein;
    // false-positive Blockade ist sicherer als false-negative während Writes.
    // nur die prozessliste refreshen, new_all() baute eine komplette
    // system-inventur (CPU/RAM/disks/netzwerk) für einen namens-check.
    // name() kommt aus /proc/<pid>/stat und ist auch mit
    // ProcessRefreshKind::nothing() befüllt.
    let sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    let target = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target)))
}

#[tauri::command]
pub async fn is_process_running(name: String) -> Result<bool, String> {
    spawn_blocking_io(move || is_process_running_sync(&name)).await
}

/// Berechnet die Größe eines Verzeichnisses.
/// async + spawn_blocking: der rekursive walk darf nicht auf dem main-thread laufen.
#[tauri::command]
pub async fn dir_size(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<DirectorySize, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_optional(&path, "dir_size", |real| {
            let Some(real) = real else {
                return Ok(DirectorySize::Missing);
            };
            measure_directory(&real)
        })
    })
    .await
}

/// Berechnet Verzeichnisgrößen sequenziell; der Vorgang ist I/O-gebunden.
/// async + spawn_blocking: walkt GB-große bäume, gehört nicht auf den main-thread.
#[tauri::command]
pub async fn batch_dir_sizes(
    state: State<'_, EnvironmentState>,
    paths: Vec<String>,
) -> Result<HashMap<String, DirectorySize>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        if paths.len() > MAX_BATCH_DIR_SIZE_PATHS {
            return Err(errcode::with_detail(errcode::SIZE_LIMIT, "path batch"));
        }
        state.with_authorized_batch(&paths, |authorized| {
            let mut result = HashMap::with_capacity(authorized.len());
            for authorized_path in authorized {
                let path = authorized_path.requested;
                let Some(real) = authorized_path.real else {
                    result.insert(path, DirectorySize::Missing);
                    continue;
                };
                result.insert(path, measure_directory(&real)?);
            }
            Ok(result)
        })
    })
    .await
}

/// Liefert kanonischen Pfad und `(dev, ino)` zur Library-Deduplizierung.
/// Nutzt `canonicalize_no_symlink()` (Symlink-Guard auf dem roh-input vor dem
/// Realpath). async + spawn_blocking: metadata ist Dateisystem-I/O und darf
/// keinen Command-Thread blockieren.
#[tauri::command]
pub async fn path_identity(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<PathIdentity, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_existing(&path, "path_identity", |real| {
            let md = fs::metadata(&real).map_err(|error| format!("path_identity: {error}"))?;
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            #[cfg(unix)]
            let identity = (md.dev().to_string(), md.ino().to_string());
            #[cfg(not(unix))]
            let identity = (String::from("0"), md.len().to_string());
            Ok(PathIdentity {
                realpath: real.to_string_lossy().into_owned(),
                dev: identity.0,
                ino: identity.1,
            })
        })
    })
    .await
}

#[cfg(test)]
#[path = "fs_ops_tests.rs"]
mod tests;
