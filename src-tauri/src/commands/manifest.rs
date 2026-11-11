// Manifest-Lesen und -Parsen der Compat-Autorität (Audit 3.11).

#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::RawFd;

#[cfg(target_os = "linux")]
use crate::commands::compat_auth::CompatAuthStage;
#[cfg(target_os = "linux")]
use crate::commands::errcode;
#[cfg(target_os = "linux")]
use crate::commands::fd::{open_file_at, read_fd_bytes};
#[cfg(target_os = "linux")]
use crate::commands::vdf_patch;

/// Der eine Deckel für appmanifest-reads (1 MiB), geteilt von der
/// Valve-Autorität und der delete-inspektion: appmanifeste sind klein, eine
/// übergrosse datei ist präpariert. Der frühere doppelte cap
/// (`MAX_DELETE_MANIFEST_BYTES`) ist entfallen (r-05).
pub(super) const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Blocked: Autoritätsverletzung (Symlink, Nicht-Verzeichnis, AppID-Mismatch). Unreadable: Lesefehler.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(super) enum ManifestReadError {
    Blocked(String),
    Unreadable(String),
}

#[cfg(target_os = "linux")]
impl ManifestReadError {
    pub(super) fn into_message(self) -> String {
        match self {
            Self::Blocked(message) | Self::Unreadable(message) => message,
        }
    }
}

/// Zeitpunkte des einen Manifest-Readers (r-05). `delete_usage` bildet alle
/// drei auf seine `DeleteReadStage` ab, die Valve-Autorität nur `AfterOpen` auf
/// ihren Hook-kanal 4; die Zeitpunkte bleiben je Aufrufer unverändert.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ManifestStage {
    BeforeOpen,
    AfterOpen,
    BeforeRead,
}

/// Identität eines gelesenen Manifests: die interne AppID (nach
/// Dateiname-/AppID-Prüfung) und der optionale Anzeigename.
#[cfg(target_os = "linux")]
pub(super) struct ManifestIdentity {
    pub(super) app_id: u32,
    pub(super) name: Option<String>,
}

/// Liest genau ein `appmanifest_<id>.acf` aus einem bereits gebundenen
/// steamapps-Deskriptor (r-05): no-follow-Open, gedeckelter Read, AppID inkl.
/// „AppId“-Fallback, Dateiname-/AppID-Mismatch. `file_id` ist die aus dem
/// Dateinamen gelesene ID, an der der innere `appid` geprüft wird. Die Politik
/// (Skip vs. fail-closed, Hook-Zeitpunkte) bleibt beim Aufrufer; `Ok(None)`
/// heißt „Manifest fehlt/für diese App nicht vorhanden“.
#[cfg(target_os = "linux")]
pub(super) fn read_app_manifest_with_hook(
    steamapps_fd: RawFd,
    manifest_name: &OsStr,
    file_id: u32,
    hook: &mut dyn FnMut(ManifestStage, Option<&mut std::fs::File>),
) -> Result<Option<ManifestIdentity>, ManifestReadError> {
    let manifest_name = manifest_name.to_string_lossy();
    hook(ManifestStage::BeforeOpen, None);
    let mut manifest = match open_file_at(steamapps_fd, OsStr::new(manifest_name.as_ref())) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            let message = format!("cannot open manifest {manifest_name}: {error}");
            return Err(
                if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                    ManifestReadError::Blocked(errcode::with_detail(errcode::BLOCKED, message))
                } else {
                    ManifestReadError::Unreadable(errcode::with_detail(
                        errcode::code_for_io(&error),
                        message,
                    ))
                },
            );
        }
    };
    hook(ManifestStage::AfterOpen, Some(&mut manifest));
    let unreadable = ManifestReadError::Unreadable;
    let label = format!("manifest {manifest_name}");
    let bytes = read_fd_bytes(&mut manifest, &label, MAX_MANIFEST_BYTES, &mut |file| {
        hook(ManifestStage::BeforeRead, Some(file));
    })
    .map_err(unreadable)?;
    let content = String::from_utf8(bytes)
        .map_err(|error| unreadable(errcode::read_error(&label, &error)))?;
    // A-04: jede meldung dieses readers trägt den kanonischen code im leitfeld,
    // wie die zeile darüber (`cannot read {label}`); sonst fällt die
    // klassifikation in der oberfläche auf "unbekannt" zurück.
    let parse_error = |error| {
        unreadable(errcode::with_detail(
            errcode::UNREADABLE,
            format!("cannot parse manifest {manifest_name}: {error}"),
        ))
    };
    let internal_id = vdf_patch::get_vdf_value(&content, &["AppState", "appid"])
        .map_err(parse_error)?
        .or(vdf_patch::get_vdf_value(&content, &["AppState", "AppId"]).map_err(parse_error)?)
        .ok_or_else(|| {
            unreadable(errcode::with_detail(
                errcode::UNREADABLE,
                format!("manifest {manifest_name} has no AppState appid"),
            ))
        })?;
    let internal_id = crate::commands::scope::parse_app_id(internal_id.trim()).map_err(|_| {
        unreadable(errcode::with_detail(
            errcode::UNREADABLE,
            format!("manifest {manifest_name} has invalid appid"),
        ))
    })?;
    if internal_id != file_id {
        return Err(ManifestReadError::Blocked(errcode::with_detail(
            errcode::BLOCKED,
            format!(
                "manifest {manifest_name} filename/appid mismatch ({file_id} != {internal_id})"
            ),
        )));
    }
    // der name wird erst nach belegter identität gelesen; die lookup-region ist
    // dieselbe wie bei `appid`, ein parsefehler hätte also schon dort gezogen.
    let name = vdf_patch::get_vdf_value(&content, &["AppState", "name"]).map_err(|error| {
        unreadable(errcode::with_detail(
            errcode::UNREADABLE,
            format!("cannot parse manifest name {manifest_name}: {error}"),
        ))
    })?;
    Ok(Some(ManifestIdentity {
        app_id: internal_id,
        name,
    }))
}

#[cfg(target_os = "linux")]
pub(super) fn is_app_installed_in_steamapps_fd<F>(
    steamapps_fd: RawFd,
    app_id: u32,
    hook: &mut F,
) -> Result<bool, ManifestReadError>
where
    F: FnMut(CompatAuthStage),
{
    let manifest_name = format!("appmanifest_{app_id}.acf");
    // appmanifeste sind klein; dasselbe limit wie im valve-pfad
    // (delete_usage), nicht das 16-MiB-limit der config-dateien.
    let mut manifest_hook = |stage: ManifestStage, _file: Option<&mut std::fs::File>| {
        if stage == ManifestStage::AfterOpen {
            hook(CompatAuthStage::ManifestOpened);
        }
    };
    match read_app_manifest_with_hook(
        steamapps_fd,
        OsStr::new(&manifest_name),
        app_id,
        &mut manifest_hook,
    )? {
        // der dateiname-/appid-mismatch ist im reader bereits fail-closed, ein
        // vorhandenes manifest belegt die identität also schon.
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
