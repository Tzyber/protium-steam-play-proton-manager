// Valve-/GE-Compat-Tool-Autorität: welche Namen das Write-Gate akzeptiert.
// Die Webview-Blocklist und Scan-Metadaten sind keine Autorität; diese
// Prüfungen lesen frische Backend-Fakten über gebundene Descriptoren und
// die feste Valve-Tabelle. Geteilt von steam.rs (save_compat_tool) und
// delete_inspect.rs (GE-Tool-Identität); die fd-Helfer liegen in fd.rs.

#[cfg(target_os = "linux")]
use crate::commands::errcode;
use crate::commands::fd::{
    fd_identity, open_absolute_dir, open_bound_root_fd, open_dir_at, open_file_at, read_fd_bytes,
    read_fd_text, FdIdentity,
};
#[cfg(target_os = "linux")]
use crate::commands::scope::LibraryFoldersStage;
use crate::commands::scope::SYSTEM_COMPAT_DIRS;
use crate::commands::vdf_patch;
#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

/// Der eine Deckel für appmanifest-reads (1 MiB), geteilt von der
/// Valve-Autorität und der delete-inspektion: appmanifeste sind klein, eine
/// übergrosse datei ist präpariert. Der frühere doppelte cap
/// (`MAX_DELETE_MANIFEST_BYTES`) ist entfallen (r-05).
pub(super) const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

// Die Webview-Blocklist ist keine Autorität; diese Tabelle bindet Valve-Namen
// an ihre Steam-App, deren Manifest danach frisch aus den Libraries gelesen wird.
const VALVE_COMPAT_TOOLS: &[(&str, &[u32])] = &[
    ("proton_11", &[4628710, 4628740]),
    ("proton_10", &[3658110]),
    ("proton_experimental", &[1493710]),
    ("proton_9", &[2805730]),
    ("proton_8", &[2348590]),
    ("proton_7", &[1887720]),
    ("proton_63", &[1580130]),
    ("proton_513", &[1420170]),
    ("proton_5", &[1245040]),
    ("proton_hotfix", &[2180100]),
];

fn parse_compat_tool_vdf(text: &str) -> Result<Option<String>, String> {
    let tokens = vdf_patch::tokenize(text)?;
    let root = match vdf_patch::find_entry(&tokens, 0, tokens.len(), "compatibilitytools")? {
        Some(entry) => entry
            .block
            .ok_or_else(|| "compatibilitytools is not a block".to_string())?,
        None => return Ok(None),
    };
    let compat_tools = match vdf_patch::find_entry(&tokens, root.0, root.1, "compat_tools")? {
        Some(entry) => entry
            .block
            .ok_or_else(|| "compat_tools is not a block".to_string())?,
        None => return Ok(None),
    };
    let entries = vdf_patch::scan_entries(&tokens, compat_tools.0, compat_tools.1)?;
    if entries.len() != 1 {
        return Err("compat_tools must contain exactly one tool".into());
    }
    let Some(entry) = entries.first() else {
        return Ok(None);
    };
    let vdf_patch::TokenKind::String(name) = &entry.key.kind else {
        return Err("compat tool name is not a string".into());
    };
    if name.is_empty()
        || name.contains('\0')
        || name.chars().any(char::is_control)
        || entry.block.is_none()
    {
        return Err("invalid compat tool identity".into());
    }
    Ok(Some(name.clone()))
}

#[cfg(target_os = "linux")]
fn compat_root_contains_name_linux_with_hook<F>(
    root: &Path,
    requested: &str,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    let root_fd = match open_absolute_dir(root) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot open compat root: {error}")),
    };
    hook(1);
    compat_root_contains_name_at_fd(&root_fd, requested, hook)
}

#[cfg(target_os = "linux")]
fn compat_root_contains_name_at_fd<F>(
    root_fd: &OwnedFd,
    requested: &str,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    const MAX_COMPAT_VDF_BYTES: u64 = 1024 * 1024; // kleiner als MAX_VDF_READ_BYTES: tool-vdfs sind winzig
    const ENOTDIR: i32 = 20;
    let proc_dir = Path::new("/proc/self/fd").join(root_fd.as_raw_fd().to_string());
    let entries =
        fs::read_dir(proc_dir).map_err(|error| format!("cannot read compat root: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot read compat entry: {error}"))?;
        let tool_name = entry.file_name();
        let tool_fd = match open_dir_at(root_fd.as_raw_fd(), &tool_name) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) if error.raw_os_error() == Some(ENOTDIR) => continue,
            Err(error) => return Err(format!("cannot open compat tool: {error}")),
        };
        hook(2);
        let mut vdf = match open_file_at(tool_fd.as_raw_fd(), OsStr::new("compatibilitytool.vdf")) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot open compatibilitytool.vdf: {error}")),
        };
        hook(3);
        // Ein einzelner kaputter Tool-Ordner darf die Autorität für alle anderen
        // nicht kippen: unlesbare, nicht-UTF8-, übergroße und syntaktisch
        // defekte VDFs werden wie fehlende verlassen. Die Autorität des
        // angefragten Namens bleibt fail-closed, er wird weiterhin nur aus
        // geparstem Inhalt belegt (S-1). Die skip-entscheidung hängt seit der
        // Fehlersemantik-Umstellung nicht mehr an der Formulierung, sondern am
        // strukturierten Code (r-15); alle übrigen Fehler schlagen weiter hart
        // durch. Einzige Erweiterung gegenüber der alten Textmenge: ein
        // gescheitertes `fstat` auf dem bereits geöffneten Deskriptor
        // (unreachable in der Praxis) zählt jetzt ebenfalls zum Skip, was
        // fail-safe bleibt: Skip heißt "dieser Kandidat belegt den Namen nicht".
        let text = match read_fd_text(&mut vdf, "compatibilitytool.vdf", MAX_COMPAT_VDF_BYTES) {
            Ok(text) => text,
            Err(error)
                if errcode::has_code(&error, errcode::UNREADABLE)
                    || errcode::has_code(&error, errcode::SIZE_LIMIT)
                    || errcode::has_code(&error, errcode::NOT_A_DIRECTORY) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        // Der Parsefehler eines Kandidaten zählt zu denselben Skip-Fällen: nur
        // dieser Kandidat wird verlassen, die übrigen Tool-Ordner bleiben
        // prüfbar. Aus unparsbarem Inhalt wird nie autorisiert (S-1).
        let parsed = match parse_compat_tool_vdf(&text) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if parsed.as_deref() == Some(requested) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn compat_root_contains_name_linux_with_hook<F>(
    _root: &Path,
    _requested: &str,
    _hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    Err("compat tool authority requires Linux no-follow descriptors".into())
}

#[cfg(target_os = "linux")]
fn read_library_folders_from_root_fd<F>(
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    hook: &mut F,
) -> Result<Vec<PathBuf>, String>
where
    F: FnMut(u8),
{
    // r-06: dieselbe Suchreihenfolge, dasselbe Cap und derselbe
    // steamapps-Fallback wie die Discovery, geteilt über die eine fd-Kette in
    // `scope::libraryfolders_contents_from_root_fd`. Der frühere eigene 1-MiB-cap
    // (eine datei zwischen 1 und 16 MiB ließ diese autorisierung sichtbar
    // scheitern, obwohl die Discovery sie vollständig las) ist damit entfallen.
    // hook(1) bleibt der Start-Haken (Root-Tausch), hook(2) der Open-Haken.
    hook(1);
    let mut libraryfolders_hook = |stage: LibraryFoldersStage| {
        if stage == LibraryFoldersStage::FileOpened {
            hook(2);
        }
    };
    match crate::commands::scope::libraryfolders_contents_from_root_fd(
        steam_root_fd,
        &mut libraryfolders_hook,
    )? {
        Some(text) => crate::commands::scope::parse_library_folder_paths(&text),
        None => Ok(vec![steam_root.to_path_buf()]),
    }
}

#[cfg(target_os = "linux")]
pub(super) fn open_external_library_fd_with_hook<F>(
    path: &Path,
    hook: &mut F,
) -> Result<OwnedFd, String>
where
    F: FnMut(u8),
{
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("cannot canonicalize Steam library: {error}"))?;
    // r-07: dieselbe stat-open-fstat-kette wie `fd::open_bound_root_fd`; der
    // Hook läuft dort genau zwischen Stat und Open, wie zuvor `hook(3)`.
    open_bound_root_fd(&canonical, &mut || hook(3))
}

#[cfg(target_os = "linux")]
fn is_app_installed_in_library_fd<F>(
    library_fd: RawFd,
    app_id: u32,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    let steamapps_fd = match open_dir_at(library_fd, OsStr::new("steamapps")) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot open Steam library steamapps: {error}")),
    };
    is_app_installed_in_steamapps_fd(steamapps_fd.as_raw_fd(), app_id, hook)
        .map_err(ManifestReadError::into_message)
}

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

/// Zeitpunkte des einen Manifest-Readers (r-05). `delete_inspect` bildet alle
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
                    ManifestReadError::Blocked(message)
                } else {
                    ManifestReadError::Unreadable(message)
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
    let content = String::from_utf8(bytes).map_err(|error| {
        unreadable(errcode::with_detail(
            errcode::UNREADABLE,
            format!("cannot read {label}: {error}"),
        ))
    })?;
    let parse_error = |error| unreadable(format!("cannot parse manifest {manifest_name}: {error}"));
    let internal_id = vdf_patch::get_vdf_value(&content, &["AppState", "appid"])
        .map_err(parse_error)?
        .or(vdf_patch::get_vdf_value(&content, &["AppState", "AppId"]).map_err(parse_error)?)
        .ok_or_else(|| unreadable(format!("manifest {manifest_name} has no AppState appid")))?;
    let internal_id = crate::commands::scope::parse_app_id(internal_id.trim())
        .map_err(|_| unreadable(format!("manifest {manifest_name} has invalid appid")))?;
    if internal_id != file_id {
        return Err(ManifestReadError::Blocked(format!(
            "manifest {manifest_name} filename/appid mismatch ({file_id} != {internal_id})"
        )));
    }
    // der name wird erst nach belegter identität gelesen; die lookup-region ist
    // dieselbe wie bei `appid`, ein parsefehler hätte also schon dort gezogen.
    let name = vdf_patch::get_vdf_value(&content, &["AppState", "name"]).map_err(|error| {
        unreadable(format!(
            "cannot parse manifest name {manifest_name}: {error}"
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
    F: FnMut(u8),
{
    let manifest_name = format!("appmanifest_{app_id}.acf");
    // appmanifeste sind klein; dasselbe limit wie im valve-pfad
    // (delete_inspect), nicht das 16-MiB-limit der config-dateien.
    let mut manifest_hook = |stage: ManifestStage, _file: Option<&mut std::fs::File>| {
        if stage == ManifestStage::AfterOpen {
            hook(4);
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

#[cfg(target_os = "linux")]
fn valve_builtin_installed_from_fds<F>(
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    app_id: u32,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    let libraries = read_library_folders_from_root_fd(steam_root, steam_root_fd, hook)?;
    let root_identity = fd_identity(steam_root_fd.as_raw_fd())
        .map_err(|error| format!("cannot stat Steam root descriptor: {error}"))?;
    for library in libraries {
        if !library.is_absolute() {
            return Err("Steam library path is not absolute".into());
        }
        if library == steam_root {
            if is_app_installed_in_library_fd(steam_root_fd.as_raw_fd(), app_id, hook)? {
                return Ok(true);
            }
            continue;
        }
        // Eine gelistete, aber nicht gemountete Library belegt keine
        // Installation: NotFound wird übersprungen und die Suche läuft weiter
        // (INV-2). Jeder andere Fehler bleibt hart fail-closed, ebenso ein
        // Identitätswechsel der Library.
        let library_canonical = match fs::canonicalize(&library) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot canonicalize Steam library: {error}")),
        };
        let library_metadata = match fs::metadata(&library_canonical) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot stat Steam library: {error}")),
        };
        let library_identity = FdIdentity::of(&library_metadata);
        if library_identity == root_identity {
            if is_app_installed_in_library_fd(steam_root_fd.as_raw_fd(), app_id, hook)? {
                return Ok(true);
            }
        } else {
            let library_fd = open_external_library_fd_with_hook(&library_canonical, hook)?;
            if is_app_installed_in_library_fd(library_fd.as_raw_fd(), app_id, hook)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn is_authorized_compat_tool_with_hook<F>(
    steam_root: &Path,
    #[cfg(target_os = "linux")] steam_root_fd: Option<&OwnedFd>,
    requested: &str,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(u8),
{
    if let Some((_, app_ids)) = VALVE_COMPAT_TOOLS
        .iter()
        .find(|(name, _)| *name == requested)
    {
        for app_id in *app_ids {
            #[cfg(target_os = "linux")]
            if let Some(root_fd) = steam_root_fd {
                if valve_builtin_installed_from_fds(steam_root, root_fd, *app_id, hook)? {
                    return Ok(true);
                }
                continue;
            }
            #[cfg(not(target_os = "linux"))]
            let _ = app_id;
        }
        #[cfg(target_os = "linux")]
        return Ok(false);
        #[cfg(not(target_os = "linux"))]
        return Err("Valve compat tool authority requires Linux no-follow descriptors".into());
    }

    #[cfg(target_os = "linux")]
    if let Some(root_fd) = steam_root_fd {
        match open_dir_at(root_fd.as_raw_fd(), OsStr::new("compatibilitytools.d")) {
            Ok(compat_fd) => {
                if compat_root_contains_name_at_fd(&compat_fd, requested, hook)? {
                    return Ok(true);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("cannot open Steam compatibility root: {error}"));
            }
        }
    }
    let mut roots = Vec::new();
    #[cfg(target_os = "linux")]
    if steam_root_fd.is_none() {
        roots.push(steam_root.join("compatibilitytools.d"));
    }
    #[cfg(not(target_os = "linux"))]
    roots.push(steam_root.join("compatibilitytools.d"));
    roots.extend(SYSTEM_COMPAT_DIRS.iter().map(PathBuf::from));
    for root in roots {
        if compat_root_contains_name_linux_with_hook(&root, requested, hook)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn is_authorized_compat_tool(
    steam_root: &Path,
    #[cfg(target_os = "linux")] steam_root_fd: Option<&OwnedFd>,
    requested: &str,
) -> Result<bool, String> {
    let mut no_hook = |_| {};
    is_authorized_compat_tool_with_hook(
        steam_root,
        #[cfg(target_os = "linux")]
        steam_root_fd,
        requested,
        &mut no_hook,
    )
}

pub(super) fn is_managed_ge_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("GE-Proton") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    let (major_text, minor_text, is_current) = match parts.as_slice() {
        [major, minor] => (*major, *minor, false),
        [major, minor, arch] if *arch == "x86_64" || *arch == "aarch64" => (*major, *minor, true),
        _ => return false,
    };
    if major_text.is_empty()
        || minor_text.is_empty()
        || !major_text.bytes().all(|byte| byte.is_ascii_digit())
        || !minor_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let Some(major) = major_text.parse::<u64>().ok() else {
        return false;
    };
    let Some(minor) = minor_text.parse::<u64>().ok() else {
        return false;
    };
    is_current || crate::commands::ge_install::is_legacy_ge_version(major, minor)
}

#[cfg(test)]
#[path = "compat_auth_tests.rs"]
mod tests;
