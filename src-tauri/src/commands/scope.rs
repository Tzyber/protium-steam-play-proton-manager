use crate::commands::errcode;
use crate::commands::libraryfolders::read_library_folders_with_failures;
use crate::commands::path::{
    canonicalize_nearest_ancestor, is_descendant_of, is_safe_path, next_existing_ancestor,
    sanitize_path,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

/// Obergrenze für gedeckelte Steam-Datei-Reads (16 MiB). Alle Lesepfade, die
/// eine fremde Datei in den Speicher holen, hängen an diesem einen Wert; die
/// sprechenden Aliase darunter dürfen ihn nicht überschreiten.
pub(crate) const MAX_VDF_READ_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_ENVIRONMENT_READ_BYTES: u64 = MAX_VDF_READ_BYTES;
/// Discovery-Kandidaten für den Steam-Root, relativ zum Home. Das Write-Gate
/// erlaubt Config-Dateien nur unter dem hier entdeckten `steam_root`, nicht
/// unter einer zweiten fest kodierten Wurzelliste. Ein neuer Kandidat ist
/// schreibbar, sobald die Discovery ihn auswählt.
pub(crate) const ROOT_CANDIDATES: [&str; 6] = [
    ".local/share/Steam",
    ".steam/steam",
    ".steam/root",
    // debians `steam-installer` (debian-bug #916303); `.steam/steam` zeigt dorthin.
    ".steam/debian-installation",
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

/// S-03: Welche Inhalte die Webview lesen darf. Nur die Dateien, die
/// `paths.ts` baut (INV-4); Login-Tokens (`local.vdf`, `ssfn*`), CEF-Cookies
/// und Logs unter dem Steam-Root bleiben unlesbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContentRead {
    Full,
    /// `config.vdf` trägt neben `CompatToolMapping` auch `ConnectCache`.
    CompatToolMappingOnly,
}

pub(crate) struct AuthorizedBatchPath {
    pub(crate) requested: String,
    /// `Err`: nur dieser pfad ist nicht autorisiert, der rest des batches bleibt messbar.
    pub(crate) real: Result<Option<PathBuf>, String>,
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
        // F-05: die beiden app-wurzeln bleiben autoritaet (`roots()`), liegen
        // aber nicht mehr im drahtvertrag; kein TS-consumer liest sie, und ein
        // zu kurzes TS-interface darf die autoritaetsmenge nicht verdecken.
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

    pub(crate) fn content_read(&self, path: &Path) -> Option<ContentRead> {
        let names = |root: &Path| -> Option<Vec<&str>> {
            path.strip_prefix(root)
                .ok()?
                .iter()
                .map(|c| c.to_str())
                .collect()
        };
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        match names(&self.steam_root).as_deref() {
            Some(["config", "config.vdf"]) => return Some(ContentRead::CompatToolMappingOnly),
            Some(
                ["config", "loginusers.vdf"] | ["compatibilitytools.d", _, "compatibilitytool.vdf"],
            ) => return Some(ContentRead::Full),
            Some(["userdata", id, "config", "localconfig.vdf" | "shortcuts.vdf"])
            | Some(["appcache", "librarycache", id, _, "library_header.jpg"])
                if digits(id) =>
            {
                return Some(ContentRead::Full)
            }
            _ => {}
        }
        let manifest = self
            .libraries
            .iter()
            .chain(std::iter::once(&self.steam_root))
            .any(|library| match names(library).as_deref() {
                Some(["steamapps", name]) => name
                    .strip_prefix("appmanifest_")
                    .and_then(|rest| rest.strip_suffix(".acf"))
                    .is_some_and(digits),
                _ => false,
            });
        let system_tool = self
            .system_compat_dirs
            .iter()
            .any(|dir| matches!(names(dir).as_deref(), Some([_, "compatibilitytool.vdf"])));
        (manifest || system_tool).then_some(ContentRead::Full)
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
        let current = self.current.lock().map_err(|_| {
            errcode::with_detail(errcode::UNAVAILABLE, "environment snapshot lock poisoned")
        })?;
        Ok(require_snapshot(&current)?.clone())
    }

    fn lock_current(&self) -> Result<MutexGuard<'_, Option<EnvironmentSnapshot>>, String> {
        self.current.lock().map_err(|_| {
            errcode::with_detail(errcode::UNAVAILABLE, "environment snapshot lock poisoned")
        })
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
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("{label}: {error}"),
                ));
            }
        };

        // Kein Webview-Claim darf über einen Zwischen-Symlink in einen anderen
        // Root zeigen. Die kanonischen Snapshot-Pfade selbst kommen ohne Claim
        // aus; fehlende letzte Komponenten werden erst nach diesem Check erlaubt.
        reject_symlink_components(raw_path, metadata.is_some(), label)?;

        let canonical = if metadata.is_some() {
            fs::canonicalize(raw_path).map_err(|error| {
                errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
            })?
        } else {
            canonicalize_nearest_ancestor(raw_path, label)?
        };
        if !is_safe_path(&canonical.to_string_lossy()) {
            return Err(errcode::with_detail(errcode::BLOCKED_LOCATION, raw));
        }
        if !snapshot.authorizes(&canonical) {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                format!("outside snapshot: {raw}"),
            ));
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
        let snapshot = require_snapshot(&current)?;
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

    /// Wie `with_authorized_existing`, nur für Dateien aus `content_read`.
    pub(crate) fn with_authorized_content<T, F>(
        &self,
        raw: &str,
        label: &str,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce(PathBuf, ContentRead) -> Result<T, String>,
    {
        let current = self.lock_current()?;
        let snapshot = require_snapshot(&current)?;
        let authorized = Self::authorize_path_with_status(snapshot, raw, label, false)?;
        let read = snapshot.content_read(&authorized.real).ok_or_else(|| {
            errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                format!("{label}: content not readable: {raw}"),
            )
        })?;
        operation(authorized.real, read)
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
        let snapshot = require_snapshot(&current)?;
        let authorized = Self::authorize_path_with_status(snapshot, raw, label, true)?;
        operation(authorized.exists.then_some(authorized.real))
    }

    pub(crate) fn with_authorized_library<T, F>(&self, raw: &str, operation: F) -> Result<T, String>
    where
        F: FnOnce(PathBuf) -> Result<T, String>,
    {
        let current = self.lock_current()?;
        let snapshot = require_snapshot(&current)?;
        let real = Self::authorize_path_against(snapshot, raw, "library path", false)?;
        if !snapshot.libraries.iter().any(|library| library == &real) {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                format!("path is not a current Steam library: {raw}"),
            ));
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
        let snapshot = require_snapshot(&current)?;
        let steam_root =
            Self::authorize_path_against(snapshot, raw_steam_root, "steam root", false)?;
        if steam_root != snapshot.steam_root {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                "steam root is not the current environment root",
            ));
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

    /// Der aktuelle Snapshot muss Root und Tool-Ordner noch autorisieren, dann
    /// läuft `operation` unter demselben Mutex. Aufrufer übergeben nur den
    /// Vorab-Check und den finalen Installations-Rename, nie die Extraktion
    /// (A-10): so landet kein Rename in einem Root, den ein paralleles `replace`
    /// gerade ablöst. Pfade statt Generation: jeder Rescan erhöht die
    /// Generation, und ein Rescan ohne Root-Wechsel darf eine laufende
    /// Installation nicht abbrechen.
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
        let snapshot = require_snapshot(&current)?;
        if snapshot.steam_root != steam_root || tools_dir != steam_root.join("compatibilitytools.d")
        {
            return Err(errcode::with_detail(
                errcode::BLOCKED_LOCATION,
                "steam root is not the current environment root",
            ));
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
        let snapshot = require_snapshot(&current)?;
        let mut authorized = Vec::with_capacity(paths.len());
        for path in paths {
            let real = Self::authorize_path_with_status(snapshot, path, "batch_dir_sizes", true)
                .map(|authorized_path| authorized_path.exists.then_some(authorized_path.real));
            authorized.push(AuthorizedBatchPath {
                requested: path.clone(),
                real,
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
        let snapshot = require_snapshot(&current)?;
        Self::authorize_path_against(snapshot, &path.to_string_lossy(), "test", true)
    }

    #[cfg(test)]
    pub(crate) fn exists_for_test(&self, path: &Path) -> Result<bool, String> {
        let raw = path.to_string_lossy();
        let current = self.lock_current()?;
        let snapshot = require_snapshot(&current)?;
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

/// belegter snapshot oder der eine UNAVAILABLE-fehler aller scope-pfade; text
/// und code stehen hier genau einmal.
fn require_snapshot(
    snapshot: &Option<EnvironmentSnapshot>,
) -> Result<&EnvironmentSnapshot, String> {
    snapshot.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            "steam environment has not been discovered",
        )
    })
}

/// Prueft die Komponenten eines Rohpfads per `lstat` auf Symlinks, bevor
/// irgendetwas kanonisiert oder angelegt wird. `include_leaf` schliesst die
/// letzte Komponente ein; mit `true` faellt damit auch ein toter Blatt-Symlink
/// auf, den `path.exists()` als abwesend melden wuerde.
///
/// Abgebrochen wird, sobald eine Komponente fehlt oder nicht durchquerbar ist
/// (`NotFound`/`NotADirectory`): tiefer liegende Komponenten gibt es dann nicht,
/// und den echten Grund meldet das Anlegen (F-04: `prepare_app_dir`).
pub(super) fn reject_symlink_components(
    path: &Path,
    include_leaf: bool,
    label: &str,
) -> Result<(), String> {
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
                return Err(errcode::with_detail(
                    errcode::SYMLINK_REJECTED,
                    format!("{label}: symlink component rejected"),
                ));
            }
            Ok(_) => {}
            // Ein fehlender Pfad und ein Nicht-Verzeichnis als Vorfahr koennen
            // kein Symlink sein; tiefer liegende Komponenten existieren dann
            // nicht. Den echten Grund meldet das Anlegen (F-04:
            // `prepare_app_dir`): `unavailable`, nicht die io-regel
            // `unreadable`/`not-found`.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                break
            }
            Err(error) => {
                return Err(errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("{label}: {error}"),
                ))
            }
        }
    }
    Ok(())
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

/// Legt App-Verzeichnisse mit `0700` an; fehlende Elternverzeichnisse
/// erhalten ebenfalls `0700`. Der Default-Modus (`create_dir_all`) folgt dem
/// umask und gibt einem zweiten lokalen Account Einblick in Logs, Backups und
/// Cache-Metadaten (audit 2026-10-20, 6.1).
#[cfg(unix)]
pub(crate) fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
pub(crate) fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

/// Pfadbasierter Fallback: nur verengen, Leaf-Symlinks ueberspringen.
/// Braucht kein Leserecht auf das Verzeichnis und traegt deshalb die Faelle, in
/// denen der Deskriptor nicht aufgeht (`0111`, `0355`).
#[cfg(unix)]
fn restrict_dir_to_owner_by_path(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        return;
    }
    let mode = metadata.permissions().mode() & 0o7777;
    if mode & 0o077 != 0 {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode & !0o077));
    }
}

/// Best effort: Bestand aus aelteren Versionen kann weiter offen stehen.
/// Nur verengen; ein bereits engerer Modus bleibt erhalten.
///
/// Der Linux-Deskriptorweg beseitigt zwei Dinge: das Folgen eines Blatt-Symlinks
/// (das `chmod` traefe sonst das Ziel dahinter) und das Fenster zwischen `lstat`
/// und `chmod` am Blatt selbst (R3).
///
/// Was er NICHT beseitigt: die Elternkomponenten werden in BEIDEN Zweigen
/// pfadbasiert aufgeloest, dort bleibt das TOCTOU-Restfenster. Wird ein
/// Elternpfad zwischen Aufloesung und `chmod` ausgetauscht, kann das `chmod`
/// ein fremdes Verzeichnis treffen. Der Fallback greift bei JEDEM Fehler des
/// Deskriptor-Opens, insbesondere bei EACCES aus fehlendem Leserecht
/// (`0111`/`0355`): dann bleibt nur der pfadbasierte Weg, damit das Verengen
/// nicht still entfaellt; dort kommt das Folgen von Blatt-Symlinks hinzu.
#[cfg(target_os = "linux")]
fn restrict_dir_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(fd) = crate::commands::fd::open_absolute_dir(path) else {
        restrict_dir_to_owner_by_path(path);
        return;
    };
    let file = fs::File::from(fd);
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let mode = metadata.permissions().mode() & 0o7777;
    if mode & 0o077 != 0 {
        let _ = file.set_permissions(fs::Permissions::from_mode(mode & !0o077));
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn restrict_dir_to_owner(path: &Path) {
    restrict_dir_to_owner_by_path(path);
}

#[cfg(not(unix))]
fn restrict_dir_to_owner(_path: &Path) {}

/// Anlegen und Bestand verengen, ohne `exists()`-Vorpruefung: so zieht auch
/// ein bereits vorhandenes Verzeichnis nach (Panic-Pfad ohne Discovery).
///
/// Bewusst ohne Root- und Descendant-Pruefung: der Aufruf verengt jedes
/// uebergebene Verzeichnis. Nur mit bereits geprueften App-Pfaden aufrufen.
pub(crate) fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    create_private_dir_all(path)?;
    restrict_dir_to_owner(path);
    Ok(())
}

/// Legt ein App-Verzeichnis an und gibt den kanonischen Pfad zurueck. Auch von
/// den Backup- und Log-Commands genutzt, damit Pfad-Haertung und Ableitung
/// ueberall gleich sind.
///
/// Wirkung: der `app_root` selbst wird bei Bedarf angelegt (Default-Modus, siehe
/// `create_dir_all` unten), ein fehlendes Kindverzeichnis entsteht mit `0700`,
/// vorhandener Bestand wird auf `0700` verengt (nur verengen, nie weiten). Der
/// Pfad muss echt unterhalb des uebergebenen `app_root` liegen; der Root selbst
/// wird abgelehnt. Die Zugehoerigkeitspruefung ist noetig, weil das Verengen
/// sonst auch ein fremdes Verzeichnis (`/home`, `/tmp/...`, als root
/// systemweit) träfe (R2).
///
/// `app_root` selbst laeuft nicht separat durch `reject_symlink_components`
/// (nur `is_safe_path` nach der Kanonisierung): liegt `path` bereits auf dem
/// kanonischen Zielpfad eines Symlink-`app_root`, wird `app_root` verfolgt und
/// als kanonisches Ziel zur Wurzel der Descendant-Pruefung. Liegt `path`
/// dagegen lexikalisch unter `app_root` (Regelfall der Aufrufer), prueft
/// `reject_symlink_components(path, true, label)` alle Komponenten ab `/` und
/// lehnt auch einen Symlink im `app_root`-Praefix mit `symlink-rejected` ab.
/// Der kanonische Gleichheitscheck unten faengt Aliase derselben Komponente ab
/// (etwa `/pfad/.`).
///
/// Fuer einen nicht durchquerbaren Vorfahren (Datei als Elternverzeichnis,
/// `NotADirectory`) bricht `reject_symlink_components` die Komponentenpruefung
/// ab; der Abbruch endet jetzt beim Anlegen als `unavailable` statt vorher als
/// `unreadable` aus der Komponentenpruefung. Diese Vertragsaenderung ist bewusst
/// und mit dem F-04-Test gepinnt.
pub(crate) fn prepare_app_dir(
    path: &Path,
    app_root: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let raw = path.to_string_lossy();
    sanitize_path(&raw, label)?;
    if !is_safe_path(&raw) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{path:?}"),
        ));
    }
    // Symlink-komponenten werden auf dem Rohpfad VOR jedem Kanonisieren
    // abgelehnt: sonst verdeckt der spaetere Descendant-Check den Grund und die
    // Ablehnung traegt `blocked-location` statt `symlink-rejected`.
    // `true` schliesst das Blatt ein; die Begruendung (toter Blatt-Symlink, den
    // `path.exists()` als abwesend meldet) steht beim Helper. Fehlende Vorfahren
    // brechen die Schleife selbst ab, fehlende Pfade kosten also nichts.
    reject_symlink_components(path, true, label)?;
    // Der Root selbst ist kein App-Verzeichnis: er wuerde beim spaeteren
    // Verengen ein fremdes Elternverzeichnis treffen.
    if path == app_root {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: app root itself: {path:?}"),
        ));
    }
    // Der Root darf fehlen (erster Start, geloeschter Cache) und wird hier
    // angelegt. Bewusst `create_dir_all` im Default-Modus: der Root ist die
    // App-Basis, deren Elternverzeichnis der App nicht gehoert (`~/.cache`,
    // `~/.local/share`); ein 0700 dort waere ein Eingriff in fremde Rechte. Die
    // Kindpfade laufen weiter ueber `create_private_dir_all` (0700).
    fs::create_dir_all(app_root).map_err(|error| {
        errcode::with_detail(errcode::UNAVAILABLE, format!("{label} root: {error}"))
    })?;
    let canonical_root = fs::canonicalize(app_root).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("{label} root: {error}"),
        )
    })?;
    if !is_safe_path(&canonical_root.to_string_lossy()) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{app_root:?}"),
        ));
    }
    // Der descendant-check läuft VOR dem anlegen: sonst entstünde schon ein
    // Verzeichnis außerhalb des App-Roots, bevor die Prüfung greift.
    let ancestor = next_existing_ancestor(path).ok_or_else(|| {
        errcode::with_detail(
            errcode::NOT_FOUND,
            format!("{label}: no existing ancestor for {path:?}"),
        )
    })?;
    let ancestor_canonical = fs::canonicalize(&ancestor).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("{label} ancestor: {error}"),
        )
    })?;
    if !is_descendant_of(&ancestor_canonical, &canonical_root) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: outside app root: {path:?}"),
        ));
    }
    // F-04: ein fehlgeschlagenes anlegen ist kein lesevorgang; `code_for_io`
    // (not-found/unreadable) beschreibt hier die falsche ursache (rechte/ro).
    //
    // Restrisiko "R11-TOCTOU": im Wettlauf (Komponente zwischen Pruefung und
    // mkdir/chmod ausgetauscht) kann hier ein Pfad ausserhalb des Roots
    // entstehen. Ebenso kann ein Elternpfad zwischen der zweiten
    // Descendant-Pruefung und dem chmod getauscht werden; dann verengt
    // `restrict_dir_to_owner` ein fremdes Verzeichnis. Beides ist ein
    // Restrisiko, nicht ausgeschlossen: Pfadpruefung und Dateizugriff sind
    // nicht atomar, und der Deskriptorweg deckt nur das Blatt ab.
    create_private_dir_all(path)
        .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, format!("{label}: {error}")))?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(errcode::with_detail(
            errcode::NOT_A_DIRECTORY,
            format!("{label}: not a regular directory"),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        errcode::with_detail(errcode::code_for_io(&error), format!("{label}: {error}"))
    })?;
    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{path:?}"),
        ));
    }
    // Zweite Root-Pruefung: der lexikalische Check oben greift nicht, wenn sich
    // der Rohpfad erst durch die Kanonisierung auf den Root abbildet.
    if canonical == canonical_root {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: app root itself: {path:?}"),
        ));
    }
    // Nach dem Anlegen erneut prüfen: eine Komponente kann zwischen den
    // beiden Läufen ausgetauscht worden sein.
    if !is_descendant_of(&canonical, &canonical_root) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("{label}: outside app root: {path:?}"),
        ));
    }
    restrict_dir_to_owner(&canonical);
    Ok(canonical)
}

fn build_fixed_system_compat_root(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errcode::with_detail(
                errcode::code_for_io(&error),
                format!("system compat root: {error}"),
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(errcode::with_detail(
            errcode::NOT_A_DIRECTORY,
            format!("system compat root is not a regular directory: {path:?}"),
        ));
    }
    reject_symlink_components(path, true, "system compat root")?;
    let canonical = fs::canonicalize(path).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("system compat root canonicalize: {error}"),
        )
    })?;
    if canonical != path {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("system compat root changed identity: {path:?}"),
        ));
    }
    if !is_safe_path(&canonical.to_string_lossy()) {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            format!("blocked system compat root: {path:?}"),
        ));
    }
    Ok(Some(canonical))
}

pub(crate) fn build_environment_snapshot(
    home: &Path,
    app_cache_dir: &Path,
    app_config_dir: &Path,
) -> Result<EnvironmentSnapshot, String> {
    let home = fs::canonicalize(home).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("home canonicalize: {error}"),
        )
    })?;
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
        let canonical = fs::canonicalize(&candidate).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("steam candidate canonicalize: {error}"),
            )
        })?;
        // ein alias auf ein fremdes ziel wird nie root; nur dieser kandidat
        // entfällt, die übrigen festen kandidaten bleiben auffindbar.
        if !fixed_candidates.iter().any(|fixed| fixed == &canonical)
            || !is_descendant_of(&canonical, &home)
        {
            continue;
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

    // Root ist jeweils das Elternverzeichnis: fachlich die App-Basis, unter der
    // Cache und Config liegen, nicht das Verzeichnis selbst (sonst wäre der
    // descendant-check tautologisch).
    let cache_root = app_cache_dir
        .parent()
        .ok_or_else(|| errcode::with_detail(errcode::UNAVAILABLE, "app cache: no parent root"))?;
    let app_cache_dir = prepare_app_dir(app_cache_dir, cache_root, "app cache")?;
    let config_root = app_config_dir
        .parent()
        .ok_or_else(|| errcode::with_detail(errcode::UNAVAILABLE, "app config: no parent root"))?;
    let app_config_dir = prepare_app_dir(app_config_dir, config_root, "app config")?;

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
    let home = app.path().home_dir().map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("home directory unavailable: {error}"),
        )
    })?;
    let app_cache_dir = app.path().app_cache_dir().map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("app cache directory unavailable: {error}"),
        )
    })?;
    let app_config_dir = app.path().app_config_dir().map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("app config directory unavailable: {error}"),
        )
    })?;
    // discovery macht blocking io (canonicalize, libraryfolders, app-dirs):
    // spawn_blocking, sonst friert der main-thread beim start ein (C1-muster).
    // replace und current nehmen denselben std-Mutex und laufen deshalb
    // ebenfalls im blocking-pool, nicht auf einem Tokio-Worker.
    let state = state.inner().clone();
    crate::commands::spawn_blocking_io(move || {
        let snapshot = build_environment_snapshot(&home, &app_cache_dir, &app_config_dir)?;
        state.replace(snapshot);
        Ok(state.current()?.to_info())
    })
    .await
}

/// extrahiert das library-verzeichnis (alles vor dem letzten "/steamapps/").
/// `rfind` ist sicher, weil das folgende muster-check die echte anwendung garantiert.
pub(super) fn library_of(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str.rfind(marker).ok_or_else(|| {
        errcode::with_detail(errcode::INVALID_VALUE, "path does not contain /steamapps/")
    })?;
    Ok(&canon_str[..idx])
}

/// alles nach dem letzten "/steamapps/". gibt None wenn der marker fehlt.
pub(super) fn suffix_after_steamapps(canon_str: &str) -> Result<&str, String> {
    let marker = "/steamapps/";
    let idx = canon_str.rfind(marker).ok_or_else(|| {
        errcode::with_detail(errcode::INVALID_VALUE, "path does not contain /steamapps/")
    })?;
    Ok(&canon_str[idx + marker.len()..])
}

/// gemeinsame typ/appId-validierung der beiden lösch-pfade (orphan + trash):
/// typ ∈ {compatdata, shadercache}, ascii-digits, appId ∈ 1..u32::MAX. das
/// split selbst bleibt an den stellen (orphan: '/', trash: '_' nach
/// marker/timestamp-parse, unterschiedliche fehlermeldungen).
pub(super) fn parse_compat_id<'a>(pair: (&'a str, &'a str)) -> Result<(&'a str, &'a str), String> {
    let (typ, app_id_str) = pair;
    if typ != "compatdata" && typ != "shadercache" {
        return Err(errcode::with_detail(errcode::UNSUPPORTED_TARGET, typ));
    }
    if app_id_str.is_empty() || !app_id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("non-numeric appId: {app_id_str}"),
        ));
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
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("non-numeric appId: {app_id_str}"),
        ));
    }
    let app_id = app_id_str.parse::<u64>().map_err(|_| {
        errcode::with_detail(
            errcode::UNREADABLE,
            format!("appId out of range: {app_id_str}"),
        )
    })?;
    // appIDs sind unsigned 32-bit. non-steam-shortcuts setzen bit 31 (2^31+n)
    // und bleiben unterhalb u32::MAX, nur 0 (reserviert) und 2^32+ sind
    // ungültig. ein i32-cap würde legitime shortcut-ids ausschließen.
    if !(1..=u32::MAX as u64).contains(&app_id) {
        return Err(if app_id == 0 {
            // bewusste ablehnung des geprueften werts 0 (reserviert)
            errcode::with_detail(errcode::INVALID_VALUE, "appId 0 rejected")
        } else {
            errcode::with_detail(
                errcode::UNREADABLE,
                format!("appId out of range: {app_id_str}"),
            )
        });
    }
    Ok(app_id as u32)
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
