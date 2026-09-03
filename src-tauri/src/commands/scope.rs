use crate::commands::path::{
    canonicalize_nearest_ancestor, canonicalize_safe, is_descendant_of, is_safe_path, sanitize_path,
};
use crate::commands::vdf_patch;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

pub(crate) const MAX_ENVIRONMENT_READ_BYTES: u64 = 16 * 1024 * 1024;
const ROOT_CANDIDATES: [&str; 5] = [
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

#[derive(Clone, Debug)]
pub(crate) struct EnvironmentSnapshot {
    pub(crate) generation: u64,
    pub(crate) steam_root: PathBuf,
    pub(crate) libraries: Vec<PathBuf>,
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
        F: FnOnce(PathBuf) -> Result<T, String>,
    {
        // Der blocking worker hält diesen Guard bis nach dem Dateizugriff;
        // Discovery kann alte Snapshot-Autorität nicht währenddessen fortsetzen.
        let current = self.lock_current()?;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| "steam environment has not been discovered".to_string())?;
        let real = Self::authorize_path_against(snapshot, raw, label, allow_missing)?;
        operation(real)
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
        self.with_authorized_path(raw, label, false, operation)
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
        self.with_authorized_path(raw, "exists", true, |_| match fs::symlink_metadata(raw) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                Err("exists: symlink rejected".into())
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("exists: {error}")),
        })
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
        self.with_authorized_path(raw, label, false, operation)
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

fn read_library_paths(steam_root: &Path) -> Result<Vec<PathBuf>, String> {
    let Some(path) = libraryfolders_path(steam_root)? else {
        return Ok(vec![steam_root.to_path_buf()]);
    };
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("libraryfolders.vdf: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("libraryfolders.vdf is not a regular file".into());
    }
    if metadata.len() > MAX_ENVIRONMENT_READ_BYTES {
        return Err("libraryfolders.vdf exceeds read limit".into());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("cannot read libraryfolders.vdf: {error}"))?;
    if bytes.len() as u64 > MAX_ENVIRONMENT_READ_BYTES {
        return Err("libraryfolders.vdf exceeds read limit".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|error| format!("cannot decode libraryfolders.vdf: {error}"))?;
    let paths = parse_library_folder_paths(&content)?;
    if paths.is_empty() {
        return Ok(vec![steam_root.to_path_buf()]);
    }
    Ok(paths)
}

fn canonical_library(path: &Path) -> Result<PathBuf, String> {
    let raw = path.to_string_lossy();
    let canonical = canonicalize_safe(&raw, "library path")?;
    let steamapps = canonical.join("steamapps");
    let metadata =
        fs::symlink_metadata(&steamapps).map_err(|error| format!("library steamapps: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("library path has no regular steamapps: {path:?}"));
    }
    Ok(canonical)
}

pub(super) fn read_library_folders(steam_root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut libraries = vec![canonical_library(steam_root)?];
    for path in read_library_paths(steam_root)? {
        let Ok(canonical) = canonical_library(&path) else {
            continue;
        };
        if !libraries.contains(&canonical) {
            libraries.push(canonical);
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
    Ok(unique)
}

fn prepare_app_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
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
    let steam_root = steam_root.ok_or_else(|| "steam installation not found".to_string())?;

    let unique = read_library_folders(&steam_root)?;

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
    // und bleiben unterhalb u32::MAX — nur 0 (reserviert) und 2^32+ sind
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
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;
    use std::path::PathBuf;

    #[test]
    fn libraryfolders_parser_fixture_behaelt_reihenfolge_und_first_wins() {
        let text = include_str!("../../../tests/fixtures/libraryfolders-parser.vdf");
        assert_eq!(
            parse_library_folder_paths(text).unwrap(),
            vec![
                PathBuf::from("/fixture/library-ten"),
                PathBuf::from("/fixture/library-two"),
            ]
        );
    }

    #[test]
    fn libraryfolders_parser_ignoriert_leeren_block_und_defekte_roots() {
        assert_eq!(
            parse_library_folder_paths(include_str!(
                "../../../tests/fixtures/libraryfolders-parser-empty.vdf"
            ))
            .unwrap(),
            Vec::<PathBuf>::new()
        );
        assert!(parse_library_folder_paths(include_str!(
            "../../../tests/fixtures/libraryfolders-parser-missing-root.vdf"
        ))
        .is_err());
        assert!(parse_library_folder_paths(include_str!(
            "../../../tests/fixtures/libraryfolders-parser-scalar-root.vdf"
        ))
        .is_err());
        assert!(parse_library_folder_paths(include_str!(
            "../../../tests/fixtures/libraryfolders-parser-broken.vdf"
        ))
        .is_err());
    }

    #[test]
    fn parse_compat_id_begrenzt_appid_exakt_auf_uint32() {
        // appIDs sind unsigned 32-bit. non-steam-shortcuts setzen bit 31
        // (2^31 + n) — die müssen compatdata/shadercache-löschpfade und die
        // config-zuordnung erreichen können.
        assert_eq!(
            parse_compat_id(("compatdata", "2207218128")),
            Ok(("compatdata", "2207218128"))
        );
        assert_eq!(
            parse_compat_id(("shadercache", "4294967295")),
            Ok(("shadercache", "4294967295"))
        );
        assert!(parse_compat_id(("compatdata", "0")).is_err());
        assert!(parse_compat_id(("compatdata", "4294967296")).is_err());
    }

    fn snapshot(root: &std::path::Path, library: &std::path::Path) -> EnvironmentSnapshot {
        EnvironmentSnapshot::for_test(
            root.join("steam"),
            vec![library.to_path_buf()],
            Vec::new(),
            root.join("cache"),
            root.join("config"),
        )
    }

    #[test]
    fn snapshot_rejects_unregistered_user_path() {
        let root = std::env::temp_dir().join(format!("protium-env-root-{}", std::process::id()));
        let library = root.join("library");
        let documents = root.join("Documents/steamapps");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::create_dir_all(&documents).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library));

        assert!(state.authorize_for_test(&documents.join("x")).is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_replaces_old_snapshot_authority_atomically() {
        let root = std::env::temp_dir().join(format!("protium-env-swap-{}", std::process::id()));
        let library_a = root.join("a");
        let library_b = root.join("b");
        std::fs::create_dir_all(&library_a).unwrap();
        std::fs::create_dir_all(&library_b).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library_a));

        state.replace_for_test(snapshot(&root, &library_b));

        assert!(state.authorize_for_test(&library_a).is_err());
        assert!(state.authorize_for_test(&library_b).is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn authorized_missing_path_keeps_root_authority_for_exists() {
        let root = std::env::temp_dir().join(format!("protium-env-missing-{}", std::process::id()));
        let library = root.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library));
        let missing = library.join("steamapps/library_header.jpg");

        let authorized = state.authorize_for_test(&missing).unwrap();
        assert_eq!(authorized, library);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn authorized_batch_preserves_existing_and_missing_paths() {
        let root =
            std::env::temp_dir().join(format!("protium-env-batch-missing-{}", std::process::id()));
        let library = root.join("library");
        let existing = library.join("steamapps/compatdata/12345");
        let missing = library.join("steamapps/compatdata/99999");
        std::fs::create_dir_all(&existing).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library));
        let paths = vec![
            existing.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ];

        state
            .with_authorized_batch(&paths, |authorized| {
                assert_eq!(authorized.len(), 2);
                assert_eq!(authorized[0].requested, paths[0]);
                assert!(authorized[0].real.is_some());
                assert_eq!(authorized[1].requested, paths[1]);
                assert!(authorized[1].real.is_none());
                Ok(())
            })
            .unwrap();

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn authorized_optional_keeps_authorization_and_existence_observation_consistent() {
        let root = std::env::temp_dir().join(format!(
            "protium-env-optional-status-{}",
            std::process::id()
        ));
        let library = root.join("library");
        let existing = library.join("steamapps/compatdata/12345");
        let missing = library.join("steamapps/compatdata/99999");
        std::fs::create_dir_all(&existing).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library));

        state
            .with_authorized_optional(&existing.to_string_lossy(), "test", |real| {
                assert_eq!(real, Some(std::fs::canonicalize(&existing).unwrap()));
                Ok(())
            })
            .unwrap();
        state
            .with_authorized_optional(&missing.to_string_lossy(), "test", |real| {
                assert!(real.is_none());
                Ok(())
            })
            .unwrap();

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_reads_libraries_only_from_validated_vdf() {
        let home = std::env::temp_dir().join(format!("protium-discovery-{}", std::process::id()));
        let root = home.join(".local/share/Steam");
        let external = home.join("mnt/SteamLibrary");
        let stale = home.join("gone/SteamLibrary");
        let cache = home.join("app-cache");
        let config = home.join("app-config");
        std::fs::create_dir_all(root.join("steamapps")).unwrap();
        std::fs::create_dir_all(external.join("steamapps")).unwrap();
        let vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} \"2\" {{ \"path\" \"{}\" }} }}",
            root.display(),
            external.display(),
            stale.display()
        );
        std::fs::write(root.join("steamapps/libraryfolders.vdf"), vdf).unwrap();

        let snapshot = build_environment_snapshot(&home, &cache, &config).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let external = std::fs::canonicalize(external).unwrap();
        assert_eq!(snapshot.steam_root, root);
        assert!(snapshot.libraries.contains(&root));
        assert!(snapshot.libraries.contains(&external));
        assert!(!snapshot.libraries.contains(&stale));

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_rejects_root_symlink_outside_home() {
        let home =
            std::env::temp_dir().join(format!("protium-discovery-link-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("protium-discovery-outside-{}", std::process::id()));
        std::fs::create_dir_all(outside.join("steamapps")).unwrap();
        std::fs::create_dir_all(home.join(".steam")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, home.join(".steam/steam")).unwrap();

        let result =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn discovery_rejects_documents_fake_steam() {
        let home = std::env::temp_dir().join(format!(
            "protium-discovery-documents-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(home.join("Documents/fake-steam/steamapps")).unwrap();
        let result =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
        assert!(result.unwrap_err().contains("steam installation not found"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_rejects_home_without_fixed_candidate() {
        let home =
            std::env::temp_dir().join(format!("protium-discovery-no-steam-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let result =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
        assert!(result.unwrap_err().contains("steam installation not found"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_prioritizes_native_fixed_candidate() {
        let home =
            std::env::temp_dir().join(format!("protium-discovery-priority-{}", std::process::id()));
        let native = home.join(".local/share/Steam");
        let flatpak = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
        std::fs::create_dir_all(native.join("steamapps")).unwrap();
        std::fs::create_dir_all(flatpak.join("steamapps")).unwrap();

        let snapshot =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
                .unwrap();
        assert_eq!(snapshot.steam_root, std::fs::canonicalize(native).unwrap());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_accepts_flatpak_and_snap_fixed_candidates() {
        for (index, relative) in [
            ".var/app/com.valvesoftware.Steam/.local/share/Steam",
            "snap/steam/common/.local/share/Steam",
        ]
        .into_iter()
        .enumerate()
        {
            let home = std::env::temp_dir().join(format!(
                "protium-discovery-fixed-{index}-{}",
                std::process::id()
            ));
            let root = home.join(relative);
            std::fs::create_dir_all(root.join("steamapps")).unwrap();
            let snapshot = build_environment_snapshot(
                &home,
                &home.join("app-cache"),
                &home.join("app-config"),
            )
            .unwrap();
            assert_eq!(snapshot.steam_root, std::fs::canonicalize(root).unwrap());
            let _ = std::fs::remove_dir_all(home);
        }
    }

    #[cfg(unix)]
    #[test]
    fn discovery_accepts_alias_to_another_fixed_candidate() {
        let home =
            std::env::temp_dir().join(format!("protium-discovery-alias-{}", std::process::id()));
        let target = home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam");
        let alias = home.join(".steam/steam");
        std::fs::create_dir_all(target.join("steamapps")).unwrap();
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();

        let snapshot =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"))
                .unwrap();
        assert_eq!(snapshot.steam_root, std::fs::canonicalize(target).unwrap());
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_alias_to_documents_fake_steam() {
        let home = std::env::temp_dir().join(format!(
            "protium-discovery-alias-documents-{}",
            std::process::id()
        ));
        let target = home.join("Documents/fake-steam");
        let alias = home.join(".steam/steam");
        std::fs::create_dir_all(target.join("steamapps")).unwrap();
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();

        let result =
            build_environment_snapshot(&home, &home.join("app-cache"), &home.join("app-config"));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_uses_fixed_system_compat_roots_only() {
        let fixed: Vec<PathBuf> = super::SYSTEM_COMPAT_DIRS
            .iter()
            .map(PathBuf::from)
            .collect();
        assert_eq!(fixed.len(), 2);
        assert!(!fixed.iter().any(|path| path.ends_with("custom")));
    }

    #[test]
    fn fixed_system_compat_root_rejects_symlink_target() {
        let root =
            std::env::temp_dir().join(format!("protium-system-compat-link-{}", std::process::id()));
        let target = root.join("target");
        let raw = root.join("fixed");
        std::fs::create_dir_all(&target).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &raw).unwrap();

        assert!(build_fixed_system_compat_root(&raw).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_replacement_waits_for_running_authorized_read() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root =
            std::env::temp_dir().join(format!("protium-env-concurrent-{}", std::process::id()));
        let library_a = root.join("a");
        let library_b = root.join("b");
        std::fs::create_dir_all(&library_a).unwrap();
        std::fs::create_dir_all(&library_b).unwrap();
        let state = EnvironmentState::for_test(snapshot(&root, &library_a));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let reader_state = state.clone();
        let reader_entered = entered.clone();
        let reader_release = release.clone();
        let reader_library = library_a.clone();
        let reader = thread::spawn(move || {
            reader_state
                .with_authorized_existing_for_test(
                    &reader_library.to_string_lossy(),
                    "concurrent read",
                    |_path| {
                        reader_entered.wait();
                        reader_release.wait();
                        Ok(())
                    },
                )
                .unwrap();
        });

        entered.wait();
        assert!(state.current_for_test().is_none());

        let replacement_state = state.clone();
        let replacement_root = root.clone();
        let replacement_library_b = library_b.clone();
        let replacement = thread::spawn(move || {
            replacement_state.replace_for_test(snapshot(&replacement_root, &replacement_library_b));
        });
        assert!(state.current_for_test().is_none());
        release.wait();
        reader.join().unwrap();
        replacement.join().unwrap();

        assert!(state.authorize_for_test(&library_a).is_err());
        assert!(state.authorize_for_test(&library_b).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

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

        std::fs::remove_file(config_dir.join("libraryfolders.vdf")).unwrap();
        let fallback_vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
            fallback_library.display()
        );
        std::fs::write(steamapps.join("libraryfolders.vdf"), &fallback_vdf).unwrap();
        let fallback_libraries = read_library_folders(&steam).unwrap();

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
        let empty_libraries = read_library_folders(&steam).unwrap();
        assert_eq!(empty_libraries, vec![steam.clone()]);

        std::fs::remove_file(steam.join("steamapps/libraryfolders.vdf")).unwrap();
        let no_vdf_libraries = read_library_folders(&steam).unwrap();
        assert_eq!(no_vdf_libraries, vec![steam.clone()]);

        std::fs::remove_dir_all(steam.join("steamapps")).unwrap();
        assert!(read_library_folders(&steam).is_err());

        std::fs::write(steam.join("steamapps"), b"").unwrap();
        assert!(read_library_folders(&steam).is_err());

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
}
