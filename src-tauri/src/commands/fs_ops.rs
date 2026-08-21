#[cfg(test)]
use crate::commands::path::{canonicalize_safe, is_safe_path, sanitize_path};
use crate::commands::scope::EnvironmentState;
use crate::commands::spawn_blocking_io;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::State;

// Verzeichnisgrößen und Pfadidentität über `(dev, ino)`.

const MAX_BATCH_DIR_SIZE_PATHS: usize = 4096;
const MAX_ENVIRONMENT_READ_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENVIRONMENT_DIR_ENTRIES: usize = 8192;

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
    state.with_authorized_existing(path, label, |real| {
        let metadata = fs::symlink_metadata(&real).map_err(|error| format!("{label}: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("{label}: not a regular file"));
        }
        if metadata.len() > MAX_ENVIRONMENT_READ_BYTES {
            return Err(format!("{label}: file exceeds read limit"));
        }
        let bytes = fs::read(real).map_err(|error| format!("{label}: {error}"))?;
        if bytes.len() as u64 > MAX_ENVIRONMENT_READ_BYTES {
            return Err(format!("{label}: file exceeds read limit"));
        }
        Ok(bytes)
    })
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
) -> Result<Vec<u8>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || read_environment_file(&state, &path, "environment read binary")).await
}

#[tauri::command]
pub async fn environment_read_dir(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<Vec<EnvironmentDirEntry>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_existing(&path, "environment read dir", |real| {
            let metadata = fs::symlink_metadata(&real)
                .map_err(|error| format!("environment read dir: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("environment read dir: not a regular directory".into());
            }
            let mut entries = Vec::new();
            for (index, entry) in fs::read_dir(real)
                .map_err(|error| format!("environment read dir: {error}"))?
                .enumerate()
            {
                if index >= MAX_ENVIRONMENT_DIR_ENTRIES {
                    return Err("environment read dir: entry limit exceeded".into());
                }
                let entry = entry.map_err(|error| format!("environment read dir: {error}"))?;
                let file_type = entry
                    .file_type()
                    .map_err(|error| format!("environment read dir: {error}"))?;
                entries.push(EnvironmentDirEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_directory: file_type.is_dir(),
                    is_symlink: file_type.is_symlink(),
                });
            }
            Ok(entries)
        })
    })
    .await
}

#[cfg(test)]
pub(super) fn dir_size_inner(path: &str, scope_ok: &dyn Fn(&Path) -> bool) -> Result<u64, String> {
    let real = canonicalize_safe(path, "dir_size")?;
    if !scope_ok(&real) {
        return Err("path outside allowed scope".into());
    }
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

#[cfg(test)]
pub(super) fn batch_dir_sizes_inner(
    paths: Vec<String>,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<HashMap<String, u64>, String> {
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
        if !scope_ok(&real) {
            return Err(format!("path outside allowed scope: {p}"));
        }
        map.insert(p, dir_size_impl(&real));
    }
    Ok(map)
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
        return Err("process check only allowed for steam".into());
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
pub async fn dir_size(state: State<'_, EnvironmentState>, path: String) -> Result<u64, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_existing(&path, "dir_size", |real| {
            let metadata =
                fs::symlink_metadata(&real).map_err(|error| format!("dir_size: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("dir_size: not a regular directory".into());
            }
            Ok(dir_size_impl(&real))
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
) -> Result<HashMap<String, u64>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        if paths.len() > MAX_BATCH_DIR_SIZE_PATHS {
            return Err("too many paths for batch_dir_sizes".into());
        }
        state.with_authorized_batch(&paths, |authorized| {
            let mut result = HashMap::with_capacity(authorized.len());
            for (path, real) in authorized {
                let metadata = fs::symlink_metadata(&real)
                    .map_err(|error| format!("batch_dir_sizes: {error}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!("batch_dir_sizes: not a regular directory: {path}"));
                }
                result.insert(path, dir_size_impl(&real));
            }
            Ok(result)
        })
    })
    .await
}

#[cfg(test)]
pub(super) fn canonicalize_path_inner(path: &str) -> Result<String, String> {
    let canonical = canonicalize_safe(path, "canonicalize")?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// symlink-auflösung (steam-root-discovery). `..` im input abgelehnt,
/// auflösungen in blockierte dateisysteme verweigert (info-disclosure).
/// Nutzt `canonicalize_safe()` (Sanitize + Realpath + Systempfad-Blocklist).
#[tauri::command]
pub fn canonicalize_path(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<String, String> {
    state.with_authorized_existing(&path, "canonicalize", |real| {
        Ok(real.to_string_lossy().into_owned())
    })
}

#[cfg(test)]
pub(super) fn path_identity_inner(path: &str) -> Result<PathIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let real = canonicalize_safe(path, "path_identity")?;
    let md = fs::metadata(&real).map_err(|e| e.to_string())?;
    Ok(PathIdentity {
        realpath: real.to_string_lossy().into_owned(),
        dev: md.dev().to_string(),
        ino: md.ino().to_string(),
    })
}

/// Liefert kanonischen Pfad und `(dev, ino)` zur Library-Deduplizierung.
/// Nutzt `canonicalize_safe()` (Sanitize + Realpath + Systempfad-Blocklist).
#[tauri::command]
pub fn path_identity(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<PathIdentity, String> {
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
}

#[cfg(test)]
mod tests {
    use super::{
        batch_dir_sizes_inner, canonicalize_path_inner, dir_size_inner, path_identity_inner,
        read_environment_file,
    };
    use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
    use std::os::unix::fs as unixfs;

    // `dir_size` lehnt blockierte Systempfade ab.
    #[test]
    fn dir_size_rejects_blocked_paths() {
        assert!(dir_size_inner("/etc", &|_| true).is_err());
        assert!(dir_size_inner("/proc", &|_| true).is_err());
        assert!(dir_size_inner("/sys", &|_| true).is_err());
        assert!(dir_size_inner("/dev", &|_| true).is_err());
    }

    #[test]
    fn dir_size_rejects_dotdot() {
        assert!(dir_size_inner("/home/../etc", &|_| true).is_err());
    }

    #[test]
    fn dir_size_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        assert!(dir_size_inner(&tmp.to_string_lossy(), &|_| true).is_ok());
        assert!(dir_size_inner("/tmp", &|_| true).is_ok());
    }

    #[test]
    fn dir_size_rejects_unscoped_path() {
        let tmp = std::env::temp_dir();
        let res = dir_size_inner(&tmp.to_string_lossy(), &|_| false);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("outside allowed scope"));
    }

    #[test]
    fn batch_dir_sizes_partial_failure_skips_missing_paths() {
        let mut root = std::env::temp_dir();
        root.push(format!("protium-batch-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let real = root.join("compatdata/12345");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("payload"), vec![0u8; 8192]).unwrap();
        let real_canon = std::fs::canonicalize(&real).unwrap();

        let missing = root.join("compatdata/99999_gone");

        let res = batch_dir_sizes_inner(
            vec![
                real_canon.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
            &|_| true,
        );
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

    #[test]
    fn batch_dir_sizes_propagates_blocked_path() {
        let tmp = std::env::temp_dir();
        let res = batch_dir_sizes_inner(
            vec![tmp.to_string_lossy().into_owned(), "/etc".to_string()],
            &|_| true,
        );
        assert!(res.is_err(), "blockierter pfad muss Err liefern");
        assert!(
            res.as_ref().unwrap_err().contains("blocked path"),
            "fehlermeldung soll den blocklist-grund nennen: {:?}",
            res
        );
    }

    #[test]
    fn batch_dir_sizes_rejects_unscoped_path() {
        let tmp = std::env::temp_dir();
        let res = batch_dir_sizes_inner(vec![tmp.to_string_lossy().into_owned()], &|_| false);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("outside allowed scope"));
    }

    #[test]
    fn batch_dir_sizes_begrenzt_die_eingabemenge() {
        use super::MAX_BATCH_DIR_SIZE_PATHS;

        let res = batch_dir_sizes_inner(
            vec!["/tmp".to_string(); MAX_BATCH_DIR_SIZE_PATHS + 1],
            &|_| true,
        );
        assert_eq!(res.unwrap_err(), "too many paths for batch_dir_sizes");
    }

    #[test]
    fn dir_size_skipped_symlinks() {
        let mut root = std::env::temp_dir();
        root.push(format!("protium-dirsymlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("big.bin"), vec![0u8; 5_000_000]).unwrap();

        let via = root.join("via-link");
        std::fs::create_dir_all(&via).unwrap();
        unixfs::symlink(&real, via.join("link-to-real")).unwrap();

        let res = dir_size_inner(&via.to_string_lossy(), &|_| true).unwrap();
        assert!(
            res < 1000,
            "symlink wurde gefolgt, dir_size={res} (sollte < 1000 sein)"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_identity_rejects_blocked_paths() {
        assert!(path_identity_inner("/etc/passwd").is_err());
        assert!(path_identity_inner("/proc/cpuinfo").is_err());
    }

    #[test]
    fn path_identity_rejects_dotdot() {
        assert!(path_identity_inner("/home/../etc/passwd").is_err());
    }

    #[test]
    fn path_identity_accepts_normal_paths() {
        let tmp = std::env::temp_dir();
        let s = tmp.to_string_lossy().into_owned();
        assert!(path_identity_inner(&s).is_ok());
    }

    #[test]
    fn canonicalize_rejects_etc() {
        assert!(canonicalize_path_inner("/etc").is_err());
        assert!(canonicalize_path_inner("/etc/cron.d").is_err());
    }

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
                canonicalize_path_inner(blocked).is_err(),
                "canonicalize_path should reject {blocked}"
            );
        }
    }

    #[test]
    fn environment_exists_not_found_is_false_only_inside_snapshot() {
        let root = std::env::temp_dir().join(format!("protium-env-exists-{}", std::process::id()));
        let library = root.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let snapshot = EnvironmentSnapshot::for_test(
            root.join("steam"),
            vec![library.clone()],
            Vec::new(),
            root.join("cache"),
            root.join("config"),
        );
        let state = EnvironmentState::for_test(snapshot);
        assert!(!state
            .exists_for_test(&library.join("steamapps/missing.jpg"))
            .unwrap());
        assert!(state
            .exists_for_test(&root.join("Documents/missing.jpg"))
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn environment_binary_read_requires_current_snapshot_root() {
        let root = std::env::temp_dir().join(format!("protium-env-read-{}", std::process::id()));
        let library = root.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let cover = library.join("library_header.jpg");
        std::fs::write(&cover, [1u8, 2, 3]).unwrap();
        let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
            root.join("steam"),
            vec![library.clone()],
            Vec::new(),
            root.join("cache"),
            root.join("config"),
        ));

        assert_eq!(
            read_environment_file(&state, cover.to_str().unwrap(), "test").unwrap(),
            [1, 2, 3]
        );
        assert!(read_environment_file(&state, "/tmp/protium-not-authorized.jpg", "test").is_err());

        let _ = std::fs::remove_dir_all(root);
    }
}
