use crate::commands::errcode;
use crate::commands::scope::EnvironmentState;
use tauri::State;

#[cfg(target_os = "linux")]
use {
    crate::commands::{
        compat_auth::{is_app_installed_in_steamapps_fd, ManifestReadError},
        external::{open_directory_with_handler, spawn_detached_os, SpawnOs},
        fd,
        scope::parse_app_id,
    },
    std::{
        ffi::OsStr,
        fs, io,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
        path::Path,
    },
};

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrefixReadStage {
    BeforeLibraryOpen,
    LibraryOpened,
    SteamappsOpened,
    PrefixOpened,
    BeforeHandler,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrefixError {
    NotFound,
    Unreadable,
    Blocked,
    HandlerUnavailable,
}

#[cfg(target_os = "linux")]
impl PrefixError {
    // SECURITY: Nur diese Codes verlassen den Command, nie ein Pfad oder Rohtext.
    fn code(self) -> &'static str {
        match self {
            Self::NotFound => errcode::NOT_FOUND,
            Self::Unreadable => errcode::UNREADABLE,
            Self::Blocked => errcode::BLOCKED,
            Self::HandlerUnavailable => errcode::HANDLER_UNAVAILABLE,
        }
    }
}

#[cfg(target_os = "linux")]
impl From<io::Error> for PrefixError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::PermissionDenied => Self::Unreadable,
            _ => Self::Blocked,
        }
    }
}

#[cfg(target_os = "linux")]
impl From<ManifestReadError> for PrefixError {
    fn from(error: ManifestReadError) -> Self {
        match error {
            ManifestReadError::Blocked(_) => Self::Blocked,
            ManifestReadError::Unreadable(_) => Self::Unreadable,
        }
    }
}

#[cfg(target_os = "linux")]
fn validate_handler_path(path: &Path, library: &Path) -> Result<(), PrefixError> {
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute()
        || bytes.contains(&0)
        || bytes.ends_with(b" (deleted)")
        || !path.starts_with(library)
        || path == library
    {
        return Err(PrefixError::Blocked);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[cfg(target_os = "linux")]
fn open_prefix_folder_with(
    state: &EnvironmentState,
    library: &str,
    app_id: &str,
    hook: &mut dyn FnMut(PrefixReadStage),
    spawn: &mut SpawnOs<'_>,
) -> Result<(), &'static str> {
    let app_id = parse_app_id(app_id).map_err(|_| errcode::BLOCKED)?;
    // Der Snapshot bleibt bis zum Spawn gesperrt; Scope-Fehler verlassen diese Grenze nie.
    state
        .with_authorized_library(library, |canonical| {
            Ok(open_authorized_prefix(&canonical, app_id, hook, spawn).map_err(PrefixError::code))
        })
        .map_err(|_| errcode::BLOCKED)?
}

#[cfg(target_os = "linux")]
fn open_authorized_prefix(
    library: &Path,
    app_id: u32,
    hook: &mut dyn FnMut(PrefixReadStage),
    spawn: &mut SpawnOs<'_>,
) -> Result<(), PrefixError> {
    // r-07: dieselbe stat-open-fstat-kette wie `fd::open_bound_root_fd`; der
    // Hook läuft dort zwischen Stat und Open wie zuvor. Randfall-Abweichung
    // gegenüber der Vorversion: ein stat-/open-Fehler der Open-Phase meldet
    // sich als `unreadable`, die Vorversion hätte dort in Einzelfällen
    // `not-found` (Tausch zwischen Stat und Open) oder `blocked` (sonstiger
    // stat-Fehler) geliefert. Beide Wege verweigern fail-closed und starten nie
    // einen Handler; nur der Code der Oberfläche weicht in diesen Randfällen ab.
    // Ein Nicht-Verzeichnis scheitert jetzt vor dem Hook statt im Open.
    let library_fd = fd::open_bound_root_fd(library, &mut || {
        hook(PrefixReadStage::BeforeLibraryOpen);
    })
    .map_err(|error| {
        if errcode::has_code(&error, errcode::NOT_FOUND) {
            PrefixError::NotFound
        } else if errcode::has_code(&error, errcode::UNREADABLE) {
            PrefixError::Unreadable
        } else {
            PrefixError::Blocked
        }
    })?;
    hook(PrefixReadStage::LibraryOpened);
    // Ohne steamapps ist das Spiel hier nicht installiert: Autoritätsfehler, kein fehlender Prefix.
    let steamapps =
        fd::open_dir_at(library_fd.as_raw_fd(), OsStr::new("steamapps")).map_err(|error| {
            match PrefixError::from(error) {
                PrefixError::NotFound => PrefixError::Blocked,
                other => other,
            }
        })?;
    hook(PrefixReadStage::SteamappsOpened);
    if !is_app_installed_in_steamapps_fd(steamapps.as_raw_fd(), app_id, &mut |_| {})? {
        return Err(PrefixError::Blocked);
    }
    let compatdata = fd::open_dir_at(steamapps.as_raw_fd(), OsStr::new("compatdata"))?;
    let app = fd::open_dir_at(compatdata.as_raw_fd(), OsStr::new(&app_id.to_string()))?;
    let prefix = fd::open_dir_at(app.as_raw_fd(), OsStr::new("pfx"))?;
    hook(PrefixReadStage::PrefixOpened);
    let path = fs::read_link(format!("/proc/self/fd/{}", prefix.as_raw_fd()))?;
    validate_handler_path(&path, library)?;
    // SECURITY: Der Dateimanager löst den Pfad später erneut auf; kein fd-gebundenes Öffnen.
    hook(PrefixReadStage::BeforeHandler);
    open_directory_with_handler(spawn, &path).map_err(|_| PrefixError::HandlerUnavailable)
}

#[tauri::command]
pub async fn open_prefix_folder(
    state: State<'_, EnvironmentState>,
    library: String,
    app_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let state = state.inner().clone();
        tokio::task::spawn_blocking(move || {
            open_prefix_folder_with(
                &state,
                &library,
                &app_id,
                &mut |_| {},
                &mut spawn_detached_os,
            )
        })
        .await
        .map_err(|_| errcode::BLOCKED.to_owned())?
        .map_err(str::to_owned)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, library, app_id);
        Err(errcode::BLOCKED.into())
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "prefix_tests.rs"]
mod tests;
