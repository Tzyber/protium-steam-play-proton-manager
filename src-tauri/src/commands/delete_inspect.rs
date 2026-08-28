// Delete-Inspektion (Prepare/Execute-Liveprüfung) und ihre fd-gebundenen
// Reader, von steam.rs entlang der Verantwortlichkeit geteilt. Gehärtete
// Delete-Semantik bleibt unverändert; die no-follow-Helfer selbst liegen in
// steam.rs und werden hier importiert.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};

use crate::commands::path::{is_safe_path, sanitize_path};
use crate::commands::shortcuts_bin::parse_binary_shortcut_ids;
#[cfg(target_os = "linux")]
use crate::commands::steam::{
    ensure_regular_fd, open_bound_root_fd, open_dir_at, open_external_library_fd_with_hook,
    open_file_at,
};
use crate::commands::steam::{
    is_managed_ge_name, read_library_folders, DeleteConsequence, DeletionInspection,
};
use crate::commands::vdf_patch;

/// Grössenlimit für shortcuts.vdf-reads im delete-pipeline (analog zu den
/// 16-MiB-caps der übrigen environment-reads).
pub(super) const MAX_SHORTCUTS_VDF_BYTES: u64 = 16 * 1024 * 1024;

/// steam-schreibweise der compat-tool-priority im mapping.
pub(super) const STEAM_COMPAT_PRIORITY: &str = "250";

/// Caps für die delete-pipeline-reads: appmanifeste (analog 1-MiB-read im
/// valve-pfad) und config.vdf. ohne cap könnte eine präparierte datei jeden
/// löschversuch in eine voll-allokation (oom) treiben.
pub(super) const MAX_DELETE_MANIFEST_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_DELETE_CONFIG_BYTES: u64 = 16 * 1024 * 1024;

#[cfg(not(target_os = "linux"))]
fn delete_inspection_unsupported() -> String {
    "delete inspection requires Linux no-follow descriptors".into()
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeleteReadStage {
    ManifestBeforeOpen,
    ManifestAfterOpen,
    ManifestBeforeRead,
    ShortcutsBeforeOpen,
    ShortcutsAfterOpen,
    ShortcutsBeforeRead,
    ConfigBeforeOpen,
    ConfigAfterOpen,
    ConfigBeforeRead,
}

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
    let length = ensure_regular_fd(file, label)?;
    if length > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} read limit overflows"))?;
    hook(stage, Some(file));
    let mut text = String::new();
    file.take(read_limit)
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if text.len() as u64 > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    Ok(text)
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
    let length = ensure_regular_fd(file, label)?;
    if length > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} read limit overflows"))?;
    hook(stage, Some(file));
    let mut bytes = Vec::new();
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    Ok(bytes)
}

#[cfg(test)]
pub(super) fn is_app_installed_in_libraries(
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
            Err(error) => return Err(format!("cannot canonicalize Steam library: {error}")),
        };
        let mut no_hook = |_| {};
        let library_fd = open_external_library_fd_with_hook(&canonical, &mut no_hook)?;
        let steamapps_fd = match open_dir_at(library_fd.as_raw_fd(), OsStr::new("steamapps")) {
            Ok(fd) => fd,
            // fehlende steamapps (z. b. nicht gemountete volume) kann keine
            // manifeste tragen: überspringen statt fail (INV-2), kein fehler.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot open Steam library steamapps: {error}")),
        };
        let proc_dir = Path::new("/proc/self/fd").join(steamapps_fd.as_raw_fd().to_string());
        let entries = fs::read_dir(&proc_dir)
            .map_err(|error| format!("cannot read manifest directory: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("cannot read manifest entry: {error}"))?;
            let name = entry.file_name();
            let name_string = name.to_string_lossy();
            let Some(id_part) = name_string
                .strip_prefix("appmanifest_")
                .and_then(|rest| rest.strip_suffix(".acf"))
            else {
                continue;
            };
            let file_id = crate::commands::scope::parse_app_id(id_part)
                .map_err(|_| format!("invalid app manifest filename: {name_string}"))?;

            hook(DeleteReadStage::ManifestBeforeOpen, None);
            let mut manifest = match open_file_at(steamapps_fd.as_raw_fd(), &name) {
                Ok(file) => file,
                // manifest zwischen read_dir und openat verschwunden: skip
                // (INV-2) statt fail — die löschpipeline revalidiert das ziel
                // ohnehin erneut und der claim bindet die identität.
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("cannot open manifest {name_string}: {error}"));
                }
            };
            hook(DeleteReadStage::ManifestAfterOpen, Some(&mut manifest));
            let content = read_fd_text_with_hook(
                &mut manifest,
                &format!("manifest {name_string}"),
                MAX_DELETE_MANIFEST_BYTES,
                hook,
                DeleteReadStage::ManifestBeforeRead,
            )
            .map_err(|error| {
                if error.contains("exceeds read limit") {
                    format!("manifest {name_string} exceeds size limit")
                } else {
                    error
                }
            })?;
            let internal_id = match vdf_patch::get_vdf_value(&content, &["AppState", "appid"])
                .map_err(|error| format!("cannot parse manifest {name_string}: {error}"))?
            {
                Some(value) => value,
                None => vdf_patch::get_vdf_value(&content, &["AppState", "AppId"])
                    .map_err(|error| format!("cannot parse manifest {name_string}: {error}"))?
                    .ok_or_else(|| format!("manifest {name_string} has no AppState appid"))?,
            };
            let internal_id = crate::commands::scope::parse_app_id(internal_id.trim())
                .map_err(|_| format!("manifest {name_string} has invalid appid"))?;
            if file_id != internal_id {
                return Err(format!(
                    "manifest {name_string} filename/appid mismatch ({file_id} != {internal_id})"
                ));
            }
            if internal_id == app_id {
                let game_name = vdf_patch::get_vdf_value(&content, &["AppState", "name"])
                    .map_err(|error| format!("cannot parse manifest name {name_string}: {error}"))?
                    .unwrap_or_default();
                return Ok(Some(game_name));
            }
        }
    }
    Ok(None)
}

pub(super) fn validate_trash_target(canon_str: &str, meta: &fs::Metadata) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        return Err("trash target must not be a symlink".into());
    }
    if !meta.is_dir() {
        return Err("trash target must be a directory".into());
    }

    let suffix = crate::commands::scope::suffix_after_steamapps(canon_str)?;
    let name = suffix
        .strip_prefix(".protium-trash/")
        .ok_or_else(|| "trash target must be inside .protium-trash".to_string())?;
    if name.is_empty() || name.contains('/') {
        return Err("trash target must be a direct child of .protium-trash".into());
    }

    let mut fields = name.split('_');
    let typ = fields
        .next()
        .ok_or_else(|| "trash target has invalid name".to_string())?;
    let app_id_str = fields
        .next()
        .ok_or_else(|| "trash target has invalid name".to_string())?;
    let timestamp_str = fields
        .next()
        .ok_or_else(|| "trash target has invalid name".to_string())?;
    if fields.next().is_some() {
        return Err("trash target has invalid name".into());
    }

    crate::commands::scope::parse_compat_id((typ, app_id_str))?;
    if !timestamp_str.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "trash target has non-numeric timestamp: {timestamp_str}"
        ));
    }
    let timestamp = timestamp_str
        .parse::<u64>()
        .map_err(|_| format!("trash target timestamp out of range: {timestamp_str}"))?;
    if timestamp == 0 {
        return Err("trash target timestamp must be positive".into());
    }

    Ok(())
}

#[cfg(test)]
pub(super) fn read_all_shortcut_app_ids(steam_root: &Path) -> Result<HashSet<u32>, String> {
    #[cfg(target_os = "linux")]
    {
        let canonical_root = fs::canonicalize(steam_root)
            .map_err(|error| format!("cannot canonicalize Steam root: {error}"))?;
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
        Err(error) => return Err(format!("cannot open userdata directory: {error}")),
    };

    let proc_dir = Path::new("/proc/self/fd").join(userdata_fd.as_raw_fd().to_string());
    let entries = fs::read_dir(&proc_dir)
        .map_err(|error| format!("cannot read userdata directory: {error}"))?;
    let mut all_ids = HashSet::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot read userdata entry: {error}"))?;
        let entry_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect userdata entry: {error}"))?;
        if entry_type.is_symlink() {
            return Err(format!(
                "userdata entry {} is a symlink",
                entry.path().display()
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
            Err(error) => return Err(format!("cannot open userdata account: {error}")),
        };
        let config_fd = match open_dir_at(account_fd.as_raw_fd(), OsStr::new("config")) {
            Ok(fd) => fd,
            // fehlendes account/config bedeutet, dass dieser account keine
            // shortcuts beitragen kann.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot open userdata config: {error}")),
        };

        hook(DeleteReadStage::ShortcutsBeforeOpen, None);
        let mut shortcuts = match open_file_at(config_fd.as_raw_fd(), OsStr::new("shortcuts.vdf")) {
            Ok(file) => file,
            // fehlende shortcuts.vdf bleibt ein skip wie im bisherigen Pfad.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot open shortcuts.vdf: {error}")),
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
            if error.contains("exceeds read limit") {
                "shortcuts.vdf is too large".to_string()
            } else {
                format!("cannot read shortcuts.vdf: {error}")
            }
        })?;
        let ids = parse_binary_shortcut_ids(&bytes)
            .map_err(|error| format!("failed to parse shortcuts.vdf: {error}"))?;
        all_ids.extend(ids);
    }

    Ok(all_ids)
}

/// Findet alle AppIDs in `config.vdf`, die für das angegebene Tool konfiguriert sind.
#[cfg(test)]
pub(super) fn find_apps_using_compat_tool(
    steam_root: &Path,
    tool_name: &str,
) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "linux")]
    {
        let canonical_root = fs::canonicalize(steam_root)
            .map_err(|error| format!("cannot canonicalize Steam root: {error}"))?;
        let root_fd = open_bound_root_fd(&canonical_root, &mut || {})?;
        let mut no_hook = |_: DeleteReadStage, _: Option<&mut std::fs::File>| {};
        find_apps_using_compat_tool_linux_with_hook(&root_fd, tool_name, &mut no_hook)
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
    tool_name: &str,
    hook: &mut F,
) -> Result<Vec<u32>, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    let config_fd = match open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new("config")) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot open config directory: {error}")),
    };
    hook(DeleteReadStage::ConfigBeforeOpen, None);
    let mut config_vdf = match open_file_at(config_fd.as_raw_fd(), OsStr::new("config.vdf")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot open config.vdf: {error}")),
    };
    hook(DeleteReadStage::ConfigAfterOpen, Some(&mut config_vdf));
    let content = read_fd_text_with_hook(
        &mut config_vdf,
        "config.vdf",
        MAX_DELETE_CONFIG_BYTES,
        hook,
        DeleteReadStage::ConfigBeforeRead,
    )
    .map_err(|error| {
        if error.contains("exceeds read limit") {
            "config.vdf exceeds size limit".to_string()
        } else {
            error
        }
    })?;

    let tokens =
        vdf_patch::tokenize(&content).map_err(|e| format!("cannot tokenize config.vdf: {e}"))?;

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
                        // steam schreibt selbst einen default-eintrag mit appId 0
                        // (globale standard-zuordnung, kein spiel) — der darf
                        // den lösch-durchlauf nicht brechen.
                        if app_key == "0" {
                            continue;
                        }
                        let app_id = crate::commands::scope::parse_app_id(app_key)?;
                        if let Some((sub_from, sub_to)) = app_entry.block {
                            let sub_entries = vdf_patch::scan_entries(&tokens, sub_from, sub_to)?;
                            for sub in sub_entries {
                                if let vdf_patch::TokenKind::String(sub_k) = &sub.key.kind {
                                    if sub_k.eq_ignore_ascii_case("name") {
                                        if let vdf_patch::TokenKind::String(tool) = &sub.value.kind
                                        {
                                            if tool == tool_name {
                                                affected_apps.push(app_id);
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
    Ok(affected_apps)
}

/// Inspiziert ein Löschziel anhand der aktuellen Steam-Zustände (Manifeste, Shortcuts, Configs).
/// Fail-Closed: Wenn das Ziel kein Orphan ist (Spiel/Shortcut vorhanden) oder Sicherheitsregeln
/// verletzt sind, bricht die Inspektion mit einem Fehler ab.
pub(super) fn inspect_deletion_target(
    steam_root_str: &str,
    target_type: &str,
    target_path_str: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
) -> Result<DeletionInspection, String> {
    #[cfg(target_os = "linux")]
    {
        let mut no_hook = |_: DeleteReadStage, _: Option<&mut std::fs::File>| {};
        inspect_deletion_target_linux_with_hook(
            steam_root_str,
            target_type,
            target_path_str,
            scope_ok,
            &mut no_hook,
        )
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (steam_root_str, target_type, target_path_str, scope_ok);
        Err(delete_inspection_unsupported())
    }
}

#[cfg(target_os = "linux")]
fn inspect_deletion_target_linux_with_hook<F>(
    steam_root_str: &str,
    target_type: &str,
    target_path_str: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    hook: &mut F,
) -> Result<DeletionInspection, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    sanitize_path(steam_root_str, "steam root")?;
    sanitize_path(target_path_str, "deletion target")?;

    let steam_root_input = Path::new(steam_root_str);
    if !scope_ok(steam_root_input) {
        return Err("steam root outside allowed scope".into());
    }
    let steam_root = fs::canonicalize(steam_root_input)
        .map_err(|error| format!("cannot canonicalize Steam root: {error}"))?;
    if !scope_ok(&steam_root) {
        return Err("steam root outside allowed scope".into());
    }
    let steam_root_fd = open_bound_root_fd(&steam_root, &mut || {})?;

    let canonical = crate::commands::path::canonicalize_no_symlink(target_path_str)?;
    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // das target selbst muss im scope liegen, nicht nur der root: sonst wäre
    // eine library ausserhalb der erlaubten roots loeschbar (lexikalischer
    // suffix-anchor reicht nicht). die scope_ok-closure ist backend-seitig
    // gegen den environment-snapshot gebunden (kein webview-fs-grant).
    if !scope_ok(&canonical) {
        return Err("deletion target outside allowed scope".into());
    }

    let meta = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlink rejected, will not delete".into());
    }

    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);

    match target_type {
        "orphan" => {
            if !meta.is_dir() {
                return Err("orphan target must be a directory".into());
            }
            let suffix = crate::commands::scope::suffix_after_steamapps(&canon_str)?;
            let (typ, app_id_str) = crate::commands::scope::parse_compat_id(
                suffix
                    .split_once('/')
                    .ok_or_else(|| "invalid suffix structure".to_string())?,
            )?;
            let app_id = crate::commands::scope::parse_app_id(app_id_str)?;

            let libraries = read_library_folders(&steam_root)?;

            let lib_str = crate::commands::scope::library_of(&canon_str)?;
            let lib_path = PathBuf::from(lib_str);
            if !libraries.iter().any(|l| l == &lib_path) {
                return Err("target library is not listed in libraryfolders.vdf".into());
            }

            if let Some(game_name) =
                is_app_installed_in_libraries_linux_with_hook(&libraries, app_id, hook)?
            {
                let display = if game_name.is_empty() {
                    app_id.to_string()
                } else {
                    game_name
                };
                return Err(format!(
                    "target is not an orphan: game \"{display}\" ({app_id}) is currently installed"
                ));
            }

            let shortcut_ids = read_all_shortcut_app_ids_linux_with_hook(&steam_root_fd, hook)?;
            if shortcut_ids.contains(&app_id) {
                return Err(format!(
                    "target is not an orphan: app {app_id} exists as a non-steam shortcut"
                ));
            }

            let (action, desc) = match typ {
                "compatdata" => (
                    "trash",
                    format!("Prefix von app {app_id} in den Papierkorb verschieben"),
                ),
                "shadercache" => (
                    "permanentDelete",
                    format!("Shader-Cache von app {app_id} dauerhaft löschen"),
                ),
                _ => return Err("unsupported orphan type".into()),
            };

            let consequences = vec![DeleteConsequence {
                path: canon_str.to_string(),
                action: action.to_string(),
                description: desc,
                affected_app_ids: Some(vec![app_id]),
            }];

            Ok(DeletionInspection {
                target_path: target_path_str.to_string(),
                canonical_path: canon_str.to_string(),
                target_type: target_type.to_string(),
                dev,
                ino,
                consequences,
            })
        }
        "trash" => {
            validate_trash_target(&canon_str, &meta)?;
            let consequences = vec![DeleteConsequence {
                path: canon_str.to_string(),
                action: "permanentDelete".to_string(),
                description: format!(
                    "Papierkorb-Eintrag {} dauerhaft löschen",
                    canonical.file_name().unwrap_or_default().to_string_lossy()
                ),
                affected_app_ids: None,
            }];

            Ok(DeletionInspection {
                target_path: target_path_str.to_string(),
                canonical_path: canon_str.to_string(),
                target_type: target_type.to_string(),
                dev,
                ino,
                consequences,
            })
        }
        "compatTool" => {
            if !meta.is_dir() {
                return Err("compat tool target must be a directory".into());
            }
            let tool_name = canonical
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| "invalid tool folder name".to_string())?;

            if !is_managed_ge_name(tool_name) {
                return Err(format!(
                    "only managed GE-Proton tools can be deleted, got: {tool_name}"
                ));
            }

            let expected_parent = steam_root.join("compatibilitytools.d");
            if canonical.parent() != Some(&expected_parent) {
                return Err("compat tool must be directly inside compatibilitytools.d".into());
            }

            let affected_apps =
                find_apps_using_compat_tool_linux_with_hook(&steam_root_fd, tool_name, hook)?;
            let consequences = vec![DeleteConsequence {
                path: canon_str.to_string(),
                action: "permanentDelete".to_string(),
                description: format!("GE-Proton-Tool {tool_name} dauerhaft löschen"),
                affected_app_ids: if affected_apps.is_empty() {
                    None
                } else {
                    Some(affected_apps)
                },
            }];

            Ok(DeletionInspection {
                target_path: target_path_str.to_string(),
                canonical_path: canon_str.to_string(),
                target_type: target_type.to_string(),
                dev,
                ino,
                consequences,
            })
        }
        _ => Err(format!("unknown target type: {target_type}")),
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn inspect_deletion_target_with_test_hook<F>(
    steam_root_str: &str,
    target_type: &str,
    target_path_str: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    hook: &mut F,
) -> Result<DeletionInspection, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    inspect_deletion_target_linux_with_hook(
        steam_root_str,
        target_type,
        target_path_str,
        scope_ok,
        hook,
    )
}
