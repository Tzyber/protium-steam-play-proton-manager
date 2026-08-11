use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
// ---- sicherheits-validierungen (webview-IPC-grenze) ----

pub(super) fn sanitize_path(p: &str, label: &str) -> Result<(), String> {
    if !p.starts_with('/') {
        return Err(format!("{label}: path must be absolute"));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err(format!("{label}: path traversal rejected"));
    }
    Ok(())
}

/// canonicalisierte pfade, die NIE in den scope aufgenommen werden dürfen.
pub(super) fn is_safe_path(canonical: &str) -> bool {
    let blocked: &[&str] = &["/", "/etc", "/proc", "/sys", "/dev"];
    !blocked.iter().any(|b| canonical == *b || canonical.starts_with(&format!("{b}/")))
}

/// sanitize → canonicalize → is_safe_path (blocklist). der gemeinsame
/// prolog der read-only-validierungen (S-01/S-02/S-03/S-07-umstellung).
pub(super) fn canonicalize_safe(path: &str, label: &str) -> Result<PathBuf, String> {
    sanitize_path(path, label)?;
    let real = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err(format!("blocked path: {path}"));
    }
    Ok(real)
}

/// canonicalize eines pfads, dessen roh-input kein symlink sein darf.
/// der symlink_metadata-guard läuft auf dem roh-input VOR canonicalize —
/// canonicalize folgt symlinks, ein guard auf dem gefolgten pfad wäre tot.
/// nutzer: validate_and_prepare + remove_trash_entry_inner.
pub(super) fn canonicalize_no_symlink(path: &str) -> Result<PathBuf, String> {
    let raw_meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if raw_meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    fs::canonicalize(path).map_err(|e| e.to_string())
}

/// komponentenbasierter nachfahren-check: jedes component des ancestor muss
/// am anfang von child exakt matchen. `Path::starts_with` tut das ebenfalls,
/// hier explizit per komponenten-iteration zur dokumentation der absicht.
pub(super) fn is_descendant_of(child: &Path, ancestor: &Path) -> bool {
    let mut anc = ancestor.components().peekable();
    let mut ch = child.components().peekable();
    loop {
        match (anc.next(), ch.next()) {
            (None, _) => return true,
            (Some(a), Some(c)) if a == c => continue,
            _ => return false,
        }
    }
}

/// nächsten existierenden vorfahren eines pfads ermitteln.
pub(super) fn next_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_dir() { path.to_path_buf() } else { path.parent()?.to_path_buf() };
    loop {
        if current.exists() {
            return Some(current);
        }
        current = current.parent()?.to_path_buf();
    }
}

/// nächsten existierenden vorfahren kanonisieren — für ziele, die
/// (zwangsläufig) noch nicht existieren (download-dest, backup, extract-dest).
pub(super) fn canonicalize_nearest_ancestor(path: &Path, label: &str) -> Result<PathBuf, String> {
    let ancestor = next_existing_ancestor(path)
        .ok_or_else(|| format!("no existing ancestor for {label}"))?;
    fs::canonicalize(&ancestor).map_err(|e| format!("{label} ancestor: {e}"))
}

/// validiert, dass `dest` innerhalb von `dir` liegt (allowlist statt
/// blocklist) — der gemeinsame kern von validate_download_dest und der
/// backup-prüfung in write_steam_file_inner. create_dir_all-zuerst
/// (test-erzwungen): ohne den create degradiert der ancestor-walk auf
/// einen gemeinsamen vorfahren (fremde apps im selben überbau kämen
/// durch). label für den fehler-prefix — die zwei stellen haben
/// unterschiedliche meldungen („backup outside app cache" /
/// download-fehlermeldung).
pub(super) fn ensure_dest_within_canon_dir(dest: &Path, dir: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {label}: {e}"))?;
    let dir_canon = fs::canonicalize(dir).map_err(|e| format!("{label} canonicalize: {e}"))?;

    // roh-pfad: muss nachfahre von dir sein (fängt prefix-tricks wie
    // "/pfad/dir-evil/x" gegen "/pfad/dir" ab)
    if !is_descendant_of(dest, dir) {
        return Err(format!("{label} outside app cache"));
    }

    // nächsten existierenden vorfahren kanonisieren (dest existiert
    // zwangsläufig noch nicht, deshalb ancestor-walk)
    let dest_ancestor_canon = canonicalize_nearest_ancestor(dest, label)?;

    // kanonische nachfahren-prüfung: dest-ancestor muss im kanonischen dir liegen
    if !is_descendant_of(&dest_ancestor_canon, &dir_canon) {
        return Err(format!("{label} outside app cache (canonical)"));
    }
    Ok(())
}

/// validiert, dass ein download-ziel innerhalb des app-cache-verzeichnisses
/// liegt (allowlist-statt-blocklist). lehnt symlinks auf dem ziel selbst ab.
pub(super) fn validate_download_dest(dest: &str, cache_dir: &Path) -> Result<(), String> {
    let dest_path = Path::new(dest);
    ensure_dest_within_canon_dir(dest_path, cache_dir, "download dest")?;

    // symlink-check auf dem ziel selbst, falls es bereits existiert
    // (plan-review 2026-08-03: bleibt inline — der backup-pfad in
    // write_steam_file_inner darf diesen check nicht erben)
    if dest_path.exists() {
        let meta = fs::symlink_metadata(dest_path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("download dest is a symlink".into());
        }
    }

    Ok(())
}

pub(super) fn random_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}

/// prueft, ob `target`, relativ zu `base_dir` aufgeloest, innerhalb der archiv-wurzel bleibt.
/// rein lexikalisch (kein fs-zugriff): `..` popt eine komponente, ein pop unterhalb der
/// wurzel ist ein ausbruch. absolute targets sind immer ein ausbruch.
pub(super) fn link_target_stays_inside(base_dir: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth: isize = 0;
    for c in base_dir.components() {
        match c {
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::CurDir => {}
            _ => return false,
        }
    }
    for c in target.components() {
        match c {
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    depth > 0
}

#[cfg(test)]
mod tests {
    use super::{is_descendant_of, is_safe_path, sanitize_path, validate_download_dest};
    use std::os::unix::fs as unixfs;
    use std::path::Path;

    // ---- sicherheits-validierung ----

    #[test]
    fn sanitize_rejects_relative() {
        assert!(sanitize_path("foo/bar", "test").is_err());
        assert!(sanitize_path("./foo", "test").is_err());
    }

    #[test]
    fn sanitize_rejects_dotdot() {
        assert!(sanitize_path("/foo/../bar", "test").is_err());
        assert!(sanitize_path("/../etc", "test").is_err());
        assert!(sanitize_path("/home/user/../../../etc", "test").is_err());
    }

    #[test]
    fn sanitize_accepts_normal() {
        assert!(sanitize_path("/home/user/.steam", "test").is_ok());
        assert!(sanitize_path("/mnt/games", "test").is_ok());
        assert!(sanitize_path("/run/media/user/SteamLibrary", "test").is_ok());
    }

    #[test]
    fn safe_path_blocks_system_dirs() {
        assert!(!is_safe_path("/"));
        assert!(!is_safe_path("/etc"));
        assert!(!is_safe_path("/etc/cron.d"));
        assert!(!is_safe_path("/proc"));
        assert!(!is_safe_path("/proc/cpuinfo"));
        assert!(!is_safe_path("/sys"));
        assert!(!is_safe_path("/sys/class"));
        assert!(!is_safe_path("/dev"));
        assert!(!is_safe_path("/dev/null"));
    }

    #[test]
    fn safe_path_allows_normal_dirs() {
        assert!(is_safe_path("/home/user/.steam"));
        assert!(is_safe_path("/mnt/games"));
        assert!(is_safe_path("/run/media/user/lib"));
        assert!(is_safe_path("/tmp/build"));
    }

    // ---- download-dest-validierung (allowlist: nur app-cache) ----

    #[test]
    fn is_descendant_of_echter_nachfahre() {
        assert!(is_descendant_of(
            Path::new("/a/b/c/d"),
            Path::new("/a/b")
        ));
    }

    #[test]
    fn is_descendant_of_gleicher_pfad() {
        assert!(is_descendant_of(
            Path::new("/a/b"),
            Path::new("/a/b")
        ));
    }

    #[test]
    fn is_descendant_of_prefix_trick_abgelehnt() {
        // "/pfad/cache-evil" ist KEIN nachfahre von "/pfad/cache"
        assert!(!is_descendant_of(
            Path::new("/pfad/cache-evil/x"),
            Path::new("/pfad/cache")
        ));
    }

    #[test]
    fn is_descendant_of_anderer_zweig() {
        assert!(!is_descendant_of(
            Path::new("/a/b/c"),
            Path::new("/a/x")
        ));
    }

    #[test]
    fn validate_dest_im_cache_dir_ok() {
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(cache.join("downloads")).unwrap();

        let dest = cache.join("downloads/file.tar.gz");
        let res = validate_download_dest(dest.to_str().unwrap(), &cache);
        assert!(res.is_ok(), "dest im cache-dir muss ok sein: {res:?}");

        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn validate_dest_etc_passwd_abgelehnt() {
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-etc-{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();

        let res = validate_download_dest("/etc/passwd", &cache);
        assert!(res.is_err(), "/etc/passwd muss abgelehnt werden: {res:?}");

        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn validate_dest_nichtexistenter_parent_ausserhalb_abgelehnt() {
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-parent-{}", std::process::id()));
        // cache existiert, aber dest liegt woanders mit nicht-existierendem parent
        std::fs::create_dir_all(&cache).unwrap();

        let outside = tmp.join(format!("protium-desttest-other-{}", std::process::id()));
        let dest = outside.join("subdir/file.tar.gz"); // parent existiert nicht
        let res = validate_download_dest(dest.to_str().unwrap(), &cache);
        assert!(res.is_err(), "dest ausserhalb cache muss abgelehnt werden (parent existiert nicht): {res:?}");

        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn validate_dest_symlink_abgelehnt() {
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-sym-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(cache.join("downloads")).unwrap();

        let real = cache.join("downloads/real.tar.gz");
        std::fs::write(&real, b"x").unwrap();
        let link = cache.join("downloads/link.tar.gz");
        unixfs::symlink(&real, &link).unwrap();

        let res = validate_download_dest(link.to_str().unwrap(), &cache);
        assert!(res.is_err(), "symlink-dest muss abgelehnt werden: {res:?}");
        assert!(res.as_ref().unwrap_err().contains("symlink"));

        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn validate_dest_prefix_trick_abgelehnt() {
        // dest = "<cache-dir>-evil/x" — komponenten-vergleich fängt das ab.
        // eigener verzeichnisname pro test: `validate_dest_im_cache_dir_ok`
        // nutzt `protium-desttest-cache-{pid}`, und das remove_dir_all hier
        // löschte dessen verzeichnis mitten im lauf (race, CI-rot).
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-prefix-{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();

        let evil = tmp.join(format!("protium-desttest-prefix-{}-evil", std::process::id()));
        let dest = evil.join("x");
        let res = validate_download_dest(dest.to_str().unwrap(), &cache);
        assert!(res.is_err(), "prefix-trick muss abgelehnt werden: {res:?}");

        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn validate_dest_cache_erbt_nicht_vom_vorfahren() {
        // cache_dir existiert NICHT, dest liegt in einer fremden app unter
        // demselben existierenden vorfahren (z.b. beide unter ~/.cache).
        // ohne create_dir_all(cache_dir) würde der ancestor-walk auf beiden
        // seiten denselben vorfahren finden und die prüfung degradieren.
        let tmp = std::env::temp_dir();
        let cache = tmp.join(format!("protium-desttest-meineapp-{}", std::process::id()));
        // cache_dir wird NICHT vorab angelegt — validate_download_dest
        // muss create_dir_all selbst aufrufen

        let fremd = tmp.join(format!("protium-desttest-fremdeapp-{}", std::process::id()));
        let dest = fremd.join("x");
        let res = validate_download_dest(dest.to_str().unwrap(), &cache);
        assert!(res.is_err(), "dest in fremder app muss abgelehnt werden: {res:?}");

        // cache_dir selbst wurde durch create_dir_all angelegt
        assert!(cache.exists(), "cache_dir muss jetzt existieren");
        let _ = std::fs::remove_dir_all(&cache);
        let _ = std::fs::remove_dir_all(&fremd);
    }

    use super::link_target_stays_inside;

    #[test]
    fn stays_inside_einfacher_relativer_pfad() {
        assert!(link_target_stays_inside(
            std::path::Path::new("dir/lib"),
            std::path::Path::new("libfoo.so.1.2.3")
        ));
    }

    #[test]
    fn stays_inside_legtitimer_parentdir() {
        assert!(link_target_stays_inside(
            std::path::Path::new("dir/a/b"),
            std::path::Path::new("../c/y")
        ));
    }

    #[test]
    fn stays_inside_ausbruch_durch_parentdir() {
        assert!(!link_target_stays_inside(
            std::path::Path::new("dir/lib"),
            std::path::Path::new("../../../../etc/passwd")
        ));
    }

    #[test]
    fn stays_inside_absolutes_target() {
        assert!(!link_target_stays_inside(
            std::path::Path::new("dir"),
            std::path::Path::new("/etc/passwd")
        ));
    }

    #[test]
    fn stays_inside_genau_an_der_wurzel() {
        assert!(!link_target_stays_inside(
            std::path::Path::new("dir"),
            std::path::Path::new("..")
        ));
    }

}
