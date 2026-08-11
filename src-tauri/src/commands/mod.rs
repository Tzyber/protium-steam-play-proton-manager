// rust-commands (R-1..R-6): das, was die webview nicht kann.

pub(crate) mod external;
pub(crate) mod path;

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
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha512};
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;
use tokio::io::AsyncWriteExt;
use crate::commands::path::{
    canonicalize_nearest_ancestor, canonicalize_no_symlink, canonicalize_safe,
    ensure_dest_within_canon_dir, is_safe_path, link_target_stays_inside, random_suffix,
    sanitize_path, validate_download_dest,
};

/// initiale download-URL: https + github.com + pfad-pinning auf das GE-repo.
/// ohne das pinning wäre jede github.com-url ein download-ziel (cache-poisoning
/// → beliebiger payload → extraktion → code-execution). redirect-ziele prüft
/// `validate_redirect_url` — ein github.com-redirect wäre ein offener umweg.
fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid download URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only HTTPS URLs allowed for downloads".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".into());
    }
    let host = parsed.host_str().ok_or_else(|| "download URL has no host".to_string())?;
    if host.to_ascii_lowercase() != "github.com" {
        return Err(format!("download URL host not allowed: {host}"));
    }

    // pfad-pinning: GE hostet seine assets selbst; ein anderer github-pfad ist
    // für protium nie legitim (browser_download_url ist immer diese form)
    const GE_PREFIX: [&str; 4] = ["GloriousEggroll", "proton-ge-custom", "releases", "download"];
    let mut comps = parsed.path().split('/').filter(|c| !c.is_empty());
    for expected in GE_PREFIX {
        match comps.next() {
            Some(c) if c == expected => {}
            _ => {
                return Err(
                    "download URL outside GloriousEggroll/proton-ge-custom/releases/download"
                        .into(),
                )
            }
        }
    }
    Ok(())
}

/// redirect-ziele: nur die zwei asset-CDN-hosts, host-only (redirect-pfade sind
/// nicht steuerbar). github.com als redirect-ziel ausgeschlossen — sonst wäre
/// das pfad-pinning über einen redirect umgehbar.
fn validate_redirect_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid redirect URL: {e}"))?;
    let host = parsed.host_str().ok_or_else(|| "redirect URL has no host".to_string())?;
    let host = host.to_ascii_lowercase();
    if host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com" {
        Ok(())
    } else {
        Err(format!("redirect target host not allowed: {host}"))
    }
}

/// je download-id ein Arc<AtomicBool>. download_file legt ein frisches Arc an
/// und ersetzt ein etwaiges altes. cancel_download setzt das flag im aktuell
/// registrierten Arc. am ende wird der eintrag nur entfernt, wenn noch genau
/// das eigene Arc dort liegt (ptr_eq) — so läuft ein zu spät eintreffender
/// cancel ins leere, statt eine leiche zu erzeugen.
#[derive(Default)]
pub struct CancelRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

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

fn extract_blocking(
    src: &str,
    dest_dir: &str,
    max_unpack_bytes: u64,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::io::Seek;
    use tar::Archive;

    let dest = Path::new(dest_dir);
    // scope-check VOR create_dir_all — kein mkdir vor der ablehnung. für
    // nicht-existierende dests prüft der nächste existierende vorfahre.
    let dest_ancestor_canon = canonicalize_nearest_ancestor(dest, "extract dest")?;
    if !scope_ok(&dest_ancestor_canon) {
        return Err("extract destination outside allowed scope".into());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(dest).map_err(|e| e.to_string())?;
    if !canon.is_dir() || !is_safe_path(&canon.to_string_lossy()) {
        return Err("extract destination in blocked location".into());
    }

    let src_path = Path::new(src);
    let src_canon = fs::canonicalize(src_path).map_err(|e| format!("extract source canonicalize: {e}"))?;
    if !is_safe_path(&src_canon.to_string_lossy()) {
        return Err("extract source in blocked location".into());
    }
    if !src_canon.is_file() {
        return Err("extract source not a regular file".into());
    }

    // unpredictable temp name (pid + nanos) → kein race auf statischen pfad
    let tag = format!(".protium-extract-{}-{}", std::process::id(), random_suffix());
    let tmp = dest.join(&tag);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // symlink-guard: temp-dir darf selbst kein symlink sein (TOCTOU absicherung)
    if fs::symlink_metadata(&tmp)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        let _ = fs::remove_dir_all(&tmp);
        return Err("temp dir is symlink — extraction aborted".into());
    }

    let result = (|| -> Result<(), String> {
        // pre-check: tar-crate legt block-devices, fifos und char-devices auf
        // linux fall-back als reguläre dateien ab (mknod fehlt ohne CAP_MKNOD,
        // tar fällt auf "treat as regular file" zurück). unsere post-unpack
        // filterung (is_file() || is_dir()) würde sie dann durchlassen. der
        // tar-entry-type ist also die einzige zuverlässige quelle für die
        // entscheidung "ist das ein device?".
        //
        // erlaubt: Regular, Directory, Link (hardlinks — link-target muss
        // innerhalb des archives zeigen, sonst pfad-traversal-leck) und
        // Symlink (legitime lib-versionslinks in GE-tarballs — ausbruch wird
        // lexikalisch via link_target_stays_inside geprüft statt pauschal
        // verboten). alles andere (Block, Char, Fifo, Continuous) wird
        // abgelehnt.
        //
        // post-unpack-filter bleibt als defense-in-depth, ist aber nicht
        // mehr die primäre schutzlinie (filter iteriert nur top-level, ein
        // subdir mit bad entry würde ungeprüft durchkommen).
        // datei EINMAL auf dem kanonischen pfad öffnen — kein TOCTOU
        let f = fs::File::open(&src_canon).map_err(|e| e.to_string())?;
        let mut f2 = f.try_clone().map_err(|e| e.to_string())?;
        {
            let mut ar = Archive::new(GzDecoder::new(f));
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let typ = entry.header().entry_type();
                match typ {
                    tar::EntryType::Regular | tar::EntryType::Directory => {}
                    tar::EntryType::Link => {
                        // hardlink-target muss innerhalb des archives sein.
                        // ein absoluter target oder .. würde aus dem unpack-root
                        // ausbrechen — und da der post-unpack-filter nur top-level
                        // iteriert, würde so ein hardlink in einem subdir ungeprüft
                        // durchkommen. pre-check ist die einzige zuverlässige
                        // schutzlinie für hardlinks.
                        let link_name = entry.link_name().map_err(|e| e.to_string())?;
                        match link_name {
                            None => return Err("hardlink ohne link-target".into()),
                            Some(target) => {
                                if target.as_os_str().is_empty() {
                                    return Err("hardlink-target ist leer".into());
                                }
                                if target.is_absolute() {
                                    return Err(format!(
                                        "hardlink-target ist absolut: {}",
                                        target.display()
                                    ));
                                }
                                if target.components().any(|c| {
                                    matches!(c, std::path::Component::ParentDir)
                                }) {
                                    return Err(format!(
                                        "hardlink-target enthält ..: {}",
                                        target.display()
                                    ));
                                }
                            }
                        }
                    }
                    tar::EntryType::Symlink => {
                        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
                        if path.is_absolute()
                            || path.components().any(|c| matches!(c, std::path::Component::ParentDir))
                        {
                            return Err(format!("symlink-eintragspfad ungültig: {}", path.display()));
                        }
                        let target = entry
                            .link_name()
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| "symlink ohne link-target".to_string())?
                            .into_owned();
                        if target.as_os_str().is_empty() {
                            return Err("symlink-target ist leer".into());
                        }
                        let base = path.parent().unwrap_or_else(|| Path::new(""));
                        if !link_target_stays_inside(base, &target) {
                            return Err(format!(
                                "symlink-target verlässt das archiv: {} -> {}",
                                path.display(),
                                target.display()
                            ));
                        }
                    }
                    _ => {
                        return Err(format!(
                            "tar enthält unerwarteten eintragstyp: {typ:?} (path: {:?})",
                            entry.path()
                        ));
                    }
                }
            }
        }
        // try_clone teilt den file-offset mit dem original — vor dem zweiten
        // durchlauf explizit zurücksetzen. unpack läuft manuell statt
        // ar.unpack: nur so lässt sich ein größenlimit über die deklarierten
        // entry-größen summiert durchsetzen (gzip-bomb-schutz, M1.4).
        f2.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut ar = Archive::new(GzDecoder::new(f2));
        let mut total: u64 = 0;
        for entry in ar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let entry_size = entry.header().size().map_err(|e| e.to_string())?;
            total += entry_size;
            if total > max_unpack_bytes {
                return Err(format!(
                    "extracted size limit exceeded ({total} bytes)"
                ));
            }
            entry.unpack_in(&tmp).map_err(|e| e.to_string())?;
        }
        for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            // defense-in-depth: post-unpack-filter fängt nochmal alles ab,
            // was kein file und kein dir ist (z. b. symlinks, falls tar-crate
            // sie doch mal preserved). pre-check oben ist die primäre schutzlinie.
            if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
                let _ = fs::remove_file(entry.path());
                continue;
            }
            let target = dest.join(entry.file_name());
            if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            fs::rename(entry.path(), &target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let _ = fs::remove_dir_all(&tmp);
    result
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

fn dir_size_inner(path: &str) -> Result<u64, String> {
    let real = canonicalize_safe(path, "dir_size")?;
    Ok(dir_size_impl(&real))
}

fn dir_size_impl(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => total += dir_size_impl(&entry.path()),
                Ok(ft) if ft.is_file() => {
                    if let Ok(md) = entry.metadata() {
                        total += md.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// R-3b: batch-version — sequentiell (IO-bound, kein rayon).
/// async + spawn_blocking: walkt GB-große bäume, gehört nicht auf den main-thread.
#[tauri::command]
pub async fn batch_dir_sizes(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    spawn_blocking_io(move || batch_dir_sizes_inner(paths)).await
}

fn batch_dir_sizes_inner(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    let mut map = HashMap::new();
    for p in paths {
        sanitize_path(&p, "batch_dir_sizes")?;
        let real = match fs::canonicalize(&p) {
            Ok(r) => r,
            // race: pfad ist zwischen findOrphans und diesem aufruf weg
            // (z. b. externer filemanager, parallel steam-update). nicht
            // fatal: restliche größen liefern, frontend zeigt für den
            // eintrag 0 / unbekannt an. andere canonicalize-fehler
            // (PermissionDenied, InvalidInput, IO, symlink-schleife) und
            // alle validierungs-/blocklist-fehler propagieren weiterhin.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if !is_safe_path(&real.to_string_lossy()) {
            return Err(format!("blocked path: {p}"));
        }
        map.insert(p, dir_size_impl(&real));
    }
    Ok(map)
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

/// extrahiert das library-verzeichnis (alles vor dem letzten "/steamapps/").
/// `rfind` ist sicher, weil das folgende muster-check die echte anwendung garantiert.
fn library_of(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[..idx])
}

/// alles nach dem letzten "/steamapps/". gibt None wenn der marker fehlt.
fn suffix_after_steamapps(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[idx + marker.len()..])
}

/// gemeinsame typ/appId-validierung der beiden lösch-pfade (orphan + trash):
/// typ ∈ {compatdata, shadercache}, ascii-digits, appId ≠ 0. das split
/// selbst bleibt an den stellen (orphan: '/', trash: '_' nach
/// marker/timestamp-parse — unterschiedliche fehlermeldungen).
fn parse_compat_id<'a>(pair: (&'a str, &'a str)) -> Result<(&'a str, &'a str), String> {
    let (typ, app_id_str) = pair;
    if typ != "compatdata" && typ != "shadercache" {
        return Err(format!("unexpected type: {typ}"));
    }
    if app_id_str.is_empty() || !app_id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric appId: {app_id_str}"));
    }
    // defense-in-depth: das JS-seitige findOrphans filtert appId 0 bereits,
    // aber ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht
    // stillschweigend zum löschen / trash-renamen eines 0-verzeichnisses
    // führen. 0 ist in steam reserviert (kein spiel) und darf nie ein
    // löschkandidat sein.
    if app_id_str == "0" {
        return Err("appId 0 rejected".into());
    }
    Ok((typ, app_id_str))
}

fn allow_library_scope_inner(app: AppHandle, path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("library path is not a directory".into());
    }
    let real = fs::canonicalize(path).map_err(|e| format!("cannot resolve: {e}"))?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err("library path blocked".into());
    }
    let _ = app.fs_scope().allow_directory(real.to_string_lossy().as_ref(), true);
    Ok(())
}

/// maximale download-grösse (GE-tarballs ~1 GB, 8 GiB ist reichlich luft).
const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// download-kern ohne tauri-typen (cargo-testbar). crash-fest: jeder fehlerausgang
/// (cancel, netzabbruch, schreibfehler) löscht die partielle datei vor return.
/// `max_bytes` steuert das grössenlimit (produktion: MAX_DOWNLOAD_BYTES, tests: kleiner).
async fn download_stream(
    url: &str,
    dest: &str,
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
    max_bytes: u64,
) -> Result<String, String> {
    let result: Result<String, String> = async {
        const MAX_REDIRECTS: usize = 5;

        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            if redirect_ok(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.error("redirect target not allowed")
            }
        });
        let client = reqwest::Client::builder()
            .redirect(policy)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        // content-length-prüfung (server kann lügen, also zählt der streaming-loop
        // zusätzlich die tatsächlich geschriebenen bytes mit)
        if let Some(len) = resp.content_length() {
            if len > max_bytes {
                return Err("content-length exceeds download size limit".into());
            }
        }

        if let Some(parent) = Path::new(dest).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| e.to_string())?;
        let mut hasher = Sha512::new();
        let content_length = resp.content_length();
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();

        // stall-erkennung: jede next()-poll darf max. 120 s brauchen
        const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

        loop {
            let chunk = tokio::time::timeout(STALL_TIMEOUT, stream.next())
                .await
                .map_err(|_| "download stalled".to_string())?;
            match chunk {
                None => break,
                Some(chunk) => {
                    if is_cancelled() {
                        return Err("cancelled".into());
                    }
                    let chunk = chunk.map_err(|e| e.to_string())?;

                    downloaded += chunk.len() as u64;
                    if downloaded > max_bytes {
                        return Err("download size limit exceeded".into());
                    }

                    hasher.update(&chunk);
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    on_progress(downloaded, content_length);
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>())
    }
    .await;

    // partielle datei bei fehler weg (vor return)
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

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

/// bekannte system-compat-dirs (distro-protonen, z. b. proton-cachyos).
/// ausnahme im library-kandidat-zwang, sonst verschwänden sie aus der UI.
const SYSTEM_COMPAT_DIRS: [&str; 2] = [
    "/usr/share/steam/compatibilitytools.d",
    "/usr/local/share/steam/compatibilitytools.d",
];

fn is_system_compat_dir(real: &Path) -> bool {
    SYSTEM_COMPAT_DIRS.iter().any(|d| {
        // input ist canonicalisiert — die konstante selbst kann ein symlink
        // sein (distros linken /usr/local/share/steam → /usr/share/steam)
        real == Path::new(d)
            || fs::canonicalize(d).map(|c| real == c.as_path()).unwrap_or(false)
    })
}

/// validierung + canonicalize für scope-erteilung (testbar, AppHandle-frei).
/// verlangt einen steam-library-kandidaten (`steamapps` existiert) oder ein
/// system-compat-dir — sonst scopt die webview beliebige verzeichnisse (/home).
fn validate_library_scope(path_str: &str) -> Result<std::path::PathBuf, String> {
    // spec-review 2026-08-03: der helper verschiebt die fehler-präzedenz —
    // blockierte nicht-dirs melden jetzt zuerst den blocklist-grund, dann
    // „not a directory" (akzeptanz-menge bleibt gleich).
    let real = canonicalize_safe(path_str, "library path")?;
    if !real.is_dir() {
        return Err("library path is not a directory".into());
    }
    if !real.join("steamapps").is_dir() && !is_system_compat_dir(&real) {
        return Err("library path is not a steam library or system compat dir".into());
    }
    Ok(real)
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

/// R-6: realpath + (dev,ino) zur library-dedup.
#[derive(Serialize)]
pub struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
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
    use super::download_stream;
    use super::{canonicalize_path, dir_size_inner, path_identity, validate_download_url,
    validate_library_scope, validate_redirect_url, MAX_DOWNLOAD_BYTES};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::os::unix::fs as unixfs;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    // S-01: dir_size lehnt blockierte/system-pfade ab
    #[test]
    fn dir_size_rejects_blocked_paths() {
        assert!(dir_size_inner("/etc").is_err());
        assert!(dir_size_inner("/proc").is_err());
        assert!(dir_size_inner("/sys").is_err());
        assert!(dir_size_inner("/dev").is_err());
    }

    #[test]
    fn dir_size_rejects_dotdot() {
        assert!(dir_size_inner("/home/../etc").is_err());
    }

    #[test]
    fn dir_size_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        assert!(dir_size_inner(&tmp.to_string_lossy()).is_ok());
        assert!(dir_size_inner("/tmp").is_ok());
    }

    // R-3b: batch_dir_sizes mit einem verschwundenen pfad (NotFound-Race)
    // darf den ganzen batch NICHT fehlschlagen lassen. ein einzelner
    // not-found wird übersprungen, der rest liefert normal. UI bekommt
    // für den fehlenden eintrag schlicht keinen map-eintrag (frontend
    // fällt auf 0 / unbekannt zurück).
    #[test]
    fn batch_dir_sizes_partial_failure_skips_missing_paths() {
        use super::batch_dir_sizes_inner;

        let mut root = std::env::temp_dir();
        root.push(format!("protium-batch-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // echter eintrag: 8 KB große datei → größe muss 8192 sein
        let real = root.join("compatdata/12345");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("payload"), vec![0u8; 8192]).unwrap();
        let real_canon = std::fs::canonicalize(&real).unwrap();

        // nicht-existenter eintrag: nur den pfad konstruieren, NICHT anlegen
        let missing = root.join("compatdata/99999_gone");

        let res = batch_dir_sizes_inner(vec![
            real_canon.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ]);
        assert!(
            res.is_ok(),
            "batch darf trotz missing-pfad nicht fehlschlagen: {res:?}"
        );
        let map = res.unwrap();
        assert_eq!(
            map.len(),
            1,
            "nur der echte pfad soll im map sein, ist: {:?}",
            map.keys().collect::<Vec<_>>()
        );
        assert_eq!(map[&real_canon.to_string_lossy().into_owned()], 8192);

        let _ = std::fs::remove_dir_all(&root);
    }

    // R-3b regression: andere canonicalize-fehler (nicht NotFound) und
    // validierungs-/blocklist-fehler müssen weiterhin propagieren.
    // ohne diese absicherung wäre die partial-failure-änderung eine
    // generische "alle fehler verschlucken"-lücke.
    #[test]
    fn batch_dir_sizes_propagates_blocked_path() {
        use super::batch_dir_sizes_inner;

        // /etc ist geblockt (is_safe_path). auch wenn ein gültiger pfad
        // vorne steht, schlägt der batch fehl sobald /etc drankommt.
        let tmp = std::env::temp_dir();
        let res = batch_dir_sizes_inner(vec![
            tmp.to_string_lossy().into_owned(),
            "/etc".to_string(),
        ]);
        assert!(res.is_err(), "blockierter pfad muss Err liefern");
        assert!(
            res.as_ref().unwrap_err().contains("blocked path"),
            "fehlermeldung soll den blocklist-grund nennen: {:?}",
            res
        );
    }

    // T-M-01: dir_size darf symlinks nicht folgen — sonst zählt ein symlink
    // auf ein riesiges verzeichnis dessen gesamten inhalt mit (DoS / falsche anzeige).
    // fixture liegt komplett unter /tmp, kein bezug auf /mnt oder systempfade.
    #[test]
    fn dir_size_skipped_symlinks() {
        let mut root = std::env::temp_dir();
        root.push(format!("protium-dirsymlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // echtes ziel: 5 MB große datei
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("big.bin"), vec![0u8; 5_000_000]).unwrap();

        // verzeichnis mit einem symlink der auf `real` zeigt
        let via = root.join("via-link");
        std::fs::create_dir_all(&via).unwrap();
        unixfs::symlink(&real, via.join("link-to-real")).unwrap();

        let res = dir_size_inner(&via.to_string_lossy()).unwrap();
        // ohne symlink-follow: nur die paar bytes des symlinks selbst (~50 bytes).
        // MIT symlink-follow: mindestens 5 MB.
        assert!(
            res < 1000,
            "symlink wurde gefolgt — dir_size={res} (sollte < 1000 sein)"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

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

    #[test]
    fn download_url_rejects_http() {
        assert!(validate_download_url("http://objects.githubusercontent.com/file.tar.gz").is_err());
        assert!(validate_download_url("HTTP://example.com/file").is_err());
    }

    #[test]
    fn download_url_rejects_credentials() {
        assert!(validate_download_url("https://user:pass@objects.githubusercontent.com/f").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com@evil.com/f").is_err());
    }

    #[test]
    fn download_url_rejects_other_domains() {
        assert!(validate_download_url("https://evil.com/payload.tar.gz").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com.evil.com/f").is_err());
    }

    #[test]
    fn download_url_allows_ge_release_path() {
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz").is_ok());
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz?x=1").is_ok());
    }

    #[test]
    fn download_url_pins_ge_repo_path() {
        // cache-poisoning-kette: jede github.com-url wäre sonst ein download-ziel
        assert!(validate_download_url("https://github.com/attacker/evil/releases/download/1/payload.tar.gz").is_err());
        assert!(validate_download_url("https://github.com/GloriousEggroll/other/releases/download/1/f.tar.gz").is_err());
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/archive/refs/tags/v1.tar.gz").is_err());
    }

    #[test]
    fn download_url_rejects_cdn_hosts_as_initial_url() {
        // CDN-hosts sind nur redirect-ziele, nie initiale URLs
        assert!(validate_download_url("https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz").is_err());
        assert!(validate_download_url("https://release-assets.githubusercontent.com/github-production-release-asset-2e/f.tar.gz?jwt=abc").is_err());
    }

    #[test]
    fn redirect_url_allows_cdn_hosts() {
        assert!(validate_redirect_url("https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz").is_ok());
        assert!(validate_redirect_url("https://release-assets.githubusercontent.com/x?jwt=abc@def").is_ok());
    }

    #[test]
    fn redirect_url_rejects_github_and_others() {
        // github.com als redirect-ziel wäre ein umweg um das pfad-pinning
        assert!(validate_redirect_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz").is_err());
        assert!(validate_redirect_url("https://evil.com/f").is_err());
    }

    #[test]
    fn download_url_rejects_no_host() {
        assert!(validate_download_url("https:///path").is_err());
    }

    // ---- download-stream redirect-policy tests ----

    /// HTTP-stub: kündigt `announce` bytes an, sendet nur `send`.
    /// send < announce simuliert einen netzabbruch (vorzeitiger EOF).
    fn serve_once(announce: usize, send: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf); // request ignorieren
                let header =
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {announce}\r\n\r\n");
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&vec![0xABu8; send]);
                // bei send < announce: stream wird hier gedroppt → client sieht EOF zu früh
            }
        });
        format!("http://{addr}/")
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-dltest-{tag}-{}", std::process::id()));
        p.push("file.bin");
        p
    }

    /// HTTP-stub mit redirects: baut eine kette von antworten auf.
    /// jeder eintrag = (status_code, location, body). der stub akzeptiert
    /// nacheinander verbindungen und serviert die antworten in der vorgegebenen
    /// reihenfolge. die URL wird erst beim bind ermittelt und per closure
    /// an die response-kette übergeben (chicken-egg-problem).
    fn serve_redirect_chain(f: impl FnOnce(String) -> Vec<(u16, Option<String>, Option<Vec<u8>>)>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}/");
        let chain = f(base.clone());
        std::thread::spawn(move || {
            for (status, location, body) in chain {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf);
                    let reason = if status == 302 { "Found" } else { "OK" };
                    let mut header = format!("HTTP/1.1 {status} {reason}\r\n");
                    if let Some(ref loc) = location {
                        header.push_str(&format!("Location: {}\r\n", loc));
                    }
                    if status == 302 {
                        header.push_str("Connection: close\r\n");
                    }
                    if let Some(ref b) = body {
                        header.push_str(&format!("Content-Length: {}\r\n", b.len()));
                    } else {
                        header.push_str("Content-Length: 0\r\n");
                    }
                    header.push_str("\r\n");
                    let _ = stream.write_all(header.as_bytes());
                    if let Some(ref b) = body {
                        let _ = stream.write_all(b);
                    }
                }
            }
        });
        base
    }

    #[tokio::test]
    async fn erfolg_berechnet_hash_und_behaelt_datei() {
        let dest = tmp("ok");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_ok(), "sollte erfolgreich sein: {res:?}");
        assert_eq!(res.unwrap().len(), 128); // sha512 hex = 128 zeichen
        assert!(dest.exists(), "erfolgsfall: datei muss bleiben");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn netzabbruch_raeumt_partielle_datei_auf() {
        let dest = tmp("net");
        let url = serve_once(1_000_000, 4096); // 1MB angekündigt, nur 4KB gesendet
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_err(), "vorzeitiger EOF muss fehler sein");
        assert!(!dest.exists(), "partielle datei muss weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn cancel_stoppt_und_raeumt_auf() {
        let dest = tmp("cancel");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(true); // sofort gesetzt → bricht beim ersten chunk ab
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert_eq!(res.unwrap_err(), "cancelled");
        assert!(!dest.exists(), "abbruch: keine datei zurücklassen");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    // ---- cancel-registry stale-flag tests (Arc<AtomicBool> + ptr_eq) ----

    #[test]
    fn cancel_registry_ptr_eq_entfernt_nur_eigenes_flag() {
        use super::CancelRegistry;

        let registry = CancelRegistry::default();

        // erstes Arc registrieren (simuliert download_file-start)
        let flag1 = Arc::new(AtomicBool::new(false));
        registry.0.lock().unwrap().insert("x".into(), Arc::clone(&flag1));

        // ptr_eq muss für eigenes Arc zutreffen
        assert!(
            registry.0.lock().unwrap().get("x")
                .map(|r| Arc::ptr_eq(r, &flag1))
                .unwrap_or(false),
            "eigenes Arc muss per ptr_eq matchen"
        );

        // cleanup: entfernen weil ptr_eq matched
        {
            let mut map = registry.0.lock().unwrap();
            let keep = map.get("x").map(|r| Arc::ptr_eq(r, &flag1)).unwrap_or(false);
            if keep {
                map.remove("x");
            }
        }
        assert!(registry.0.lock().unwrap().is_empty());

        // zweiter download: neues Arc (simuliert re-download)
        let flag2 = Arc::new(AtomicBool::new(false));
        registry.0.lock().unwrap().insert("x".into(), Arc::clone(&flag2));

        // altes flag1 darf NICHT mit dem neuen eintrag ptr_eq matchen
        let mismatch = registry.0.lock().unwrap().get("x")
            .map(|r| !Arc::ptr_eq(r, &flag1))
            .unwrap_or(false);
        assert!(mismatch, "altes Arc darf nicht auf neuen eintrag matchen");

        // neues flag muss frisch (false) sein — kein stale cancel
        assert!(!flag2.load(Ordering::Relaxed), "neues flag darf nicht vorbelastet sein");
    }

    #[tokio::test]
    async fn cancel_nach_abschluss_startet_zweiten_download_normal() {
        let dest1 = tmp("stale-1");
        let url1 = serve_once(32, 32);
        let cancel = AtomicBool::new(false);

        let res = download_stream(
            &url1,
            dest1.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_ok(), "erster download muss ok sein: {res:?}");
        let _ = std::fs::remove_dir_all(dest1.parent().unwrap());

        // simulate late cancel (nach abschluss) — cancel-flag bleibt false
        // (die registry hätte den eintrag bereits entfernt)

        // zweiter download mit anderer url startet normal
        let dest2 = tmp("stale-2");
        let url2 = serve_once(32, 32);
        let res2 = download_stream(
            &url2,
            dest2.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res2.is_ok(), "zweiter download muss normal starten: {res2:?}");
        let _ = std::fs::remove_dir_all(dest2.parent().unwrap());
    }

    // ---- download size-cap und stall-timeout ----

    #[tokio::test]
    async fn content_length_ueber_limit_wird_abgelehnt() {
        let dest = tmp("sizecap-cl");
        // stub kündigt 9999 bytes an → über dem test-limit von 100
        let url = serve_once(9999, 0);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            100, // kleines test-limit
        )
        .await;
        assert!(res.is_err(), "content-length über limit muss Err liefern: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("content-length"),
            "fehler soll content-length nennen: {res:?}"
        );
        assert!(!dest.exists(), "keine datei bei content-length-überschreitung");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn bytes_ueber_limit_raeumt_partielle_datei_auf() {
        let dest = tmp("sizecap-bytes");
        // stub kündigt 16 bytes an, sendet 32 — ohne content-length-check
        // greift der byte-counter im streaming-loop (limit = 8)
        let url = serve_once(16, 32);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            8, // kleines test-limit
        )
        .await;
        assert!(res.is_err(), "bytes über limit muss Err liefern: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("size limit"),
            "fehler soll size-limit nennen: {res:?}"
        );
        assert!(!dest.exists(), "partielle datei muss weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_erlaubt_folgt_302_und_liefert_inhalt() {
        let dest = tmp("redirect-ok");
        let body = vec![0xAB; 32];
        let url = serve_redirect_chain(|base| {
            vec![
                (302, Some(base.clone()), None),
                (200, None, Some(body.clone())),
            ]
        });
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |u| u.starts_with("http://127.0.0.1:"),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_ok(), "redirect zu eigenem stub muss durchlaufen: {res:?}");
        assert_eq!(res.unwrap().len(), 128);
        assert!(dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_auf_evil_host_wird_abgelehnt_und_raeumt_auf() {
        let dest = tmp("redirect-evil");
        let url = serve_redirect_chain(|_| {
            vec![
                (302, Some("https://evil.example/x".to_string()), None),
            ]
        });
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |u| u.starts_with("http://127.0.0.1:"),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_err(), "redirect zu evil-host muss abgelehnt werden: {res:?}");
        assert!(res.as_ref().unwrap_err().contains("redirect"));
        assert!(!dest.exists(), "partielle datei muss nach abbruch weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_schleife_bricht_nach_max_hops_ab() {
        let dest = tmp("redirect-loop");
        let url = serve_redirect_chain(|base| {
            vec![
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base), None),
            ]
        });
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_err(), "redirect-schleife muss abgebrochen werden: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("redirect"),
            "fehler soll redirect-bezogen sein: {res:?}"
        );
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    // ---- remove_orphan_dir (T-H-01) ----
    // gehärtete logik via remove_orphan_dir_inner (extrahiert, AppHandle-frei)
    // + validate_and_prepare (wrapper-kette, AppHandle-frei).
    // tests nutzen temp-fixtures unter /tmp; keine berührung von /mnt o. ä.

    use super::{library_of, remove_orphan_dir_inner, validate_and_prepare};

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

    // ---- extract_tarball (T-H-02) ----
    // die produktion entpackt github-release-tarballs (fremde, nicht-vertrauenswürdige
    // artefakte). die hier dokumentierten beschreibungen ("symlinks werden gefiltert",
    // "devices werden gefiltert", "kein path-traversal", "kein halbes ziel bei fehler")
    // waren bisher ungetestet. tests bauen tarballs programmatisch mit dem tar-crate,
    // rufen extract_blocking direkt (kein AppHandle, kein tokio).
    //
    // befund-basis (vor tests, durch code-lesen):
    // - post-unpack-filter iteriert nur top-level-eintraege (read_dir nicht rekursiv).
    //   subdirs werden als ganzes nach dest verschoben, ohne inhalt zu prüfen.
    //   *die hier geschriebenen tests zielen auf top-level-eintraege* — der subdir-befund
    //   ist ein separater punkt (siehe report).

    use super::extract_blocking;

    fn extract_dest(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-dest-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn extract_tarball<F>(tag: &str, populate: F) -> std::path::PathBuf
    where
        F: FnOnce(&mut tar::Builder<flate2::write::GzEncoder<&mut Vec<u8>>>),
    {
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            populate(&mut builder);
            builder.finish().unwrap();
        }
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-{tag}-{}", std::process::id()));
        std::fs::write(&p, &data).unwrap();
        p
    }

    fn extract_cleanup(tarball: &std::path::Path, dest: &std::path::Path) {
        let _ = std::fs::remove_file(tarball);
        let _ = std::fs::remove_dir_all(dest);
    }

    // helper: append_data setzt die size NICHT automatisch — der header
    // braucht sie vorher. ohne size kann das tar-archiv nicht gelesen werden
    // ("numeric field was not a number").
    fn make_data_header(path: &str, data: &[u8]) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_path(path).unwrap();
        h.set_size(data.len() as u64);
        h
    }

    #[test]
    fn happy_path_extrahiert_dateien_und_verzeichnisse() {
        let tarball = extract_tarball("happy", |b| {
            b.append_data(&mut make_data_header("file.txt", b"hello"), "file.txt", &b"hello"[..])
                .unwrap();
            b.append_data(
                &mut make_data_header("subdir/nested.txt", b"world"),
                "subdir/nested.txt",
                &b"world"[..],
            )
            .unwrap();
        });
        let dest = extract_dest("happy");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "extract sollte klappen: {res:?}");
        assert!(dest.join("file.txt").is_file(), "top-level-datei fehlt");
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "hello"
        );
        assert!(
            dest.join("subdir").is_dir(),
            "subdir fehlt: {:?}",
            std::fs::read_dir(&dest).unwrap().collect::<Vec<_>>()
        );
        assert!(
            dest.join("subdir/nested.txt").is_file(),
            "nested datei fehlt"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_absolutem_target_wird_abgelehnt() {
        // symlink auf absoluten pfad (/etc/passwd) muss via
        // link_target_stays_inside abgelehnt werden — target.is_absolute()
        // liefert false. der ganze extract wird abgebrochen, nichts im ziel.
        let tarball = extract_tarball("symlink", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Symlink);
            {
                let bytes = header.as_mut_bytes();
                let path = b"evil-link\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"/etc/passwd\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit symlink muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("evil-link")).is_err(),
            "evil-link darf nicht ins ziel"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_legitim_wird_extrahiert_und_bleibt_als_symlink() {
        let tarball = extract_tarball("symlink-legit", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut libdir_h = tar::Header::new_gnu();
            libdir_h.set_path("dir/lib").unwrap();
            libdir_h.set_entry_type(tar::EntryType::Directory);
            libdir_h.set_size(0);
            libdir_h.set_cksum();
            b.append(&libdir_h, std::io::empty()).unwrap();

            b.append_data(
                &mut make_data_header("dir/lib/libfoo.so.1.2.3", b"fake-lib"),
                "dir/lib/libfoo.so.1.2.3",
                &b"fake-lib"[..],
            )
            .unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/lib/libfoo.so.1").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"libfoo.so.1.2.3\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-legit");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "legitimer symlink muss durchlaufen: {res:?}");
        assert!(
            dest.join("dir/lib/libfoo.so.1.2.3").is_file(),
            "target-datei fehlt"
        );
        let md = std::fs::symlink_metadata(dest.join("dir/lib/libfoo.so.1")).unwrap();
        assert!(
            md.file_type().is_symlink(),
            "symlink muss als symlink im ziel sein"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_traversal_target_wird_abgelehnt() {
        let tarball = extract_tarball("symlink-traversal", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut libdir_h = tar::Header::new_gnu();
            libdir_h.set_path("dir/lib").unwrap();
            libdir_h.set_entry_type(tar::EntryType::Directory);
            libdir_h.set_size(0);
            libdir_h.set_cksum();
            b.append(&libdir_h, std::io::empty()).unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/lib/x").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"../../../../etc/passwd\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-traversal");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "symlink mit traversal-target muss abgelehnt werden: {res:?}");
        assert!(
            !dest.join("dir").exists(),
            "kein inhalt darf ins ziel bei abbruch"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_legitimen_parentdir_wird_extrahiert() {
        let tarball = extract_tarball("symlink-parent", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut a_h = tar::Header::new_gnu();
            a_h.set_path("dir/a").unwrap();
            a_h.set_entry_type(tar::EntryType::Directory);
            a_h.set_size(0);
            a_h.set_cksum();
            b.append(&a_h, std::io::empty()).unwrap();

            let mut bdir_h = tar::Header::new_gnu();
            bdir_h.set_path("dir/a/b").unwrap();
            bdir_h.set_entry_type(tar::EntryType::Directory);
            bdir_h.set_size(0);
            bdir_h.set_cksum();
            b.append(&bdir_h, std::io::empty()).unwrap();

            let mut c_h = tar::Header::new_gnu();
            c_h.set_path("dir/c").unwrap();
            c_h.set_entry_type(tar::EntryType::Directory);
            c_h.set_size(0);
            c_h.set_cksum();
            b.append(&c_h, std::io::empty()).unwrap();

            b.append_data(
                &mut make_data_header("dir/c/y", b"data"),
                "dir/c/y",
                &b"data"[..],
            )
            .unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/a/b/x").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"../c/y\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-parent");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "symlink mit legitimem parentdir muss durchlaufen: {res:?}");
        let md = std::fs::symlink_metadata(dest.join("dir/a/b/x")).unwrap();
        assert!(
            md.file_type().is_symlink(),
            "symlink mit legitimem .. muss im ziel sein"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn block_device_eintrag_wird_gefiltert() {
        // dokumentation: tar mit block-device-entry wird per pre-check
        // ABGELEHNT (Err). der tar ist suspect, der ganze extract wird
        // abgebrochen. das ist strenger als selektives skippen, aber
        // sicherer: ein tar mit einem device-entry hat dort nichts zu suchen.
        let tarball = extract_tarball("blockdev", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Block);
            {
                let bytes = header.as_mut_bytes();
                let path = b"blockdev\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("blockdev");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit block-device muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("blockdev")).is_err(),
            "block-device darf nicht ins ziel"
        );
        // ziel-dir selbst existiert, aber KEINE inhalte aus dem tar
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fifo_eintrag_wird_gefiltert() {
        // siehe block_device: pre-check lehnt den tar ab, dest bleibt leer.
        let tarball = extract_tarball("fifo", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Fifo);
            {
                let bytes = header.as_mut_bytes();
                let path = b"fifo\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("fifo");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit fifo muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("fifo")).is_err(),
            "fifo darf nicht ins ziel"
        );
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn path_traversal_escaped_nicht_in_tmp() {
        // KRITISCH: ein tar-eintrag mit "../"-pfad darf NIE ausserhalb von
        // dest landen. wir umgehen die `..`-validierung in `set_path` mit
        // `as_mut_bytes()` (ein angreifer könnte den tar mit einem anderen
        // tool bauen) und prüfen das beobachtbare ergebnis: /tmp/{filename}
        // darf NIE existieren.
        //
        // der pre-check lehnt den tar ab, sobald er einen eintrag mit bad
        // path findet — also nichts wird geschrieben.
        let escaped_filename = format!("protium-escape-{}.txt", std::process::id());
        let escaped_path = std::path::PathBuf::from("/tmp").join(&escaped_filename);
        let _ = std::fs::remove_file(&escaped_path);

        let malicious_path = format!("../../../../../../tmp/{escaped_filename}");
        let tarball = extract_tarball("traversal", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(8);
            {
                let bytes = header.as_mut_bytes();
                let path = malicious_path.as_bytes();
                for (i, b) in path.iter().enumerate() {
                    if i < 100 {
                        bytes[i] = *b;
                    }
                }
                for i in path.len()..100 {
                    bytes[i] = 0;
                }
            }
            header.set_cksum();
            b.append(&header, &b"escaped!"[..]).unwrap();
        });
        let dest = extract_dest("traversal");

        let _ = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);

        assert!(
            !escaped_path.exists(),
            "path-traversal ist gelungen: {} wurde geschrieben",
            escaped_path.display()
        );

        let _ = std::fs::remove_file(&escaped_path);
        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn hardlink_wird_wie_regulaere_datei_behandelt() {
        // dokumentation: hardlinks (EntryType::Link) sind im pre-check
        // erlaubt. ar.unpack erstellt sie als reguläre datei (oder hardlink,
        // je nach fs) im tmp-dir, und der post-unpack-filter lässt sie durch
        // (is_file() == true). sie landen im ziel — das ist das definierte
        // verhalten. tar-crate prüft, dass der link-target innerhalb des
        // archives existiert und nicht aus dem unpack-root ausbricht.
        let tarball = extract_tarball("hardlink", |b| {
            b.append_data(
                &mut make_data_header("original.txt", b"data"),
                "original.txt",
                &b"data"[..],
            )
            .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = header.as_mut_bytes();
                let path = b"hardlink-to-original\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"original.txt\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "hardlink sollte extrahiert werden: {res:?}");
        assert!(dest.join("original.txt").is_file(), "original.txt fehlt");
        // hardlink landet im ziel als reguläre datei mit gleichem inhalt
        let hl = dest.join("hardlink-to-original");
        assert!(hl.is_file(), "hardlink muss als file im ziel sein");
        assert_eq!(
            std::fs::read(&hl).unwrap(),
            b"data",
            "hardlink muss inhalt von original haben"
        );

        extract_cleanup(&tarball, &dest);
    }

    // hardlink-target-validierung: ein hardlink in einem subdir auf einen
    // pfad ausserhalb des archives würde vom post-unpack-filter nicht
    // erfasst (der filter iteriert nur top-level und folgt subdirs ungeprüft).
    // der pre-check fängt das ab, weil er link-target-pfade gegen absolute
    // pfade und `..` prüft — unabhängig von der entry-position.
    #[test]
    fn hardlink_in_subdir_auf_aussenhardlink_wird_abgelehnt() {
        // konkrete lage: tar mit subdir + hardlink `subdir/inner-hardlink`
        // dessen target = `../../etc/shadow` ist. ohne pre-check würde der
        // hardlink entpackt, das subdir (inkl. hardlink) per rename ins ziel
        // wandern, und der hardlink hätte ein link auf /etc/shadow. pre-check
        // lehnt den tar ab.
        let tarball = extract_tarball("subdir-hardlink", |b| {
            // subdir entry
            let mut dir_header = tar::Header::new_gnu();
            dir_header.set_size(0);
            dir_header.set_entry_type(tar::EntryType::Directory);
            {
                let bytes = dir_header.as_mut_bytes();
                let path = b"subdir\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            dir_header.set_cksum();
            b.append(&dir_header, std::io::empty()).unwrap();

            // hardlink im subdir, target ausserhalb archives
            let mut link_header = tar::Header::new_gnu();
            link_header.set_size(0);
            link_header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = link_header.as_mut_bytes();
                let path = b"subdir/inner-hardlink\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                // linkname (offset 157) = "../../etc/shadow"
                let target = b"../../etc/shadow\0";
                for (i, b) in target.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            link_header.set_cksum();
            b.append(&link_header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("subdir-hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(
            res.is_err(),
            "hardlink mit ..-target muss abgelehnt werden: {res:?}"
        );
        // weder subdir noch inner-hardlink im ziel
        assert!(
            !dest.join("subdir").exists(),
            "subdir darf nicht entpackt sein"
        );
        assert!(
            std::fs::symlink_metadata(dest.join("subdir/inner-hardlink")).is_err(),
            "inner-hardlink darf nicht entpackt sein"
        );
        // zieldir selbst existiert, aber leer
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fehler_beim_entpacken_laesst_kein_halbes_ziel() {
        // wir bauen einen gültigen tarball (zwei eintraege) und schneiden
        // ihn bei der hälfte ab. GzDecoder schlägt mid-stream fehl → ar.unpack
        // returnt Err → unser code verschiebt NICHTS ins ziel (rename läuft
        // erst NACH erfolgreichem unpack). das ziel muss nach dem aufruf leer sein.
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            builder
                .append_data(
                    &mut make_data_header("file1.txt", b"ok"),
                    "file1.txt",
                    &b"ok"[..],
                )
                .unwrap();
            builder
                .append_data(
                    &mut make_data_header("file2.txt", b"ok2"),
                    "file2.txt",
                    &b"ok2"[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }
        assert!(data.len() > 64, "tar.gz sollte nicht trivial klein sein");
        // gzip-stream in der mitte abschneiden → dekompression schlägt fehl
        let truncated = data[..data.len() / 2].to_vec();
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-truncated-{}", std::process::id()));
        std::fs::write(&p, &truncated).unwrap();
        let dest = extract_dest("truncated");

        let res = extract_blocking(p.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "korrupter tarball muss Err liefern: {res:?}");

        // KRITISCH: kein halbes verzeichnis im ziel. (das ziel-dir selbst
        // existiert, aber es darf KEINE datei drin sein, die aus dem tar stammt.)
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            entries.is_empty(),
            "ziel muss leer sein, enthält aber: {entries:?}"
        );
        // auch die interne temp-dir (".protium-extract-...") darf nicht übrig sein
        for name in &entries {
            assert!(
                !name.starts_with(".protium-extract-"),
                "temp-dir wurde nicht aufgeräumt: {name}"
            );
        }

        let _ = std::fs::remove_file(&p);
        extract_cleanup(&p, &dest);
    }

    #[test]
    fn blockierte_pfade_als_src_werden_abgelehnt() {
        // S-H-02: src muss canonicalize + is_safe_path durchlaufen,
        // nicht nur sanitize_path. /etc als tarball-source ist blockiert.
        let res = extract_blocking("/etc", "/tmp/protium-extract-blocked-src-test", MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "/etc darf nicht als tarball-source akzeptiert werden: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("blocked"),
            "fehlermeldung soll blockiert nennen: {:?}",
            res
        );
    }

    #[test]
    fn entpack_größenlimit_bricht_ab_und_räumt_auf() {
        let tarball = extract_tarball("limit", |b| {
            b.append_data(
                &mut make_data_header("big.bin", &[0u8; 512]),
                "big.bin",
                &[0u8; 512][..],
            )
            .unwrap();
        });
        let dest = extract_dest("limit");

        // cap kleiner als die deklarierte größe → abbruch vor dem unpack
        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), 100, &|_| true);
        assert!(res.is_err(), "limit muss abbrechen: {res:?}");
        assert!(
            res.unwrap_err().contains("limit exceeded"),
            "fehlermeldung soll limit nennen"
        );

        // kein halbes ziel, kein temp-dir-rest
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            entries.iter().all(|n| !n.starts_with(".protium-extract-")),
            "temp-dir nicht aufgeräumt: {entries:?}"
        );

        extract_cleanup(&tarball, &dest);
    }

    // ---- scope-erteilung (S4: library-kandidat-zwang) ----

    #[test]
    fn allow_scope_lehnt_home_ab() {
        // /home ist kein steam-library-kandidat und kein system-compat-dir
        let res = validate_library_scope("/home");
        assert!(res.is_err(), "/home darf nicht gescopt werden: {res:?}");
        assert!(res.unwrap_err().contains("steam library"));
    }

    #[test]
    fn allow_scope_akzeptiert_steamapps_kandidat() {
        let mut lib = std::env::temp_dir();
        lib.push(format!("protium-lib-scope-{}", std::process::id()));
        std::fs::create_dir_all(lib.join("steamapps")).unwrap();

        let res = validate_library_scope(lib.to_str().unwrap());
        assert!(res.is_ok(), "steamapps-kandidat muss akzeptiert werden: {res:?}");

        let _ = std::fs::remove_dir_all(&lib);
    }

    #[test]
    fn allow_scope_akzeptiert_system_compat_dir() {
        // systemabhängig: nur prüfen, wenn der distro-pfad existiert
        let d = Path::new("/usr/share/steam/compatibilitytools.d");
        if !d.exists() {
            return;
        }
        let res = validate_library_scope(d.to_str().unwrap());
        assert!(res.is_ok(), "system-compat-dir muss akzeptiert werden: {res:?}");
    }

    // ---- extract-dest-scope (S2: allowlist statt blocklist) ----

    #[test]
    fn extract_dest_ausserhalb_scope_abgelehnt_ohne_mkdir() {
        let mut dest = std::env::temp_dir();
        dest.push(format!("protium-extract-noscope-{}", std::process::id()));

        let res = extract_blocking("/etc", dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| false);
        assert!(res.is_err(), "unscoped dest muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(
            !dest.exists(),
            "kein mkdir vor der ablehnung — dest darf nicht entstehen"
        );
    }

    #[test]
    fn extract_dest_ancestor_im_scope_ok() {
        // dest existiert nicht, der parent ist im scope → der check greift auf
        // den nächsten existierenden vorfahren. der src-check (/etc, blockiert)
        // muss danach greifen — beweist, dass der dest-check bestanden wurde.
        let mut dest = std::env::temp_dir();
        dest.push(format!("protium-extract-ancestor-{}", std::process::id()));
        let canon = std::fs::canonicalize(std::env::temp_dir()).unwrap();

        let res = extract_blocking("/etc", dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|p| p == canon);
        assert!(res.is_err());
        assert!(
            res.unwrap_err().contains("blocked"),
            "src-check muss greifen (dest-check hat bestanden)"
        );
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn allow_scope_lehnt_steam_root_ohne_suffix_ab() {
        // /usr/share/steam (ohne compatibilitytools.d) ist kein kandidat
        let d = Path::new("/usr/share/steam");
        if !d.exists() {
            return;
        }
        let res = validate_library_scope(d.to_str().unwrap());
        assert!(res.is_err(), "/usr/share/steam ohne suffix darf nicht gescopt werden: {res:?}");
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
