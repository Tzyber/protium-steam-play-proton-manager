use crate::commands::path::{canonicalize_safe, is_safe_path, sanitize_path};
use crate::commands::spawn_blocking_io;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};

// Verzeichnisgrößen und Pfadidentität über `(dev, ino)`.

const MAX_BATCH_DIR_SIZE_PATHS: usize = 4096;

pub(super) fn dir_size_inner(path: &str) -> Result<u64, String> {
    let real = canonicalize_safe(path, "dir_size")?;
    Ok(dir_size_impl(&real))
}

fn dir_size_impl(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(rd) = fs::read_dir(dir) else {
            continue;
        };
        for entry in rd.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => pending.push(entry.path()),
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

pub(super) fn batch_dir_sizes_inner(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    if paths.len() > MAX_BATCH_DIR_SIZE_PATHS {
        return Err("too many paths for batch_dir_sizes".into());
    }
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

/// Kanonischer Pfad und `(dev, ino)` zur Library-Deduplizierung.
#[derive(Serialize)]
pub(crate) struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
}

/// Prüft ausschließlich den Prozessnamen `steam`.
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
    })
    .await
}

/// Berechnet die Größe eines Verzeichnisses.
/// async + spawn_blocking: der rekursive walk darf nicht auf dem main-thread laufen.
#[tauri::command]
pub async fn dir_size(path: String) -> Result<u64, String> {
    spawn_blocking_io(move || dir_size_inner(&path)).await
}

/// Berechnet Verzeichnisgrößen sequenziell; der Vorgang ist I/O-gebunden.
/// async + spawn_blocking: walkt GB-große bäume, gehört nicht auf den main-thread.
#[tauri::command]
pub async fn batch_dir_sizes(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
    spawn_blocking_io(move || batch_dir_sizes_inner(paths)).await
}

/// symlink-auflösung (steam-root-discovery). `..` im input abgelehnt,
/// auflösungen in blockierte dateisysteme verweigert (info-disclosure).
/// Nutzt `is_safe_path()` statt einer eigenen Blocklist.
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    let canonical = canonicalize_safe(&path, "canonicalize")?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// Liefert kanonischen Pfad und `(dev, ino)` zur Library-Deduplizierung.
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

#[cfg(test)]
mod tests {
    use super::dir_size_inner;
    use std::os::unix::fs as unixfs;

    // `dir_size` lehnt blockierte Systempfade ab.
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

    // Ein währenddessen verschwundener Pfad darf den gesamten Batch
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

    // Andere Canonicalize-Fehler als `NotFound` sowie
    // validierungs-/blocklist-fehler müssen weiterhin propagieren.
    // ohne diese absicherung wäre die partial-failure-änderung eine
    // generische "alle fehler verschlucken"-lücke.
    #[test]
    fn batch_dir_sizes_propagates_blocked_path() {
        use super::batch_dir_sizes_inner;

        // /etc ist geblockt (is_safe_path). auch wenn ein gültiger pfad
        // vorne steht, schlägt der batch fehl sobald /etc drankommt.
        let tmp = std::env::temp_dir();
        let res =
            batch_dir_sizes_inner(vec![tmp.to_string_lossy().into_owned(), "/etc".to_string()]);
        assert!(res.is_err(), "blockierter pfad muss Err liefern");
        assert!(
            res.as_ref().unwrap_err().contains("blocked path"),
            "fehlermeldung soll den blocklist-grund nennen: {:?}",
            res
        );
    }

    #[test]
    fn batch_dir_sizes_begrenzt_die_eingabemenge() {
        use super::{batch_dir_sizes_inner, MAX_BATCH_DIR_SIZE_PATHS};

        let res = batch_dir_sizes_inner(vec!["/tmp".to_string(); MAX_BATCH_DIR_SIZE_PATHS + 1]);
        assert_eq!(res.unwrap_err(), "too many paths for batch_dir_sizes");
    }

    // `dir_size` darf Symlinks nicht folgen, sonst zählt ein Symlink
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
            "symlink wurde gefolgt, dir_size={res} (sollte < 1000 sein)"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    use super::{canonicalize_path, path_identity};

    // `path_identity` lehnt blockierte Pfade ab.
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

    // `canonicalize_path` lehnt `/etc` über `is_safe_path` ab.
    #[test]
    fn canonicalize_rejects_etc() {
        assert!(canonicalize_path("/etc".into()).is_err());
        assert!(canonicalize_path("/etc/cron.d".into()).is_err());
    }

    // Derselbe Pfadsatz wie in `is_safe_path` wird abgelehnt.
    #[test]
    fn canonicalize_rejects_all_blocked() {
        for blocked in &[
            "/",
            "/etc",
            "/etc/cron.d",
            "/proc",
            "/proc/cpuinfo",
            "/sys",
            "/sys/class",
            "/dev",
            "/dev/null",
        ] {
            assert!(
                canonicalize_path(blocked.to_string()).is_err(),
                "canonicalize_path should reject {blocked}"
            );
        }
    }
}
