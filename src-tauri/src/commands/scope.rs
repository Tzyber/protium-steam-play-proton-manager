use std::fs;
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
use crate::commands::path::{canonicalize_safe, is_safe_path};

/// extrahiert das library-verzeichnis (alles vor dem letzten "/steamapps/").
/// `rfind` ist sicher, weil das folgende muster-check die echte anwendung garantiert.
pub(super) fn library_of(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[..idx])
}

/// alles nach dem letzten "/steamapps/". gibt None wenn der marker fehlt.
pub(super) fn suffix_after_steamapps(canon_str: &str) -> Result<&str, String> {
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
pub(super) fn parse_compat_id<'a>(pair: (&'a str, &'a str)) -> Result<(&'a str, &'a str), String> {
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

pub(super) fn allow_library_scope_inner(app: AppHandle, path: &Path) -> Result<(), String> {
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
pub(super) fn validate_library_scope(path_str: &str) -> Result<std::path::PathBuf, String> {
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

#[cfg(test)]
mod tests {
    use super::validate_library_scope;
    use std::path::Path;

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
}
