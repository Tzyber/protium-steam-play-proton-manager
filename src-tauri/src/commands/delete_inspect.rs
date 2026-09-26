// Delete-Inspektion (Prepare/Execute-Liveprüfung) und ihre fd-gebundenen
// Reader, von steam.rs entlang der Verantwortlichkeit geteilt. Gehärtete
// Delete-Semantik bleibt unverändert; die no-follow-Helfer liegen in fd.rs.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};

use crate::commands::compat_auth::is_managed_ge_name;
#[cfg(target_os = "linux")]
use crate::commands::compat_auth::{
    open_external_library_fd_with_hook, read_app_manifest_with_hook, ManifestStage,
};
// errcode ist plattformunabhängig und wird auch von den Nicht-Linux-Zweigen
// gebraucht (`validate_trash_target`, der unsupported-Arm); der frühere
// cfg-bedingte Import war inkonsistent (r-12).
use crate::commands::errcode;
// fd-Items gibt es nur unter Linux (fd.rs ist leer gekappt), deshalb wie ihre
// Aufrufer bedingt (r-12).
#[cfg(target_os = "linux")]
use crate::commands::fd::{open_bound_root_fd, open_dir_at, open_file_at};
use crate::commands::path::{is_safe_path, sanitize_path};
use crate::commands::scope::{read_library_folders_with_failures, LibraryUnavailableReason};
use crate::commands::shortcuts_bin::parse_binary_shortcut_ids;

use crate::commands::vdf_patch;

/// Strukturierte Löschfolge (Erzeugungs-Heimat: delete_inspect).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConsequence {
    pub path: String,
    pub action: String, // "trash" | "permanentDelete"
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_app_ids: Option<Vec<u32>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletionInspection {
    pub target_path: String,
    pub canonical_path: String,
    pub target_type: String,
    pub dev: u64,
    pub ino: u64,
    pub consequences: Vec<DeleteConsequence>,
}

/// Grössenlimit für shortcuts.vdf-reads im delete-pipeline (analog zu den
/// 16-MiB-caps der übrigen environment-reads).
const MAX_SHORTCUTS_VDF_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

/// Caps für die delete-pipeline-reads: config.vdf. Der appmanifest-Deckel
/// liegt als einziger in `compat_auth::MAX_MANIFEST_BYTES` (r-05). Ohne cap
/// könnte eine präparierte datei jeden löschversuch in eine voll-allokation
/// (oom) treiben.
const MAX_DELETE_CONFIG_BYTES: u64 = crate::commands::scope::MAX_VDF_READ_BYTES;

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
    String::from_utf8(bytes).map_err(|error| format!("cannot read {label}: {error}"))
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
fn is_app_installed_in_libraries_linux_with_hook<F>(
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

pub(super) fn validate_trash_target(canon_str: &str, meta: &fs::Metadata) -> Result<(), String> {
    // A-04: die live-ablehnungen dieser funktion tragen ihren kanonischen code;
    // als rohtext erschienen sie in der oberfläche als "unbekannt".
    if meta.file_type().is_symlink() {
        return Err(errcode::SYMLINK_REJECTED.into());
    }
    if !meta.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }

    let suffix = crate::commands::scope::suffix_after_steamapps(canon_str)?;
    let name = suffix
        .strip_prefix(".protium-trash/")
        .ok_or_else(|| errcode::NOT_AN_ORPHAN.to_string())?;
    if name.is_empty() || name.contains('/') {
        return Err(errcode::NOT_AN_ORPHAN.into());
    }

    let mut fields = name.split('_');
    let typ = fields
        .next()
        .ok_or_else(|| errcode::INVALID_ID.to_string())?;
    let app_id_str = fields
        .next()
        .ok_or_else(|| errcode::INVALID_ID.to_string())?;
    let timestamp_str = fields
        .next()
        .ok_or_else(|| errcode::INVALID_ID.to_string())?;
    if fields.next().is_some() {
        return Err(errcode::INVALID_ID.into());
    }

    crate::commands::scope::parse_compat_id((typ, app_id_str))?;
    if !timestamp_str.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(errcode::with_detail(
            errcode::INVALID_VALUE,
            format!("trash target has non-numeric timestamp: {timestamp_str}"),
        ));
    }
    let timestamp = timestamp_str.parse::<u64>().map_err(|_| {
        errcode::with_detail(
            errcode::INVALID_VALUE,
            format!("trash target timestamp out of range: {timestamp_str}"),
        )
    })?;
    if timestamp == 0 {
        return Err(errcode::with_detail(
            errcode::INVALID_VALUE,
            "trash target timestamp must be positive",
        ));
    }

    Ok(())
}

#[cfg(test)]
fn read_all_shortcut_app_ids(steam_root: &Path) -> Result<HashSet<u32>, String> {
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
fn read_all_shortcut_app_ids_linux_with_hook<F>(
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
            if errcode::has_code(&error, errcode::SIZE_LIMIT) {
                errcode::with_detail(errcode::SIZE_LIMIT, "shortcuts.vdf")
            } else {
                errcode::with_detail(errcode::UNREADABLE, format!("shortcuts.vdf: {error}"))
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
fn find_apps_using_compat_tool(steam_root: &Path, tool_name: &str) -> Result<Vec<u32>, String> {
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
fn find_apps_using_compat_tool_linux_with_hook<F>(
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
                        // (globale standard-zuordnung, kein spiel), der darf
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

/// Gemeinsamer Zielkontext der drei Löscharten (r-10): Eingabe- und kanonischer
/// Pfad, Zieltyp, das eine `symlink_metadata` und die daraus gelesene Identität.
struct DeleteTargetContext<'a> {
    target_path: &'a str,
    target_type: &'a str,
    canonical: &'a Path,
    canon_str: &'a str,
    meta: &'a fs::Metadata,
    dev: u64,
    ino: u64,
}

impl DeleteTargetContext<'_> {
    /// Die `DeletionInspection` aller drei Arme hat dieselbe Form; nur Aktion,
    /// Beschreibung und betroffene AppIDs unterscheiden sich.
    fn inspection(
        &self,
        action: &str,
        description: String,
        affected_app_ids: Option<Vec<u32>>,
    ) -> DeletionInspection {
        DeletionInspection {
            target_path: self.target_path.to_string(),
            canonical_path: self.canon_str.to_string(),
            target_type: self.target_type.to_string(),
            dev: self.dev,
            ino: self.ino,
            consequences: vec![DeleteConsequence {
                path: self.canon_str.to_string(),
                action: action.to_string(),
                description,
                affected_app_ids,
            }],
        }
    }
}

/// Löschziel „orphan" (compatdata/shadercache), r-10: fail-closed gegen
/// installierte Spiele, Shortcuts und gesperrte Libraries, danach die
/// Papierkorb- bzw. Dauerlöschfolge. Code und Fehlerreihenfolge unverändert.
#[cfg(target_os = "linux")]
fn inspect_orphan_target<F>(
    context: &DeleteTargetContext<'_>,
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    hook: &mut F,
) -> Result<DeletionInspection, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    if !context.meta.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    let suffix = crate::commands::scope::suffix_after_steamapps(context.canon_str)?;
    let (typ, app_id_str) = crate::commands::scope::parse_compat_id(
        suffix
            .split_once('/')
            .ok_or_else(|| "invalid suffix structure".to_string())?,
    )?;
    let app_id = crate::commands::scope::parse_app_id(app_id_str)?;

    let (libraries, unavailable) = read_library_folders_with_failures(steam_root)?;
    // fail-closed: ein scope- oder lesefehler einer gelisteten library
    // könnte ein installiertes spiel verbergen (INV-2). nur belegte
    // abwesenheit (`path-missing`) wird still übersprungen.
    if let Some(entry) = unavailable
        .iter()
        .find(|entry| entry.reason != LibraryUnavailableReason::PathMissing)
    {
        return Err(errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("library {} ({})", entry.path, entry.reason.as_str()),
        ));
    }

    let lib_str = crate::commands::scope::library_of(context.canon_str)?;
    let lib_path = PathBuf::from(lib_str);
    if !libraries.iter().any(|l| l == &lib_path) {
        return Err(errcode::with_detail(errcode::LIBRARY_NOT_LISTED, lib_str));
    }

    if let Some(game_name) =
        is_app_installed_in_libraries_linux_with_hook(&libraries, app_id, hook)?
    {
        let display = if game_name.is_empty() {
            app_id.to_string()
        } else {
            game_name
        };
        return Err(errcode::with_detail(
            errcode::NOT_AN_ORPHAN,
            format!("game \"{display}\" ({app_id}) is currently installed"),
        ));
    }

    let shortcut_ids = read_all_shortcut_app_ids_linux_with_hook(steam_root_fd, hook)?;
    if shortcut_ids.contains(&app_id) {
        return Err(errcode::with_detail(
            errcode::NOT_AN_ORPHAN,
            format!("app {app_id} exists as a non-steam shortcut"),
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
        _ => return Err(errcode::UNSUPPORTED_TARGET.into()),
    };

    Ok(context.inspection(action, desc, Some(vec![app_id])))
}

/// Löschziel „trash" (r-10): nur die Namensprüfung des Papierkorb-Eintrags und
/// die dauerhafte Löschung.
fn inspect_trash_target(context: &DeleteTargetContext<'_>) -> Result<DeletionInspection, String> {
    validate_trash_target(context.canon_str, context.meta)?;
    let description = format!(
        "Papierkorb-Eintrag {} dauerhaft löschen",
        context
            .canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    );
    Ok(context.inspection("permanentDelete", description, None))
}

/// Löschziel „compatTool" (r-10): nur verwaltete GE-Namen direkt in
/// `compatibilitytools.d`; die betroffenen AppIDs kommen aus `config.vdf`.
#[cfg(target_os = "linux")]
fn inspect_compat_tool_target<F>(
    context: &DeleteTargetContext<'_>,
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    hook: &mut F,
) -> Result<DeletionInspection, String>
where
    F: FnMut(DeleteReadStage, Option<&mut std::fs::File>),
{
    if !context.meta.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    let tool_name = context
        .canonical
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid tool folder name".to_string())?;

    if !is_managed_ge_name(tool_name) {
        return Err(errcode::with_detail(
            errcode::NOT_A_MANAGED_TOOL,
            format!("got: {tool_name}"),
        ));
    }

    let expected_parent = steam_root.join("compatibilitytools.d");
    if context.canonical.parent() != Some(&expected_parent) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            "compat tool must be directly inside compatibilitytools.d",
        ));
    }

    let affected_apps =
        find_apps_using_compat_tool_linux_with_hook(steam_root_fd, tool_name, hook)?;
    let affected_app_ids = if affected_apps.is_empty() {
        None
    } else {
        Some(affected_apps)
    };
    Ok(context.inspection(
        "permanentDelete",
        format!("GE-Proton-Tool {tool_name} dauerhaft löschen"),
        affected_app_ids,
    ))
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
        return Err(errcode::BLOCKED_LOCATION.into());
    }
    let steam_root = fs::canonicalize(steam_root_input)
        .map_err(|error| format!("cannot canonicalize Steam root: {error}"))?;
    if !scope_ok(&steam_root) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }
    let steam_root_fd = open_bound_root_fd(&steam_root, &mut || {})?;

    let canonical = crate::commands::path::canonicalize_no_symlink(target_path_str)?;
    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }

    // das target selbst muss im scope liegen, nicht nur der root: sonst wäre
    // eine library ausserhalb der erlaubten roots loeschbar (lexikalischer
    // suffix-anchor reicht nicht). die scope_ok-closure ist backend-seitig
    // gegen den environment-snapshot gebunden (kein webview-fs-grant).
    if !scope_ok(&canonical) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }

    let meta = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err(errcode::SYMLINK_REJECTED.into());
    }

    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);

    let context = DeleteTargetContext {
        target_path: target_path_str,
        target_type,
        canonical: &canonical,
        canon_str: &canon_str,
        meta: &meta,
        dev,
        ino,
    };

    // Die Zieltypen teilen sich den Kopf (Scope, Identität, Zielart) und
    // unterscheiden sich in Prüfliste und Löschfolge; je ein eigener Arm (r-10).
    match target_type {
        "orphan" => inspect_orphan_target(&context, &steam_root, &steam_root_fd, hook),
        "trash" => inspect_trash_target(&context),
        "compatTool" => inspect_compat_tool_target(&context, &steam_root, &steam_root_fd, hook),
        _ => Err(errcode::with_detail(
            errcode::UNSUPPORTED_TARGET,
            target_type,
        )),
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

#[cfg(test)]
#[path = "delete_inspect_tests.rs"]
mod tests;
