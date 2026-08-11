// rust-commands (R-1..R-6): das, was die webview nicht kann.

pub(crate) mod download;
pub(crate) mod extract;
pub(crate) mod external;
pub(crate) mod fs_ops;
pub(crate) mod path;
pub(crate) mod scope;

pub use download::CancelRegistry;
pub use download::MAX_DOWNLOAD_BYTES;

#[cfg(test)]
pub(crate) mod test_util {
    // cleanup-/trash-fixtures (fixture_dir, orphan_fixture, trash_fixture,
    // wsg_fixture) wandern hierher, sobald der cleanup-task die
    // papierkorb-logik in ein eigenes modul zieht.
}

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use crate::commands::external::{spawn_detached, validate_external_url};
use crate::commands::extract::extract_blocking;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;
use crate::commands::download::{download_stream, validate_download_url, validate_redirect_url};
use crate::commands::fs_ops::{batch_dir_sizes_inner, dir_size_inner, PathIdentity};
use crate::commands::path::{
    canonicalize_no_symlink, canonicalize_safe, ensure_dest_within_canon_dir, is_safe_path,
    random_suffix, sanitize_path, validate_download_dest,
};
use crate::commands::scope::{
    allow_library_scope_inner, library_of, parse_compat_id, suffix_after_steamapps,
    validate_library_scope,
};

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

/// name des papierkorb-verzeichnisses — existiert genau einmal hier, weil der
/// papierkorb in rust konstruiert wird (der webview-fs-scope erfasst
/// verzeichnisse mit führendem punkt nicht zuverlässig, s. list_trash_entries).
const TRASH_DIR_NAME: &str = ".protium-trash";

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

/// testbare validierungskette für den command-wrapper: sanitized input
/// (kein `..`, absolut) → symlink-guard auf roh-input → canonicalize →
/// library-derive. der symlink-guard auf roh-input ist nötig, weil
/// canonicalize symlinks folgt und der nachgelagerte symlink-check in
/// inner dann effektiv tot wäre. library wird hier einmal berechnet und
/// an inner weitergereicht (entfernt das doppelte `rfind` aus inner,
/// ohne die guard-reihenfolge zu verändern).
fn validate_and_prepare(path_str: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    sanitize_path(path_str, "remove_orphan_dir")?;
    // symlink-guard auf roh-input: ein orphan-eintrag, der selbst ein symlink
    // ist, ist nie ein legitimer löschkandidat (findOrphans skippt symlinks) —
    // siehe canonicalize_no_symlink für die begründung der reihenfolge.
    let canonical = canonicalize_no_symlink(path_str)?;
    let binding = canonical.to_string_lossy();
    let lib_str = library_of(&binding)?;
    Ok((std::path::PathBuf::from(lib_str), canonical))
}

/// reine lösch-logik: validierung (blocklist, symlink-defense-in-depth, is_dir,
/// muster, appid) + tatsächliches löschen/trash. `library` wird vom
/// command-wrapper durchgereicht (nicht erneut abgeleitet) — guard-reihenfolge
/// bleibt unverändert: erst sicherheit, dann parsing, dann delete.
fn remove_orphan_dir_inner(
    canonical: &Path,
    library: &Path,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<String, String> {
    // scope-gate auf das library-root (nicht den zielpfad — der trash-pfad
    // liegt in einem punkt-verzeichnis, das der glob nicht erfasst). der
    // command prüft zusätzlich VOR dem scope-grant.
    if !scope_ok(library) {
        return Err("library outside allowed scope".into());
    }
    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // symlink-guard bleibt als defense-in-depth: validate_and_prepare im
    // command-wrapper hat symlinks auf roh-input bereits abgewiesen, sodass
    // dieser check im normalen aufruf nie zuschlägt. er schützt direkte
    // inner-aufrufer (tests, zukünftige code-pfade) und kostet nichts.
    let meta = fs::symlink_metadata(canonical).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }

    let suffix = suffix_after_steamapps(&canon_str)?;

    let (typ, app_id_str) = parse_compat_id(
        suffix
            .split_once('/')
            .ok_or_else(|| "invalid suffix structure".to_string())?,
    )?;

    match typ {
        "shadercache" => {
            // hard delete; trash-ordner wird NICHT angelegt (würde leer zurückbleiben)
            fs::remove_dir_all(canonical).map_err(|e| e.to_string())?;
            Ok("deleted".into())
        }
        "compatdata" => {
            let trash_dir = library.join("steamapps").join(TRASH_DIR_NAME);
            fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let trash_name = format!("compatdata_{app_id_str}_{ts}");
            let trash_target = trash_dir.join(&trash_name);
            fs::rename(canonical, &trash_target).map_err(|e| e.to_string())?;
            Ok(format!("trashed → {}", trash_target.display()))
        }
        _ => unreachable!(),
    }
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

fn remove_trash_entry_inner(path: &str, scope_ok: &dyn Fn(&Path) -> bool) -> Result<String, String> {
    sanitize_path(&path, "remove_trash_entry")?;

    // canonicalize VOR allen weiteren prüfungen (sonst umgeht .. die
    // musterprüfung) — symlink-guard auf roh-input in canonicalize_no_symlink
    let canonical = canonicalize_no_symlink(&path)?;

    let meta = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    // defense-in-depth: der roh-input-check oben hat symlinks bereits abgewiesen
    if meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }

    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // scope-gate auf das library-root (nicht den trash-pfad — punkt-verzeichnis,
    // nicht vom glob erfasst). der papierkorb bleibt damit nur innerhalb
    // session-bestätigter libraries leerbar.
    let lib_str = library_of(&canon_str)?;
    if !scope_ok(Path::new(lib_str)) {
        return Err("library outside allowed scope".into());
    }

    let suffix = suffix_after_steamapps(&canon_str)?;

    // suffix muss exakt .protium-trash/<name> sein
    let (trash_marker, name) = suffix
        .split_once('/')
        .ok_or_else(|| "invalid suffix structure".to_string())?;

    if trash_marker != TRASH_DIR_NAME {
        return Err(format!(
            "expected .protium-trash, got: {trash_marker}"
        ));
    }

    if name.contains('/') {
        return Err("name must not contain '/'".into());
    }

    // name parsen: (compatdata|shadercache)_<appId>_<ms>
    let (rest, ms_str) = name
        .rsplit_once('_')
        .ok_or_else(|| "missing timestamp suffix".to_string())?;

    if ms_str.is_empty() || !ms_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric timestamp: {ms_str}"));
    }

    parse_compat_id(
        rest.split_once('_')
            .ok_or_else(|| "missing type/appId separator".to_string())?,
    )?;

    fs::remove_dir_all(&canonical).map_err(|e| e.to_string())?;
    Ok("deleted".into())
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

/// M3.1: INV-1-write-gate in rust. prüft, ob ein canonicalisierter pfad eine
/// der legitimen steam-config-dateien ist: drei canonicalisierte root-
/// varianten (nativ/flatpak/snap — `.steam/steam` und `.steam/root` sind
/// symlinks und kollabieren per canonicalize auf die native variante) ×
/// `config/config.vdf` und `userdata/<digits>/config/localconfig.vdf`.
fn is_steam_config_path(file: &Path, home: &Path) -> bool {
    let roots = [
        home.join(".local/share/Steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
        home.join("snap/steam/common/.local/share/Steam"),
    ];
    for root in &roots {
        if file == &root.join("config").join("config.vdf") {
            return true;
        }
        if let Ok(rel) = file.strip_prefix(root.join("userdata")) {
            let comps: Vec<_> = rel.components().collect();
            if comps.len() == 3
                && comps[0].as_os_str().to_string_lossy().chars().all(|c| c.is_ascii_digit())
                && comps[1].as_os_str() == "config"
                && comps[2].as_os_str() == "localconfig.vdf"
            {
                return true;
            }
        }
    }
    false
}

/// testbare kette für den write-gate-command (AppHandle-frei): sanitize →
/// steam-läuft → canonicalize (fail-closed bei fehlender zieldatei) →
/// blocklist → muster → backup (descendant von app-cache) → backup schreiben
/// → atomar temp+rename. TOCTOU wie gehabt: der original-text kommt vom
/// aufrufer, es wird nie von disk nachgelesen.
fn write_steam_file_inner(
    file: &str,
    original: &str,
    content: &str,
    backup: &str,
    backup_dir: &Path,
    home: &Path,
    running: bool,
) -> Result<(), String> {
    sanitize_path(file, "write target")?;
    if running {
        return Err("steam is running — write refused".into());
    }
    let canon = fs::canonicalize(file).map_err(|e| format!("write target canonicalize: {e}"))?;
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err("write target in blocked location".into());
    }
    if !is_steam_config_path(&canon, home) {
        return Err("write target is not a steam config file".into());
    }

    // backup ist ein zweites write-ziel — es muss zwingend innerhalb des
    // app-cache liegen (allowlist statt blocklist, muster validate_download_dest).
    // verhaltens-delta (spec 2026-08-03): der helper erstellt das app-cache-dir
    // VOR der ablehnung — bei abgelehntem backup bleibt ein leerer
    // verzeichnis-stamm (eigenes verzeichnis, harmlos, INV-konform).
    let backup_path = Path::new(backup);
    ensure_dest_within_canon_dir(backup_path, backup_dir, "backup")?;

    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(backup_path, original).map_err(|e| format!("backup write: {e}"))?;

    // atomar: temp im ziel-verzeichnis + rename; temp-cleanup bei fehler
    let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
    let name = canon.file_name().ok_or_else(|| "no file name".to_string())?;
    let tmp = parent.join(format!(".{}.{}.tmp", name.to_string_lossy(), random_suffix()));
    let write_result = fs::write(&tmp, content).and_then(|()| fs::rename(&tmp, &canon));
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic write: {e}"));
    }
    Ok(())
}

/// M3.1: schreibt eine steam-config-datei mit vollem INV-1-write-gate in
/// rust: steam-läuft-check → backup → atomarer temp+rename. ersetzt die
/// plugin-fs-writes des frontends auf steam-bäumen.
/// M3.4: entfernt ein GE-tool aus `compatibilitytools.d`. ersetzt den
/// plugin-fs-remove des frontends (M3.3 nimmt die remove-rechte im steam-baum)
/// mit scope-check auf den steam-root und tool_name-validierung.
fn remove_compat_tool_inner(
    steam_root: &str,
    tool_name: &str,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    sanitize_path(steam_root, "steam root")?;
    if tool_name.is_empty()
        || tool_name.contains('/')
        || tool_name == "."
        || tool_name == ".."
    {
        return Err("invalid tool name".into());
    }
    let root = Path::new(steam_root);
    if !scope_ok(root) {
        return Err("steam root outside allowed scope".into());
    }
    let target = root.join("compatibilitytools.d").join(tool_name);
    // symlink-guard: ein tool, das ein symlink ist, wird nie gelöscht
    let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("tool is a symlink — rejected".into());
    }
    if !meta.is_dir() {
        return Err("tool is not a directory".into());
    }
    fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
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

/// ein verzeichniseintrag im papierkorb. is_symlink kommt aus file_type() des
/// read_dir-eintrags, folgt also KEINEM symlink.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// ergebnis von list_trash_entries. `present` unterscheidet "kein papierkorb
/// vorhanden" (normalfall, kein fehler) von einem lesefehler (Err).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListing {
    /// kanonischer pfad des papierkorbs, den wir wirklich gelesen haben.
    /// das frontend baut eintragspfade daraus, statt selbst zu joinen —
    /// sonst driftet die anzeige bei symlinks vom echten ort ab.
    pub dir: String,
    pub present: bool,
    pub entries: Vec<TrashDirEntry>,
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

fn list_trash_entries_inner(library: &str) -> Result<TrashListing, String> {
    let real = canonicalize_safe(library, "list_trash_entries")?;

    let trash_dir = real.join("steamapps").join(TRASH_DIR_NAME);
    let dir = trash_dir.to_string_lossy().into_owned();

    // symlink_metadata: ein symlink an dieser stelle wird nicht verfolgt
    let md = match fs::symlink_metadata(&trash_dir) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrashListing { dir, present: false, entries: Vec::new() });
        }
        Err(e) => return Err(e.to_string()),
    };
    if md.file_type().is_symlink() {
        return Err("trash dir is a symlink — refusing to read".into());
    }
    if !md.is_dir() {
        return Err("trash path is not a directory".into());
    }

    let mut entries = Vec::new();
    for e in fs::read_dir(&trash_dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        entries.push(TrashDirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
        });
    }

    Ok(TrashListing { dir, present: true, entries })
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
    use std::os::unix::fs as unixfs;

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

    // ---- remove_orphan_dir (T-H-01) ----
    // gehärtete logik via remove_orphan_dir_inner (extrahiert, AppHandle-frei)
    // + validate_and_prepare (wrapper-kette, AppHandle-frei).
    // tests nutzen temp-fixtures unter /tmp; keine berührung von /mnt o. ä.

    use super::{remove_orphan_dir_inner, validate_and_prepare};
    use crate::commands::scope::library_of;

    /// tempdir-fixture (tempdir + pid-tag + remove_dir_all) — der eine
    /// fixture-helper für die drei fixture-prefixe orphan/trash/wsg.
    fn fixture_dir(prefix: &str, tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-{prefix}-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn orphan_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("orphan", tag)
    }

    fn touch(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("marker"), b"x").unwrap();
    }

    // helper: ruft inner mit korrekt abgeleiteter library auf, damit die
    // bestehenden tests nicht jeden library-pfad selbst berechnen müssen.
    fn call_inner(canonical: &std::path::Path) -> Result<String, String> {
        let lib = std::path::PathBuf::from(
            library_of(&canonical.to_string_lossy()).map_err(|e| e.to_string())?,
        );
        remove_orphan_dir_inner(canonical, &lib, &|_| true)
    }

    #[test]
    fn compatdata_orphan_wird_in_trash_verschoben() {
        let root = orphan_fixture("compat-trash");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/12345");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_ok(), "sollte klappen: {res:?}");
        assert!(res.unwrap().contains("trashed"));
        assert!(!compat.exists(), "quelle muss weg sein");

        let trash = lib.join("steamapps/.protium-trash");
        assert!(trash.is_dir(), ".protium-trash muss angelegt sein");
        let entries: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("compatdata_12345_")
            })
            .collect();
        assert_eq!(entries.len(), 1, "genau ein trash-eintrag für 12345");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shadercache_orphan_wird_hard_deleted() {
        let root = orphan_fixture("shadercache-del");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/67890");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert_eq!(res.as_deref(), Ok("deleted"));
        assert!(!cache.exists(), "shadercache muss weg sein");

        // KEIN trash-eintrag (nur compatdata wird getrasht)
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            "shadercache darf keinen trash-ordner anlegen"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_als_ziel_wird_abgelehnt() {
        // defense-in-depth: der command-wrapper lehnt bereits in
        // validate_and_prepare ab, aber inner soll auch direkte aufrufer
        // schützen (z. b. tests, zukünftige code-pfade). canonicalize wurde
        // hier absichtlich übersprungen, damit symlink_metadata den symlink
        // selbst sieht (sonst folgt canonicalize und der guard wäre tot).
        let root = orphan_fixture("symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let lib_path = std::path::PathBuf::from(library_of(&link.to_string_lossy()).unwrap());
        let res = remove_orphan_dir_inner(&link, &lib_path, &|_| true);
        assert!(res.is_err(), "symlink muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pfad_ohne_steamapps_anker_wird_abgelehnt() {
        let root = orphan_fixture("no-anchor");
        let random = root.join("lib/some/other/dir");
        touch(&random);

        let canonical = std::fs::canonicalize(&random).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "ohne /steamapps/ muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("/steamapps/"),
            "fehler soll den marker nennen: {:?}",
            res
        );
        assert!(random.exists(), "verzeichnis darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nichtnumerische_appid_wird_abgelehnt() {
        let root = orphan_fixture("nonnumeric");
        let lib = root.join("lib");
        let bad = lib.join("steamapps/compatdata/foo");
        touch(&bad);

        let canonical = std::fs::canonicalize(&bad).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "nicht-numerische appid muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("non-numeric"));
        assert!(bad.exists(), "quelle darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // defense-in-depth: JS-seitiges findOrphans filtert appId 0 bereits, aber
    // ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht zum
    // löschen / trash-renamen eines 0-verzeichnisses führen. 0 ist in steam
    // reserviert (kein spiel) und darf nie ein löschkandidat sein.
    #[test]
    fn appid_zero_compatdata_wird_abgelehnt() {
        let root = orphan_fixture("zero-compat");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/0");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "compatdata/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(compat.exists(), "compatdata/0 darf nicht gelöscht werden");
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            ".protium-trash darf für appId 0 NICHT angelegt werden"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn appid_zero_shadercache_wird_abgelehnt() {
        let root = orphan_fixture("zero-shader");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/0");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "shadercache/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(cache.exists(), "shadercache/0 darf nicht gelöscht werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn doppelter_steamapps_anker_bleibt_innerhalb_des_scopes() {
        // /tmp/.../lib/steamapps/compatdata/123/steamapps/compatdata/456
        // rfind("/steamapps/") findet den letzten anker → library wird zu
        // /tmp/.../lib/steamapps/compatdata/123. das ist INNERHALB des inputs.
        // akzeptiert: erfolgreich (in trash) ODER reject.
        // nicht akzeptabel: ein delete der outer (lib/steamapps/compatdata/123) zerstört.
        let root = orphan_fixture("double-anchor");
        let lib = root.join("lib");
        let outer = lib.join("steamapps/compatdata/123");
        let inner = outer.join("steamapps/compatdata/456");
        touch(&inner);
        // marker in outer, um zu prüfen dass outer nicht gelöscht wird
        std::fs::write(outer.join("keep"), b"important").unwrap();

        let canonical = std::fs::canonicalize(&inner).unwrap();
        let res = call_inner(&canonical);

        // outer (lib + steamapps + compatdata/123) muss IMMER noch existieren
        assert!(outer.exists(), "outer darf nicht gelöscht werden");
        assert!(outer.join("keep").exists(), "marker in outer muss bleiben");
        assert!(lib.exists(), "library-root muss bleiben");
        assert!(lib.join("steamapps").exists(), "steamapps muss bleiben");

        match res {
            Ok(msg) => {
                assert!(msg.contains("trashed"));
                assert!(!inner.exists());
            }
            Err(_) => {
                // reject ist auch ok, solange nichts zerstört wurde
                assert!(inner.exists(), "bei reject: inner muss noch da sein");
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    // validate_and_prepare: testbare wrapper-kette (sanitize + symlink-guard
    // auf roh-input + canonicalize + library-derive). symlink-guard auf dem
    // nicht-kanonisierten input ist nötig, weil canonicalize symlinks folgt
    // und der nachgelagerte symlink-check in inner dann effektiv tot wäre.
    #[test]
    fn validate_and_prepare_lehnt_symlink_auf_roh_input_ab() {
        let root = orphan_fixture("raw-symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let res = validate_and_prepare(link.to_str().unwrap());
        assert!(res.is_err(), "symlink auf roh-input muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- remove_trash_entry ----
    // selbes tempdir-muster wie remove_orphan_dir.
    // tests prüfen remove_trash_entry_inner — die komplette validierungs- und
    // löschkette (der async-command darüber ist nur spawn_blocking).

    use super::remove_trash_entry_inner;

    fn trash_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("trash", tag)
    }

    #[test]
    fn gueltiger_eintrag_wird_geloescht() {
        let root = trash_fixture("valid");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1091500_1753372800123");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join("marker"), b"x").unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert_eq!(res.as_deref(), Ok("deleted"));
        assert!(!entry.exists(), "eintrag muss gelöscht sein");
        // trash-verzeichnis selbst darf stehen bleiben (enthält evtl. andere einträge)
        assert!(trash.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pfad_mit_dotdot_wird_abgelehnt() {
        let root = trash_fixture("dotdot");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1_2");
        std::fs::create_dir_all(&entry).unwrap();

        // konstruiere einen pfad mit .., der auf den eintrag zeigt
        let tricky = trash.join("../.protium-trash/compatdata_1_2");
        let res = remove_trash_entry_inner(&tricky.to_string_lossy(), &|_| true);
        assert!(res.is_err(), ".. muss abgelehnt werden");
        assert!(entry.exists(), "ziel darf nicht gelöscht worden sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_statt_verzeichnis_wird_abgelehnt() {
        let root = trash_fixture("symlink");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        std::fs::create_dir_all(&trash).unwrap();
        let target = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(target.join("42")).unwrap();
        let link = trash.join("compatdata_42_100");
        unixfs::symlink(&target.join("42"), &link).unwrap();

        let res = remove_trash_entry_inner(&link.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "symlink muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.join("42").exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn eintrag_ausserhalb_protium_trash_wird_abgelehnt() {
        let root = trash_fixture("outside");
        let lib = root.join("lib");
        let dir = lib.join("steamapps/compatdata/42");
        std::fs::create_dir_all(&dir).unwrap();

        let res = remove_trash_entry_inner(&dir.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "pfad nicht in .protium-trash muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains(".protium-trash"));
        assert!(dir.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn name_ohne_timestamp_wird_abgelehnt() {
        let root = trash_fixture("no-ts");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1091500");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "ohne timestamp muss abgelehnt werden");
        assert!(entry.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn appid_zero_wird_abgelehnt() {
        let root = trash_fixture("zero");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_0_123");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "appId 0 muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("appId 0"));
        assert!(entry.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tiefer_pfad_mit_zweitem_slash_wird_abgelehnt() {
        let root = trash_fixture("deep");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let deep = trash.join("compatdata_1_2/pfx");
        std::fs::create_dir_all(&deep).unwrap();

        let res = remove_trash_entry_inner(&deep.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "tiefer pfad mit / muss abgelehnt werden");
        assert!(deep.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn steamapps_im_library_namen_rfind_nimmt_letztes_vorkommen() {
        let root = trash_fixture("rfind");
        // /tmp/.../lib/steamapps-alt/steamapps/.protium-trash/compatdata_1_2
        let lib = root.join("lib");
        let nested = lib.join("steamapps-alt/steamapps/.protium-trash");
        let entry = nested.join("compatdata_1_2");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_ok(), "rfind muss das letzte /steamapps/ nehmen: {res:?}");
        assert!(!entry.exists(), "eintrag muss gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- lösch-scope-gates (S5: nur session-bestätigte libraries) ----

    #[test]
    fn remove_orphan_unscoped_library_abgelehnt() {
        let root = orphan_fixture("orphan-noscope");
        let lib = root.join("lib");
        let target = lib.join("steamapps").join("shadercache").join("12345");
        touch(&target);

        let canonical = std::fs::canonicalize(&target).unwrap();
        let res = remove_orphan_dir_inner(&canonical, &lib, &|_| false);
        assert!(res.is_err(), "unscoped library muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(target.join("marker").is_file(), "nichts darf gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_trash_unscoped_library_abgelehnt() {
        let root = orphan_fixture("trash-noscope");
        let lib = root.join("lib");
        let entry = lib
            .join("steamapps")
            .join(".protium-trash")
            .join("compatdata_12345_1700000000000");
        touch(&entry);

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| false);
        assert!(res.is_err(), "unscoped library muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(entry.join("marker").is_file(), "nichts darf gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- write-gate (M3.1: INV-1 in rust) ----

    use super::{is_steam_config_path, write_steam_file_inner};

    fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }

    // baut $TMP/fakehome/.local/share/Steam/... und $TMP/cache (backup-dir)
    fn wsg_env(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let home = root.join("fakehome");
        let steam = home.join(".local/share/Steam");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
        std::fs::write(steam.join("config/config.vdf"), "alt-config").unwrap();
        std::fs::write(steam.join("userdata/123/config/localconfig.vdf"), "alt-local").unwrap();
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        (home, cache, steam)
    }

    #[test]
    fn write_gate_steam_laeuft_abgelehnt() {
        let (home, cache, steam) = wsg_env("running");
        let target = steam.join("config/config.vdf");
        let backup = cache.join("backups/1.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "alt-config",
            "neu",
            backup.to_str().unwrap(),
            &cache,
            &home,
            true,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt-config");
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_happy_backup_und_atomarer_write() {
        let (home, cache, steam) = wsg_env("happy");
        let target = steam.join("config/config.vdf");
        let backup = cache.join("backups/1.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "alt-config",
            "neu",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "alt-config");
        // kein temp-rest im ziel-verzeichnis
        let rest: Vec<_> = std::fs::read_dir(steam.join("config"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with('.'))
            .collect();
        assert!(rest.is_empty(), "temp-rest: {rest:?}");
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_userdata_localconfig_ok() {
        let (home, cache, steam) = wsg_env("userdata");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let backup = cache.join("backups/2.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "alt-local",
            "neu-local",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "neu-local"
        );
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_fremde_datei_abgelehnt() {
        let (home, cache, steam) = wsg_env("fremd");
        let target = steam.join("config/fremd.vdf");
        std::fs::write(&target, "x").unwrap();
        let backup = cache.join("b.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "x",
            "y",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not a steam config file"));
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_fremder_root_abgelehnt() {
        let (home, cache, _steam) = wsg_env("fremdroot");
        let target = home.join(".local/share/Other/config/config.vdf");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "x").unwrap();
        let backup = cache.join("b.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "x",
            "y",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not a steam config file"));
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_fehlende_zieldatei_abgelehnt() {
        let (home, cache, steam) = wsg_env("fehlt");
        let target = steam.join("config/config.vdf"); // existiert nicht (fixture schreibt sie — hier: löschen)
        std::fs::remove_file(&target).unwrap();
        let backup = cache.join("b.vdf");
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "x",
            "y",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_err(), "fail-closed bei fehlender zieldatei: {res:?}");
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    #[test]
    fn write_gate_backup_ausserhalb_appcache_abgelehnt() {
        let (home, cache, steam) = wsg_env("backupweg");
        let target = steam.join("config/config.vdf");
        let backup = home.join("böse-backup.vdf"); // außerhalb cache
        let res = write_steam_file_inner(
            target.to_str().unwrap(),
            "alt-config",
            "neu",
            backup.to_str().unwrap(),
            &cache,
            &home,
            false,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("backup outside app cache"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt-config");
        let _ = std::fs::remove_dir_all(&home.parent().unwrap());
    }

    // ---- remove_compat_tool (M3.4) ----

    use super::remove_compat_tool_inner;

    #[test]
    fn remove_tool_happy_löscht_tool_dir() {
        let root = wsg_fixture("rmtool-happy");
        let steam = root.join("steam");
        let tool = steam.join("compatibilitytools.d/GE-Proton9-27");
        std::fs::create_dir_all(&tool).unwrap();
        std::fs::write(tool.join("file"), "x").unwrap();

        let res = remove_compat_tool_inner(steam.to_str().unwrap(), "GE-Proton9-27", &|_| true);
        assert!(res.is_ok(), "{res:?}");
        assert!(!tool.exists(), "tool muss gelöscht sein");
        assert!(steam.join("compatibilitytools.d").is_dir(), "basis bleibt");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_tool_invalid_name_abgelehnt() {
        let root = wsg_fixture("rmtool-invalid");
        let steam = root.join("steam");
        std::fs::create_dir_all(&steam).unwrap();

        for bad in ["a/b", "..", ".", ""] {
            let res = remove_compat_tool_inner(steam.to_str().unwrap(), bad, &|_| true);
            assert!(res.is_err(), "tool_name {bad:?} muss abgelehnt werden");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_tool_symlink_abgelehnt() {
        let root = wsg_fixture("rmtool-symlink");
        let steam = root.join("steam");
        let tools = steam.join("compatibilitytools.d");
        std::fs::create_dir_all(&tools).unwrap();
        let real = root.join("echt");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, tools.join("evil")).unwrap();

        let res = remove_compat_tool_inner(steam.to_str().unwrap(), "evil", &|_| true);
        assert!(res.is_err(), "symlink-tool muss abgelehnt werden: {res:?}");
        assert!(real.is_dir(), "ziel des symlinks bleibt");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_tool_unscoped_root_abgelehnt() {
        let root = wsg_fixture("rmtool-noscope");
        let steam = root.join("steam");
        let tool = steam.join("compatibilitytools.d/GE-Proton9-27");
        std::fs::create_dir_all(&tool).unwrap();

        let res = remove_compat_tool_inner(steam.to_str().unwrap(), "GE-Proton9-27", &|_| false);
        assert!(res.is_err(), "unscoped root muss abgelehnt werden: {res:?}");
        assert!(tool.is_dir(), "nichts gelöscht");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_gate_muster_erkennung_flatpak_und_snap() {
        let root = wsg_fixture("muster");
        let home = root.join("fakehome");
        let flatpak = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam/config/config.vdf");
        let snap = home.join("snap/steam/common/.local/share/Steam/config/config.vdf");
        assert!(is_steam_config_path(&flatpak, &home));
        assert!(is_steam_config_path(&snap, &home));
        assert!(!is_steam_config_path(&home.join("etc/evil"), &home));
        // userdata mit nicht-numerischem ordner → abgelehnt
        assert!(!is_steam_config_path(
            &home.join(".local/share/Steam/userdata/abc/config/localconfig.vdf"),
            &home
        ));
        let _ = std::fs::remove_dir_all(&root);
    }
}
