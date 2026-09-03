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
    !blocked
        .iter()
        .any(|b| canonical == *b || canonical.starts_with(&format!("{b}/")))
}

/// sanitize → canonicalize → is_safe_path (blocklist). der gemeinsame
/// Gemeinsamer Prolog der schreibfreien Validierungen.
pub(super) fn canonicalize_safe(path: &str, label: &str) -> Result<PathBuf, String> {
    sanitize_path(path, label)?;
    let real = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !is_safe_path(&real.to_string_lossy()) {
        return Err(format!("blocked path: {path}"));
    }
    Ok(real)
}

/// canonicalize eines pfads, dessen roh-input kein symlink sein darf.
/// der symlink_metadata-guard läuft auf dem roh-input VOR canonicalize
/// canonicalize folgt symlinks, ein guard auf dem gefolgten pfad wäre tot.
pub(super) fn canonicalize_no_symlink(path: &str) -> Result<PathBuf, String> {
    let raw_meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if raw_meta.file_type().is_symlink() {
        return Err("symlink rejected, will not recurse".into());
    }
    fs::canonicalize(path).map_err(|e| e.to_string())
}

pub(super) fn is_descendant_of(child: &Path, ancestor: &Path) -> bool {
    child.starts_with(ancestor)
}

/// nächsten existierenden vorfahren eines pfads ermitteln.
pub(super) fn next_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    start
        .ancestors()
        .find(|candidate| candidate.exists())
        .map(Path::to_path_buf)
}

/// nächsten existierenden vorfahren kanonisieren, für ziele, die
/// (zwangsläufig) noch nicht existieren (download-dest, backup, extract-dest).
pub(super) fn canonicalize_nearest_ancestor(path: &Path, label: &str) -> Result<PathBuf, String> {
    let ancestor =
        next_existing_ancestor(path).ok_or_else(|| format!("no existing ancestor for {label}"))?;
    fs::canonicalize(&ancestor).map_err(|e| format!("{label} ancestor: {e}"))
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
    use super::{is_descendant_of, is_safe_path, sanitize_path};
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

    #[test]
    fn is_descendant_of_echter_nachfahre() {
        assert!(is_descendant_of(Path::new("/a/b/c/d"), Path::new("/a/b")));
    }

    #[test]
    fn is_descendant_of_gleicher_pfad() {
        assert!(is_descendant_of(Path::new("/a/b"), Path::new("/a/b")));
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
        assert!(!is_descendant_of(Path::new("/a/b/c"), Path::new("/a/x")));
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
