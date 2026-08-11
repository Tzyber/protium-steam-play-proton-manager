// ---- M3.1/M3.4: steam-write-gate (write_steam_file, remove_compat_tool) ----

use std::fs;
use std::path::Path;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

use crate::commands::fs_ops::is_process_running;
use crate::commands::path::{
    ensure_dest_within_canon_dir, is_safe_path, random_suffix, sanitize_path,
};
use crate::commands::spawn_blocking_io;

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
pub(super) fn write_steam_file_inner(
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
pub(super) fn remove_compat_tool_inner(
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

#[cfg(test)]
mod tests {
    // ---- write-gate (M3.1: INV-1 in rust) ----

    use super::{is_steam_config_path, write_steam_file_inner};
    use crate::commands::test_util::wsg_fixture;

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
