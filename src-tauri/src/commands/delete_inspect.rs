// Delete-Inspektion (Prepare/Execute-Liveprüfung): Zielkontext, Ablehnungen und
// Löschfolgen. Die fd-gebundenen Reader der Nutzungsabfragen liegen in
// delete_usage.rs, die no-follow-Helfer in fd.rs. Gehärtete Delete-Semantik
// bleibt unverändert.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;

use crate::commands::compat_auth::is_managed_ge_name;
#[cfg(target_os = "linux")]
use crate::commands::compat_auth::read_compat_tool_internal_name;
#[cfg(target_os = "linux")]
use crate::commands::delete_usage::{
    find_apps_using_compat_tool_linux_with_hook, is_app_installed_in_libraries_linux_with_hook,
    read_all_shortcut_app_ids_linux_with_hook,
};
// errcode ist plattformunabhängig und wird auch von den Nicht-Linux-Zweigen
// gebraucht (`validate_trash_target`, der unsupported-Arm); der frühere
// cfg-bedingte Import war inkonsistent (r-12).
use crate::commands::errcode;
// fd-Items gibt es nur unter Linux (fd.rs ist leer gekappt), deshalb wie ihre
// Aufrufer bedingt (r-12).
#[cfg(target_os = "linux")]
use crate::commands::fd::open_bound_root_fd;
use crate::commands::libraryfolders::read_library_folders_with_failures;
use crate::commands::path::{is_safe_path, sanitize_path};
use crate::commands::scope::LibraryUnavailableReason;

/// Strukturierte Löschfolge (Erzeugungs-Heimat: delete_inspect).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConsequence {
    pub path: String,
    pub action: String, // "trash" | "permanentDelete"
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_app_ids: Option<Vec<u32>>,
    /// INV-6: das tool ist steams globale standard-zuordnung (mapping `"0"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affects_global_default: Option<bool>,
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

#[cfg(not(target_os = "linux"))]
pub(super) fn delete_inspection_unsupported() -> String {
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
    // F-02: das artefakt ist hier der dateiname, nicht eine geprüfte eingabe.
    // Nicht-numerisch und überlauf sind derselbe dateisystem-formfehler wie
    // eine nicht-numerische appId (`parse_compat_id` → `unreadable`); nur der
    // im bereich liegende, semantisch verbotene wert 0 bleibt eine bewusste
    // wert-ablehnung (wie „appId 0 rejected").
    if !timestamp_str.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("trash target has non-numeric timestamp: {timestamp_str}"),
        ));
    }
    let timestamp = timestamp_str.parse::<u64>().map_err(|_| {
        errcode::with_detail(
            errcode::UNREADABLE,
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
                affects_global_default: None,
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
    let (typ, app_id_str) =
        crate::commands::scope::parse_compat_id(suffix.split_once('/').ok_or_else(|| {
            errcode::with_detail(errcode::INVALID_VALUE, "invalid suffix structure")
        })?)?;
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
        "compatdata" => ("trash", format!("move app {app_id} prefix to trash")),
        "shadercache" => (
            "permanentDelete",
            format!("permanently delete app {app_id} shader cache"),
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
        "permanently delete trash entry {}",
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
        .ok_or_else(|| errcode::with_detail(errcode::INVALID_VALUE, "invalid tool folder name"))?;

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

    // config.vdf trägt den internen namen aus der tool-vdf; er kann vom
    // ordnernamen abweichen. unlesbar heißt: nur der ordnername zählt.
    let internal_name = read_compat_tool_internal_name(steam_root_fd, tool_name);
    let mut names = vec![tool_name];
    names.extend(internal_name.as_deref());
    let (affected_apps, global_default) =
        find_apps_using_compat_tool_linux_with_hook(steam_root_fd, &names, hook)?;
    let affected_app_ids = if affected_apps.is_empty() {
        None
    } else {
        Some(affected_apps)
    };
    let mut inspection = context.inspection(
        "permanentDelete",
        format!("permanently delete GE-Proton tool {tool_name}"),
        affected_app_ids,
    );
    if global_default {
        inspection.consequences[0].affects_global_default = Some(true);
    }
    Ok(inspection)
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
    let steam_root = fs::canonicalize(steam_root_input).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot canonicalize Steam root: {error}"),
        )
    })?;
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

    let meta = fs::symlink_metadata(&canonical).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot stat deletion target: {error}"),
        )
    })?;
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
