// Steam-Write-Gate für Konfigurationsdateien und Compat-Tools.

use std::ffi::{CString, OsStr};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;

use tauri::Manager;

use crate::commands::fs_ops::is_process_running_sync;
use crate::commands::path::{is_safe_path, random_suffix, sanitize_path};
use crate::commands::scope::SYSTEM_COMPAT_DIRS;
use crate::commands::spawn_blocking_io;
use crate::commands::vdf_patch;

#[cfg(not(target_os = "linux"))]
fn delete_inspection_unsupported() -> String {
    "delete inspection requires Linux no-follow descriptors".into()
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum WriteResult {
    Written,
    Unchanged,
}

/// Prüft, ob ein kanonischer Pfad eine
/// der legitimen steam-config-dateien ist: drei canonicalisierte root-
/// varianten (nativ/flatpak/snap, `.steam/steam` und `.steam/root` sind
/// symlinks und kollabieren per canonicalize auf die native variante) ×
/// `config/config.vdf` und `userdata/<digits>/config/localconfig.vdf`.
/// spiegel zu ROOT_CANDIDATES in src/core/paths.ts (dort 5 kandidaten inkl.
/// symlink-varianten), beide zusammen pflegen, wie assetProtocol.scope.
fn is_steam_config_path(file: &Path, home: &Path) -> bool {
    let roots = [
        home.join(".local/share/Steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
        home.join("snap/steam/common/.local/share/Steam"),
    ];
    for root in &roots {
        if file == root.join("config").join("config.vdf") {
            return true;
        }
        if let Ok(rel) = file.strip_prefix(root.join("userdata")) {
            let comps: Vec<_> = rel.components().collect();
            if comps.len() == 3
                && comps[0]
                    .as_os_str()
                    .to_string_lossy()
                    .chars()
                    .all(|c| c.is_ascii_digit())
                && comps[1].as_os_str() == "config"
                && comps[2].as_os_str() == "localconfig.vdf"
            {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn component_name(component: &OsStr) -> io::Result<CString> {
    CString::new(component.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL"))
}

#[cfg(target_os = "linux")]
fn open_dir_at(parent_fd: RawFd, component: &OsStr) -> io::Result<OwnedFd> {
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let component = component_name(component)?;
    let fd = unsafe {
        openat(
            parent_fd,
            component.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn open_or_create_dir_at(parent_fd: RawFd, component: &OsStr) -> io::Result<OwnedFd> {
    match open_dir_at(parent_fd, component) {
        Ok(dir) => Ok(dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            const MODE_700: u32 = 0o700;
            let component_name = component_name(component)?;
            let created = unsafe { mkdirat(parent_fd, component_name.as_ptr(), MODE_700) };
            if created < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            open_dir_at(parent_fd, component)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
extern "C" {
    fn openat(dirfd: RawFd, pathname: *const i8, flags: i32, mode: u32) -> i32;
    fn mkdirat(dirfd: RawFd, pathname: *const i8, mode: u32) -> i32;
}

#[cfg(target_os = "linux")]
fn open_backup_target_no_follow(
    relative: &Path,
    backup_dir: &Path,
) -> io::Result<(std::fs::File, OwnedFd, CString)> {
    const O_WRONLY: i32 = 1;
    const O_CREAT: i32 = 0o100;
    const O_EXCL: i32 = 0o200;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    const MODE_600: u32 = 0o600;

    let mut components = relative.components().peekable();
    let file_name = match components.next_back() {
        Some(std::path::Component::Normal(name)) => component_name(name)?,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "backup relative path must end in a normal file name",
            ))
        }
    };

    let backup_dir_c = CString::new(backup_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "backup_dir contains NUL byte"))?;
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    let root_fd = unsafe {
        openat(
            -100, // AT_FDCWD
            backup_dir_c.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut current_dir = unsafe { OwnedFd::from_raw_fd(root_fd) };

    for component in components {
        let name = match component {
            std::path::Component::Normal(name) => name,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "backup relative path contains non-normal component",
                ))
            }
        };
        current_dir = open_or_create_dir_at(current_dir.as_raw_fd(), name)?;
    }

    let raw_fd = unsafe {
        openat(
            current_dir.as_raw_fd(),
            file_name.as_ptr(),
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            MODE_600,
        )
    };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { std::fs::File::from_raw_fd(raw_fd) };
    Ok((file, current_dir, file_name))
}

#[cfg(target_os = "linux")]
fn write_backup_no_follow(
    relative: &Path,
    backup_dir: &Path,
    original: &str,
) -> Result<(), String> {
    let (mut file, dir_fd, file_name) = open_backup_target_no_follow(relative, backup_dir)
        .map_err(|e| format!("backup open (no-follow): {e}"))?;
    if let Err(e) = file
        .write_all(original.as_bytes())
        .and_then(|()| file.flush())
    {
        drop(file);
        unsafe {
            extern "C" {
                fn unlinkat(dirfd: RawFd, pathname: *const i8, flags: i32) -> i32;
            }
            unlinkat(dir_fd.as_raw_fd(), file_name.as_ptr(), 0);
        }
        return Err(format!("backup write: {e}"));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn write_backup_no_follow(
    _relative: &Path,
    _backup_dir: &Path,
    _original: &str,
) -> Result<(), String> {
    Err("backup write: no-follow open unsupported on this platform".into())
}

pub(super) fn save_launch_options_inner<F>(
    steam_root: &str,
    account_id: &str,
    app_id: u32,
    launch_options: &str,
    backup_dir: &Path,
    home: &Path,
    process_reader: &mut F,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
{
    sanitize_path(steam_root, "steam root")?;
    if account_id.parse::<u64>().map_or(true, |value| value == 0) {
        return Err("invalid account id".into());
    }
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|_| "invalid app id".to_string())?;
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| format!("steam root canonicalize: {e}"))?;
    let target = root
        .join("userdata")
        .join(account_id)
        .join("config")
        .join("localconfig.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| format!("write target canonicalize: {e}"))?;
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err("write target in blocked location".into());
    }
    if !is_steam_config_path(&canon, home) {
        return Err("write target is not a steam config file".into());
    }

    let original = fs::read_to_string(&canon).map_err(|e| format!("read target: {e}"))?;
    let app_id_str = app_id.to_string();
    let path = [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Apps",
        &app_id_str,
        "LaunchOptions",
    ];

    let current_val = vdf_patch::get_vdf_value(&original, &path)?;
    let trimmed = launch_options.trim();

    let patched = if trimmed.is_empty() {
        if current_val.is_none() {
            return Ok(WriteResult::Unchanged);
        }
        vdf_patch::remove_vdf_entry(&original, &path)?
    } else {
        if current_val.as_deref() == Some(launch_options) {
            return Ok(WriteResult::Unchanged);
        }
        vdf_patch::set_vdf_value(&original, &path, launch_options)?
    };

    if patched == original {
        return Ok(WriteResult::Unchanged);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_rel =
        Path::new("backups").join(format!("localconfig-{}-{}.vdf", account_id, timestamp));
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    write_backup_no_follow(&backup_rel, backup_dir, &original)?;

    let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
    let name = canon
        .file_name()
        .ok_or_else(|| "no file name".to_string())?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        random_suffix()
    ));
    let write_result = fs::write(&tmp, &patched).and_then(|()| fs::rename(&tmp, &canon));
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic write: {e}"));
    }

    Ok(WriteResult::Written)
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
fn open_absolute_dir(path: &Path) -> io::Result<OwnedFd> {
    const AT_FDCWD: RawFd = -100;
    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o200000;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let fd = unsafe {
        openat(
            AT_FDCWD,
            path.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn open_bound_root_fd<F>(canonical: &Path, hook: &mut F) -> Result<OwnedFd, String>
where
    F: FnMut(),
{
    let metadata = fs::metadata(canonical)
        .map_err(|error| format!("cannot stat Steam root before open: {error}"))?;
    if !metadata.is_dir() {
        return Err("Steam root is not a directory".into());
    }
    use std::os::unix::fs::MetadataExt;
    let expected = FdIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    };
    hook();
    let fd = open_absolute_dir(canonical)
        .map_err(|error| format!("steam root descriptor open: {error}"))?;
    let actual = fd_identity(fd.as_raw_fd())
        .map_err(|error| format!("cannot stat Steam root descriptor: {error}"))?;
    if actual != expected {
        return Err("Steam root changed while opening descriptor".into());
    }
    Ok(fd)
}

#[cfg(target_os = "linux")]
fn open_file_at(parent_fd: RawFd, name: &OsStr) -> io::Result<std::fs::File> {
    const O_RDONLY: i32 = 0;
    const O_NOFOLLOW: i32 = 0o400000;
    const O_CLOEXEC: i32 = 0o2000000;
    let name = component_name(name)?;
    let fd = unsafe {
        openat(
            parent_fd,
            name.as_ptr(),
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FdIdentity {
    dev: u64,
    ino: u64,
}

#[cfg(target_os = "linux")]
fn fd_identity(fd: RawFd) -> io::Result<FdIdentity> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(FdIdentity {
        dev: stat.st_dev,
        ino: stat.st_ino,
    })
}

#[cfg(target_os = "linux")]
fn ensure_regular_fd(file: &std::fs::File, label: &str) -> Result<u64, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot stat {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    Ok(metadata.len())
}

#[cfg(target_os = "linux")]
fn read_fd_text(file: &mut std::fs::File, label: &str, max_bytes: u64) -> Result<String, String> {
    let length = ensure_regular_fd(file, label)?;
    if length > max_bytes {
        return Err(format!("{label} exceeds read limit"));
    }
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} read limit overflows"))?;
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
fn compat_root_contains_name_linux_with_hook<F>(
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
fn parse_library_folder_paths(text: &str) -> Result<Vec<PathBuf>, String> {
    let tokens =
        vdf_patch::tokenize(text).map_err(|e| format!("cannot parse libraryfolders.vdf: {e}"))?;
    let entries = vdf_patch::scan_entries(&tokens, 0, tokens.len())
        .map_err(|e| format!("scan libraryfolders entries: {e}"))?;
    let lf_entry = entries
        .into_iter()
        .find(|entry| {
            matches!(&entry.key.kind, vdf_patch::TokenKind::String(key) if key.eq_ignore_ascii_case("libraryfolders"))
        })
        .ok_or_else(|| "missing libraryfolders root block in libraryfolders.vdf".to_string())?;
    let (from, to) = lf_entry
        .block
        .ok_or_else(|| "libraryfolders is not a block".to_string())?;
    let mut libraries = Vec::new();
    let mut seen = HashSet::new();
    for child in vdf_patch::scan_entries(&tokens, from, to)? {
        let vdf_patch::TokenKind::String(child_key) = &child.key.kind else {
            continue;
        };
        if !child_key
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let Some((sub_from, sub_to)) = child.block else {
            continue;
        };
        for sub in vdf_patch::scan_entries(&tokens, sub_from, sub_to)? {
            if !matches!(&sub.key.kind, vdf_patch::TokenKind::String(key) if key.eq_ignore_ascii_case("path"))
            {
                continue;
            }
            if let vdf_patch::TokenKind::String(path) = &sub.value.kind {
                let path = PathBuf::from(path);
                if seen.insert(path.clone()) {
                    libraries.push(path);
                }
            }
        }
    }
    Ok(libraries)
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
        return parse_library_folder_paths(&text);
    }
    if open_dir_at(steam_root_fd.as_raw_fd(), OsStr::new("steamapps")).is_ok() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    Err("steam root has no steamapps directory and no libraryfolders.vdf".into())
}

#[cfg(target_os = "linux")]
fn open_external_library_fd_with_hook<F>(path: &Path, hook: &mut F) -> Result<OwnedFd, String>
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

fn is_authorized_compat_tool(
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

pub(super) fn save_compat_tool_inner<F>(
    steam_root: &str,
    app_id: u32,
    tool_name: Option<&str>,
    backup_dir: &Path,
    home: &Path,
    process_reader: &mut F,
) -> Result<WriteResult, String>
where
    F: FnMut() -> Result<bool, String>,
{
    sanitize_path(steam_root, "steam root")?;
    crate::commands::scope::parse_app_id(&app_id.to_string())
        .map_err(|_| "invalid app id".to_string())?;
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    let root = fs::canonicalize(steam_root).map_err(|e| format!("steam root canonicalize: {e}"))?;
    #[cfg(target_os = "linux")]
    let steam_root_fd = open_bound_root_fd(&root, &mut || {})?;
    let target = root.join("config").join("config.vdf");
    let canon = fs::canonicalize(&target).map_err(|e| format!("write target canonicalize: {e}"))?;
    if !is_safe_path(&canon.to_string_lossy()) {
        return Err("write target in blocked location".into());
    }
    if !is_steam_config_path(&canon, home) {
        return Err("write target is not a steam config file".into());
    }

    let original = fs::read_to_string(&canon).map_err(|e| format!("read target: {e}"))?;
    let app_id_str = app_id.to_string();
    let name_path = [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        &app_id_str,
        "name",
    ];
    let current_name = vdf_patch::get_vdf_value(&original, &name_path)?;

    let patched = match tool_name {
        None | Some("default") => {
            if current_name.is_none() {
                return Ok(WriteResult::Unchanged);
            }
            let path = [
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                &app_id_str,
            ];
            vdf_patch::remove_vdf_entry(&original, &path)?
        }
        Some(tool) => {
            if !is_authorized_compat_tool(
                &root,
                #[cfg(target_os = "linux")]
                Some(&steam_root_fd),
                tool,
            )? {
                return Err("compat tool is not currently installed or backend-authorized".into());
            }
            if current_name.as_deref() == Some(tool) {
                return Ok(WriteResult::Unchanged);
            }
            let base = [
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                &app_id_str,
            ];
            let mut p = vdf_patch::set_vdf_value(
                &original,
                &[base[0], base[1], base[2], base[3], base[4], base[5], "name"],
                tool,
            )?;
            p = vdf_patch::set_vdf_value(
                &p,
                &[
                    base[0], base[1], base[2], base[3], base[4], base[5], "config",
                ],
                "",
            )?;
            p = vdf_patch::set_vdf_value(
                &p,
                &[
                    base[0], base[1], base[2], base[3], base[4], base[5], "priority",
                ],
                STEAM_COMPAT_PRIORITY,
            )?;
            p
        }
    };

    if patched == original {
        return Ok(WriteResult::Unchanged);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup_rel = Path::new("backups").join(format!("config-{}-{}.vdf", app_id, timestamp));
    if process_reader()? {
        return Err("steam is running, write refused".into());
    }
    write_backup_no_follow(&backup_rel, backup_dir, &original)?;

    let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
    let name = canon
        .file_name()
        .ok_or_else(|| "no file name".to_string())?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        random_suffix()
    ));
    let write_result = fs::write(&tmp, &patched).and_then(|()| fs::rename(&tmp, &canon));
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic write: {e}"));
    }

    Ok(WriteResult::Written)
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

// ---- Steam State Readers (Paket 18 / S-06a) ----

use std::collections::HashSet;
use std::path::PathBuf;

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

/// Liest `libraryfolders.vdf` aus `<steam_root>/config/libraryfolders.vdf` oder
/// `<steam_root>/steamapps/libraryfolders.vdf`.
/// Verwendet den gemeinsamen, begrenzten Scope-Leser für Discovery und Delete.
pub(super) fn read_library_folders(steam_root: &Path) -> Result<Vec<PathBuf>, String> {
    crate::commands::scope::read_library_folders(steam_root)
}

/// Prüft alle vorhandenen App-Manifeste und bricht bei unklaren Live-Daten ab.
/// Some(name) = app installiert (name aus dem manifest, evtl. leer),
/// None = app in keiner library gefunden.
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

fn validate_trash_target(canon_str: &str, meta: &fs::Metadata) -> Result<(), String> {
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

// ---- Binary VDF shortcuts.vdf Parser ----

fn read_c_string(buf: &[u8], pos: usize) -> Result<(String, usize), String> {
    if pos >= buf.len() {
        return Err("truncated buffer while reading string".into());
    }
    let end = buf[pos..]
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| "unterminated string in binary vdf".to_string())?;
    let s = std::str::from_utf8(&buf[pos..pos + end])
        .map_err(|e| format!("invalid utf-8 in binary vdf: {e}"))?;
    Ok((s.to_string(), pos + end + 1))
}

fn read_u32_le(buf: &[u8], pos: usize) -> Result<(u32, usize), String> {
    if pos + 4 > buf.len() {
        return Err("truncated buffer while reading u32".into());
    }
    let val = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
    Ok((val, pos + 4))
}

/// Tiefenlimit für binäre shortcuts.vdf-maps: echte dateien sind flach
/// (shortcut → werte). ohne cap liesse eine künstlich tief geschachtelte
/// datei den rekursiven walker den thread-stack überlaufen (abort).
const MAX_BINARY_VDF_DEPTH: usize = 64;

/// Grössenlimit für shortcuts.vdf-reads im delete-pipeline (analog zu den
/// 16-MiB-caps der übrigen environment-reads).
const MAX_SHORTCUTS_VDF_BYTES: u64 = 16 * 1024 * 1024;

/// steam-schreibweise der compat-tool-priority im mapping.
const STEAM_COMPAT_PRIORITY: &str = "250";

/// Caps für die delete-pipeline-reads: appmanifeste (analog 1-MiB-read im
/// valve-pfad) und config.vdf. ohne cap könnte eine präparierte datei jeden
/// löschversuch in eine voll-allokation (oom) treiben.
const MAX_DELETE_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DELETE_CONFIG_BYTES: u64 = 16 * 1024 * 1024;

fn skip_binary_value(buf: &[u8], pos: usize, val_type: u8, depth: usize) -> Result<usize, String> {
    match val_type {
        0x00 => walk_binary_map_body(buf, pos, &mut |_| {}, false, depth),
        0x01 => {
            let (_, next) = read_c_string(buf, pos)?;
            Ok(next)
        }
        0x02 | 0x03 | 0x04 | 0x06 => {
            if pos + 4 > buf.len() {
                return Err("truncated binary scalar".into());
            }
            Ok(pos + 4)
        }
        0x05 => {
            if pos + 2 > buf.len() {
                return Err("truncated wstring count".into());
            }
            let count = u16::from_le_bytes([buf[pos], buf[pos + 1]]) as usize;
            let end = pos + 2 + count * 2;
            if end > buf.len() {
                return Err("truncated wstring data".into());
            }
            Ok(end)
        }
        0x07 => {
            if pos + 8 > buf.len() {
                return Err("truncated uint64".into());
            }
            Ok(pos + 8)
        }
        _ => Err(format!("unknown binary vdf type byte: 0x{val_type:02x}")),
    }
}

fn walk_binary_map_body(
    buf: &[u8],
    mut pos: usize,
    on_app_id: &mut dyn FnMut(u32),
    is_root: bool,
    depth: usize,
) -> Result<usize, String> {
    if depth > MAX_BINARY_VDF_DEPTH {
        return Err("binary vdf nesting too deep".into());
    }
    while pos < buf.len() {
        let type_byte = buf[pos];
        if type_byte == 0x08 {
            return Ok(pos + 1);
        }
        pos += 1;
        let (key, next_pos) = read_c_string(buf, pos)?;
        pos = next_pos;

        if is_root {
            if type_byte == 0x00 && key.chars().all(|c| c.is_ascii_digit()) {
                pos = walk_binary_map_body(buf, pos, on_app_id, false, depth + 1)?;
            } else {
                pos = skip_binary_value(buf, pos, type_byte, depth + 1)?;
            }
        } else if type_byte == 0x02 && key.eq_ignore_ascii_case("appid") {
            let (val, next) = read_u32_le(buf, pos)?;
            if val > 0 {
                on_app_id(val);
            }
            pos = next;
        } else {
            pos = skip_binary_value(buf, pos, type_byte, depth + 1)?;
        }
    }
    Err("unterminated binary map body".into())
}

pub(super) fn parse_binary_shortcut_ids(buf: &[u8]) -> Result<HashSet<u32>, String> {
    if buf.is_empty() || buf[0] != 0x00 {
        return Err("missing magic byte 0x00 in shortcuts.vdf".into());
    }
    let (root_name, pos) = read_c_string(buf, 1)?;
    if !root_name.eq_ignore_ascii_case("shortcuts") {
        return Err(format!("unexpected binary root key: {root_name}"));
    }

    let mut ids = HashSet::new();
    walk_binary_map_body(
        buf,
        pos,
        &mut |app_id| {
            ids.insert(app_id);
        },
        true,
        0,
    )?;

    Ok(ids)
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

#[tauri::command]
pub async fn save_launch_options(
    app: tauri::AppHandle,
    steam_root: String,
    account_id: String,
    app_id: u32,
    launch_options: String,
) -> Result<WriteResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    spawn_blocking_io(move || {
        let mut process_reader = || is_process_running_sync("steam");
        save_launch_options_inner(
            &steam_root,
            &account_id,
            app_id,
            &launch_options,
            &backup_dir,
            &home,
            &mut process_reader,
        )
    })
    .await
}

#[tauri::command]
pub async fn save_compat_tool(
    app: tauri::AppHandle,
    steam_root: String,
    app_id: u32,
    tool_name: Option<String>,
) -> Result<WriteResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let backup_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    spawn_blocking_io(move || {
        let mut process_reader = || is_process_running_sync("steam");
        save_compat_tool_inner(
            &steam_root,
            app_id,
            tool_name.as_deref(),
            &backup_dir,
            &home,
            &mut process_reader,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;

    fn wsg_env(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let home = root.join("fakehome");
        let steam = home.join(".local/share/Steam");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
        let config_vdf = r#""InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"620"
					{
						"name"		"GE-Proton9-27"
					}
				}
			}
		}
	}
}
"#;
        let local_vdf = r#""UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
					}
				}
			}
		}
	}
}
"#;
        std::fs::write(steam.join("config/config.vdf"), config_vdf).unwrap();
        std::fs::write(steam.join("userdata/123/config/localconfig.vdf"), local_vdf).unwrap();
        for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
            let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
            std::fs::create_dir_all(&tool_dir).unwrap();
            let tool_vdf = format!(
                "\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}"
            );
            std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
        }
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        (home, cache, steam)
    }

    #[test]
    fn save_launch_options_steam_laeuft_abgelehnt() {
        let (home, cache, steam) = wsg_env("launch-running");
        std::fs::remove_file(steam.join("userdata/123/config/localconfig.vdf")).unwrap();
        let mut reader = || Ok(true);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
        let (home, cache, steam) = wsg_env("launch-process-race");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut states = [false, true].into_iter();
        let mut reader = || Ok(states.next().expect("process reader call"));

        let result = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );

        assert!(result.unwrap_err().contains("steam is running"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_happy_write_and_backup() {
        let (home, cache, steam) = wsg_env("launch-happy");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let mut reader = || Ok(false);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("\"-novid\""));

        let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
        assert!(backup_content.contains("\"gamemoderun %command%\""));

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_empty_removes_entry() {
        let (home, cache, steam) = wsg_env("launch-empty");
        let target = steam.join("userdata/123/config/localconfig.vdf");
        let mut reader = || Ok(false);
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(!content.contains("LaunchOptions"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_no_op_unchanged() {
        let (home, cache, steam) = wsg_env("launch-noop");
        let mut states = [false].into_iter();
        let mut reader = || Ok(states.next().expect("no-op must check once"));
        let res = save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            620,
            "gamemoderun %command%",
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Unchanged);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_launch_options_invalid_account_or_app_id() {
        let (home, cache, steam) = wsg_env("launch-invalid");
        let mut reader = || Ok(false);
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "abc",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "0",
            620,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        assert!(save_launch_options_inner(
            steam.to_str().unwrap(),
            "123",
            0,
            "-novid",
            &cache,
            &home,
            &mut reader
        )
        .is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_steam_laeuft_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-running");
        std::fs::remove_file(steam.join("config/config.vdf")).unwrap();
        let mut reader = || Ok(true);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_prueft_prozess_zweimal_und_schreibt_nicht_bei_start_race() {
        let (home, cache, steam) = wsg_env("compat-process-race");
        let target = steam.join("config/config.vdf");
        let before = std::fs::read_to_string(&target).unwrap();
        let mut states = [false, true].into_iter();
        let mut reader = || Ok(states.next().expect("process reader call"));

        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );

        assert!(result.unwrap_err().contains("steam is running"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_unbekannter_name_und_leerer_wert_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-invalid-name");
        for tool_name in [Some("unknown-tool"), Some("")] {
            let mut reader = || Ok(false);
            let result = save_compat_tool_inner(
                steam.to_str().unwrap(),
                620,
                tool_name,
                &cache,
                &home,
                &mut reader,
            );
            assert!(result.is_err(), "{tool_name:?} muss abgelehnt werden");
        }
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_erlaubt_valve_builtin_nur_mit_installiertem_manifest() {
        let (home, cache, steam) = wsg_env("compat-valve-installed");
        let steamapps = steam.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::write(
            steamapps.join("appmanifest_1493710.acf"),
            "\"AppState\" { \"appid\" \"1493710\" }",
        )
        .unwrap();
        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("proton_experimental"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(result.unwrap(), WriteResult::Written);

        let mut reader = || Ok(false);
        let missing = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("proton_11"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(missing.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_symlinkendes_custom_tool() {
        let (home, cache, steam) = wsg_env("compat-symlink-tool");
        let external = home.parent().unwrap().join("external-tool");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(
            external.join("compatibilitytool.vdf"),
            "\"compatibilitytools\" { \"compat_tools\" { \"evil-tool\" {} } }",
        )
        .unwrap();
        std::os::unix::fs::symlink(&external, steam.join("compatibilitytools.d/evil-tool"))
            .unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("evil-tool"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_symlinkendes_custom_root() {
        let (home, cache, steam) = wsg_env("compat-symlink-root");
        let external = home.parent().unwrap().join("external-compat-root");
        std::fs::create_dir_all(external.join("CustomTool")).unwrap();
        std::fs::write(
            external.join("CustomTool/compatibilitytool.vdf"),
            "\"compatibilitytools\" { \"compat_tools\" { \"CustomTool\" {} } }",
        )
        .unwrap();
        let compat_root = steam.join("compatibilitytools.d");
        std::fs::remove_dir_all(&compat_root).unwrap();
        std::os::unix::fs::symlink(&external, &compat_root).unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("CustomTool"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_verwirft_defekte_custom_vdf() {
        let (home, cache, steam) = wsg_env("compat-broken-vdf");
        let vdf_path = steam
            .join("compatibilitytools.d")
            .join("GE-Proton9-27")
            .join("compatibilitytool.vdf");
        std::fs::write(vdf_path, "broken {").unwrap();

        let mut reader = || Ok(false);
        let result = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-27"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[cfg(target_os = "linux")]
    fn valve_authority_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let steam = root.join("steam");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        (root, steam)
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
    fn save_compat_tool_happy_write_and_backup() {
        let (home, cache, steam) = wsg_env("compat-happy");
        let target = steam.join("config/config.vdf");
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("\"GE-Proton9-28\""));
        assert!(content.contains("\"config\"\t\t\"\""));
        assert!(content.contains("\"priority\"\t\t\"250\""));

        let backups: Vec<_> = std::fs::read_dir(cache.join("backups"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup_content = std::fs::read_to_string(backups[0].path()).unwrap();
        assert!(backup_content.contains("\"GE-Proton9-27\""));

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_none_or_default_removes_entry() {
        let (home, cache, steam) = wsg_env("compat-remove");
        let target = steam.join("config/config.vdf");
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            None,
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Written);
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(!content.contains("\"620\""));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_no_op_unchanged() {
        let (home, cache, steam) = wsg_env("compat-noop");
        let mut states = [false].into_iter();
        let mut reader = || Ok(states.next().expect("no-op must check once"));
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-27"),
            &cache,
            &home,
            &mut reader,
        );
        assert_eq!(res.unwrap(), WriteResult::Unchanged);
        assert!(!cache.join("backups").exists());
        assert_eq!(states.next(), None);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_fehlende_zieldatei_abgelehnt() {
        let (home, cache, steam) = wsg_env("compat-fehlt");
        let target = steam.join("config/config.vdf");
        std::fs::remove_file(&target).unwrap();
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            steam.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn save_compat_tool_fremder_root_abgelehnt() {
        let (home, cache, _steam) = wsg_env("compat-fremdroot");
        let fremd = home.join(".local/share/Other");
        std::fs::create_dir_all(fremd.join("config")).unwrap();
        std::fs::write(fremd.join("config/config.vdf"), "x").unwrap();
        let mut reader = || Ok(false);
        let res = save_compat_tool_inner(
            fremd.to_str().unwrap(),
            620,
            Some("GE-Proton9-28"),
            &cache,
            &home,
            &mut reader,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not a steam config file"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_backup_zwischenpfad_symlink_abgelehnt_ohne_zielveraenderung() {
        let (home, cache, steam) = wsg_env("backup-intermediate-symlink");
        let target = steam.join("config/config.vdf");
        let external_dir = home.parent().unwrap().join("externes-backup-dir");
        let external_file = external_dir.join("1.vdf");
        std::fs::create_dir_all(&external_dir).unwrap();
        std::fs::write(&external_file, "extern-unveraendert").unwrap();

        let backup_parent = cache.join("backups");
        let backup = backup_parent.join("1.vdf");
        std::fs::create_dir_all(&backup_parent).unwrap();
        std::fs::remove_dir(&backup_parent).unwrap();
        std::os::unix::fs::symlink(&external_dir, &backup_parent).unwrap();

        let relative = backup.strip_prefix(&cache).unwrap();
        let res = write_backup_no_follow(relative, &cache, "neu");

        assert!(
            res.is_err(),
            "zwischenpfad-symlink muss abgelehnt werden: {res:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&external_file).unwrap(),
            "extern-unveraendert"
        );
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("GE-Proton9-27"));
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn write_gate_backup_root_swap_auf_symlink_abgelehnt_ohne_zielveraenderung() {
        let (home, cache, steam) = wsg_env("backup-root-swap");
        let target = steam.join("config/config.vdf");
        let external_dir = home.parent().unwrap().join("externes-backup-root");
        let external_file = external_dir.join("1.vdf");
        std::fs::create_dir_all(&external_dir).unwrap();
        std::fs::write(&external_file, "extern-unveraendert").unwrap();

        let backup_parent = cache.join("backups");
        let backup = backup_parent.join("1.vdf");
        std::fs::create_dir_all(&backup_parent).unwrap();
        std::fs::remove_dir_all(&cache).unwrap();
        std::os::unix::fs::symlink(&external_dir, &cache).unwrap();

        let relative = backup.strip_prefix(&cache).unwrap();
        let res = write_backup_no_follow(relative, &cache, "neu");

        assert!(
            res.is_err(),
            "geswapte backup-root symlink muss abgelehnt werden: {res:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&external_file).unwrap(),
            "extern-unveraendert"
        );
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("GE-Proton9-27"));
        let _ = std::fs::remove_file(&cache);
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

    #[test]
    fn write_gate_muster_erkennung_flatpak_und_snap() {
        let root = wsg_fixture("muster");
        let home = root.join("fakehome");
        let flatpak =
            home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam/config/config.vdf");
        let snap = home.join("snap/steam/common/.local/share/Steam/config/config.vdf");
        assert!(is_steam_config_path(&flatpak, &home));
        assert!(is_steam_config_path(&snap, &home));
        assert!(!is_steam_config_path(&home.join("etc/evil"), &home));
        assert!(!is_steam_config_path(
            &home.join(".local/share/Steam/userdata/abc/config/localconfig.vdf"),
            &home
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- Tests für Paket 18 (S-06a: State Readers) ----

    #[test]
    fn read_library_folders_lehnt_symlink_und_nicht_regulaere_datei_ab() {
        let root = wsg_fixture("lf-delete-hardening-file-types");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let external = root.join("external");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let valid_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            external.display()
        );
        let target = config_dir.join("libraryfolders.vdf");
        let external_vdf = root.join("external-libraryfolders.vdf");
        std::fs::write(&external_vdf, &valid_vdf).unwrap();
        std::fs::write(steamapps.join("libraryfolders.vdf"), &valid_vdf).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&external_vdf, &target).unwrap();
            let error = read_library_folders(&steam).unwrap_err();
            assert!(error.contains("symlink"), "error: {error}");
            std::fs::remove_file(&target).unwrap();

            let dangling_target = root.join("missing-libraryfolders.vdf");
            std::os::unix::fs::symlink(&dangling_target, &target).unwrap();
            let error = read_library_folders(&steam).unwrap_err();
            assert!(error.contains("symlink"), "error: {error}");
            std::fs::remove_file(&target).unwrap();
        }

        std::fs::create_dir(&target).unwrap();
        assert!(read_library_folders(&steam).is_err());
        std::fs::remove_dir(&target).unwrap();

        let steamapps_vdf = steamapps.join("libraryfolders.vdf");
        #[cfg(unix)]
        {
            std::fs::remove_file(&steamapps_vdf).unwrap();
            std::os::unix::fs::symlink(&external_vdf, &steamapps_vdf).unwrap();
            let error = read_library_folders(&steam).unwrap_err();
            assert!(error.contains("symlink"), "error: {error}");
            std::fs::remove_file(&steamapps_vdf).unwrap();

            std::fs::create_dir(&steamapps_vdf).unwrap();
            assert!(read_library_folders(&steam).is_err());
            std::fs::remove_dir(&steamapps_vdf).unwrap();

            let external_steamapps = root.join("external-steamapps");
            std::fs::create_dir_all(&external_steamapps).unwrap();
            std::fs::write(external_steamapps.join("libraryfolders.vdf"), &valid_vdf).unwrap();
            std::fs::remove_dir(&steamapps).unwrap();
            std::os::unix::fs::symlink(&external_steamapps, &steamapps).unwrap();
            assert!(read_library_folders(&steam).is_err());
        }

        #[cfg(not(unix))]
        {
            std::fs::remove_file(&steamapps_vdf).unwrap();
            std::fs::create_dir(&steamapps_vdf).unwrap();
            assert!(read_library_folders(&steam).is_err());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_library_folders_lehnt_dateien_ueber_dem_read_limit_ab() {
        let root = wsg_fixture("lf-delete-hardening-size");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let library = root.join("library");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        let prefix = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            library.display()
        );
        let path = config_dir.join("libraryfolders.vdf");
        std::fs::write(&path, prefix).unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();

        let error = read_library_folders(&steam).unwrap_err();
        assert!(error.contains("read limit"), "error: {error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_library_folders_config_und_steamapps_fallback_bleiben_identisch() {
        let root = wsg_fixture("lf-delete-hardening-fallback");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let config_library = root.join("config-library");
        let fallback_library = root.join("fallback-library");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&steamapps).unwrap();
        std::fs::create_dir_all(config_library.join("steamapps")).unwrap();
        std::fs::create_dir_all(fallback_library.join("steamapps")).unwrap();

        let config_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            config_library.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &config_vdf).unwrap();
        let config_libraries = read_library_folders(&steam).unwrap();
        let config_discovery_libraries =
            crate::commands::scope::read_library_folders(&steam).unwrap();
        assert_eq!(config_libraries, config_discovery_libraries);

        std::fs::remove_file(config_dir.join("libraryfolders.vdf")).unwrap();
        let fallback_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            fallback_library.display()
        );
        std::fs::write(steamapps.join("libraryfolders.vdf"), &fallback_vdf).unwrap();
        let fallback_libraries = read_library_folders(&steam).unwrap();
        let fallback_discovery_libraries =
            crate::commands::scope::read_library_folders(&steam).unwrap();
        assert_eq!(fallback_libraries, fallback_discovery_libraries);

        let steam = std::fs::canonicalize(&steam).unwrap();
        let config_library = std::fs::canonicalize(config_library).unwrap();
        let fallback_library = std::fs::canonicalize(fallback_library).unwrap();
        assert_eq!(config_libraries, vec![steam.clone(), config_library]);
        assert_eq!(fallback_libraries, vec![steam.clone(), fallback_library]);

        std::fs::remove_file(steam.join("steamapps/libraryfolders.vdf")).unwrap();
        std::fs::write(
            steam.join("steamapps/libraryfolders.vdf"),
            "\"libraryfolders\" {}",
        )
        .unwrap();
        let empty_delete_libraries = read_library_folders(&steam).unwrap();
        let empty_discovery_libraries =
            crate::commands::scope::read_library_folders(&steam).unwrap();
        assert_eq!(empty_delete_libraries, empty_discovery_libraries);
        assert_eq!(empty_delete_libraries, vec![steam.clone()]);

        std::fs::remove_file(steam.join("steamapps/libraryfolders.vdf")).unwrap();
        let no_vdf_delete_libraries = read_library_folders(&steam).unwrap();
        let no_vdf_discovery_libraries =
            crate::commands::scope::read_library_folders(&steam).unwrap();
        assert_eq!(no_vdf_delete_libraries, no_vdf_discovery_libraries);
        assert_eq!(no_vdf_delete_libraries, vec![steam.clone()]);

        std::fs::remove_dir_all(steam.join("steamapps")).unwrap();
        assert!(read_library_folders(&steam).is_err());
        assert!(crate::commands::scope::read_library_folders(&steam).is_err());

        std::fs::write(steam.join("steamapps"), b"").unwrap();
        assert!(read_library_folders(&steam).is_err());
        assert!(crate::commands::scope::read_library_folders(&steam).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_livepruefung_verwirft_nachtraeglich_ungescopte_library() {
        let root = wsg_fixture("lf-delete-hardening-snapshot-boundary");
        let steam = root.join("steam");
        let external = root.join("external-library");
        let config_dir = steam.join("config");
        let target = external.join("steamapps/.protium-trash/compatdata_123_1");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&target).unwrap();

        let initial_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), initial_vdf).unwrap();
        let changed_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
            steam.display(),
            external.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), changed_vdf).unwrap();

        let steam_owned = steam.clone();
        let error = inspect_deletion_target(
            steam.to_str().unwrap(),
            "trash",
            target.to_str().unwrap(),
            &|path| path.starts_with(&steam_owned),
        )
        .unwrap_err();
        assert!(
            error.contains("deletion target outside allowed scope"),
            "error: {error}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_library_folders_happy_path_und_corrupt() {
        let root = wsg_fixture("lf-readers");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();

        let lib1 = root.join("lib1");
        let lib2 = root.join("lib2");
        std::fs::create_dir_all(lib1.join("steamapps")).unwrap();
        std::fs::create_dir_all(lib2.join("steamapps")).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            lib1.display(),
            lib2.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        let libs = read_library_folders(&steam).unwrap();
        assert_eq!(libs.len(), 3);
        assert_eq!(libs[0], std::fs::canonicalize(&steam).unwrap());
        assert_eq!(libs[1], std::fs::canonicalize(&lib1).unwrap());
        assert_eq!(libs[2], std::fs::canonicalize(&lib2).unwrap());

        // Corrupt VDF -> Fail-closed
        std::fs::write(
            config_dir.join("libraryfolders.vdf"),
            "\"libraryfolders\" { \"0\" { unclosed",
        )
        .unwrap();
        assert!(read_library_folders(&steam).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_app_installed_in_libraries_pruefung() {
        let root = wsg_fixture("app-installed-check");
        let lib = root.join("lib");
        let steamapps = lib.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();

        let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n\t\"name\"\t\t\"Dota 2\"\n}\n";
        std::fs::write(steamapps.join("appmanifest_570.acf"), manifest).unwrap();

        let libraries = vec![lib.clone()];
        assert!(is_app_installed_in_libraries(&libraries, 570)
            .unwrap()
            .is_some());
        assert!(is_app_installed_in_libraries(&libraries, 730)
            .unwrap()
            .is_none());

        // Mismatched filename/internal ID -> fail-closed
        let bad_manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"999\"\n}\n";
        std::fs::write(steamapps.join("appmanifest_440.acf"), bad_manifest).unwrap();
        assert!(is_app_installed_in_libraries(&libraries, 440).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_app_installed_library_ohne_steamapps_wird_uebersprungen() {
        let root = wsg_fixture("app-installed-missing-steamapps");
        let present = root.join("present");
        std::fs::create_dir_all(present.join("steamapps")).unwrap();
        let absent = root.join("absent"); // kein steamapps (z. b. volume nicht gemountet)

        // fehlende steamapps = dort liegen keine manifeste: kein fehler (INV-2).
        let libraries = vec![absent, present.clone()];
        assert!(is_app_installed_in_libraries(&libraries, 570)
            .unwrap()
            .is_none());

        // symlink-steamapps bleibt anomalie -> abgelehnt.
        let symlink_steamapps = root.join("symlinklib");
        std::fs::create_dir_all(&symlink_steamapps).unwrap();
        std::os::unix::fs::symlink(
            present.join("steamapps"),
            symlink_steamapps.join("steamapps"),
        )
        .unwrap();
        let symlink_libs = vec![symlink_steamapps];
        assert!(is_app_installed_in_libraries(&symlink_libs, 570).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uebergrosses_manifest_blockiert_delete_inspektion() {
        let root = wsg_fixture("app-installed-oversized");
        let lib = root.join("lib");
        let steamapps = lib.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        let oversized = vec![b'x'; (MAX_DELETE_MANIFEST_BYTES + 1) as usize];
        std::fs::write(steamapps.join("appmanifest_570.acf"), oversized).unwrap();

        let error = is_app_installed_in_libraries(&[lib], 570).unwrap_err();
        assert!(error.contains("exceeds size limit"), "error: {error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uebergrosse_config_vdf_blockiert_compat_tool_suche() {
        let root = wsg_fixture("config-vdf-oversized");
        let steam_root = root.join("steam");
        std::fs::create_dir_all(steam_root.join("config")).unwrap();
        let oversized = vec![b'x'; (MAX_DELETE_CONFIG_BYTES + 1) as usize];
        std::fs::write(steam_root.join("config/config.vdf"), oversized).unwrap();

        let error = find_apps_using_compat_tool(&steam_root, "GE-Proton9-27").unwrap_err();
        assert!(error.contains("exceeds size limit"), "error: {error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_reads_begrenzen_wachstum_nach_fd_pruefung() {
        let root = wsg_fixture("delete-read-growth");

        let library = root.join("library");
        let manifest_dir = library.join("steamapps");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        std::fs::write(
            manifest_dir.join("appmanifest_570.acf"),
            "\"AppState\" { \"appid\" \"570\" }",
        )
        .unwrap();
        let manifest_path = manifest_dir.join("appmanifest_570.acf");
        let mut manifest_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ManifestBeforeRead {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&manifest_path)
                    .unwrap()
                    .set_len(MAX_DELETE_MANIFEST_BYTES + 1)
                    .unwrap();
            }
        };
        let manifest_error =
            is_app_installed_in_libraries_linux_with_hook(&[library], 570, &mut manifest_hook)
                .unwrap_err();
        assert!(
            manifest_error.contains("exceeds size limit"),
            "error: {manifest_error}"
        );

        let steam = root.join("steam");
        let config_dir = steam.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.vdf"), "\"InstallConfigStore\" {}\n").unwrap();
        let steam = std::fs::canonicalize(&steam).unwrap();
        let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();
        let config_path = config_dir.join("config.vdf");
        let mut config_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ConfigBeforeRead {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&config_path)
                    .unwrap()
                    .set_len(MAX_DELETE_CONFIG_BYTES + 1)
                    .unwrap();
            }
        };
        let config_error = find_apps_using_compat_tool_linux_with_hook(
            &root_fd,
            "GE-Proton9-27",
            &mut config_hook,
        )
        .unwrap_err();
        assert!(
            config_error.contains("exceeds size limit"),
            "error: {config_error}"
        );

        let shortcut_dir = steam.join("userdata/123/config");
        std::fs::create_dir_all(&shortcut_dir).unwrap();
        std::fs::write(
            shortcut_dir.join("shortcuts.vdf"),
            make_test_bin_shortcuts(&[42]),
        )
        .unwrap();
        let shortcuts_path = shortcut_dir.join("shortcuts.vdf");
        let mut shortcuts_hook = |stage: DeleteReadStage, _file: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ShortcutsBeforeRead {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&shortcuts_path)
                    .unwrap()
                    .set_len(MAX_SHORTCUTS_VDF_BYTES + 1)
                    .unwrap();
            }
        };
        let shortcuts_root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();
        let shortcuts_error =
            read_all_shortcut_app_ids_linux_with_hook(&shortcuts_root_fd, &mut shortcuts_hook)
                .unwrap_err();
        assert!(
            shortcuts_error.contains("too large"),
            "error: {shortcuts_error}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
        let root = wsg_fixture("manifest-fd-swap");
        let library = root.join("library");
        let steamapps = library.join("steamapps");
        std::fs::create_dir_all(&steamapps).unwrap();
        let manifest = steamapps.join("appmanifest_570.acf");
        std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();

        let before_path = manifest.clone();
        let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ManifestBeforeOpen {
                let old = before_path.with_extension("old");
                std::fs::rename(&before_path, old).unwrap();
                std::fs::File::create(&before_path)
                    .unwrap()
                    .set_len(MAX_DELETE_MANIFEST_BYTES + 1)
                    .unwrap();
            }
        };
        let error = is_app_installed_in_libraries_linux_with_hook(
            std::slice::from_ref(&library),
            570,
            &mut before_open,
        )
        .unwrap_err();
        assert!(error.contains("exceeds size limit"), "error: {error}");

        std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();
        let after_path = manifest.clone();
        let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ManifestAfterOpen {
                let old = after_path.with_extension("bound");
                // defensiv: readdir-lieferung unter modifikation ist nicht
                // spezifiziert; ein zweiter slot darf nicht am fehlenden
                // original paniken.
                if std::fs::rename(&after_path, &old).is_ok() {
                    std::fs::write(&after_path, "\"AppState\" { \"appid\" \"999\" }").unwrap();
                }
            }
        };
        assert!(
            is_app_installed_in_libraries_linux_with_hook(&[library], 570, &mut after_open,)
                .unwrap()
                .is_some()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn config_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
        let root = wsg_fixture("config-fd-swap");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config = config_dir.join("config.vdf");
        let content = "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }";
        std::fs::write(&config, content).unwrap();
        let steam = std::fs::canonicalize(&steam).unwrap();
        let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();

        let before_path = config.clone();
        let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ConfigBeforeOpen {
                let old = before_path.with_extension("old");
                std::fs::rename(&before_path, old).unwrap();
                std::fs::File::create(&before_path)
                    .unwrap()
                    .set_len(MAX_DELETE_CONFIG_BYTES + 1)
                    .unwrap();
            }
        };
        let error = find_apps_using_compat_tool_linux_with_hook(
            &root_fd,
            "GE-Proton9-27",
            &mut before_open,
        )
        .unwrap_err();
        assert!(error.contains("exceeds size limit"), "error: {error}");

        std::fs::write(&config, content).unwrap();
        let after_path = config.clone();
        let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ConfigAfterOpen {
                let old = after_path.with_extension("bound");
                std::fs::rename(&after_path, old).unwrap();
                std::fs::write(&after_path, "\"InstallConfigStore\" {}").unwrap();
            }
        };
        assert_eq!(
            find_apps_using_compat_tool_linux_with_hook(&root_fd, "GE-Proton9-27", &mut after_open)
                .unwrap(),
            vec![620]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shortcuts_read_bleibt_am_geoeffneten_fd_bei_pfadtausch() {
        let root = wsg_fixture("shortcuts-fd-swap");
        let steam = root.join("steam");
        let config_dir = steam.join("userdata/123/config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let shortcuts = config_dir.join("shortcuts.vdf");
        std::fs::write(&shortcuts, make_test_bin_shortcuts(&[42])).unwrap();
        let steam = std::fs::canonicalize(&steam).unwrap();
        let root_fd = open_bound_root_fd(&steam, &mut || {}).unwrap();

        let before_path = shortcuts.clone();
        let mut before_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ShortcutsBeforeOpen {
                let old = before_path.with_extension("old");
                std::fs::rename(&before_path, old).unwrap();
                std::fs::File::create(&before_path)
                    .unwrap()
                    .set_len(MAX_SHORTCUTS_VDF_BYTES + 1)
                    .unwrap();
            }
        };
        let error =
            read_all_shortcut_app_ids_linux_with_hook(&root_fd, &mut before_open).unwrap_err();
        assert!(error.contains("too large"), "error: {error}");

        std::fs::write(&shortcuts, make_test_bin_shortcuts(&[42])).unwrap();
        let after_path = shortcuts.clone();
        let mut after_open = |stage: DeleteReadStage, _: Option<&mut std::fs::File>| {
            if stage == DeleteReadStage::ShortcutsAfterOpen {
                let old = after_path.with_extension("bound");
                std::fs::rename(&after_path, old).unwrap();
                std::fs::write(&after_path, b"not-a-shortcuts-vdf").unwrap();
            }
        };
        assert!(
            read_all_shortcut_app_ids_linux_with_hook(&root_fd, &mut after_open)
                .unwrap()
                .contains(&42)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn make_test_bin_shortcuts(app_ids: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.push(0x00);
        buf.extend_from_slice(b"shortcuts\0");
        for (i, id) in app_ids.iter().enumerate() {
            buf.push(0x00); // map
            buf.extend_from_slice(format!("{i}\0").as_bytes());
            buf.push(0x02); // type u32
            buf.extend_from_slice(b"appid\0");
            buf.extend_from_slice(&id.to_le_bytes());
            buf.push(0x01); // type string
            buf.extend_from_slice(b"appname\0Test\0");
            buf.push(0x08); // map end
        }
        buf.push(0x08); // root map end
        buf
    }

    #[test]
    fn binary_shortcuts_parser_erkennt_ids_und_schuetzt_vor_korruption() {
        let bytes = make_test_bin_shortcuts(&[3641016077, 123456]);
        let ids = parse_binary_shortcut_ids(&bytes).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&3641016077));
        assert!(ids.contains(&123456));

        // Truncated buffer -> Err
        assert!(parse_binary_shortcut_ids(&bytes[..10]).is_err());
        // Bad magic byte -> Err
        let mut bad_magic = bytes.clone();
        bad_magic[0] = 0x01;
        assert!(parse_binary_shortcut_ids(&bad_magic).is_err());
    }

    #[test]
    fn binary_shortcuts_parser_lehnt_tiefe_verschachtelung_ab() {
        // 100_000 geschachtelte maps: ohne depth-cap stack overflow (abort),
        // mit cap sauberes Err statt Prozess-Absturz.
        let mut deep = vec![0x00];
        deep.extend_from_slice(b"shortcuts\0");
        for _ in 0..100_000 {
            deep.extend_from_slice(&[0x00]);
            deep.push(b'a');
            deep.push(0x00);
        }
        deep.push(0x08);
        let err = parse_binary_shortcut_ids(&deep).unwrap_err();
        assert!(err.contains("nesting"), "err: {err}");

        // flache struktur (10 ebenen) bleibt ok: jede map braucht ihren
        // eigenen 0x08-abschluss (10 nested + root)
        let mut flat = vec![0x00];
        flat.extend_from_slice(b"shortcuts\0");
        for _ in 0..10 {
            flat.extend_from_slice(&[0x00]);
            flat.push(b'a');
            flat.push(0x00);
        }
        flat.extend(std::iter::repeat_n(0x08, 11));
        assert!(parse_binary_shortcut_ids(&flat).is_ok());
    }

    #[test]
    fn read_all_shortcut_app_ids_lehnt_riesige_datei_ab() {
        let root = wsg_fixture("shortcuts-huge");
        let steam = root.join("steam");
        let config_dir = steam.join("userdata/12345/config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let shortcuts_vdf = config_dir.join("shortcuts.vdf");
        // sparse file ueber dem größenlimit: darf nicht gelesen werden
        let file = std::fs::File::create(&shortcuts_vdf).unwrap();
        file.set_len(17 * 1024 * 1024).unwrap();
        drop(file);
        let err = read_all_shortcut_app_ids(&steam).unwrap_err();
        assert!(err.contains("too large"), "err: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_apps_using_compat_tool_findet_abhaengige_spiele() {
        let root = wsg_fixture("compat-tool-usage");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();

        let config_content = r#"
"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
				"0"
				{
					"name"		"proton-cachyos-slr"
				}
				"2207218128"
				{
					"name"		"GE-Proton11-4"
				}
					"620"
					{
						"name"		"GE-Proton9-27"
						"config"		""
						"priority"		"250"
					}
					"730"
					{
						"name"		"GE-Proton9-27"
					}
					"570"
					{
						"name"		"proton_experimental"
					}
				}
			}
		}
	}
}
"#;
        std::fs::write(config_dir.join("config.vdf"), config_content).unwrap();

        let apps = find_apps_using_compat_tool(&steam, "GE-Proton9-27").unwrap();
        assert_eq!(apps, vec![620, 730]);

        let other = find_apps_using_compat_tool(&steam, "GE-Proton10-1").unwrap();
        assert!(other.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_deletion_target_schuetzt_vor_falschen_loeschungen() {
        let root = wsg_fixture("inspect-target");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata");
        let shadercache = steamapps.join("shadercache");
        let tools_dir = steam.join("compatibilitytools.d");
        let trash_dir = steamapps.join(".protium-trash");

        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();
        std::fs::create_dir_all(&shadercache).unwrap();
        std::fs::create_dir_all(&tools_dir).unwrap();
        std::fs::create_dir_all(&trash_dir).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        // 1. Reines Orphan (kein Manifest, kein Shortcut)
        let orphan_dir = compatdata.join("999999");
        std::fs::create_dir_all(&orphan_dir).unwrap();
        let inspection = inspect_deletion_target(
            steam.to_str().unwrap(),
            "orphan",
            orphan_dir.to_str().unwrap(),
            &|_| true,
        )
        .unwrap();
        assert_eq!(inspection.target_type, "orphan");
        assert_eq!(inspection.consequences.len(), 1);
        assert_eq!(inspection.consequences[0].action, "trash");
        assert_eq!(
            inspection.consequences[0].affected_app_ids,
            Some(vec![999999])
        );

        // 2. Installiertes Spiel darf nicht als Orphan inspiziert werden;
        // der fehler nennt den spielnamen aus dem manifest statt nur die id.
        let installed_dir = compatdata.join("570");
        std::fs::create_dir_all(&installed_dir).unwrap();
        let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n\t\"name\"\t\t\"Dota 2\"\n}\n";
        std::fs::write(steamapps.join("appmanifest_570.acf"), manifest).unwrap();

        let err = inspect_deletion_target(
            steam.to_str().unwrap(),
            "orphan",
            installed_dir.to_str().unwrap(),
            &|_| true,
        )
        .unwrap_err();
        assert!(err.contains("currently installed"), "err: {err}");
        assert!(
            err.contains("Dota 2"),
            "fehler muss den spielnamen nennen: {err}"
        );

        // 3. Shortcut-Spiel darf nicht als Orphan inspiziert werden
        let shortcut_dir = compatdata.join("123456");
        std::fs::create_dir_all(&shortcut_dir).unwrap();
        let userdata_cfg = steam.join("userdata/12345/config");
        std::fs::create_dir_all(&userdata_cfg).unwrap();
        let sc_bytes = make_test_bin_shortcuts(&[123456]);
        std::fs::write(userdata_cfg.join("shortcuts.vdf"), sc_bytes).unwrap();

        let err2 = inspect_deletion_target(
            steam.to_str().unwrap(),
            "orphan",
            shortcut_dir.to_str().unwrap(),
            &|_| true,
        )
        .unwrap_err();
        assert!(err2.contains("non-steam shortcut"), "err: {err2}");

        // 4. GE-Proton Tool Inspektion
        let tool = tools_dir.join("GE-Proton9-27");
        std::fs::create_dir_all(&tool).unwrap();
        let tool_inspection = inspect_deletion_target(
            steam.to_str().unwrap(),
            "compatTool",
            tool.to_str().unwrap(),
            &|_| true,
        )
        .unwrap();
        assert_eq!(tool_inspection.target_type, "compatTool");
        assert_eq!(tool_inspection.consequences[0].action, "permanentDelete");

        // 5. Nicht-GE Tool -> Err
        let custom_tool = tools_dir.join("Proton-Custom");
        std::fs::create_dir_all(&custom_tool).unwrap();
        assert!(inspect_deletion_target(
            steam.to_str().unwrap(),
            "compatTool",
            custom_tool.to_str().unwrap(),
            &|_| true,
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_deletion_target_lehnt_target_ausserhalb_scope_ab() {
        let root = wsg_fixture("inspect-target-scope");
        let steam = root.join("steam");
        let trash_dir = steam.join("steamapps/.protium-trash");
        let target = trash_dir.join("compatdata_123_1");
        std::fs::create_dir_all(&target).unwrap();

        // scope_ok autorisiert nur den steam-root selbst, nicht das target.
        // der target-check darf nicht am lexikalischen steam-root-suffix hängen.
        let steam_root_path = steam.clone();
        let result = inspect_deletion_target(
            steam.to_str().unwrap(),
            "trash",
            target.to_str().unwrap(),
            &|p| p == steam_root_path,
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("deletion target outside allowed scope"),
            "err: {err}"
        );

        // kontrast: scope der das target einschliesst → ok
        let steam_owned = steam.clone();
        let ok = inspect_deletion_target(
            steam.to_str().unwrap(),
            "trash",
            target.to_str().unwrap(),
            &|p| p.starts_with(&steam_owned),
        )
        .unwrap();
        assert_eq!(ok.target_type, "trash");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_inspektion_erlaubt_nur_direkte_gueltige_ordner() {
        let root = wsg_fixture("inspect-trash-validator");
        let steam = root.join("steam");
        let trash_dir = steam.join("steamapps/.protium-trash");
        std::fs::create_dir_all(&trash_dir).unwrap();
        let all_in_scope = |_: &Path| true;
        let inspect = |path: &Path| {
            inspect_deletion_target(
                steam.to_str().unwrap(),
                "trash",
                path.to_str().unwrap(),
                &all_in_scope,
            )
        };

        let compatdata = trash_dir.join("compatdata_123_1700000000000");
        let shadercache = trash_dir.join("shadercache_4294967295_1");
        std::fs::create_dir_all(&compatdata).unwrap();
        std::fs::create_dir_all(&shadercache).unwrap();
        assert!(inspect(&compatdata).is_ok());
        assert!(inspect(&shadercache).is_ok());

        let nested = trash_dir.join("nested/compatdata_123_1");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(inspect(&nested).is_err());

        let unknown = trash_dir.join("unknown_123_1");
        std::fs::create_dir_all(&unknown).unwrap();
        assert!(inspect(&unknown).is_err());

        let file = trash_dir.join("compatdata_123_2");
        std::fs::write(&file, b"not a directory").unwrap();
        assert!(inspect(&file).is_err());

        let app_id_zero = trash_dir.join("compatdata_0_3");
        let app_id_non_numeric = trash_dir.join("compatdata_not-a-number_5");
        let app_id_too_large = trash_dir.join("compatdata_4294967296_4");
        let timestamp_zero = trash_dir.join("compatdata_123_0");
        let timestamp_non_numeric = trash_dir.join("compatdata_123_not-a-number");
        let timestamp_overflow = trash_dir.join("compatdata_123_18446744073709551616");
        for path in [
            &app_id_zero,
            &app_id_non_numeric,
            &app_id_too_large,
            &timestamp_zero,
            &timestamp_non_numeric,
            &timestamp_overflow,
        ] {
            std::fs::create_dir_all(path).unwrap();
            assert!(
                inspect(path).is_err(),
                "muss abgelehnt werden: {}",
                path.display()
            );
        }

        #[cfg(unix)]
        {
            let symlink_target = trash_dir.join("symlink-target");
            let symlink = trash_dir.join("compatdata_123_5");
            std::fs::create_dir_all(&symlink_target).unwrap();
            std::os::unix::fs::symlink(&symlink_target, &symlink).unwrap();
            assert!(inspect(&symlink).is_err());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspection_erlaubt_non_steam_shortcut_appid() {
        let root = wsg_fixture("inspect-appid-non-steam");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let target = steam.join("steamapps/compatdata/2207218128");
        std::fs::create_dir_all(config_dir).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            steam.join("config/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
                steam.display()
            ),
        )
        .unwrap();

        let result = inspect_deletion_target(
            steam.to_str().unwrap(),
            "orphan",
            target.to_str().unwrap(),
            &|_| true,
        );
        assert!(
            result.is_ok(),
            "inspection muss bit-31-appids autorisieren: {:?}",
            result.err()
        );
        assert!(target.exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
