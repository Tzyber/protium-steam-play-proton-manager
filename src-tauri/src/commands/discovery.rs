// Discovery und Snapshot-Aufbau der Steam-Umgebung (Audit 3.11).

use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::errcode;
use crate::commands::libraryfolders::read_library_folders_with_failures;
use crate::commands::path::{is_descendant_of, is_safe_path};
use crate::commands::scope::{
    prepare_app_dir, reject_symlink_components, EnvironmentSnapshot, LibraryUnavailable,
    LibraryUnavailableReason, SYSTEM_COMPAT_DIRS,
};
use crate::commands::steam_layout;

/// Discovery-Kandidaten für den Steam-Root, relativ zum Home. Das Write-Gate
/// erlaubt Config-Dateien nur unter dem hier entdeckten `steam_root`, nicht
/// unter einer zweiten fest kodierten Wurzelliste. Ein neuer Kandidat ist
/// schreibbar, sobald die Discovery ihn auswählt.
pub(crate) const ROOT_CANDIDATES: [&str; 6] = [
    ".local/share/Steam",
    ".steam/steam",
    ".steam/root",
    // debians `steam-installer` (debian-bug #916303); `.steam/steam` zeigt dorthin.
    ".steam/debian-installation",
    ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    "snap/steam/common/.local/share/Steam",
];

fn build_fixed_system_compat_root(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("system compat root: {error}"),
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(errcode::with_detail(
            errcode::NOT_A_DIRECTORY,
            format!("system compat root is not a regular directory: {path:?}"),
        ));
    }
    reject_symlink_components(path, true, "system compat root")?;
    let canonical = fs::canonicalize(path).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("system compat root canonicalize: {error}"),
        )
    })?;
    if canonical != path {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("system compat root changed identity: {path:?}"),
        ));
    }
    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("blocked system compat root: {path:?}"),
        ));
    }
    Ok(Some(canonical))
}

pub(crate) fn build_environment_snapshot(
    home: &Path,
    app_cache_dir: &Path,
    app_config_dir: &Path,
) -> Result<EnvironmentSnapshot, String> {
    let home = fs::canonicalize(home).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("home canonicalize: {error}"),
        )
    })?;
    let fixed_candidates: Vec<PathBuf> = ROOT_CANDIDATES
        .iter()
        .map(|relative| home.join(relative))
        .collect();
    let mut steam_root = None;
    let mut skipped_symlink_target: Option<PathBuf> = None;
    for relative in ROOT_CANDIDATES {
        let candidate = home.join(relative);
        if !candidate.exists() {
            continue;
        }
        let canonical = fs::canonicalize(&candidate).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("steam candidate canonicalize: {error}"),
            )
        })?;
        // ein alias auf ein fremdes ziel wird nie root; nur dieser kandidat
        // entfällt, die übrigen festen kandidaten bleiben auffindbar.
        if !fixed_candidates.iter().any(|fixed| fixed == &canonical)
            || !is_descendant_of(&canonical, &home)
        {
            skipped_symlink_target.get_or_insert(canonical);
            continue;
        }
        let steamapps = steam_layout::steamapps(&canonical);
        let Ok(metadata) = fs::symlink_metadata(&steamapps) else {
            continue;
        };
        if !metadata.file_type().is_symlink() && metadata.is_dir() {
            steam_root = Some(canonical);
            break;
        }
    }
    let steam_root = steam_root.ok_or_else(|| match skipped_symlink_target {
        Some(target) => errcode::with_detail(
            errcode::STEAM_ROOT_SYMLINK_UNSUPPORTED,
            format!(
                "steam root symlink points outside supported candidates ({})",
                target.display()
            ),
        ),
        None => errcode::STEAM_NOT_FOUND.to_owned(),
    })?;

    let (unique, mut unavailable_libraries) = read_library_folders_with_failures(&steam_root)?;

    // Root ist jeweils das Elternverzeichnis: fachlich die App-Basis, unter der
    // Cache und Config liegen, nicht das Verzeichnis selbst (sonst wäre der
    // descendant-check tautologisch).
    let cache_root = app_cache_dir
        .parent()
        .ok_or_else(|| errcode::with_detail(errcode::UNAVAILABLE, "app cache: no parent root"))?;
    let app_cache_dir = prepare_app_dir(app_cache_dir, cache_root, "app cache")?;
    let config_root = app_config_dir
        .parent()
        .ok_or_else(|| errcode::with_detail(errcode::UNAVAILABLE, "app config: no parent root"))?;
    let app_config_dir = prepare_app_dir(app_config_dir, config_root, "app config")?;

    // S-11: `$HOME` und Vorfahren von `$HOME`, `$APPCACHE` oder `$APPCONFIG`
    // dürfen auch außerhalb des Steam-Roots nie als Library autorisiert werden.
    let mut libraries = Vec::with_capacity(unique.len());
    for lib in unique {
        if is_descendant_of(&home, &lib)
            || is_descendant_of(&app_cache_dir, &lib)
            || is_descendant_of(&app_config_dir, &lib)
        {
            unavailable_libraries.push(LibraryUnavailable {
                path: lib.to_string_lossy().into_owned(),
                reason: LibraryUnavailableReason::ScopeFailed,
            });
        } else {
            libraries.push(lib);
        }
    }

    let mut system_compat_dirs = Vec::new();
    for fixed in SYSTEM_COMPAT_DIRS {
        let path = Path::new(fixed);
        if let Some(canonical) = build_fixed_system_compat_root(path)? {
            if !system_compat_dirs.contains(&canonical) {
                system_compat_dirs.push(canonical);
            }
        }
    }

    Ok(EnvironmentSnapshot {
        generation: 0,
        steam_root,
        libraries,
        unavailable_libraries,
        system_compat_dirs,
        app_cache_dir,
        app_config_dir,
    })
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
