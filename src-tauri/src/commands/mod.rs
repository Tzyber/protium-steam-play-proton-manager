// rust-commands (R-1..R-6): das, was die webview nicht kann.

pub(crate) mod cleanup;
pub(crate) mod download;
pub(crate) mod extract;
pub(crate) mod external;
pub(crate) mod fs_ops;
pub(crate) mod path;
pub(crate) mod scope;
pub(crate) mod steam;

pub use download::CancelRegistry;
pub use download::MAX_DOWNLOAD_BYTES;

#[cfg(test)]
pub(crate) mod test_util {
    // gemeinsame fixture-helper der commands-tests: tempdir-fixtures
    // (fixture_dir + prefix-factories orphan/trash/wsg) und touch
    // (marker-datei bauen). genutzt von den cleanup.rs- (orphan/trash)
    // und steam.rs-tests (wsg).
    pub(super) fn fixture_dir(prefix: &str, tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-{prefix}-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    pub(super) fn orphan_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("orphan", tag)
    }

    pub(super) fn trash_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("trash", tag)
    }

    pub(super) fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }

    pub(super) fn touch(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("marker"), b"x").unwrap();
    }
}

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use crate::commands::cleanup::{
    list_trash_entries_inner, remove_orphan_dir_inner, remove_trash_entry_inner, TrashListing,
    validate_and_prepare,
};
use crate::commands::external::{spawn_detached, validate_external_url};
use crate::commands::extract::extract_blocking;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;
use crate::commands::download::{download_stream, validate_download_url, validate_redirect_url};
use crate::commands::fs_ops::{batch_dir_sizes_inner, dir_size_inner, PathIdentity};
use crate::commands::path::{canonicalize_safe, sanitize_path, validate_download_dest};
use crate::commands::scope::{allow_library_scope_inner, validate_library_scope};
use crate::commands::steam::{remove_compat_tool_inner, write_steam_file_inner};

/// markiert einen download zum abbruch; setzt das flag im aktuell registrierten Arc.
#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, CancelRegistry>, download_id: String) {
    if let Ok(map) = state.0.lock() {
        if let Some(flag) = map.get(&download_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: Option<u64>,
}

/// spawn_blocking + join-handle-fehler → String. die sync-commands laufen
/// bei tauri v2 auf dem main-thread — blockierende IO gehört in den
/// blocking-pool (batch C1).
async fn spawn_blocking_io<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// R-1: .tar.gz entpacken. temp im ziel-fs (EXDEV-safe), dann rename ins ziel.
/// dest-allowlist (M1.3): der scope-check läuft VOR create_dir_all und prüft
/// den nächsten existierenden vorfahren — der einzige legitime dest ist
/// `compatibilitytools.d` unter einem session-bestätigten steam-root.
#[tauri::command]
pub async fn extract_tarball(
    app: tauri::AppHandle,
    src: String,
    dest: String,
) -> Result<(), String> {
    sanitize_path(&src, "extract source")?;
    sanitize_path(&dest, "extract destination")?;
    let app2 = app.clone();
    spawn_blocking_io(move || {
        extract_blocking(&src, &dest, MAX_EXTRACT_BYTES, &|p: &Path| {
            app2.fs_scope().is_allowed(p)
        })
    })
    .await
}

/// R-2: steam-läuft-check (INV-1a). nur "steam" als name erlaubt —
/// bewusst kein generisches process-enumeration-werkzeug für die webview.
/// async + spawn_blocking: sync commands laufen bei tauri v2 auf dem main-thread,
/// und dieser check steht vor JEDEM write-gate.
#[tauri::command]
pub async fn is_process_running(name: String) -> Result<bool, String> {
    if name.to_lowercase() != "steam" {
        return Err("process check only allowed for steam".into());
    }
    spawn_blocking_io(move || {
        // Substring-Match schließt absichtlich Steam-Helper wie steamwebhelper ein;
        // false-positive Blockade ist sicherer als false-negative während Writes.
        // nur die prozessliste refreshen — new_all() baute eine komplette
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
    })
    .await
}

/// R-3 (S-01: validierung nach batch_dir_sizes-vorlage).
/// async + spawn_blocking: der rekursive walk darf nicht auf dem main-thread laufen.
#[tauri::command]
pub async fn dir_size(path: String) -> Result<u64, String> {
    spawn_blocking_io(move || dir_size_inner(&path)).await
}

/// R-3b: batch-version — sequentiell (IO-bound, kein rayon).
/// async + spawn_blocking: walkt GB-große bäume, gehört nicht auf den main-thread.
#[tauri::command]
pub async fn batch_dir_sizes(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    spawn_blocking_io(move || batch_dir_sizes_inner(paths)).await
}

/// löscht ein verwaistes compatdata- oder shadercache-verzeichnis.
/// leitet library + typ selbst ab (defense-in-depth: backend traut frontend nicht).
/// compatdata → trash (rename), shadercache → hard delete.
/// async + spawn_blocking: remove_dir_all/rename auf GB-großen prefixes
/// darf den main-thread nicht blockieren.
#[tauri::command]
pub async fn remove_orphan_dir(app: AppHandle, path: String) -> Result<String, String> {
    let app2 = app.clone();
    spawn_blocking_io(move || {
        let (library, canonical) = validate_and_prepare(&path)?;
        // scope-gate VOR dem grant (S5): ohne diesen check würde der grant
        // unten das library-root selbst in den scope heben und der is_allowed-
        // check in inner wäre trivial true — löschung außerhalb bestätigter
        // libraries wäre möglich.
        if !app.fs_scope().is_allowed(&library) {
            return Err("library outside allowed scope".into());
        }
        allow_library_scope_inner(app, &library)?;
        remove_orphan_dir_inner(&canonical, &library, &|p| app2.fs_scope().is_allowed(p))
    })
    .await
}

/// löscht einen eintrag aus .protium-trash endgültig (kein zweiter papierkorb).
/// muster: `.protium-trash/(compatdata|shadercache)_<appId>_<ms>`.
/// keinerlei gates (kein steam-läuft, kein scope-check): der papierkorb ist
/// keine steam-datei, löschen kann nichts korrumpieren.
/// async + spawn_blocking (remove_dir_all auf GB-bäumen).
#[tauri::command]
pub async fn remove_trash_entry(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let app2 = app.clone();
    spawn_blocking_io(move || {
        remove_trash_entry_inner(&path, &|p| app2.fs_scope().is_allowed(p))
    })
    .await
}

const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// R-4: tauri-wrapper um download_stream — cancel-registry + fortschritt (throttled ~1 MB).
/// validiert URL (domain + https) und dest-pfad vor dem start.
/// dest-validierung per allowlist: nur ziele innerhalb des app-cache-verzeichnisses.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    url: String,
    dest: String,
    download_id: String,
) -> Result<String, String> {
    validate_download_url(&url)?;
    sanitize_path(&dest, "download dest")?;

    // allowlist: cache-dir selbst über den tauri path-resolver ermitteln
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    validate_download_dest(&dest, &cache_dir)?;

    // frisches cancel-flag; ersetzt ein etwaiges altes in der registry
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(download_id.clone(), Arc::clone(&cancel_flag));
    }
    let cancel_flag_clone = Arc::clone(&cancel_flag);

    let mut last_emit: u64 = 0;

    let result = download_stream(
        &url,
        &dest,
        |u| validate_redirect_url(u).is_ok(),
        move || cancel_flag_clone.load(std::sync::atomic::Ordering::Relaxed),
        |downloaded, total| {
            let done = total.map(|t| downloaded >= t).unwrap_or(false);
            if downloaded - last_emit >= 1_000_000 || done {
                last_emit = downloaded;
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress { id: download_id.clone(), downloaded, total },
                );
            }
        },
        MAX_DOWNLOAD_BYTES,
    )
    .await;

    // nur aufräumen, wenn noch genau unser eigenes Arc registriert ist
    if let Ok(mut map) = state.0.lock() {
        let keep = map
            .get(&download_id)
            .map(|registered| Arc::ptr_eq(registered, &cancel_flag))
            .unwrap_or(false);
        if keep {
            map.remove(&download_id);
        }
    }
    result
}

/// R-5: verzeichnis zur laufzeit in den fs-scope aufnehmen.
/// zwingend: canonicalize + sicherheitscheck + library-kandidat-zwang.
#[tauri::command]
pub fn allow_library_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let real = validate_library_scope(&path)?;
    let _ = app.fs_scope().allow_directory(real.to_string_lossy().as_ref(), true);
    Ok(())
}

#[tauri::command]
pub async fn remove_compat_tool(
    app: tauri::AppHandle,
    steam_root: String,
    tool_name: String,
) -> Result<(), String> {
    let app2 = app.clone();
    spawn_blocking_io(move || {
        remove_compat_tool_inner(&steam_root, &tool_name, &|p| app2.fs_scope().is_allowed(p))
    })
    .await
}

#[tauri::command]
pub async fn write_steam_file(
    app: tauri::AppHandle,
    file: String,
    original: String,
    content: String,
    backup: String,
) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    let running = is_process_running("steam".to_string()).await?;
    spawn_blocking_io(move || {
        write_steam_file_inner(&file, &original, &content, &backup, &backup_dir, &home, running)
    })
    .await
}

/// symlink-auflösung (steam-root-discovery). `..` im input abgelehnt,
/// auflösungen in blockierte dateisysteme verweigert (info-disclosure).
/// S-07: nutzt is_safe_path() statt eigener blocklist (konsistenz).
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    let canonical = canonicalize_safe(&path, "canonicalize")?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// listet `<library>/steamapps/.protium-trash`.
///
/// WARUM in rust und nicht per plugin-fs readDir im frontend: der fs-scope des
/// webviews wird über globs vergeben (`<library>/**`). ein verzeichnis mit
/// führendem punkt wird davon nicht zuverlässig erfasst, und das lesen des
/// papierkorbs schlug in externen libraries still fehl — die app zeigte einen
/// leeren papierkorb, obwohl vier prefixes darin lagen. rust hat keinen
/// webview-scope; dieselbe begründung wie bei dir_size und remove_trash_entry.
/// async + spawn_blocking (verzeichnis-read auf dem main-thread vermeiden).
#[tauri::command]
pub async fn list_trash_entries(library: String) -> Result<TrashListing, String> {
    spawn_blocking_io(move || list_trash_entries_inner(&library)).await
}

/// R-6: realpath + (dev,ino) zur library-dedup (S-02: validierung).
#[tauri::command]
pub fn path_identity(path: String) -> Result<PathIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let real = canonicalize_safe(&path, "path_identity")?;
    let md = fs::metadata(&real).map_err(|e| e.to_string())?;
    Ok(PathIdentity {
        realpath: real.to_string_lossy().into_owned(),
        dev: md.dev().to_string(),
        ino: md.ino().to_string(),
    })
}

/// R-7: url im system-browser bzw. im steam-handler öffnen.
///
/// eigener command statt tauri-plugin-opener, weil dessen spawn die env des
/// app-prozesses ungefiltert vererbt — im AppImage genau der grund, warum
/// play-button und protondb-link dort nichts taten (siehe env_overrides).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    let mut last_err = String::new();
    for (program, args) in [("xdg-open", &[][..]), ("gio", &["open"][..])] {
        match spawn_detached(program, args, &url) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = format!("{program}: {e}"),
        }
    }
    Err(format!("no URL handler available ({last_err})"))
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_path, path_identity};

    // S-02: path_identity lehnt blockierte pfade ab
    #[test]
    fn path_identity_rejects_blocked_paths() {
        assert!(path_identity("/etc/passwd".into()).is_err());
        assert!(path_identity("/proc/cpuinfo".into()).is_err());
    }

    #[test]
    fn path_identity_rejects_dotdot() {
        assert!(path_identity("/home/../etc/passwd".into()).is_err());
    }

    #[test]
    fn path_identity_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        let s = tmp.to_string_lossy().into_owned();
        assert!(path_identity(s).is_ok());
    }

    // S-03+S-07: canonicalize_path lehnt /etc ab (nutzt jetzt is_safe_path)
    #[test]
    fn canonicalize_rejects_etc() {
        assert!(canonicalize_path("/etc".into()).is_err());
        assert!(canonicalize_path("/etc/cron.d".into()).is_err());
    }

    // S-07: cross-check — derselbe pfad-satz den is_safe_path blockt wird abgelehnt
    #[test]
    fn canonicalize_rejects_all_blocked() {
        for blocked in &["/", "/etc", "/etc/cron.d", "/proc", "/proc/cpuinfo",
                          "/sys", "/sys/class", "/dev", "/dev/null"] {
            assert!(
                canonicalize_path(blocked.to_string()).is_err(),
                "canonicalize_path should reject {blocked}"
            );
        }
    }
}
