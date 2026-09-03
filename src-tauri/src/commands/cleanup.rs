// ---- papierkorb-logik (list_trash_entries) ----

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::commands::scope::EnvironmentState;
use crate::commands::spawn_blocking_io;

/// name des papierkorb-verzeichnisses, existiert genau einmal hier, weil der
/// Backend-Command den Pfad innerhalb des aktuellen Environment-Snapshots
/// konstruiert.
pub(crate) const TRASH_DIR_NAME: &str = ".protium-trash";

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
    /// kanonischer pfad des papierkorbs, den wir wirklich gelesen haben.
    /// das frontend baut eintragspfade daraus, statt selbst zu joinen
    /// sonst driftet die anzeige bei symlinks vom echten ort.
    pub dir: String,
    pub present: bool,
    pub entries: Vec<TrashDirEntry>,
}

fn list_trash_entries_at(real: &Path) -> Result<TrashListing, String> {
    let library_metadata = fs::symlink_metadata(real).map_err(|error| error.to_string())?;
    if library_metadata.file_type().is_symlink() || !library_metadata.is_dir() {
        return Err("library path is not a regular directory".into());
    }
    let steamapps = real.join("steamapps");
    let steamapps_metadata = fs::symlink_metadata(&steamapps).map_err(|error| error.to_string())?;
    if steamapps_metadata.file_type().is_symlink() || !steamapps_metadata.is_dir() {
        return Err("library steamapps is not a regular directory".into());
    }
    let trash_dir = steamapps.join(TRASH_DIR_NAME);
    let dir = trash_dir.to_string_lossy().into_owned();

    // symlink_metadata: ein symlink an dieser stelle wird nicht verfolgt
    let md = match fs::symlink_metadata(&trash_dir) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrashListing {
                dir,
                present: false,
                entries: Vec::new(),
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    if md.file_type().is_symlink() {
        return Err("trash dir is a symlink, refusing to read".into());
    }
    if !md.is_dir() {
        return Err("trash path is not a directory".into());
    }

    let mut entries = Vec::new();
    for e in fs::read_dir(&trash_dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        entries.push(TrashDirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
        });
    }

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
