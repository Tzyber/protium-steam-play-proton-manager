use crate::commands::errcode;
// fd-Items gibt es nur unter Linux (fd.rs ist leer gekappt); der Import ist
// deshalb wie seine Aufrufer bedingt (r-12).
#[cfg(target_os = "linux")]
use crate::commands::fd::{
    ensure_regular_fd, open_bound_root_fd, open_dir_at, open_file_at, read_fd_bytes,
};
#[cfg(target_os = "linux")]
use crate::commands::scope::ContentRead;
use crate::commands::scope::{EnvironmentState, MAX_ENVIRONMENT_READ_BYTES};
use crate::commands::spawn_blocking_io;
#[cfg(target_os = "linux")]
use crate::commands::vdf_patch;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;
use std::path::Path;
// die prozessliste wird nur unter Linux befragt (r-12).
#[cfg(target_os = "linux")]
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
// Beide Layouts, in denen Steam die Compat-Zuordnung ablegt: das klassische
// `InstallConfigStore`-Dokument und ein flaches `Software`-Dokument. Die
// Reihenfolge ist fest und Teil des Vertrags: der Lesepfad in
// `src/core/compatTools.ts` nimmt die erste Zuordnung je AppID, bei doppelten
// AppIDs gewinnt deshalb das `InstallConfigStore`-Layout.
#[cfg(target_os = "linux")]
const COMPAT_TOOL_MAPPING_PATHS: [&[&str]; 2] = [
    &[
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
    ],
    &["Software", "Valve", "Steam", "CompatToolMapping"],
];

/// Reduziert `config.vdf` auf beide Mapping-Layouts: `extract_vdf_blocks`
/// tokenisiert die Datei einmal und liefert beide Blöcke in fester Reihenfolge,
/// verbunden mit `\n`. Das Ergebnis hat zwei Root-Knoten; der TS-Parser liest
/// sie als zwei Wurzeln. Fremde Teilbäume (Login-Tokens und Ähnliches) fallen
/// weg (INV-7, S-03).
#[cfg(target_os = "linux")]
fn reduce_compat_config(text: &str) -> Result<String, String> {
    vdf_patch::extract_vdf_blocks(text, &COMPAT_TOOL_MAPPING_PATHS)
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum DirectorySize {
    Measured {
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Missing,
    Failed {
        /// Immer gesetzt; ein leerer String bleibt aus dem Wire-Format heraus
        /// (r-18: `Option<String>` hatte einen nie konstruierten `None`-Zustand).
        #[serde(skip_serializing_if = "String::is_empty")]
        detail: String,
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
    state.with_authorized_content(path, label, |real, read| {
        let parent = real.parent().ok_or_else(|| {
            errcode::with_detail(
                errcode::UNAVAILABLE,
                format!("{label}: no parent directory"),
            )
        })?;
        let file_name = real.file_name().ok_or_else(|| {
            errcode::with_detail(errcode::UNAVAILABLE, format!("{label}: no file name"))
        })?;
        let parent_fd = open_bound_root_fd(parent, before_open)
            .map_err(|error| errcode::with_context(label, &error))?;
        let mut file = open_file_at(parent_fd.as_raw_fd(), file_name).map_err(|error| {
            errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
        })?;
        after_open(&mut file);
        let bytes = read_fd_bytes(&mut file, label, MAX_ENVIRONMENT_READ_BYTES, &mut |_| {})?;
        match read {
            ContentRead::Full => Ok(bytes),
            ContentRead::CompatToolMappingOnly => {
                let text = String::from_utf8(bytes).map_err(|error| {
                    errcode::with_detail(errcode::UNREADABLE, format!("{label}: {error}"))
                })?;
                Ok(reduce_compat_config(&text)?.into_bytes())
            }
        }
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
        String::from_utf8(bytes).map_err(|error| {
            errcode::with_detail(
                errcode::UNREADABLE,
                format!("environment read text: {error}"),
            )
        })
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
        let dir_fd = open_bound_root_fd(&real, before_open)
            .map_err(|error| errcode::with_context(label, &error))?;
        let proc_path = Path::new("/proc/self/fd").join(dir_fd.as_raw_fd().to_string());
        let mut entries = Vec::new();
        for (index, entry) in fs::read_dir(&proc_path)
            .map_err(|error| {
                errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
            })?
            .enumerate()
        {
            if index >= MAX_ENVIRONMENT_DIR_ENTRIES {
                return Err(errcode::with_detail(errcode::SIZE_LIMIT, label));
            }
            let entry = entry.map_err(|error| {
                errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
            })?;
            let file_type = entry.file_type().map_err(|error| {
                errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
            })?;
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
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, "walk depth"));
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
                detail: format!("directory size: {error}"),
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    let root_fd = open_bound_root_fd(path, before_bind)
        .map_err(|error| errcode::with_context("directory size", &error))?;
    let mut total = 0u64;
    before_read(Path::new(""))?;
    match walk_directory_fd(&root_fd, Path::new(""), 0, before_read, &mut total) {
        Ok(()) => Ok(DirectorySize::Measured { size_bytes: total }),
        Err(detail) => Ok(DirectorySize::Failed { detail }),
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

/// Belegt zuerst die Lesbarkeit der Prozessliste und meldet dann, ob ein
/// Prozessname `steam` enthält. „Nicht belegbar" ist ein Fehler, kein `false`
/// (Audit 5.5): eine verdeckte Liste sieht sonst wie „kein Steam" aus.
/// Die Webview übergibt keinen Prozessnamen: ein generisches
/// Process-Enumeration-Werkzeug wäre von dort aus wählbar.
/// async + spawn_blocking: sync commands laufen bei tauri v2 auf dem main-thread,
/// und dieser check steht vor JEDEM write-gate.
#[cfg(target_os = "linux")]
pub(super) fn is_steam_running_sync() -> Result<bool, String> {
    probe_proc(Path::new("/proc"))?;
    // nur die prozessliste refreshen, new_all() baute eine komplette
    // system-inventur (CPU/RAM/disks/netzwerk) für einen namens-check.
    // name() kommt aus /proc/<pid>/stat und ist auch mit
    // ProcessRefreshKind::nothing() befüllt.
    let sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    let own_pid = sysinfo::Pid::from_u32(std::process::id());
    steam_running_from(
        sys.processes().contains_key(&own_pid),
        sys.processes()
            .values()
            .map(|process| process.name().to_string_lossy().into_owned()),
    )
}

/// Entscheidung über den befund des prozess-scans, ohne sysinfo: eine liste
/// ohne den eigenen prozess ist nicht belegbar (hidepid, fremde
/// PID-Namespace), nicht etwa „kein Steam", und bleibt ein Fehler. Der
/// Substring-Match schließt absichtlich Steam-Helper wie steamwebhelper ein;
/// eine false-positive Blockade ist sicherer als ein false-negative während
/// Writes.
#[cfg(target_os = "linux")]
fn steam_running_from(
    own_pid_visible: bool,
    names: impl IntoIterator<Item = String>,
) -> Result<bool, String> {
    if !own_pid_visible {
        return Err(errcode::with_detail(
            errcode::STEAM_CHECK_UNAVAILABLE,
            format!("process list without own pid {}", std::process::id()),
        ));
    }
    Ok(names.into_iter().any(|name| is_steam_process_name(&name)))
}

#[cfg(not(target_os = "linux"))]
pub(super) fn is_steam_running_sync() -> Result<bool, String> {
    // r-12: auf anderen plattformen ist die prozessliste nicht belegbar,
    // deshalb fail-closed statt „kein Steam".
    Err(errcode::with_detail(
        errcode::STEAM_CHECK_UNAVAILABLE,
        "process list not verifiable on this platform",
    ))
}

/// Fehlerform jedes nicht belegten Probe-Zustands: Code plus Pfad/Zustand im
/// Detail, damit das Log den Grund zeigt und die Klasse `unavailable` bleibt.
#[cfg(target_os = "linux")]
fn probe_error(path: &Path, state: impl std::fmt::Display) -> String {
    errcode::with_detail(
        errcode::STEAM_CHECK_UNAVAILABLE,
        format!("probe {}: {state}", path.display()),
    )
}

/// `comm` trägt ein abschließendes Newline; nur exakt `kthreadd` ist der
/// belegte Kernel-Thread, jede andere Schreibweise sperrt.
#[cfg(target_os = "linux")]
fn comm_is_kthreadd(comm: &str) -> bool {
    comm.trim_end_matches('\n') == "kthreadd"
}

/// Belegt, dass die Prozessliste des Kernels lesbar und plausibel ist: PID 2
/// ist der Kernel-Thread `kthreadd` mit ppid 0 und ohne auflösbaren
/// `exe`-Link. Ohne diesen Beleg ist „kein Steam sichtbar" nicht von einer
/// verdeckten Liste zu unterscheiden (hidepid, `ProtectProc`, fremde
/// PID-Namespace); jeder Zweifel sperrt.
///
/// Grenze des Belegs: `read_dir` zeigt nur, dass sich die Liste öffnen und
/// lesen lässt, nicht dass sie vollständig ist. Die anschließende Auswertung
/// über sysinfo verwirft einzelne unlesbare Prozesse still; die Probe bleibt
/// deshalb eine Plausibilitätsprüfung und keine Vollständigkeitsaussage.
#[cfg(target_os = "linux")]
fn probe_proc(root: &Path) -> Result<(), String> {
    fs::read_dir(root).map_err(|error| probe_error(root, error))?;

    let init = root.join("2");
    let comm_path = init.join("comm");
    let comm = fs::read_to_string(&comm_path).map_err(|error| probe_error(&comm_path, error))?;
    if !comm_is_kthreadd(&comm) {
        let comm = comm.trim_end_matches('\n');
        return Err(probe_error(
            &comm_path,
            format!("comm is {comm:?}, expected \"kthreadd\""),
        ));
    }

    let stat_path = init.join("stat");
    let stat = fs::read_to_string(&stat_path).map_err(|error| probe_error(&stat_path, error))?;
    match stat_ppid(&stat) {
        Some(0) => {}
        other => {
            return Err(probe_error(
                &stat_path,
                format!("ppid is {other:?}, expected 0"),
            ));
        }
    }

    probe_exe_not_resolvable(&init.join("exe"))
}

/// ppid ist Feld 4 der `stat`-Zeile. Der comm (Feld 2) ist geklammert und kann
/// selbst Klammern und Leerzeichen enthalten, deshalb beginnt die Zerlegung
/// erst nach dem LETZTEN `)`.
#[cfg(target_os = "linux")]
fn stat_ppid(stat: &str) -> Option<u32> {
    let rest = stat.get(stat.rfind(')')? + 1..)?;
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Kernel-Threads haben keinen `exe`-Link (ENOENT; mit `hidepid` auch EPERM,
/// das Rust auf `PermissionDenied` abbildet). Nur diese beiden Fehlerarten sind
/// belegte Abwesenheit; jedes `Ok` und jeder andere Fehler (etwa `EINVAL` bei
/// einer regulären Datei) widerspricht dem erwarteten Prozessbild und sperrt.
#[cfg(target_os = "linux")]
fn exe_error_is_expected(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
    )
}

/// Eigenständig prüfbar, weil EACCES über den vollen Probe-Pfad nicht
/// konstruierbar ist: `comm` und `stat` brauchen denselben durchsuchbaren
/// Parent wie `exe`. Die Entscheidung selbst liegt deshalb in
/// `exe_error_is_expected`.
#[cfg(target_os = "linux")]
fn probe_exe_not_resolvable(exe: &Path) -> Result<(), String> {
    match fs::read_link(exe) {
        Err(error) if exe_error_is_expected(error.kind()) => Ok(()),
        Err(error) => Err(probe_error(exe, error)),
        Ok(target) => Err(probe_error(
            exe,
            format!("resolves to {}", target.display()),
        )),
    }
}

#[cfg(target_os = "linux")]
fn is_steam_process_name(name: &str) -> bool {
    name.to_lowercase().contains("steam")
}

#[tauri::command]
pub async fn is_steam_running() -> Result<bool, String> {
    spawn_blocking_io(is_steam_running_sync).await
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
                let size = match authorized_path.real {
                    Err(detail) => DirectorySize::Failed { detail },
                    Ok(None) => DirectorySize::Missing,
                    Ok(Some(real)) => measure_directory(&real)
                        .unwrap_or_else(|detail| DirectorySize::Failed { detail }),
                };
                result.insert(authorized_path.requested, size);
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
            let md = fs::metadata(&real).map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("path_identity: {error}"),
                )
            })?;
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
