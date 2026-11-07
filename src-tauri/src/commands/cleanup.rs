// ---- papierkorb-logik (list_trash_entries) ----

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::commands::delete_ops::TrashListingHandle;
use crate::commands::errcode;
use crate::commands::scope::EnvironmentState;
use crate::commands::spawn_blocking_io;

/// ein verzeichniseintrag im papierkorb. is_symlink kommt aus file_type() des
/// read_dir-eintrags, folgt also KEINEM symlink.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// ergebnis von list_trash_entries. `present` unterscheidet "kein papierkorb
/// vorhanden" (normalfall, kein fehler) von einem lesefehler (Err).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashListing {
    /// geprüfter referenzpfad des papierkorbs: dorthin zeigt der deskriptor,
    /// über den gelesen wurde. das frontend baut eintragspfade daraus, statt
    /// selbst zu joinen, sonst driftet die anzeige vom echten ort.
    pub dir: String,
    pub present: bool,
    pub entries: Vec<TrashDirEntry>,
}

fn list_trash_entries_at(real: &Path) -> Result<TrashListing, String> {
    // dieselbe gebundene kette wie der löschpfad; der papierkorb wird dabei
    // nicht angelegt.
    let handle = crate::commands::delete_ops::open_trash_dir_for_listing(real)?;
    collect_trash_entries(&handle)
}

/// derselbe lesepfad wie die produktion, nur mit mutierbaren prüffenstern.
#[cfg(test)]
fn list_trash_entries_at_with_hook(
    real: &Path,
    hook: &mut dyn FnMut(crate::commands::delete_ops::TrashListingStage),
) -> Result<TrashListing, String> {
    let handle = crate::commands::delete_ops::open_trash_dir_for_listing_with_hook(real, hook)?;
    collect_trash_entries(&handle)
}

/// die einzige lesestelle des papierkorbs: über den deskriptor-pfad des
/// handles, nie über den referenzpfad. danach wird der deskriptor nachgeprüft,
/// damit `dir` nicht auf einen anderen ort zeigt als die gelesenen einträge.
fn collect_trash_entries(handle: &TrashListingHandle) -> Result<TrashListing, String> {
    let dir = handle.wire_dir().to_string_lossy().into_owned();
    if !handle.present() {
        // WARUM: das listing legt den papierkorb nicht an. ein halb gefüllter
        // handle wäre dagegen ein bindungsfehler, kein "nicht vorhanden".
        if handle.entries_path().is_some() {
            return Err(errcode::UNREADABLE.to_string());
        }
        return Ok(TrashListing {
            dir,
            present: false,
            entries: Vec::new(),
        });
    }

    let entries_path = handle
        .entries_path()
        .ok_or_else(|| errcode::UNREADABLE.to_string())?;
    let mut entries = Vec::new();
    for e in fs::read_dir(entries_path)
        .map_err(|error| errcode::with_detail(errcode::code_for_io(&error), error))?
    {
        let e = e.map_err(|error| errcode::with_detail(errcode::code_for_io(&error), error))?;
        let ft = e
            .file_type()
            .map_err(|error| errcode::with_detail(errcode::code_for_io(&error), error))?;
        entries.push(TrashDirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
        });
    }
    handle.recheck_after_read()?;

    Ok(TrashListing {
        dir,
        present: true,
        entries,
    })
}

/// listet `<library>/steamapps/.protium-trash`.
///
/// WARUM in rust und nicht per plugin-fs readDir im frontend: der aktuelle
/// Environment-Snapshot autorisiert die Library und den Backend-Read atomar;
/// die Webview erhält dafür keinen Dateisystem-Grant.
/// async + spawn_blocking (verzeichnis-read auf dem main-thread vermeiden).
#[tauri::command]
pub async fn list_trash_entries(
    state: State<'_, EnvironmentState>,
    library: String,
) -> Result<TrashListing, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_library(&library, |real| list_trash_entries_at(&real))
    })
    .await
}

#[cfg(test)]
#[path = "cleanup_tests.rs"]
mod tests;
