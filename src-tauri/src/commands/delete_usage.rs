// Nutzungsabfragen der Delete-Inspektion: installierte Apps, Shortcuts und
// Compat-Tool-Zuordnungen über fd-gebundene, gedeckelte Reader. Die
// Inspektion selbst (Zielkontext, Folgen) liegt in delete_inspect.rs.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};

#[cfg(target_os = "linux")]
use crate::commands::compat_auth::{
    open_external_library_fd_with_hook, read_app_manifest_with_hook, ManifestStage,
};
use crate::commands::errcode;
// fd-Items gibt es nur unter Linux (fd.rs ist leer gekappt), deshalb wie ihre
// Aufrufer bedingt (r-12).
#[cfg(all(test, target_os = "linux"))]
use crate::commands::fd::open_bound_root_fd;
#[cfg(target_os = "linux")]
use crate::commands::fd::{open_dir_at, open_file_at};
use crate::commands::shortcuts_bin::parse_binary_shortcut_ids;

#[cfg(all(test, not(target_os = "linux")))]
use crate::commands::delete_inspect::delete_inspection_unsupported;
#[cfg(target_os = "linux")]
use crate::commands::delete_inspect::DeleteReadStage;
use crate::commands::vdf_patch;

/// Grössenlimit für shortcuts.vdf-reads im delete-pipeline (analog zu den
/// 16-MiB-caps der übrigen environment-reads).
const MAX_SHORTCUTS_VDF_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

/// Caps für die delete-pipeline-reads: config.vdf. Der appmanifest-Deckel
/// liegt als einziger in `compat_auth::MAX_MANIFEST_BYTES` (r-05). Ohne cap
/// könnte eine präparierte datei jeden löschversuch in eine voll-allokation
/// (oom) treiben.
const MAX_DELETE_CONFIG_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

/// Gedeckelter Read mit Testhaken vor dem Lesen. Die Längen- und Limitprüfung
/// liegt in `fd::read_fd_bytes`, damit es nur eine Cap-Read-Stelle gibt.
#[cfg(target_os = "linux")]
fn read_fd_text_with_hook<F>(
    file: &mut std::fs::File,
    label: &str,
    max_bytes: u64,
    hook: &mut F,
    stage: DeleteReadStage,
) -> Result<String, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    let bytes = read_fd_bytes_with_hook(file, label, max_bytes, hook, stage)?;
    String::from_utf8(bytes).map_err(|error| {
        errcode::with_detail(errcode::UNREADABLE, format!("cannot read {label}: {error}"))
    })
}

#[cfg(target_os = "linux")]
fn read_fd_bytes_with_hook<F>(
    file: &mut std::fs::File,
    label: &str,
    max_bytes: u64,
    hook: &mut F,
    stage: DeleteReadStage,
) -> Result<Vec<u8>, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    crate::commands::fd::read_fd_bytes(file, label, max_bytes, &mut |file| {
        hook(stage, Some(file));
    })
}

#[cfg(test)]
fn is_app_installed_in_libraries(
    libraries: &[PathBuf],
    app_id: u32,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let mut no_hook = |_: DeleteReadStage, _: Option<&mut std::fs::File>| {};
        is_app_installed_in_libraries_linux_with_hook(libraries, app_id, &mut no_hook)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (libraries, app_id);
        Err(delete_inspection_unsupported())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn is_app_installed_in_libraries_linux_with_hook<F>(
    libraries: &[PathBuf],
    app_id: u32,
    hook: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    for lib in libraries {
        let canonical = match fs::canonicalize(lib) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot canonicalize Steam library: {error}"),
                ))
            }
        };
        let mut no_hook = |_| {};
        let library_fd = open_external_library_fd_with_hook(&canonical, &mut no_hook)?;
        let steamapps_fd = match open_dir_at(library_fd.as_raw_fd(), OsStr::new("steamapps")) {
            Ok(fd) => fd,
            // fehlende steamapps (z. b. nicht gemountete volume) kann keine
            // manifeste tragen: überspringen statt fail (INV-2), kein fehler.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open Steam library steamapps: {error}"),
                ))
            }
        };
        let proc_dir = Path::new("/proc/self/fd").join(steamapps_fd.as_raw_fd().to_string());
        let entries = fs::read_dir(&proc_dir).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot read manifest directory: {error}"),
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot read manifest entry: {error}"),
                )
            })?;
            let name = entry.file_name();
            let name_string = name.to_string_lossy();
            let Some(id_part) = name_string
                .strip_prefix("appmanifest_")
                .and_then(|rest| rest.strip_suffix(".acf"))
            else {
                continue;
            };
            let file_id = crate::commands::scope::parse_app_id(id_part).map_err(|_| {
                // F-04: der "wert" kommt aus dem dateisystem, nicht aus einer
                // gepatchten eingabe; `invalid-value` zeigte der oberflaeche
                // "unzulaessige zeichen" fuer eine fremde library-datei.
                errcode::with_detail(
                    errcode::UNREADABLE,
                    format!("invalid app manifest filename: {name_string}"),
                )
            })?;

            // Skip (manifest zwischen read_dir und openat verschwunden, INV-2)
            // und fail-closed (Mismatch, Lesefehler) bleiben Politik dieses
            // Aufrufers; der gemeinsame reader (r-05) liest nur ein Manifest.
            let mut manifest_hook =
                |stage: ManifestStage, file: Option<&mut std::fs::File>| match stage {
                    ManifestStage::BeforeOpen => hook(DeleteReadStage::ManifestBeforeOpen, None),
                    ManifestStage::AfterOpen => hook(DeleteReadStage::ManifestAfterOpen, file),
                    ManifestStage::BeforeRead => hook(DeleteReadStage::ManifestBeforeRead, file),
                };
            match read_app_manifest_with_hook(
                steamapps_fd.as_raw_fd(),
                &name,
                file_id,
                &mut manifest_hook,
            ) {
                Ok(Some(identity)) if identity.app_id == app_id => {
                    return Ok(Some(identity.name.unwrap_or_default()));
                }
                Ok(Some(_)) | Ok(None) => continue,
                // Code erhalten: die Oberflaeche uebersetzt den Grund, das
                // Detail (welche Datei) bleibt im Protokoll.
                Err(error) => {
                    return Err(errcode::remap_size_limit(
                        error.into_message(),
                        format!("manifest {name_string}"),
                    ));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
fn read_all_shortcut_app_ids(steam_root: &Path) -> Result<HashSet<u32>, String> {
    #[cfg(target_os = "linux")]
    {
        let canonical_root = fs::canonicalize(steam_root).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot canonicalize Steam root: {error}"),
            )
        })?;
        let root_fd = open_bound_root_fd(&canonical_root, &mut || {})?;
        let mut no_hook = |_: DeleteReadStage, _: Option<&mut std::fs::File>| {};
        read_all_shortcut_app_ids_linux_with_hook(&root_fd, &mut no_hook)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = steam_root;
        Err(delete_inspection_unsupported())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn read_all_shortcut_app_ids_linux_with_hook<F>(
    steam_root_fd: &OwnedFd,
    hook: &mut F,
) -> Result<HashSet<u32>, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    let userdata_fd = match open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new("userdata")) {
        Ok(fd) => fd,
        // fehlendes userdata bedeutet, dass keine shortcuts bekannt sind.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open userdata directory: {error}"),
            ))
        }
    };

    let proc_dir = Path::new("/proc/self/fd").join(userdata_fd.as_raw_fd().to_string());
    let entries = fs::read_dir(&proc_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot read userdata directory: {error}"),
        )
    })?;
    let mut all_ids = HashSet::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot read userdata entry: {error}"),
            )
        })?;
        let entry_type = entry.file_type().map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot inspect userdata entry: {error}"),
            )
        })?;
        if entry_type.is_symlink() {
            return Err(errcode::with_detail(
                errcode::SYMLINK_REJECTED,
                format!("userdata entry {} is a symlink", entry.path().display()),
            ));
        }
        if !entry_type.is_dir() {
            continue;
        }

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let account_fd = match open_dir_at(userdata_fd.as_raw_fd(), &name) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open userdata account: {error}"),
                ))
            }
        };
        let config_fd = match open_dir_at(account_fd.as_raw_fd(), OsStr::new("config")) {
            Ok(fd) => fd,
            // fehlendes account/config bedeutet, dass dieser account keine
            // shortcuts beitragen kann.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open userdata config: {error}"),
                ))
            }
        };

        hook(DeleteReadStage::ShortcutsBeforeOpen, None);
        let mut shortcuts = match open_file_at(config_fd.as_raw_fd(), OsStr::new("shortcuts.vdf")) {
            Ok(file) => file,
            // fehlende shortcuts.vdf bleibt ein skip wie im bisherigen Pfad.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open shortcuts.vdf: {error}"),
                ))
            }
        };
        hook(DeleteReadStage::ShortcutsAfterOpen, Some(&mut shortcuts));
        let bytes = read_fd_bytes_with_hook(
            &mut shortcuts,
            "shortcuts.vdf",
            MAX_SHORTCUTS_VDF_BYTES,
            hook,
            DeleteReadStage::ShortcutsBeforeRead,
        )
        .map_err(|error| {
            if errcode::has_code(&error, errcode::SIZE_LIMIT) {
                errcode::with_detail(errcode::SIZE_LIMIT, "shortcuts.vdf")
            } else {
                errcode::with_detail(errcode::UNREADABLE, format!("shortcuts.vdf: {error}"))
            }
        })?;
        let ids = parse_binary_shortcut_ids(&bytes).map_err(|error| {
            errcode::with_detail(
                errcode::UNREADABLE,
                format!("failed to parse shortcuts.vdf: {error}"),
            )
        })?;
        all_ids.extend(ids);
    }

    Ok(all_ids)
}

/// Findet alle AppIDs in `config.vdf`, die für das angegebene Tool konfiguriert sind.
#[cfg(test)]
fn find_apps_using_compat_tool(
    steam_root: &Path,
    tool_name: &str,
) -> Result<(Vec<u32>, bool), String> {
    #[cfg(target_os = "linux")]
    {
        let canonical_root = fs::canonicalize(steam_root).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot canonicalize Steam root: {error}"),
            )
        })?;
        let root_fd = open_bound_root_fd(&canonical_root, &mut || {})?;
        let mut no_hook = |_: DeleteReadStage, _: Option<&mut std::fs::File>| {};
        find_apps_using_compat_tool_linux_with_hook(&root_fd, &[tool_name], &mut no_hook)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (steam_root, tool_name);
        Err(delete_inspection_unsupported())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn find_apps_using_compat_tool_linux_with_hook<F>(
    steam_root_fd: &OwnedFd,
    tool_names: &[&str],
    hook: &mut F,
) -> Result<(Vec<u32>, bool), String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    let config_fd = match open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new("config")) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open config directory: {error}"),
            ))
        }
    };
    hook(DeleteReadStage::ConfigBeforeOpen, None);
    let mut config_vdf = match open_file_at(config_fd.as_raw_fd(), OsStr::new("config.vdf")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open config.vdf: {error}"),
            ))
        }
    };
    hook(DeleteReadStage::ConfigAfterOpen, Some(&mut config_vdf));
    let content = read_fd_text_with_hook(
        &mut config_vdf,
        "config.vdf",
        MAX_DELETE_CONFIG_BYTES,
        hook,
        DeleteReadStage::ConfigBeforeRead,
    )
    .map_err(|error| errcode::remap_size_limit(error, "config.vdf"))?;

    let tokens = vdf_patch::tokenize(&content)
        .map_err(|error| errcode::with_context("cannot tokenize config.vdf", &error))?;

    let base_paths = [
        vec![
            "InstallConfigStore",
            "Software",
            "Valve",
            "Steam",
            "CompatToolMapping",
        ],
        vec!["Software", "Valve", "Steam", "CompatToolMapping"],
    ];

    let mut affected_apps = Vec::new();
    let mut global_default = false;

    for base in &base_paths {
        let mut curr_from = 0;
        let mut curr_to = tokens.len();
        let mut found = true;

        for key in base {
            match vdf_patch::find_entry(&tokens, curr_from, curr_to, key)? {
                Some(e) => {
                    if let Some((sub_from, sub_to)) = e.block {
                        curr_from = sub_from;
                        curr_to = sub_to;
                    } else {
                        found = false;
                        break;
                    }
                }
                None => {
                    found = false;
                    break;
                }
            }
        }

        if found {
            let mapping_entries = vdf_patch::scan_entries(&tokens, curr_from, curr_to)?;
            for app_entry in mapping_entries {
                if let vdf_patch::TokenKind::String(app_key) = &app_entry.key.kind {
                    if app_key.chars().all(|c| c.is_ascii_digit()) {
                        // appId 0 ist steams globale standard-zuordnung, kein
                        // spiel: sie wird als eigene folge gemeldet.
                        let app_id = if app_key == "0" {
                            None
                        } else {
                            Some(crate::commands::scope::parse_app_id(app_key)?)
                        };
                        if let Some((sub_from, sub_to)) = app_entry.block {
                            let sub_entries = vdf_patch::scan_entries(&tokens, sub_from, sub_to)?;
                            for sub in sub_entries {
                                if let vdf_patch::TokenKind::String(sub_k) = &sub.key.kind {
                                    if sub_k.eq_ignore_ascii_case("name") {
                                        if let vdf_patch::TokenKind::String(tool) = &sub.value.kind
                                        {
                                            if tool_names.contains(&tool.as_str()) {
                                                match app_id {
                                                    Some(id) => affected_apps.push(id),
                                                    None => global_default = true,
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    affected_apps.sort_unstable();
    affected_apps.dedup();
    Ok((affected_apps, global_default))
}

#[cfg(test)]
#[path = "delete_usage_tests.rs"]
mod tests;
