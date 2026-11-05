use crate::commands::errcode;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
// ---- sicherheits-validierungen (webview-IPC-grenze) ----

pub(super) fn sanitize_path(p: &str, label: &str) -> Result<(), String> {
    // r-03: beide ablehnungen sind ort-ablehnungen der IPC-grenze und tragen
    // deshalb denselben code wie die uebrigen pfad-prüfungen (blocked-location);
    // das label bleibt im detail.
    if !p.starts_with('/') {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: path must be absolute"),
        ));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: path traversal rejected"),
        ));
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

/// canonicalize eines pfads, dessen roh-input kein symlink sein darf.
/// der symlink_metadata-guard läuft auf dem roh-input VOR canonicalize
/// canonicalize folgt symlinks, ein guard auf dem gefolgten pfad wäre tot.
pub(super) fn canonicalize_no_symlink(path: &str) -> Result<PathBuf, String> {
    // n-01/n-02: io-restfehler tragen die io-regel als code, die
    // symlink-ablehnung den kanonischen code statt eines rohtextes.
    let raw_meta = fs::symlink_metadata(path)
        .map_err(|error| errcode::with_detail(errcode::code_for_io(&error), error))?;
    if raw_meta.file_type().is_symlink() {
        return Err(errcode::SYMLINK_REJECTED.into());
    }
    fs::canonicalize(path)
        .map_err(|error| errcode::with_detail(errcode::code_for_io(&error), error))
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
    // n-01-muster: auch dieser pfad endet an der UI-grenze, ein rohtext würde
    // dort als "unbekannt" erscheinen. ein fehlender vorfahre ist ein
    // nicht verfügbarer ort, kein not-found des ziels.
    let ancestor = next_existing_ancestor(path).ok_or_else(|| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("no existing ancestor for {label}"),
        )
    })?;
    fs::canonicalize(&ancestor).map_err(|e| errcode::with_detail(errcode::code_for_io(&e), e))
}

/// gemeinsame uhrquelle für delete-tokens und claim-namen. ein rückwärts
/// laufender oder fehlender uhrwert wird als fehler geführt statt als 0: mit 0
/// wäre jedes token sofort abgelaufen und jeder zeitstempel-name doppelt.
pub(super) fn unix_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .map_err(|error| {
            errcode::with_detail(errcode::UNAVAILABLE, format!("system clock: {error}"))
        })
}

pub(super) fn random_suffix() -> String {
    // bewusst nanosekunden statt `unix_millis`: der suffix unterscheidet
    // namen innerhalb desselben aufrufs und derselben millisekunde. ein
    // uhrfehler liefert 0 statt eines fehlers: der zähler darunter hält den
    // namen trotzdem eindeutig.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    // der zähler hängt an jedem aufruf, nicht nur im uhrfehlerfall: bei grober
    // oder virtualisierter uhr (zweimal dieselben nanosekunden) wären zwei
    // namen sonst identisch. die prozess-id trennt parallel laufende prozesse,
    // der zähler macht die folge prozessweit eindeutig und monoton.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let pid = std::process::id();
    format!("{nanos:x}-{pid:x}-{count:x}")
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
    use super::{
        canonicalize_nearest_ancestor, canonicalize_no_symlink, is_descendant_of, is_safe_path,
        random_suffix, sanitize_path, unix_millis,
    };
    use crate::commands::errcode;
    use std::path::Path;

    // ---- sicherheits-validierung ----

    /// Regression zu n-01/n-02: beide ablehnungen von `canonicalize_no_symlink`
    /// tragen ihren code am leitfeld, kein rohtext mehr.
    #[cfg(unix)]
    #[test]
    fn canonicalize_no_symlink_meldet_codiert() {
        let root = std::env::temp_dir().join(format!("protium-path-codes-{}", std::process::id()));
        std::fs::create_dir_all(root.join("ziel")).unwrap();
        std::os::unix::fs::symlink(root.join("ziel"), root.join("verweis")).unwrap();

        let error = canonicalize_no_symlink(&root.join("verweis").to_string_lossy()).unwrap_err();
        assert!(
            errcode::has_code(&error, errcode::SYMLINK_REJECTED),
            "unexpected error: {error}"
        );

        let error = canonicalize_no_symlink(&root.join("fehlt").to_string_lossy()).unwrap_err();
        assert!(
            errcode::has_code(&error, errcode::NOT_FOUND),
            "unexpected error: {error}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 1.11: der fehlende vorfahre trägt `unavailable` am leitfeld, damit die
    /// oberfläche den grund kategorisiert statt einen rohtext zu zeigen.
    /// Der fall braucht einen relativen pfad: bei absoluten existiert `/`
    /// immer und ist damit der nächste vorhandene vorfahre.
    #[test]
    fn canonicalize_nearest_ancestor_meldet_fehlenden_vorfahren_codiert() {
        let fehlend = Path::new("protium-gibt-es-nicht/kind");

        let error = canonicalize_nearest_ancestor(fehlend, "test ziel").unwrap_err();

        assert!(errcode::has_code(&error, errcode::UNAVAILABLE), "{error}");
        assert!(error.contains("test ziel"), "detail verloren: {error}");
    }

    #[test]
    fn random_suffix_ist_nie_null_und_je_aufruf_verschieden() {
        let first = random_suffix();
        let second = random_suffix();

        assert_ne!(first, "0");
        assert_ne!(second, "0");
        assert_ne!(first, second);
    }

    #[test]
    fn unix_millis_liefert_einen_wert_nach_der_epoche() {
        // Ein pre-epoch-uhrfehler ist ohne eingriff in SystemTime nicht
        // simulierbar; der test hält den normalpfad fest.
        assert!(unix_millis().unwrap() > 0);
    }

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
