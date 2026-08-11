use std::collections::HashMap;
use std::fs;
use std::path::Path;
use serde::Serialize;
use crate::commands::path::{canonicalize_safe, is_safe_path, sanitize_path};

// ---- R-3/R-3b/R-6: verzeichnisgrößen (dir_size, batch_dir_sizes) + path-identity (dev,ino) ----

pub(super) fn dir_size_inner(path: &str) -> Result<u64, String> {
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

pub(super) fn batch_dir_sizes_inner(paths: Vec<String>) -> Result<HashMap<String, u64>, String> {
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

/// R-6: realpath + (dev,ino) zur library-dedup.
#[derive(Serialize)]
pub(crate) struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
}

#[cfg(test)]
mod tests {
    use super::dir_size_inner;
    use std::os::unix::fs as unixfs;

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
}
