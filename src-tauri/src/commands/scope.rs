use crate::commands::errcode;
use crate::commands::path::{
    canonicalize_nearest_ancestor, is_descendant_of, is_safe_path, sanitize_path,
};
use crate::commands::vdf_patch;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

#[cfg(target_os = "linux")]
use crate::commands::fd::{open_bound_root_fd, open_dir_at, open_file_at};
#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;

/// Obergrenze für gedeckelte Steam-Datei-Reads (16 MiB). Alle Lesepfade, die
/// eine fremde Datei in den Speicher holen, hängen an diesem einen Wert; die
/// sprechenden Aliase darunter dürfen ihn nicht überschreiten.
pub(crate) const MAX_VDF_READ_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_ENVIRONMENT_READ_BYTES: u64 = MAX_VDF_READ_BYTES;
/// Discovery-Kandidaten für den Steam-Root, relativ zum Home. Das Write-Gate
/// (`steam::is_steam_config_path`) erkennt nur die kanonischen Vertreter
/// (nativ/flatpak/snap); ein neuer Kandidat hier muss dort mitgeprüft werden.
/// Der Test `root_kandidaten_kollabieren_auf_die_write_gate_wurzeln` hält das.
pub(crate) const ROOT_CANDIDATES: [&str; 5] = [
    ".local/share/Steam",
    ".steam/steam",
    ".steam/root",
    ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    "snap/steam/common/.local/share/Steam",
];

/// feste, backendkanonische Ausnahmen für read-only-Distro-Protonen.
/// Beliebige Custom-Tool-Wurzeln bleiben ausgeschlossen (G-1.11).
pub(crate) const SYSTEM_COMPAT_DIRS: [&str; 2] = [
    "/usr/share/steam/compatibilitytools.d",
    "/usr/local/share/steam/compatibilitytools.d",
];

/// Discovery-Fehler einer gelisteten Library. `path-missing` ist belegte
/// abwesenheit, `scope-failed`/`read-failed` sind struktur- oder zugriffsschäden
/// (INV-2: nur der erste fall darf still übersprungen werden).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryUnavailable {
    pub path: String,
    pub reason: LibraryUnavailableReason,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LibraryUnavailableReason {
    PathMissing,
    ScopeFailed,
    ReadFailed,
}

#[derive(Clone, Debug)]
pub(crate) struct EnvironmentSnapshot {
    pub(crate) generation: u64,
    pub(crate) steam_root: PathBuf,
    pub(crate) libraries: Vec<PathBuf>,
    pub(crate) unavailable_libraries: Vec<LibraryUnavailable>,
    pub(crate) system_compat_dirs: Vec<PathBuf>,
    pub(crate) app_cache_dir: PathBuf,
    pub(crate) app_config_dir: PathBuf,
}

pub(crate) struct AuthorizedBatchPath {
    pub(crate) requested: String,
    pub(crate) real: Option<PathBuf>,
}

struct AuthorizedPath {
    real: PathBuf,
    exists: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentInfo {
    pub generation: u64,
    pub steam_root: String,
    pub libraries: Vec<String>,
    pub unavailable_libraries: Vec<LibraryUnavailable>,
    pub system_compat_dirs: Vec<String>,
    pub app_cache_dir: String,
    pub app_config_dir: String,
}

impl EnvironmentSnapshot {
    #[cfg(test)]
    pub(crate) fn for_test(
        steam_root: PathBuf,
        libraries: Vec<PathBuf>,
        system_compat_dirs: Vec<PathBuf>,
        app_cache_dir: PathBuf,
        app_config_dir: PathBuf,
    ) -> Self {
        Self {
            generation: 1,
            steam_root,
            libraries,
            unavailable_libraries: Vec::new(),
            system_compat_dirs,
            app_cache_dir,
            app_config_dir,
        }
    }

    fn to_info(&self) -> EnvironmentInfo {
        EnvironmentInfo {
            generation: self.generation,
            steam_root: self.steam_root.to_string_lossy().into_owned(),
            libraries: self
                .libraries
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            unavailable_libraries: self.unavailable_libraries.clone(),
            system_compat_dirs: self
                .system_compat_dirs
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            app_cache_dir: self.app_cache_dir.to_string_lossy().into_owned(),
            app_config_dir: self.app_config_dir.to_string_lossy().into_owned(),
        }
    }

    fn roots(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.steam_root.as_path())
            .chain(self.libraries.iter().map(PathBuf::as_path))
            .chain(self.system_compat_dirs.iter().map(PathBuf::as_path))
            .chain(std::iter::once(self.app_cache_dir.as_path()))
            .chain(std::iter::once(self.app_config_dir.as_path()))
    }

    pub(crate) fn authorizes(&self, path: &Path) -> bool {
        self.roots().any(|root| is_descendant_of(path, root))
    }
}

#[derive(Clone, Default)]
pub(crate) struct EnvironmentState {
    current: Arc<Mutex<Option<EnvironmentSnapshot>>>,
}

impl EnvironmentState {
    #[cfg(test)]
    pub(crate) fn for_test(snapshot: EnvironmentSnapshot) -> Self {
        let state = Self::default();
        state.replace(snapshot);
        state
    }

    pub(crate) fn replace(&self, mut snapshot: EnvironmentSnapshot) {
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot.generation = current
            .as_ref()
            .map_or(1, |previous| previous.generation.saturating_add(1));
        *current = Some(snapshot);
    }

    #[cfg(test)]
    pub(crate) fn replace_for_test(&self, snapshot: EnvironmentSnapshot) {
        self.replace(snapshot);
    }

    pub(crate) fn current(&self) -> Result<EnvironmentSnapshot, String> {
        self.current
            .lock()
            .map_err(|_| "environment snapshot lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "steam environment has not been discovered".to_string())
    }

    fn lock_current(&self) -> Result<MutexGuard<'_, Option<EnvironmentSnapshot>>, String> {
        self.current
            .lock()
            .map_err(|_| "environment snapshot lock poisoned".to_string())
    }

    fn authorize_path_with_status(
        snapshot: &EnvironmentSnapshot,
        raw: &str,
        label: &str,
        allow_missing: bool,
    ) -> Result<AuthorizedPath, String> {
        sanitize_path(raw, label)?;
        let raw_path = Path::new(raw);
        let metadata = match fs::symlink_metadata(raw_path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => None,
            Err(error) => return Err(format!("{label}: {error}")),
        };

        // Kein Webview-Claim darf über einen Zwischen-Symlink in einen anderen
        // Root zeigen. Die kanonischen Snapshot-Pfade selbst kommen ohne Claim
        // aus; fehlende letzte Komponenten werden erst nach diesem Check erlaubt.
        reject_symlink_components(raw_path, metadata.is_some(), label)?;

        let canonical = if metadata.is_some() {
            fs::canonicalize(raw_path).map_err(|error| format!("{label}: {error}"))?
        } else {
            canonicalize_nearest_ancestor(raw_path, label)?
        };
        if !is_safe_path(&canonical.to_string_lossy()) {
            return Err(format!("blocked path: {raw}"));
        }
        if !snapshot.authorizes(&canonical) {
            return Err(format!("path outside current environment: {raw}"));
        }
        Ok(AuthorizedPath {
            real: canonical,
            exists: metadata.is_some(),
        })
    }

    fn authorize_path_against(
        snapshot: &EnvironmentSnapshot,
        raw: &str,
        label: &str,
        allow_missing: bool,
    ) -> Result<PathBuf, String> {
        Ok(Self::authorize_path_with_status(snapshot, raw, label, allow_missing)?.real)
    }

    fn with_authorized_path<T, F>(
        &self,
        raw: &str,
        label: &str,
        allow_missing: bool,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(AuthorizedPath) -> Result<T, String>,
    {
        // Der blocking worker hält diesen Guard bis nach dem Dateizugriff;
        // Discovery kann alte Snapshot-Authorität nicht währenddessen fortsetzen.
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let authorized = Self::authorize_path_with_status(snapshot, raw, label, allow_missing)?;
        operation(authorized)
    }

    pub(crate) fn with_authorized_existing<T, F>(
        &self,
        raw: &str,
        label: &str,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(PathBuf) -> Result<T, String>,
    {
        self.with_authorized_path(raw, label, false, |authorized| operation(authorized.real))
    }

    pub(crate) fn with_authorized_optional<T, F>(
        &self,
        raw: &str,
        label: &str,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(Option<PathBuf>) -> Result<T, String>,
    {
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let authorized = Self::authorize_path_with_status(snapshot, raw, label, true)?;
        operation(authorized.exists.then_some(authorized.real))
    }

    pub(crate) fn with_authorized_library<T, F>(&self, raw: &str, operation: F) -> Result<T, String>
    where
        F: FnOnce(PathBuf) -> Result<T, String>,
    {
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let real = Self::authorize_path_against(snapshot, raw, "library path", false)?;
        if !snapshot.libraries.iter().any(|library| library == &real) {
            return Err(format!("path is not a current Steam library: {raw}"));
        }
        operation(real)
    }

    /// autorisiert genau den aktuellen Steam-Root und dessen festen GE-Zielordner.
    /// `compatibilitytools.d` darf vor der Installation fehlen, aber kein
    /// vorhandener Symlink oder ein fremder Snapshot-Pfad wird akzeptiert.
    pub(crate) fn authorize_ge_install_paths(
        &self,
        raw_steam_root: &str,
    ) -> Result<(PathBuf, PathBuf), String> {
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let steam_root =
            Self::authorize_path_against(snapshot, raw_steam_root, "steam root", false)?;
        if steam_root != snapshot.steam_root {
            return Err("steam root is not the current environment root".into());
        }
        let tools_dir = steam_root.join("compatibilitytools.d");
        Self::authorize_path_against(
            snapshot,
            &tools_dir.to_string_lossy(),
            "compatibilitytools.d",
            true,
        )?;
        Ok((steam_root, tools_dir))
    }

    pub(crate) fn is_current_ge_install_path(
        &self,
        path: &Path,
        steam_root: &Path,
        tools_dir: &Path,
    ) -> bool {
        let Ok(current) = self.current() else {
            return false;
        };
        if current.steam_root != steam_root {
            return false;
        }
        if path == steam_root {
            return true;
        }
        path == tools_dir
            && Self::authorize_path_against(
                &current,
                &tools_dir.to_string_lossy(),
                "compatibilitytools.d",
                true,
            )
            .is_ok()
    }

    pub(crate) fn with_authorized_ge_install<T, F>(
        &self,
        steam_root: &Path,
        tools_dir: &Path,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        if snapshot.steam_root != steam_root || tools_dir != steam_root.join("compatibilitytools.d")
        {
            return Err("steam root is not the current environment root".into());
        }
        Self::authorize_path_against(
            snapshot,
            &tools_dir.to_string_lossy(),
            "compatibilitytools.d",
            true,
        )?;
        operation()
    }

    pub(crate) fn with_authorized_batch<T, F>(
        &self,
        paths: &[String],
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(Vec<AuthorizedBatchPath>) -> Result<T, String>,
    {
        // Batch-Autorisierung und alle Größenläufe bilden eine Generation.
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let mut authorized = Vec::with_capacity(paths.len());
        for path in paths {
            let authorized_path =
                Self::authorize_path_with_status(snapshot, path, "batch_dir_sizes", true)?;
            authorized.push(AuthorizedBatchPath {
                requested: path.clone(),
                real: authorized_path.exists.then_some(authorized_path.real),
            });
        }
        operation(authorized)
    }

    pub(crate) fn environment_exists(&self, raw: &str) -> Result<bool, String> {
        // r-16: die existenzangabe stammt aus der autorisierungs-stat; ein
        // zweites stat des roheingabepfads würde genau das fenster wieder
        // öffnen, das die autorisierung schließt
        self.with_authorized_path(raw, "exists", true, |authorized| Ok(authorized.exists))
    }

    #[cfg(test)]
    pub(crate) fn authorize_for_test(&self, path: &Path) -> Result<PathBuf, String> {
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        Self::authorize_path_against(snapshot, &path.to_string_lossy(), "test", true)
    }

    #[cfg(test)]
    pub(crate) fn exists_for_test(&self, path: &Path) -> Result<bool, String> {
        let raw = path.to_string_lossy();
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        Self::authorize_path_against(snapshot, &raw, "exists", true)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => Err("exists: symlink rejected".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("exists: {error}")),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_authorized_existing_for_test<T, F>(
        &self,
        raw: &str,
        label: &str,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(PathBuf) -> Result<T, String>,
    {
        self.with_authorized_path(raw, label, false, |authorized| operation(authorized.real))
    }

    #[cfg(test)]
    pub(crate) fn current_for_test(&self) -> Option<EnvironmentSnapshot> {
        self.current
            .try_lock()
            .ok()
            .and_then(|current| current.clone())
    }
}

fn reject_symlink_components(path: &Path, include_leaf: bool, label: &str) -> Result<(), String> {
    let mut current = PathBuf::from("/");
    let components: Vec<_> = path.components().collect();
    let end = if include_leaf {
        components.len()
    } else {
        components.len().saturating_sub(1)
    };
    for component in components.into_iter().skip(1).take(end.saturating_sub(1)) {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("{label}: symlink component rejected"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("{label}: {error}")),
        }
    }
    Ok(())
}

fn libraryfolders_path(steam_root: &Path) -> Result<Option<PathBuf>, String> {
    for relative in ["config/libraryfolders.vdf", "steamapps/libraryfolders.vdf"] {
        let path = steam_root.join(relative);
        reject_symlink_components(&path, true, "libraryfolders.vdf")?;
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(Some(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("libraryfolders.vdf: {error}")),
        }
    }
    Ok(None)
}

pub(super) fn parse_library_folder_paths(text: &str) -> Result<Vec<PathBuf>, String> {
    let tokens = vdf_patch::tokenize(text)
        .map_err(|error| format!("cannot parse libraryfolders.vdf: {error}"))?;
    let entries = vdf_patch::scan_entries(&tokens, 0, tokens.len())
        .map_err(|error| format!("scan libraryfolders entries: {error}"))?;
    let root_entry = entries
        .into_iter()
        .find(|entry| {
            matches!(&entry.key.kind, vdf_patch::TokenKind::String(key) if key.eq_ignore_ascii_case("libraryfolders"))
        })
        .ok_or_else(|| "missing libraryfolders root block in libraryfolders.vdf".to_string())?;
    let (from, to) = root_entry
        .block
        .ok_or_else(|| "libraryfolders is not a block".to_string())?;
    let children = vdf_patch::scan_entries(&tokens, from, to)
        .map_err(|error| format!("scan libraryfolders children: {error}"))?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for child in children {
        let vdf_patch::TokenKind::String(key) = &child.key.kind else {
            continue;
        };
        if !key.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let Some((child_from, child_to)) = child.block else {
            continue;
        };
        for entry in vdf_patch::scan_entries(&tokens, child_from, child_to)
            .map_err(|error| format!("scan library entry: {error}"))?
        {
            let vdf_patch::TokenKind::String(entry_key) = &entry.key.kind else {
                continue;
            };
            if !entry_key.eq_ignore_ascii_case("path") {
                continue;
            }
            if let vdf_patch::TokenKind::String(value) = &entry.value.kind {
                let path = PathBuf::from(value);
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }
    }
    Ok(paths)
}

/// Liest `libraryfolders.vdf` über die gebundene no-follow-Deskriptorkette
/// (S-2): Root und Unterverzeichnis werden als Deskriptor gebunden, die Datei
/// per `openat(O_NOFOLLOW|O_NONBLOCK)` geöffnet und erst am Deskriptor auf
/// regulären Typ und Größe geprüft. Ein Pfad-`fs::read` hinge sonst an einem
/// FIFO, der zwischen Prüfung und Open untergeschoben wird. Der Hook sitzt
/// genau in dieser Lücke, damit ein Test den Tausch dort erzwingen kann.
#[cfg(target_os = "linux")]
fn libraryfolders_contents_with_hook<F>(
    steam_root: &Path,
    hook: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(),
{
    const NAME: &str = "libraryfolders.vdf";
    const LABEL: &str = "libraryfolders.vdf";

    let root_fd = open_bound_root_fd(steam_root, &mut || {})?;
    for directory in ["config", "steamapps"] {
        let parent_fd = match open_dir_at(root_fd.as_raw_fd(), OsStr::new(directory)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{LABEL}: {error}")),
        };
        hook();
        let mut file = match open_file_at(parent_fd.as_raw_fd(), OsStr::new(NAME)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(libraryfolders_open_error(error)),
        };
        let content =
            crate::commands::fd::read_fd_text(&mut file, LABEL, MAX_ENVIRONMENT_READ_BYTES)?;
        return Ok(Some(content));
    }
    if open_dir_at(root_fd.as_raw_fd(), OsStr::new("steamapps")).is_err() {
        return Err(format!("{LABEL}: no config or steamapps directory"));
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn libraryfolders_open_error(error: io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR) => {
            format!("libraryfolders.vdf is not a regular file: {error}")
        }
        _ => format!("cannot open libraryfolders.vdf: {error}"),
    }
}

/// Nicht-Linux baut nicht (Linux-only-App); fail-closed statt Pfad-Read.
#[cfg(not(target_os = "linux"))]
fn libraryfolders_contents_with_hook<F>(
    _steam_root: &Path,
    _hook: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(),
{
    Err("libraryfolders.vdf requires Linux no-follow descriptors".into())
}

fn read_library_paths_with_hook<F>(steam_root: &Path, hook: &mut F) -> Result<Vec<PathBuf>, String>
where
    F: FnMut(),
{
    if libraryfolders_path(steam_root)?.is_none() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    let Some(content) = libraryfolders_contents_with_hook(steam_root, hook)? else {
        return Ok(vec![steam_root.to_path_buf()]);
    };
    let paths = parse_library_folder_paths(&content)?;
    if paths.is_empty() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    Ok(paths)
}

/// kanonisiert eine gelistete library und klassifiziert andernfalls den grund,
/// warum sie nicht nutzbar ist (INV-2). `NotFound` ist belegte abwesenheit,
/// ablehnungen der pfad-validierung sind strukturschäden; echte io-fehler
/// dürfen nicht als abwesenheit gelten, sonst würde ein zugriffsfehler still
/// übersprungen.
fn canonical_library(path: &Path) -> Result<PathBuf, (LibraryUnavailableReason, String)> {
    let raw = path.to_string_lossy();
    sanitize_path(&raw, "library path").map_err(|message| {
        (
            LibraryUnavailableReason::ScopeFailed,
            format!("library path rejected: {message}"),
        )
    })?;
    // Ein Pfad, den die Blocklist ablehnt, darf nie in `libraries` landen: die
    // liste ist das scope-gate für lese- und löschpfade, und `canonicalize_safe`
    // würde ihn ablehnen, ohne dass der aufrufer den grund sehen könnte.
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        #[cfg(unix)]
        Err(error) => {
            let reason = match error.raw_os_error() {
                Some(libc::ENOENT) => LibraryUnavailableReason::PathMissing,
                // ein symlink-loop besteht `lstat`, scheitert erst beim
                // auflösen; `ErrorKind::FilesystemLoop` ist instabil, deshalb
                // der rohe errno auf unix.
                Some(libc::ELOOP | libc::ENOTDIR | libc::EACCES) => {
                    LibraryUnavailableReason::ReadFailed
                }
                _ => LibraryUnavailableReason::ScopeFailed,
            };
            return Err((reason, format!("library path: {error}")));
        }
        #[cfg(not(unix))]
        Err(error) => {
            let reason = match error.kind() {
                io::ErrorKind::NotFound => LibraryUnavailableReason::PathMissing,
                io::ErrorKind::PermissionDenied => LibraryUnavailableReason::ReadFailed,
                _ => LibraryUnavailableReason::ScopeFailed,
            };
            return Err((reason, format!("library path: {error}")));
        }
    };

    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err((
            LibraryUnavailableReason::ScopeFailed,
            format!("blocked path: {path:?}"),
        ));
    }

    let steamapps = canonical.join("steamapps");
    let metadata = fs::symlink_metadata(&steamapps).map_err(|error| {
        let reason = if error.kind() == io::ErrorKind::NotFound {
            LibraryUnavailableReason::PathMissing
        } else {
            LibraryUnavailableReason::ReadFailed
        };
        (reason, format!("library steamapps: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err((
            LibraryUnavailableReason::ScopeFailed,
            format!("library path has no regular steamapps: {path:?}"),
        ));
    }
    Ok(canonical)
}

impl LibraryUnavailableReason {
    /// text für fehlermeldungen der autoritätspfade, identisch mit den
    /// JSON-werten des drahtvertrags.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PathMissing => "path-missing",
            Self::ScopeFailed => "scope-failed",
            Self::ReadFailed => "read-failed",
        }
    }
}

/// Nur für Tests, die den alten rückgabewert ohne fehlerliste festhalten.
/// Produktionspfade nehmen `read_library_folders_with_failures`: eine hier
/// verworfene fehlerliste wäre genau der F1-verlust (INV-2).
#[cfg(test)]
pub(super) fn read_library_folders(steam_root: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(read_library_folders_with_failures(steam_root)?.0)
}

/// Snapshot-variante: nicht erreichbare libraries werden als grund gesammelt
/// statt verworfen (INV-2, F1). Der Steam-Root selbst bleibt hart.
pub(super) fn read_library_folders_with_failures(
    steam_root: &Path,
) -> Result<(Vec<PathBuf>, Vec<LibraryUnavailable>), String> {
    read_library_folders_with_hook(steam_root, &mut || {})
}

/// Hook-Variante für die Tausch-Regression: der Hook läuft nach der
/// Pfad-Vorprüfung und vor dem Deskriptor-Open, also in der TOCTOU-Lücke von
/// S-2. Produktionsaufrufer nutzen `read_library_folders_with_failures` ohne Hook.
fn read_library_folders_with_hook<F>(
    steam_root: &Path,
    hook: &mut F,
) -> Result<(Vec<PathBuf>, Vec<LibraryUnavailable>), String>
where
    F: FnMut(),
{
    let mut libraries = vec![canonical_library(steam_root).map_err(|(_, message)| message)?];
    let mut unavailable = Vec::new();
    for path in read_library_paths_with_hook(steam_root, hook)? {
        match canonical_library(&path) {
            Ok(canonical) => {
                if !libraries.contains(&canonical) {
                    libraries.push(canonical);
                }
            }
            Err((reason, _)) => unavailable.push(LibraryUnavailable {
                path: path.to_string_lossy().into_owned(),
                reason,
            }),
        }
    }

    let mut unique = Vec::new();
    let mut identities = HashSet::new();
    for library in libraries {
        let metadata =
            fs::metadata(&library).map_err(|error| format!("library identity: {error}"))?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(unix)]
        let identity = (metadata.dev(), metadata.ino());
        #[cfg(not(unix))]
        let identity = (0, metadata.len());
        if identities.insert(identity) {
            unique.push(library);
        }
    }
    Ok((unique, unavailable))
}

/// Legt ein App-Verzeichnis an und gibt den kanonischen Pfad zurueck. Auch von
/// den Backup- und Log-Commands genutzt, damit Pfad-Haertung und Ableitung
/// ueberall gleich sind.
pub(crate) fn prepare_app_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    let raw = path.to_string_lossy();
    sanitize_path(&raw, label)?;
    if !is_safe_path(&raw) {
        return Err(format!("blocked path: {path:?}"));
    }
    reject_symlink_components(path, path.exists(), label)?;
    fs::create_dir_all(path).map_err(|error| format!("{label}: {error}"))?;
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}: not a regular directory"));
    }
    let canonical = fs::canonicalize(path).map_err(|error| format!("{label}: {error}"))?;
    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err(format!("blocked path: {path:?}"));
    }
    Ok(canonical)
}

fn build_fixed_system_compat_root(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("system compat root: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "system compat root is not a regular directory: {path:?}"
        ));
    }
    reject_symlink_components(path, true, "system compat root")?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("system compat root canonicalize: {error}"))?;
    if canonical != path {
        return Err(format!("system compat root changed identity: {path:?}"));
    }
    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err(format!("blocked system compat root: {path:?}"));
    }
    Ok(Some(canonical))
}

pub(crate) fn build_environment_snapshot(
    home: &Path,
    app_cache_dir: &Path,
    app_config_dir: &Path,
) -> Result<EnvironmentSnapshot, String> {
    let home = fs::canonicalize(home).map_err(|error| format!("home canonicalize: {error}"))?;
    let fixed_candidates: Vec<PathBuf> = ROOT_CANDIDATES
        .iter()
        .map(|relative| home.join(relative))
        .collect();
    let mut steam_root = None;
    for relative in ROOT_CANDIDATES {
        let candidate = home.join(relative);
        if !candidate.exists() {
            continue;
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("steam candidate canonicalize: {error}"))?;
        if !fixed_candidates.iter().any(|fixed| fixed == &canonical) {
            return Err("steam candidate resolves to a non-fixed path".into());
        }
        if !is_descendant_of(&canonical, &home) {
            return Err("steam candidate resolves outside home".into());
        }
        let steamapps = canonical.join("steamapps");
        let Ok(metadata) = fs::symlink_metadata(&steamapps) else {
            continue;
        };
        if !metadata.file_type().is_symlink() && metadata.is_dir() {
            steam_root = Some(canonical);
            break;
        }
    }
    let steam_root = steam_root.ok_or_else(|| errcode::STEAM_NOT_FOUND.to_owned())?;

    let (unique, unavailable_libraries) = read_library_folders_with_failures(&steam_root)?;

    let app_cache_dir = prepare_app_dir(app_cache_dir, "app cache")?;
    let app_config_dir = prepare_app_dir(app_config_dir, "app config")?;

    let mut system_compat_dirs = Vec::new();
    for fixed in SYSTEM_COMPAT_DIRS {
        let path = Path::new(fixed);
        if let Some(canonical) = build_fixed_system_compat_root(path)? {
            if !system_compat_dirs.contains(&canonical) {
                system_compat_dirs.push(canonical);
            }
        }
    }

    Ok(EnvironmentSnapshot {
        generation: 0,
        steam_root,
        libraries: unique,
        unavailable_libraries,
        system_compat_dirs,
        app_cache_dir,
        app_config_dir,
    })
}

#[tauri::command]
pub async fn discover_steam_environment(
    app: tauri::AppHandle,
    state: tauri::State<'_, EnvironmentState>,
) -> Result<EnvironmentInfo, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("home directory unavailable: {error}"))?;
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("app cache directory unavailable: {error}"))?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("app config directory unavailable: {error}"))?;
    // discovery macht blocking io (canonicalize, libraryfolders, app-dirs):
    // spawn_blocking, sonst friert der main-thread beim start ein (C1-muster).
    let snapshot = crate::commands::spawn_blocking_io(move || {
        build_environment_snapshot(&home, &app_cache_dir, &app_config_dir)
    })
    .await?;
    state.replace(snapshot);
    Ok(state.current()?.to_info())
}

/// extrahiert das library-verzeichnis (alles vor dem letzten "/steamapps/").
/// `rfind` ist sicher, weil das folgende muster-check die echte anwendung garantiert.
pub(super) fn library_of(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[..idx])
}

/// alles nach dem letzten "/steamapps/". gibt None wenn der marker fehlt.
pub(super) fn suffix_after_steamapps(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str
        .rfind(marker)
        .ok_or_else(|| "path does not contain /steamapps/".to_string())?;
    Ok(&canon_str[idx + marker.len()..])
}

/// gemeinsame typ/appId-validierung der beiden lösch-pfade (orphan + trash):
/// typ ∈ {compatdata, shadercache}, ascii-digits, appId ∈ 1..u32::MAX. das
/// split selbst bleibt an den stellen (orphan: '/', trash: '_' nach
/// marker/timestamp-parse, unterschiedliche fehlermeldungen).
pub(super) fn parse_compat_id<'a>(pair: (&'a str, &'a str)) -> Result<(&'a str, &'a str), String> {
    let (typ, app_id_str) = pair;
    if typ != "compatdata" && typ != "shadercache" {
        return Err(format!("unexpected type: {typ}"));
    }
    if app_id_str.is_empty() || !app_id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric appId: {app_id_str}"));
    }
    // defense-in-depth: das JS-seitige findOrphans filtert appId 0 bereits,
    // aber ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht
    // stillschweigend zum löschen / trash-renamen eines 0-verzeichnisses
    // führen. 0 ist in steam reserviert (kein spiel) und darf nie ein
    // löschkandidat sein.
    parse_app_id(app_id_str)?;
    Ok((typ, app_id_str))
}

pub(super) fn parse_app_id(app_id_str: &str) -> Result<u32, String> {
    if app_id_str.is_empty() || !app_id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric appId: {app_id_str}"));
    }
    let app_id = app_id_str
        .parse::<u64>()
        .map_err(|_| format!("appId out of range: {app_id_str}"))?;
    // appIDs sind unsigned 32-bit. non-steam-shortcuts setzen bit 31 (2^31+n)
    // und bleiben unterhalb u32::MAX, nur 0 (reserviert) und 2^32+ sind
    // ungültig. ein i32-cap würde legitime shortcut-ids ausschließen.
    if !(1..=u32::MAX as u64).contains(&app_id) {
        return Err(if app_id == 0 {
            "appId 0 rejected".into()
        } else {
            format!("appId out of range: {app_id_str}")
        });
    }
    Ok(app_id as u32)
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
