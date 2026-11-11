// Valve-/GE-Compat-Tool-Autorität: welche Namen das Write-Gate akzeptiert.
// Die Webview-Blocklist und Scan-Metadaten sind keine Autorität; diese
// Prüfungen lesen frische Backend-Fakten über gebundene Descriptoren und
// die feste Valve-Tabelle. Geteilt von steam.rs (save_compat_tool) und
// delete_inspect.rs (GE-Tool-Identität); die fd-Helfer liegen in fd.rs.

use crate::commands::errcode;
// fd-Items gibt es nur unter Linux (fd.rs ist leer gekappt); jeder Aufrufer
// liegt in einem linux-Zweig, deshalb ist der Import bedingt (r-12).
#[cfg(target_os = "linux")]
use crate::commands::fd::{
    fd_identity, open_absolute_dir, open_bound_root_fd, open_dir_at, open_file_at, read_fd_text,
    FdIdentity,
};
#[cfg(target_os = "linux")]
use crate::commands::libraryfolders::LibraryFoldersStage;
use crate::commands::scope::SYSTEM_COMPAT_DIRS;
use crate::commands::steam_layout;
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

// Manifest-Lesen und -Parsen lebt in `manifest`; nur der Installations-Nachweis
// wird hier gebraucht, und nur der linux-Zweig ruft ihn (r-12).
#[cfg(target_os = "linux")]
use crate::commands::manifest::{is_app_installed_in_steamapps_fd, ManifestReadError};

/// Zeitpunkte der Compat-Tool-Autoritätsleseketten (r-11). Die Stufen waren
/// zuvor magische `u8`-Literale (1 bis 4) am gemeinsamen Hook-Kanal; als Enum
/// sind sie benannt und vollständig (Muster wie `DeleteReadStage` in
/// `delete_inspect` bzw. `PrefixReadStage` in `prefix`).
///
/// Der frühere Kanal war zu grob: `2` hieß je nach Aufrufer
/// „`libraryfolders.vdf` offen" ODER „Tool-Unterverzeichnis offen", `3` hieß
/// „`compatibilitytool.vdf` offen" ODER „externe Library zwischen Stat und
/// Open". Beide Bedeutungen sind jetzt eigene Varianten; die
/// Auslösezeitpunkte selbst bleiben unverändert.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CompatAuthStage {
    /// Start der Suche: der Root-Deskriptor ist geöffnet.
    RootOpened,
    /// `libraryfolders.vdf` ist am Deskriptor geöffnet, vor dem Lesen.
    LibraryFileOpened,
    /// Ein Tool-Unterverzeichnis ist am Deskriptor geöffnet.
    ToolOpened,
    /// `compatibilitytool.vdf` ist geöffnet, vor dem Lesen.
    VdfOpened,
    /// Eine externe Library wird zwischen Stat und Open gebunden.
    ExternalLibraryBound,
    /// Das appmanifest ist geöffnet, vor dem Lesen.
    ManifestOpened,
}

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

// kleiner als MAX_VDF_READ_BYTES: tool-vdfs sind winzig
#[cfg(target_os = "linux")]
const MAX_COMPAT_VDF_BYTES: u64 = 1024 * 1024;

fn parse_compat_tool_vdf(text: &str) -> Result<Option<String>, String> {
    let tokens = vdf_patch::tokenize(text)?;
    let root = match vdf_patch::find_entry(&tokens, 0, tokens.len(), "compatibilitytools")? {
        Some(entry) => entry.block.ok_or_else(|| {
            errcode::with_detail(errcode::UNREADABLE, "compatibilitytools is not a block")
        })?,
        None => return Ok(None),
    };
    let compat_tools = match vdf_patch::find_entry(&tokens, root.0, root.1, "compat_tools")? {
        Some(entry) => entry.block.ok_or_else(|| {
            errcode::with_detail(errcode::UNREADABLE, "compat_tools is not a block")
        })?,
        None => return Ok(None),
    };
    let entries = vdf_patch::scan_entries(&tokens, compat_tools.0, compat_tools.1)?;
    // F-03: das slice-pattern bindet genau einen eintrag und lehnt 0 oder
    // mehrere im selben zug ab; der fruehere zweite zweig war nach der
    // laengenpruefung unerreichbar und haette bei kuenftigen aenderungen
    // still `Ok(None)` (kein tool) statt eines fehlers geliefert.
    let [entry] = entries.as_slice() else {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            "compat_tools must contain exactly one tool",
        ));
    };
    let vdf_patch::TokenKind::String(name) = &entry.key.kind else {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            "compat tool name is not a string",
        ));
    };
    if name.is_empty()
        || name.contains('\0')
        || name.chars().any(char::is_control)
        || entry.block.is_none()
    {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            "invalid compat tool identity",
        ));
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
    F: FnMut(CompatAuthStage),
{
    let root_fd = match open_absolute_dir(root) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open compat root: {error}"),
            ))
        }
    };
    hook(CompatAuthStage::RootOpened);
    compat_root_contains_name_at_fd(&root_fd, requested, hook)
}

/// Interner Name aus `compatibilitytools.d/<tool>/compatibilitytool.vdf`.
/// Belegte abwesenheit (NotFound) ist `Ok(None)`; jeder andere lese- oder
/// parsefehler ist `Err` mit code (FR-8): ein fehler darf nicht als
/// abwesenheit erscheinen.
#[cfg(target_os = "linux")]
pub(super) fn read_compat_tool_internal_name(
    steam_root_fd: &OwnedFd,
    tool_name: &str,
) -> Result<Option<String>, String> {
    let tools_fd = match open_dir_at(
        steam_root_fd.as_raw_fd(),
        OsStr::new("compatibilitytools.d"),
    ) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open compatibilitytools.d: {error}"),
            ))
        }
    };
    let tool_fd = match open_dir_at(tools_fd.as_raw_fd(), OsStr::new(tool_name)) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open compat tool {tool_name}: {error}"),
            ))
        }
    };
    let mut vdf = match open_file_at(tool_fd.as_raw_fd(), OsStr::new("compatibilitytool.vdf")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open compatibilitytool.vdf: {error}"),
            ))
        }
    };
    let text = read_fd_text(&mut vdf, "compatibilitytool.vdf", MAX_COMPAT_VDF_BYTES)?;
    parse_compat_tool_vdf(&text)
}

#[cfg(target_os = "linux")]
fn compat_root_contains_name_at_fd<F>(
    root_fd: &OwnedFd,
    requested: &str,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(CompatAuthStage),
{
    const ENOTDIR: i32 = 20;
    let proc_dir = Path::new("/proc/self/fd").join(root_fd.as_raw_fd().to_string());
    let entries = fs::read_dir(proc_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot read compat root: {error}"),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot read compat entry: {error}"),
            )
        })?;
        let tool_name = entry.file_name();
        let tool_fd = match open_dir_at(root_fd.as_raw_fd(), &tool_name) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) if error.raw_os_error() == Some(ENOTDIR) => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open compat tool: {error}"),
                ))
            }
        };
        hook(CompatAuthStage::ToolOpened);
        let mut vdf = match open_file_at(tool_fd.as_raw_fd(), OsStr::new("compatibilitytool.vdf")) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open compatibilitytool.vdf: {error}"),
                ))
            }
        };
        hook(CompatAuthStage::VdfOpened);
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
    F: FnMut(CompatAuthStage),
{
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "compat tool authority requires Linux no-follow descriptors",
    ))
}

#[cfg(target_os = "linux")]
fn read_library_folders_from_root_fd<F>(
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    hook: &mut F,
) -> Result<Vec<PathBuf>, String>
where
    F: FnMut(CompatAuthStage),
{
    // r-06: dieselbe Suchreihenfolge, dasselbe Cap und derselbe
    // steamapps-Fallback wie die Discovery, geteilt über die eine fd-Kette in
    // `libraryfolders::libraryfolders_contents_from_root_fd`. Der frühere eigene 1-MiB-cap
    // (eine datei zwischen 1 und 16 MiB ließ diese autorisierung sichtbar
    // scheitern, obwohl die Discovery sie vollständig las) ist damit entfallen.
    // hook(`RootOpened`) bleibt der Start-Haken (Root-Tausch),
    // hook(`LibraryFileOpened`) der Open-Haken der Datei.
    hook(CompatAuthStage::RootOpened);
    let mut libraryfolders_hook = |stage: LibraryFoldersStage| {
        if stage == LibraryFoldersStage::FileOpened {
            hook(CompatAuthStage::LibraryFileOpened);
        }
    };
    match crate::commands::libraryfolders::libraryfolders_contents_from_root_fd(
        steam_root_fd,
        &mut libraryfolders_hook,
    )? {
        Some(text) => crate::commands::libraryfolders::parse_library_folder_paths(&text),
        None => Ok(vec![steam_root.to_path_buf()]),
    }
}

/// Kanonisiert eine gelistete Library über dieselbe Härtung wie die Discovery
/// (FR-2: `libraryfolders::canonical_library` mit sanitize, is_safe_path und
/// steamapps-Prüfung). `Ok(None)` heißt: die Library autorisiert nichts und
/// wird wie in der Discovery übersprungen (INV-2), also bei belegter Abwesenheit
/// und bei einem Strukturschaden der Pfadvalidierung. Ein Leseschaden des
/// Pfads bleibt hart fail-closed — wie zuvor jeder Nicht-NotFound-Fehler der
/// Kanonisierung.
#[cfg(target_os = "linux")]
fn canonical_authority_library(path: &Path) -> Result<Option<PathBuf>, String> {
    match crate::commands::libraryfolders::canonical_library(path) {
        Ok(canonical) => Ok(Some(canonical)),
        Err((crate::commands::scope::LibraryUnavailableReason::ReadFailed, detail)) => {
            Err(errcode::with_detail(
                errcode::UNREADABLE,
                format!("cannot canonicalize Steam library: {detail}"),
            ))
        }
        // INV-2: eine library, die die pfad-validierung nicht besteht (etwa
        // `..` oder ein symlink), autorisiert nichts und wird uebersprungen;
        // der aufrufer prueft autoritaet/scope ohnehin erneut.
        Err(_) => Ok(None),
    }
}

/// Bindet einen externen Library-Deskriptor an den vom Aufrufer bereits
/// kanonisierten Pfad (FR-2). Die Kanonisierung ist Sache des Aufrufers
/// (`canonical_authority_library` hier, `delete_usage` dort); ein zweiter
/// Kanonisierungsweg in dieser Funktion wäre eine eigene Haftung ohne
/// Aufrufer, der sie braucht. `open_bound_root_fd` prüft die Identität
/// zwischen Stat und Open selbst.
#[cfg(target_os = "linux")]
pub(super) fn open_external_library_fd_with_hook<F>(
    path: &Path,
    hook: &mut F,
) -> Result<OwnedFd, String>
where
    F: FnMut(CompatAuthStage),
{
    // r-07: dieselbe stat-open-fstat-kette wie `fd::open_bound_root_fd`; der
    // Hook läuft dort genau zwischen Stat und Open, wie zuvor die dritte Stufe.
    open_bound_root_fd(path, &mut || hook(CompatAuthStage::ExternalLibraryBound))
}

#[cfg(target_os = "linux")]
fn is_app_installed_in_library_fd<F>(
    library_fd: RawFd,
    app_id: u32,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(CompatAuthStage),
{
    let steamapps_fd = match open_dir_at(library_fd, OsStr::new("steamapps")) {
        Ok(fd) => fd,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot open Steam library steamapps: {error}"),
            ))
        }
    };
    is_app_installed_in_steamapps_fd(steamapps_fd.as_raw_fd(), app_id, hook)
        .map_err(ManifestReadError::into_message)
}

#[cfg(target_os = "linux")]
fn valve_builtin_installed_from_fds<F>(
    steam_root: &Path,
    steam_root_fd: &OwnedFd,
    app_id: u32,
    hook: &mut F,
) -> Result<bool, String>
where
    F: FnMut(CompatAuthStage),
{
    let libraries = read_library_folders_from_root_fd(steam_root, steam_root_fd, hook)?;
    let root_identity = fd_identity(steam_root_fd.as_raw_fd()).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot stat Steam root descriptor: {error}"),
        )
    })?;
    for library in libraries {
        if !library.is_absolute() {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                "Steam library path is not absolute",
            ));
        }
        if library == steam_root {
            if is_app_installed_in_library_fd(steam_root_fd.as_raw_fd(), app_id, hook)? {
                return Ok(true);
            }
            continue;
        }
        // Eine gelistete, aber nicht gemountete Library belegt keine
        // Installation: NotFound wird übersprungen und die Suche läuft weiter
        // (INV-2). Die Auflösung ist die der Discovery-Härtung (FR-2); jeder
        // andere Fehler bleibt hart fail-closed, ebenso ein Identitätswechsel
        // der Library.
        let Some(library_canonical) = canonical_authority_library(&library)? else {
            continue;
        };
        let library_metadata = match fs::metadata(&library_canonical) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot stat Steam library: {error}"),
                ))
            }
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
    F: FnMut(CompatAuthStage),
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
        return Err(errcode::with_detail(
            errcode::UNSUPPORTED_PLATFORM,
            "Valve compat tool authority requires Linux no-follow descriptors",
        ));
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
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open Steam compatibility root: {error}"),
                ));
            }
        }
    }
    let mut roots = Vec::new();
    #[cfg(target_os = "linux")]
    if steam_root_fd.is_none() {
        roots.push(steam_layout::compatibilitytools(steam_root));
    }
    #[cfg(not(target_os = "linux"))]
    roots.push(steam_layout::compatibilitytools(steam_root));
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
    if !crate::commands::scope::is_ascii_digits(major_text)
        || !crate::commands::scope::is_ascii_digits(minor_text)
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
