// Valve-/GE-Compat-Tool-Autorität: welche Namen das Write-Gate akzeptiert.
// Die Webview-Blocklist und Scan-Metadaten sind keine Autorität; diese
// Prüfungen lesen frische Backend-Fakten über gebundene Descriptoren und
// die feste Valve-Tabelle. Geteilt von steam.rs (save_compat_tool) und
// delete_inspect.rs (GE-Tool-Identität); die fd-Helfer liegen in fd.rs.

#[cfg(target_os = "linux")]
use crate::commands::fd::{
    fd_identity, open_absolute_dir, open_dir_at, open_file_at, read_fd_text, FdIdentity,
};
use crate::commands::scope::SYSTEM_COMPAT_DIRS;
use crate::commands::vdf_patch;
#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io::{self, Read};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

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
    const MAX_COMPAT_VDF_BYTES: u64 = 1024 * 1024;
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
        let metadata = vdf
            .metadata()
            .map_err(|error| format!("cannot stat compatibilitytool.vdf: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_COMPAT_VDF_BYTES {
            continue;
        }
        let mut text = String::new();
        vdf.read_to_string(&mut text)
            .map_err(|error| format!("cannot read compatibilitytool.vdf: {error}"))?;
        if parse_compat_tool_vdf(&text)?.as_deref() == Some(requested) {
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
    const MAX_LIBRARYFOLDERS_BYTES: u64 = 1024 * 1024;
    hook(1);
    for directory in ["config", "steamapps"] {
        let directory_fd = match open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new(directory)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot open Steam {directory}: {error}")),
        };
        let mut file =
            match open_file_at(directory_fd.as_raw_fd(), OsStr::new("libraryfolders.vdf")) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("cannot open libraryfolders.vdf: {error}")),
            };
        hook(2);
        let text = read_fd_text(&mut file, "libraryfolders.vdf", MAX_LIBRARYFOLDERS_BYTES)?;
        return crate::commands::scope::parse_library_folder_paths(&text);
    }
    if open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new("steamapps")).is_ok() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    Err("steam root has no steamapps directory and no libraryfolders.vdf".into())
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
    let expected =
        fs::metadata(&canonical).map_err(|error| format!("cannot stat Steam library: {error}"))?;
    if !expected.is_dir() {
        return Err("Steam library is not a directory".into());
    }
    use std::os::unix::fs::MetadataExt;
    let expected_identity = FdIdentity {
        dev: expected.dev(),
        ino: expected.ino(),
    };
    hook(3);
    let fd = open_absolute_dir(&canonical)
        .map_err(|error| format!("cannot open Steam library descriptor: {error}"))?;
    let actual = fd_identity(fd.as_raw_fd())
        .map_err(|error| format!("cannot stat Steam library descriptor: {error}"))?;
    if actual != expected_identity {
        return Err("Steam library changed while opening descriptor".into());
    }
    Ok(fd)
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
    let manifest_name = format!("appmanifest_{app_id}.acf");
    let mut manifest = match open_file_at(steamapps_fd.as_raw_fd(), OsStr::new(&manifest_name)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot open {manifest_name}: {error}")),
    };
    hook(4);
    let content = read_fd_text(&mut manifest, &manifest_name, 1024 * 1024)?;
    let internal_id = vdf_patch::get_vdf_value(&content, &["AppState", "appid"])
        .map_err(|error| format!("cannot parse manifest {manifest_name}: {error}"))?
        .or(vdf_patch::get_vdf_value(&content, &["AppState", "AppId"])
            .map_err(|error| format!("cannot parse manifest {manifest_name}: {error}"))?)
        .ok_or_else(|| format!("manifest {manifest_name} has no AppState appid"))?;
    let internal_id = crate::commands::scope::parse_app_id(internal_id.trim())
        .map_err(|_| format!("manifest {manifest_name} has invalid appid"))?;
    if internal_id != app_id {
        return Err(format!(
            "manifest {manifest_name} filename/appid mismatch ({app_id} != {internal_id})"
        ));
    }
    Ok(true)
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
        let library_canonical = fs::canonicalize(&library)
            .map_err(|error| format!("cannot canonicalize Steam library: {error}"))?;
        let library_metadata = fs::metadata(&library_canonical)
            .map_err(|error| format!("cannot stat Steam library: {error}"))?;
        use std::os::unix::fs::MetadataExt;
        let library_identity = FdIdentity {
            dev: library_metadata.dev(),
            ino: library_metadata.ino(),
        };
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
    is_current || major < 11 || (major == 11 && minor <= 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use crate::commands::fd::{open_absolute_dir, open_bound_root_fd};
    use crate::commands::test_util::wsg_fixture;

    #[cfg(target_os = "linux")]
    fn valve_authority_fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = wsg_fixture(tag);
        let steam = root.join("steam");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        (root, steam)
    }

    #[cfg(target_os = "linux")]
    fn wsg_env(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = wsg_fixture(tag);
        let home = root.join("fakehome");
        let steam = home.join(".local/share/Steam");
        let cache = root.join("cache");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
            let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
            std::fs::create_dir_all(&tool_dir).unwrap();
            let tool_vdf = format!(
                "\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}"
            );
            std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
        }
        (home, cache, steam)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_libraryfolders_descriptor_reader_nutzt_gemeinsamen_parser() {
        let (root, steam) = valve_authority_fixture("libraryfolders-descriptor-reader");
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();
        let libraryfolders = steam.join("config/libraryfolders.vdf");
        std::fs::write(
            &libraryfolders,
            include_str!("../../../tests/fixtures/libraryfolders-parser.vdf"),
        )
        .unwrap();
        let root_fd = open_absolute_dir(&steam).unwrap();

        let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();
        assert_eq!(
            libraries,
            vec![
                PathBuf::from("/fixture/library-ten"),
                PathBuf::from("/fixture/library-two"),
            ]
        );

        std::fs::write(
            &libraryfolders,
            include_str!("../../../tests/fixtures/libraryfolders-parser-broken.vdf"),
        )
        .unwrap();
        let error = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap_err();
        assert!(
            error.starts_with("scan libraryfolders entries:"),
            "error: {error}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_libraryfolders_leerer_block_bleibt_leer() {
        let (root, steam) = valve_authority_fixture("libraryfolders-empty");
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();
        std::fs::write(
            steam.join("config/libraryfolders.vdf"),
            include_str!("../../../tests/fixtures/libraryfolders-parser-empty.vdf"),
        )
        .unwrap();
        let root_fd = open_absolute_dir(&steam).unwrap();

        let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();

        assert!(libraries.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_libraryfolders_fehlende_vdf_nutzt_steamapps_fallback() {
        let (root, steam) = valve_authority_fixture("libraryfolders-missing");
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();
        let root_fd = open_absolute_dir(&steam).unwrap();

        let libraries = read_library_folders_from_root_fd(&steam, &root_fd, &mut |_| {}).unwrap();

        assert_eq!(libraries, vec![steam.clone()]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_authority_missing_local_compat_root_is_false() {
        let (root, steam) = valve_authority_fixture("compat-missing-local-root");
        let compat_root = steam.join("compatibilitytools.d");
        let mut hook = |_| {};
        assert!(
            !compat_root_contains_name_linux_with_hook(&compat_root, "missing", &mut hook).unwrap()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn steam_root_identity_swap_between_capture_and_open_fails_closed() {
        let (root, steam) = valve_authority_fixture("valve-root-open-race");
        let canonical = std::fs::canonicalize(&steam).unwrap();
        let foreign = root.join("foreign-root");
        std::fs::create_dir_all(&foreign).unwrap();
        let mut swapped = false;
        let result = open_bound_root_fd(&canonical, &mut || {
            if !swapped {
                std::fs::rename(&canonical, canonical.with_extension("old")).unwrap();
                std::os::unix::fs::symlink(&foreign, &canonical).unwrap();
                swapped = true;
            }
        });
        assert!(
            result.is_err(),
            "Root-Identity-Swap muss fail-closed bleiben"
        );
        std::fs::remove_file(&canonical).unwrap();
        std::fs::rename(canonical.with_extension("old"), &canonical).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_authority_root_and_libraryfolders_race_use_bound_fds() {
        let (root, steam) = valve_authority_fixture("valve-root-vdf-races");
        let steamapps = steam.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::write(
            steamapps.join("appmanifest_1493710.acf"),
            "\"AppState\" { \"appid\" \"1493710\" }",
        )
        .unwrap();
        let libraryfolders = "\"libraryfolders\" { \"0\" { \"path\" \"";
        let libraryfolders = format!("{libraryfolders}{}\" }} }}", steam.display());
        let libraryfolders_path = steam.join("config/libraryfolders.vdf");
        std::fs::write(&libraryfolders_path, &libraryfolders).unwrap();

        let root_fd = open_absolute_dir(&steam).unwrap();
        let external = root.join("foreign-steam-root");
        std::fs::create_dir_all(&external).unwrap();
        let mut swapped_root = false;
        let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
            if stage == 1 && !swapped_root {
                std::fs::rename(&steam, steam.with_extension("old")).unwrap();
                std::os::unix::fs::symlink(&external, &steam).unwrap();
                swapped_root = true;
            }
        })
        .unwrap();
        assert!(result, "gebundener Steam-root muss trotz Pfadtausch gelten");
        std::fs::remove_file(&steam).unwrap();
        std::fs::rename(steam.with_extension("old"), &steam).unwrap();

        let mut swapped_vdf = false;
        let foreign_vdf = root.join("foreign-libraryfolders.vdf");
        std::fs::write(&foreign_vdf, "\"libraryfolders\" { \"0\" { unclosed").unwrap();
        let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
            if stage == 2 && !swapped_vdf {
                std::fs::rename(
                    &libraryfolders_path,
                    libraryfolders_path.with_extension("old"),
                )
                .unwrap();
                std::os::unix::fs::symlink(&foreign_vdf, &libraryfolders_path).unwrap();
                swapped_vdf = true;
            }
        })
        .unwrap();
        assert!(
            result,
            "libraryfolders muss aus dem bereits geöffneten fd kommen"
        );
        std::fs::remove_file(&libraryfolders_path).unwrap();
        std::fs::rename(
            libraryfolders_path.with_extension("old"),
            &libraryfolders_path,
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_authority_external_library_identity_race_fails_closed() {
        let (root, steam) = valve_authority_fixture("valve-external-library-race");
        let external = root.join("library");
        std::fs::create_dir_all(external.join("steamapps")).unwrap();
        std::fs::write(
            external.join("steamapps/appmanifest_1493710.acf"),
            "\"AppState\" { \"appid\" \"1493710\" }",
        )
        .unwrap();
        let libraryfolders_path = steam.join("config/libraryfolders.vdf");
        std::fs::write(
            &libraryfolders_path,
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
                external.display()
            ),
        )
        .unwrap();
        let root_fd = open_absolute_dir(&steam).unwrap();
        let foreign = root.join("foreign-library");
        std::fs::create_dir_all(foreign.join("steamapps")).unwrap();
        std::fs::write(
            foreign.join("steamapps/appmanifest_1493710.acf"),
            "\"AppState\" { \"appid\" \"1493710\" }",
        )
        .unwrap();
        let mut swapped = false;
        let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
            if stage == 3 && !swapped {
                std::fs::rename(&external, external.with_extension("old")).unwrap();
                std::os::unix::fs::symlink(&foreign, &external).unwrap();
                swapped = true;
            }
        });
        assert!(
            result.is_err(),
            "fremde externe Library darf nicht autorisieren"
        );
        std::fs::remove_file(&external).unwrap();
        std::fs::rename(external.with_extension("old"), &external).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valve_authority_manifest_swap_reads_same_fd() {
        let (root, steam) = valve_authority_fixture("valve-manifest-race");
        let steamapps = steam.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        let manifest = steamapps.join("appmanifest_1493710.acf");
        std::fs::write(&manifest, "\"AppState\" { \"appid\" \"1493710\" }").unwrap();
        std::fs::write(
            steam.join("config/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
                steam.display()
            ),
        )
        .unwrap();
        let root_fd = open_absolute_dir(&steam).unwrap();
        let mut swapped = false;
        let result = valve_builtin_installed_from_fds(&steam, &root_fd, 1493710, &mut |stage| {
            if stage == 4 && !swapped {
                std::fs::rename(&manifest, manifest.with_extension("old")).unwrap();
                std::fs::write(&manifest, "\"AppState\" { \"appid\" \"1\" }").unwrap();
                swapped = true;
            }
        })
        .unwrap();
        assert!(result, "Manifest muss aus dem gebundenen fd gelesen werden");
        std::fs::remove_file(&manifest).unwrap();
        std::fs::rename(manifest.with_extension("old"), &manifest).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn compat_authority_bleibt_an_root_tooldir_und_vdf_fd_gebunden() {
        let (home, _cache, steam) = wsg_env("compat-fd-races");
        let root = steam.join("compatibilitytools.d");
        let tool = root.join("GE-Proton9-27");
        let external = home.parent().unwrap().join("compat-fd-external");
        std::fs::create_dir_all(external.join("ExternalTool")).unwrap();
        std::fs::write(
            external.join("ExternalTool/compatibilitytool.vdf"),
            "\"compatibilitytools\" { \"compat_tools\" { \"ExternalTool\" {} } }",
        )
        .unwrap();

        let mut root_swapped = false;
        let root_result =
            compat_root_contains_name_linux_with_hook(&root, "ExternalTool", &mut |stage| {
                if stage == 1 && !root_swapped {
                    std::fs::rename(&root, root.with_extension("old")).unwrap();
                    std::os::unix::fs::symlink(&external, &root).unwrap();
                    root_swapped = true;
                }
            })
            .unwrap();
        assert!(
            !root_result,
            "root-swap darf keinen externen namen autorisieren"
        );
        std::fs::remove_file(&root).unwrap();
        std::fs::rename(root.with_extension("old"), &root).unwrap();

        let mut tool_swapped = false;
        let tool_result =
            compat_root_contains_name_linux_with_hook(&root, "ExternalTool", &mut |stage| {
                if stage == 2 && !tool_swapped {
                    std::fs::rename(&tool, tool.with_extension("old")).unwrap();
                    std::os::unix::fs::symlink(external.join("ExternalTool"), &tool).unwrap();
                    tool_swapped = true;
                }
            })
            .unwrap();
        assert!(
            !tool_result,
            "tooldir-swap darf keinen externen namen autorisieren"
        );
        std::fs::remove_file(&tool).unwrap();
        std::fs::rename(tool.with_extension("old"), &tool).unwrap();

        let vdf = tool.join("compatibilitytool.vdf");
        let mut vdf_swapped = false;
        let vdf_result =
            compat_root_contains_name_linux_with_hook(&root, "GE-Proton9-27", &mut |stage| {
                if stage == 3 && !vdf_swapped {
                    std::fs::rename(&vdf, vdf.with_extension("old")).unwrap();
                    std::fs::write(
                        &vdf,
                        "\"compatibilitytools\" { \"compat_tools\" { \"ExternalTool\" {} } }",
                    )
                    .unwrap();
                    vdf_swapped = true;
                }
            })
            .unwrap();
        assert!(vdf_result, "vdf-swap muss am bereits geöffneten fd bleiben");
        std::fs::remove_file(&vdf).unwrap();
        std::fs::rename(vdf.with_extension("old"), &vdf).unwrap();
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn is_managed_ge_name_validiert_exakte_muster() {
        assert!(is_managed_ge_name("GE-Proton9-27"));
        assert!(is_managed_ge_name("GE-Proton10-25"));
        assert!(is_managed_ge_name("GE-Proton11-4-x86_64"));
        assert!(is_managed_ge_name("GE-Proton11-5-aarch64"));
        assert!(is_managed_ge_name("GE-Proton11-3"));
        assert!(!is_managed_ge_name("Proton"));
        assert!(!is_managed_ge_name("GE-Proton"));
        assert!(!is_managed_ge_name("GE-Proton10"));
        assert!(!is_managed_ge_name("ge-proton9-27"));
        assert!(!is_managed_ge_name("GE-Proton9-27-custom"));
        assert!(!is_managed_ge_name("GE-Proton11-5-arm64"));
        assert!(!is_managed_ge_name("GE-Proton11-4"));
        assert!(!is_managed_ge_name("GE-Proton9-"));
        assert!(!is_managed_ge_name("GE-Proton-27"));
    }
}
