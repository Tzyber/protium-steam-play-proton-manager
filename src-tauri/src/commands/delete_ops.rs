// Interne Delete-Operationen und Replay-Schutz (Paket 19 / S-06b / S-06c).
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::commands::cleanup::TRASH_DIR_NAME;
use crate::commands::delete_inspect::inspect_deletion_target;
use crate::commands::delete_inspect::{DeleteConsequence, DeletionInspection};
use crate::commands::errcode;
#[cfg(target_os = "linux")]
use crate::commands::fd::{component_name, FdIdentity};
use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};

pub const DELETE_TOKEN_TTL_SECS: u64 = 300;

/// 3.2: der uhrfehler wird geführt, nicht verschluckt. Mit 0 als "jetzt" wäre
/// jedes frisch ausgegebene Token sofort abgelaufen.
fn now_ms() -> Result<u64, String> {
    crate::commands::path::unix_millis()
}

/// renameat2-flag: kein überschreiben des ziels (RENAME_NOREPLACE).
const RENAME_NOREPLACE_FLAG: u32 = 1;
/// Ein Claim-Versuch endet mit EEXIST, wenn der Zufallsname kollidiert; vier
/// Versuche deckeln die Schleife (r-11: die Zahl war ein magisches Literal).
const CLAIM_NAME_ATTEMPTS: u32 = 4;
pub const MAX_PENDING_DELETES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDeleteRequest {
    pub target_type: String, // "orphan" | "trash" | "compatTool"
    pub path: String,
    pub steam_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeleteInfo {
    pub token: String,
    pub expires_at: u64,
    pub target_type: String,
    pub target_path: String,
    pub consequences: Vec<DeleteConsequence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    /// Pfad der abgeschlossenen Mutation. Ein Fehlschlag ist ein `Err` des
    /// Commands, kein `false`-Flag: das Feld `success` war konstant `true`.
    pub deleted_path: String,
}

#[derive(Debug)]
pub struct PendingDelete {
    pub created_at: u64,
    pub expires_at: u64,
    pub target_type: String,
    pub target_path: String,
    pub canonical_path: PathBuf,
    pub steam_root: PathBuf,
    pub dev: u64,
    pub ino: u64,
    // Der offene Descriptor hält das ursprünglich autorisierte Verzeichnis
    // auch bei Linux-Inode-Recycling eindeutig gebunden.
    pub target_handle: Option<fs::File>,
    // Der Parent-Descriptor bindet den Directory-Entry für die Mutation.
    pub parent_handle: Option<fs::File>,
    pub target_name: Option<OsString>,
    pub consequences: Vec<DeleteConsequence>,
}

#[derive(Default, Clone)]
pub struct PendingDeleteRegistry(pub Arc<Mutex<HashMap<String, PendingDelete>>>);

pub(super) fn generate_os_random_128() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    // 3.2: ohne CSPRNG gibt es kein eindeutiges, nicht ratbares Token; der
    // ausfall ist ein nicht verfügbarer dienst, kein rohtext.
    getrandom::fill(&mut bytes).map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("cannot read OS CSPRNG: {error}"),
        )
    })?;
    Ok(crate::commands::fd::hex_lower(&bytes))
}

#[cfg(target_os = "linux")]
fn open_delete_target_handle(path: &Path) -> Result<fs::File, String> {
    // r-13: dieselbe no-follow-open-kette wie fd::open_absolute_dir statt eines
    // zweiten handgeschriebenen libc::open. Der fehlerfall bleibt unreadable.
    let fd = crate::commands::fd::open_absolute_dir(path)
        .map_err(|error| errcode::with_detail(errcode::UNREADABLE, error))?;
    let handle = fs::File::from(fd);
    if !handle
        .metadata()
        .map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("cannot stat bound delete target: {error}"),
            )
        })?
        .is_dir()
    {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    Ok(handle)
}

#[cfg(not(target_os = "linux"))]
fn open_delete_target_handle(_path: &Path) -> Result<fs::File, String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "delete target identity binding",
    ))
}

/// Öffnet oder erzeugt `<library>/steamapps/.protium-trash` entlang gebundener
/// Deskriptoren (N3): die Library wird identitätsgeprüft geöffnet, `steamapps`
/// und der Papierkorb folgen relativ dazu mit `O_NOFOLLOW`. Damit gibt es kein
/// Fenster, in dem ein ausgetauschter Parent den Papierkorb außerhalb der
/// autorisierten Library anlegen könnte; `hook` ist der Testhaken in genau
/// diesem Bindefenster.
#[cfg(target_os = "linux")]
fn open_trash_dir<F>(library: &Path, hook: &mut F) -> Result<fs::File, String>
where
    F: FnMut() + ?Sized,
{
    use std::os::fd::AsRawFd;

    let library_fd = crate::commands::fd::open_bound_root_fd(library, hook)?;
    let steamapps_fd =
        crate::commands::fd::open_dir_at(library_fd.as_raw_fd(), OsStr::new("steamapps")).map_err(
            |error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("cannot open steamapps: {error}"),
                )
            },
        )?;
    let trash_fd = crate::commands::fd::open_or_create_dir_at(
        steamapps_fd.as_raw_fd(),
        OsStr::new(TRASH_DIR_NAME),
    )
    .map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot create trash dir: {error}"),
        )
    })?;
    Ok(fs::File::from(trash_fd))
}

#[cfg(not(target_os = "linux"))]
fn open_trash_dir<F>(_library: &Path, _hook: &mut F) -> Result<fs::File, String>
where
    F: FnMut() + ?Sized,
{
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "trash directory binding",
    ))
}

#[cfg(target_os = "linux")]
fn delete_handle_identity(handle: &fs::File) -> Result<FdIdentity, String> {
    let metadata = handle.metadata().map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("cannot stat bound delete target: {error}"),
        )
    })?;
    if !metadata.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    Ok(FdIdentity::of(&metadata))
}

#[cfg(target_os = "linux")]
fn open_delete_child_handle(parent: &fs::File, name: &OsStr) -> Result<fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    // ein NUL ist in einem POSIX-namen unmöglich; der name kann dann keinen ort
    // bezeichnen. blocked-location statt invalid-value, weil letzteres einen
    // syntaktisch falschen eingabewert meint, nicht einen defekten bindungsnamen.
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| {
        errcode::with_detail(errcode::BLOCKED_LOCATION, "delete target name contains NUL")
    })?;
    let raw = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if raw < 0 {
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            std::io::Error::last_os_error(),
        ));
    }
    let handle = fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) });
    let _ = delete_handle_identity(&handle)?;
    Ok(handle)
}

#[cfg(not(target_os = "linux"))]
fn open_delete_child_handle(_parent: &fs::File, _name: &OsStr) -> Result<fs::File, String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "delete target identity binding",
    ))
}

#[cfg(target_os = "linux")]
pub(super) fn renameat2_no_replace(
    source_dir: &fs::File,
    source_name: &OsStr,
    target_dir: &fs::File,
    target_name: &OsStr,
) -> Result<(), std::io::Error> {
    use std::os::fd::AsRawFd;

    let source_name = component_name(source_name)?;
    let target_name = component_name(target_name)?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_dir.as_raw_fd(),
            source_name.as_ptr(),
            target_dir.as_raw_fd(),
            target_name.as_ptr(),
            RENAME_NOREPLACE_FLAG,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn renameat2_no_replace(
    _source_dir: &fs::File,
    _source_name: &OsStr,
    _target_dir: &fs::File,
    _target_name: &OsStr,
) -> Result<(), String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "delete target claim",
    ))
}

/// Der gebundene Parent-Deskriptor einer vorbereiteten Löschung; fehlt er,
/// ist der `PendingDelete`-Zustand defekt. Eine Form für alle sechs
/// Mutationsstellen statt vier kodierter und zwei roher Kopien desselben
/// Textes (sonst erscheint derselbe Defekt in der Oberfläche einmal als
/// „unbekannt" und einmal als „unlesbar").
fn bound_parent(pending: &PendingDelete) -> Result<&fs::File, String> {
    pending.parent_handle.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound parent directory",
        )
    })
}

/// Ergebnis eines erfolgreichen Claims: gebundener Handle, privater Name und
/// der `/proc/self/fd`-Pfad für die Mutation. Existiert nur unter Linux, weil
/// der Nicht-Linux-Stummel fail-closed ohne Claim zurückkehrt (r-18: die
/// Struktur war unter zwei cfg-Zweigen byteidentisch doppelt definiert).
#[cfg(target_os = "linux")]
struct ClaimedDeleteTarget {
    path: PathBuf,
    handle: fs::File,
    name: OsString,
}

#[cfg(target_os = "linux")]
fn claim_delete_target(pending: &PendingDelete) -> Result<ClaimedDeleteTarget, String> {
    use std::os::fd::AsRawFd;

    let parent = bound_parent(pending)?;
    let source_name = pending.target_name.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target name",
        )
    })?;
    let expected = pending.target_handle.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target identity",
        )
    })?;
    let expected_identity = delete_handle_identity(expected)?;

    for _ in 0..CLAIM_NAME_ATTEMPTS {
        let claim_name = OsString::from(format!(
            ".protium-delete-claim-{}",
            generate_os_random_128()?
        ));
        match renameat2_no_replace(parent, source_name, parent, &claim_name) {
            Ok(()) => {
                // Guard direkt nach dem eigenen Rename armen: scheitern das
                // Öffnen oder der Identity-Check, wird der Claim best-effort
                // per NOREPLACE auf den Originalnamen zurückbenannt, statt
                // fremde Daten unter .protium-delete-claim-* liegen zu lassen.
                let mut restore = ClaimRestoreGuard {
                    parent,
                    claim_name: &claim_name,
                    original_name: source_name,
                    armed: true,
                };
                let handle = open_delete_child_handle(parent, &claim_name)
                    .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
                let observed = delete_handle_identity(&handle)
                    .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
                if observed != expected_identity {
                    return Err(if restore.restore() {
                        errcode::with_detail(
                            errcode::TARGET_CHANGED,
                            "target changed before mutation; claim restored to its original name",
                        )
                    } else {
                        errcode::with_detail(
                            errcode::WRITE_UNCERTAIN,
                            "target changed before mutation; claim restore failed or not durable",
                        )
                    });
                }
                restore.disarm();
                drop(restore); // borrow auf claim_name endet vor dem move in das ergebnis
                let path = PathBuf::from(format!(
                    "/proc/self/fd/{}/{}",
                    parent.as_raw_fd(),
                    claim_name.to_string_lossy()
                ));
                return Ok(ClaimedDeleteTarget {
                    path,
                    handle,
                    name: claim_name,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => return Err(errcode::with_detail(errcode::UNREADABLE, error)),
        }
    }
    Err(errcode::with_detail(
        errcode::UNAVAILABLE,
        "unique claim name",
    ))
}

#[cfg(not(target_os = "linux"))]
fn claim_delete_target(_pending: &PendingDelete) -> Result<(), String> {
    Err(errcode::with_detail(
        errcode::UNSUPPORTED_PLATFORM,
        "delete target claim",
    ))
}

/// Rückweg für einen geclaimten, aber noch nicht mutierten Löschvorgang.
///
/// `claim_delete_target` benennt das Ziel vor der Mutation auf einen privaten
/// Namen um. Scheitert ein Schritt VOR dem destruktiven Aufruf (EACCES, EBUSY,
/// kein Platz im Trash-Ziel, Panik), läge das Verzeichnis sonst dauerhaft unter
/// `.protium-delete-claim-*`: unsichtbar für Steam UND für Protium, weil
/// `findOrphans` auf numerische Namen filtert. Bei compatdata bedeutet
/// unsichtbar = Savegames verloren.
///
/// Der Rückweg gilt nur vor begonnener Mutation. Nach einem `remove_dir_all`
/// ist das Ziel teilweise oder ganz weg; dann bleibt der Claim liegen und der
/// Aufrufer meldet `write-may-have-applied` (Audit 5.1). Ein `NotFound` beim
/// Remove ist kein Erfolg: das Kind kann mitten im Abbau verschwunden sein oder
/// eine zweite Instanz hat den Claim zurückbenannt.
///
/// Der Rückweg ist NOREPLACE: ist am Originalnamen inzwischen etwas Neues
/// entstanden, bleibt der Claim liegen, statt das Neue zu überschreiben.
/// Best effort: ein fehlgeschlagener Rückweg darf den ursprünglichen Fehler
/// nicht verdecken.
///
/// Nicht abgedeckt (per Konstruktion unerreichbar für In-Process-Code):
/// SIGKILL oder Stromausfall im Fenster zwischen Claim und Mutation.
struct ClaimRestoreGuard<'a> {
    parent: &'a fs::File,
    claim_name: &'a OsStr,
    original_name: &'a OsStr,
    armed: bool,
}

impl ClaimRestoreGuard<'_> {
    /// Nach erfolgreicher Mutation existiert der Claim-Name nicht mehr
    /// (gelöscht oder in den Trash verschoben); es gibt nichts zurückzuholen.
    fn disarm(&mut self) {
        self.armed = false;
    }

    /// Benennt den Claim auf den Originalnamen zurück. `true` nur bei
    /// erfolgreichem Rename UND Verzeichnis-fsync: ohne fsync ist der Rückweg
    /// nach einem Absturz nicht belegt, der Zustand bleibt dann unsicher.
    fn restore(&mut self) -> bool {
        if !self.armed {
            return false;
        }
        if renameat2_no_replace(
            self.parent,
            self.claim_name,
            self.parent,
            self.original_name,
        )
        .is_err()
        {
            // Ein zweiter Versuch im `Drop` könnte einen zwischenzeitlich
            // untergeschobenen Fremdeintrag treffen; pro Guard genau ein
            // Rückweg, auch wenn er scheitert.
            self.armed = false;
            return false;
        }
        // `armed` fällt unabhängig vom fsync: der Claim-Name ist weg, ein
        // zweiter Rename könnte nur noch einen fremden Namen treffen.
        self.armed = false;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            if crate::commands::fd::sync_dir_fd(self.parent.as_raw_fd()).is_err() {
                return false;
            }
        }
        // Der Nicht-Linux-Stummel kann nicht umbenennen; dort ist der Zweig oben
        // unerreichbar und es gibt keinen fsync-Zweig.
        true
    }
}

impl Drop for ClaimRestoreGuard<'_> {
    fn drop(&mut self) {
        // Best effort wie der Rückweg selbst; der fsync liegt in `restore`,
        // damit es genau eine Stelle für Rename und Sync gibt.
        let _ = self.restore();
    }
}

/// Nach dem Claim: ein Fehlschlag VOR der destruktiven Mutation ist nur dann
/// harmlos, wenn der Originalname wieder steht. Gelingt der Rückweg nicht,
/// bleibt der Claim liegen; dann ist der Zustand unsicher und darf nicht als
/// der ursprüngliche Fehler (etwa „unlesbar, nichts passiert") zurückgehen
/// (Audit 5.1).
#[cfg(target_os = "linux")]
fn restore_or_write_uncertain(restore: &mut ClaimRestoreGuard<'_>, error: String) -> String {
    if restore.restore() {
        return error;
    }
    errcode::with_detail(
        errcode::WRITE_UNCERTAIN,
        format!("claim restore failed: {error}"),
    )
}

/// Bindet den angeforderten Steam-Root an den aktuellen Snapshot (F1): ein
/// autorisierter Nachbarpfad (etwa eine externe Library) darf nicht als Root
/// für die Lösch-Inspektion dienen, sonst liest die Inspektion `userdata`
/// unter einem fremden Verzeichnis und hält echte Einträge für verwaist.
fn ensure_current_steam_root(
    steam_root: &str,
    snapshot: &EnvironmentSnapshot,
) -> Result<(), String> {
    let canonical = fs::canonicalize(steam_root).map_err(|error| {
        errcode::with_detail(errcode::NOT_FOUND, format!("steam root: {error}"))
    })?;
    if canonical != snapshot.steam_root {
        return Err(errcode::with_detail(
            errcode::BLOCKED_LOCATION,
            "steam root is not the current environment root",
        ));
    }
    Ok(())
}

pub(super) fn prepare_delete_inner(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    snapshot: &EnvironmentSnapshot,
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
) -> Result<PendingDeleteInfo, String> {
    // FR-4: für `trash` wird der Check gar nicht aufgerufen, damit ein nicht
    // prüfbarer Steam-Status den Papierkorb nicht blockiert (Audit 5.5).
    if request.target_type != "trash" && is_steam_running_fn()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    ensure_current_steam_root(&request.steam_root, snapshot)?;

    let scope_ok = |path: &Path| snapshot.authorizes(path);
    let inspection = inspect_deletion_target(
        &request.steam_root,
        &request.target_type,
        &request.path,
        &scope_ok,
    )?;
    prepare_delete_with_inspection(registry, request, inspection)
}

fn prepare_delete_with_inspection(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    inspection: DeletionInspection,
) -> Result<PendingDeleteInfo, String> {
    let canonical_path = PathBuf::from(&inspection.canonical_path);
    let target_name = canonical_path
        .file_name()
        .ok_or_else(|| {
            errcode::with_detail(errcode::UNREADABLE, "delete target has no directory name")
        })?
        .to_os_string();
    let parent_path = canonical_path.parent().ok_or_else(|| {
        errcode::with_detail(errcode::UNREADABLE, "delete target has no parent directory")
    })?;
    let parent_handle = open_delete_target_handle(parent_path)?;
    let target_handle = open_delete_child_handle(&parent_handle, &target_name)?;
    #[cfg(target_os = "linux")]
    if delete_handle_identity(&target_handle)?
        != (FdIdentity {
            dev: inspection.dev,
            ino: inspection.ino,
        })
    {
        return Err(errcode::TARGET_CHANGED.into());
    }

    let token = generate_os_random_128()?;

    let now_ms = now_ms()?;
    let expires_at = now_ms + DELETE_TOKEN_TTL_SECS * 1000;

    let pending = PendingDelete {
        created_at: now_ms,
        expires_at,
        target_type: request.target_type.clone(),
        target_path: request.path.clone(),
        canonical_path,
        steam_root: PathBuf::from(&request.steam_root),
        dev: inspection.dev,
        ino: inspection.ino,
        target_handle: Some(target_handle),
        parent_handle: Some(parent_handle),
        target_name: Some(target_name),
        consequences: inspection.consequences.clone(),
    };

    let mut map = registry.0.lock().map_err(|error| {
        errcode::with_detail(errcode::UNAVAILABLE, format!("mutex lock error: {error}"))
    })?;

    map.retain(|_, v| v.expires_at > now_ms);

    if map.len() >= MAX_PENDING_DELETES {
        let oldest_token = map
            .iter()
            .min_by(|(token_a, a), (token_b, b)| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| token_a.cmp(token_b))
            })
            .map(|(token, _)| token.clone())
            .ok_or_else(|| {
                errcode::with_detail(
                    errcode::UNAVAILABLE,
                    "pending deletion registry is unexpectedly empty",
                )
            })?;
        map.remove(&oldest_token);
    }

    map.insert(token.clone(), pending);

    Ok(PendingDeleteInfo {
        token,
        expires_at,
        target_type: request.target_type.clone(),
        target_path: request.path.clone(),
        consequences: inspection.consequences,
    })
}

#[cfg(all(test, target_os = "linux"))]
fn prepare_delete_inner_with_hook<F>(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
    hook: &mut F,
) -> Result<PendingDeleteInfo, String>
where
    F: FnMut(crate::commands::delete_inspect::DeleteReadStage, Option<&mut std::fs::File>),
{
    // FR-4: gleiche lazy Papierkorb-Ausnahme wie in `prepare_delete_inner`.
    if request.target_type != "trash" && is_steam_running_fn()? {
        return Err(errcode::STEAM_RUNNING.into());
    }

    let inspection = crate::commands::delete_inspect::inspect_deletion_target_with_test_hook(
        &request.steam_root,
        &request.target_type,
        &request.path,
        scope_ok,
        hook,
    )?;
    prepare_delete_with_inspection(registry, request, inspection)
}

pub(crate) fn execute_delete_pipeline(
    registry: &PendingDeleteRegistry,
    token: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
) -> Result<DeleteResult, String> {
    execute_delete_pipeline_inner(
        registry,
        token,
        scope_ok,
        is_steam_running_fn,
        || {},
        || {},
        &mut |path: &Path| fs::remove_dir_all(path),
    )
}

fn execute_delete_pipeline_inner(
    registry: &PendingDeleteRegistry,
    token: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
    before_claim_fn: impl FnOnce(),
    after_claim_fn: impl FnOnce(),
    remove_dir_all_fn: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> Result<DeleteResult, String> {
    let pending = {
        let mut map = registry.0.lock().map_err(|error| {
            errcode::with_detail(errcode::UNAVAILABLE, format!("mutex lock error: {error}"))
        })?;
        // 5.8: ein unbekanntes oder verdrängtes Token ist eine Blockade, kein
        // syntaktisch falsches ID-format (invalid-id bleibt dort).
        map.remove(token)
            .ok_or_else(|| errcode::TOKEN_UNKNOWN.to_string())?
    };

    let now_ms = now_ms()?;
    if now_ms > pending.expires_at {
        return Err(errcode::TOKEN_EXPIRED.into());
    }

    // FR-4: `trash` bleibt von beiden Checks ausgenommen; ein nicht prüfbarer
    // Steam-Status darf den Papierkorb nicht blockieren.
    if pending.target_type != "trash" && is_steam_running_fn()? {
        return Err(errcode::STEAM_RUNNING.into());
    }

    // Die beiden Invarianten hängen nur am pending, nicht am Claim: sie VOR
    // dem Claim ziehen, damit zwischen claim_delete_target und der
    // Guard-Armierung kein fallibler Schritt den Claim stranden lassen kann.
    let claim_parent = bound_parent(&pending)?;
    let original_name = pending.target_name.as_deref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target name",
        )
    })?;

    // Letzte Zustandsprüfung unmittelbar vor dem Claim: zwischen Token-Ausgabe
    // und hier kann sich alles geändert haben. Die Inspection (VDF-Parsing)
    // kann dauern; in diesem Fenster darf sich weder Steam noch das Ziel
    // ändern, deshalb liegt der Steam-Check zwischen zwei Inspektionen
    // (steam_start_zwischen_den_checks_...,
    // live_aenderung_zwischen_checks_...).
    inspect_pending_target(&pending, scope_ok)?;
    if pending.target_type != "trash" && is_steam_running_fn()? {
        return Err(errcode::STEAM_RUNNING.into());
    }
    inspect_pending_target(&pending, scope_ok)?;
    before_claim_fn();
    let claimed = claim_delete_target(&pending)?;
    let mut restore = ClaimRestoreGuard {
        parent: claim_parent,
        claim_name: &claimed.name,
        original_name,
        armed: true,
    };
    // Der Claim-Name ist im Verzeichnis sichtbar. Zwischen Claim und Mutation
    // wird er deshalb ein zweites Mal geöffnet und gegen den gehaltenen Handle
    // geprüft: ein gleichnamiger Ersatz darf nicht gelöscht werden.
    after_claim_fn();
    #[cfg(target_os = "linux")]
    {
        let current = open_delete_child_handle(claim_parent, &claimed.name)
            .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
        let current_identity = delete_handle_identity(&current)
            .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
        let claimed_identity = delete_handle_identity(&claimed.handle)
            .map_err(|error| restore_or_write_uncertain(&mut restore, error))?;
        if current_identity != claimed_identity {
            return Err(if restore.restore() {
                errcode::with_detail(
                    errcode::TARGET_CHANGED,
                    "claim handle mismatch; claim restored to its original name",
                )
            } else {
                errcode::with_detail(
                    errcode::WRITE_UNCERTAIN,
                    "claim handle mismatch; claim restore failed or not durable",
                )
            });
        }
    }
    let deleted_path = pending.target_path.clone();

    apply_delete_mutation(&pending, &claimed, now_ms, &mut restore, remove_dir_all_fn)?;

    // Ab hier ist die Mutation abgeschlossen; der Claim-Name ist weg.
    restore.disarm();

    Ok(DeleteResult { deleted_path })
}

fn inspect_pending_target(
    pending: &PendingDelete,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
) -> Result<(), String> {
    let target_handle = pending.target_handle.as_ref().ok_or_else(|| {
        errcode::with_detail(
            errcode::UNREADABLE,
            "pending delete has no bound target identity",
        )
    })?;
    // ein nicht-UTF8-root kann die VDF-/pfad-inspektion nicht ausdrücken; das
    // ist ein bindungszustand, den nur ein neues prepare heilt.
    let steam_root = pending.steam_root.to_str().ok_or_else(|| {
        errcode::with_detail(errcode::UNREADABLE, "steam root is not valid UTF-8")
    })?;
    let inspection = crate::commands::delete_inspect::inspect_deletion_target(
        steam_root,
        &pending.target_type,
        &pending.target_path,
        scope_ok,
    )?;
    let canonical = pending.canonical_path.to_string_lossy();
    #[cfg(target_os = "linux")]
    if delete_handle_identity(target_handle)?
        != (FdIdentity {
            dev: inspection.dev,
            ino: inspection.ino,
        })
    {
        return Err(errcode::with_detail(
            errcode::TARGET_CHANGED,
            "bound handle mismatch",
        ));
    }
    if inspection.dev != pending.dev || inspection.ino != pending.ino {
        return Err(errcode::with_detail(
            errcode::TARGET_CHANGED,
            "dev/ino mismatch",
        ));
    }
    if inspection.target_type != pending.target_type
        || inspection.target_path != pending.target_path
        || inspection.canonical_path != canonical
        || inspection.consequences != pending.consequences
    {
        return Err(errcode::TARGET_CHANGED.into());
    }
    Ok(())
}

/// r-08: den gebundenen parent eines entfernten ziels durabel machen. ein
/// sync-fehler nach der bereits ausgeführten mutation meldet
/// `write-may-have-applied` statt "nichts passiert"; das label unterscheidet
/// den aufrufenden lösch-zweig im log.
#[cfg(target_os = "linux")]
fn sync_deleted_parent(parent: &fs::File, label: &str) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    crate::commands::fd::sync_dir_fd(parent.as_raw_fd()).map_err(|error| {
        errcode::with_detail(errcode::WRITE_UNCERTAIN, format!("{label}: {error}"))
    })
}

/// Kapselt jeden `remove_dir_all` der drei Löschzweige (Audit 5.1). Ein
/// Fehlschlag nach begonnener Mutation, auch `NotFound`, ist keine unlesbare
/// Abwesenheit: das Kind kann mitten im Abbau verschwunden sein oder eine
/// zweite Instanz hat den Claim zurückbenannt. Der Claim bleibt deshalb liegen
/// (Rest, typweit sichtbar), zurückgemeldet wird `write-may-have-applied` mit
/// dem ursprünglichen Fehler.
#[cfg(target_os = "linux")]
fn remove_claimed_dir(
    path: &Path,
    parent: &fs::File,
    restore: &mut ClaimRestoreGuard<'_>,
    label: &str,
    remove_dir_all_fn: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let sync_label = format!("{label} remove parent sync");
    match remove_dir_all_fn(path) {
        Ok(()) => {
            restore.disarm();
            // r-08: nach dem löschen den parent synchronisieren, sonst kann das
            // verzeichnis nach absturz driftig sichtbar bleiben; ein sync-fehler
            // meldet die möglich angewandte mutation statt "nichts passiert".
            sync_deleted_parent(parent, &sync_label)
        }
        Err(error) => {
            restore.disarm();
            let _ = sync_deleted_parent(parent, &sync_label);
            Err(errcode::with_detail(
                errcode::WRITE_UNCERTAIN,
                format!("claim may be gone or partial: {label}: {error}"),
            ))
        }
    }
}

/// Führt die eigentliche Mutation des geclaimten Ziels aus (r-10). Genau die
/// drei Zieltypen der Pipeline, derselbe Papierkorb-Move samt
/// Verzeichnis-fsync und dieselben Fehler wie zuvor; nur zusammenhängend
/// verschoben.
///
/// Rückweg-Vertrag (Audit 5.1): jeder Fehlschlag VOR dem destruktiven Aufruf
/// benennt das Ziel über `restore` auf seinen Originalnamen zurück; scheitert
/// der Rückweg, wird der Fehler zur Unsicherheitsaussage. Nach begonnener
/// Mutation gibt es keinen Rückweg mehr: der Claim bleibt liegen, damit der
/// Rest sichtbar bleibt und ein zweiter Lauf ihn nicht als intaktes Ziel
/// behandelt. Ein `NotFound` beim Remove ist in diesem Sinn kein Erfolg.
#[cfg(target_os = "linux")]
fn apply_delete_mutation(
    pending: &PendingDelete,
    claimed: &ClaimedDeleteTarget,
    now_ms: u64,
    restore: &mut ClaimRestoreGuard<'_>,
    remove_dir_all_fn: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    match pending.target_type.as_str() {
        "orphan" => {
            let canon_str = pending.canonical_path.to_string_lossy();
            let suffix = crate::commands::scope::suffix_after_steamapps(&canon_str)
                .map_err(|error| restore_or_write_uncertain(restore, error))?;
            let suffix_pair = suffix
                .split_once('/')
                .ok_or_else(|| {
                    errcode::with_detail(errcode::INVALID_VALUE, "invalid suffix structure")
                })
                .map_err(|error| restore_or_write_uncertain(restore, error))?;
            let (typ, app_id_str) = crate::commands::scope::parse_compat_id(suffix_pair)
                .map_err(|error| restore_or_write_uncertain(restore, error))?;
            match typ {
                "shadercache" => {
                    let parent = bound_parent(pending)
                        .map_err(|error| restore_or_write_uncertain(restore, error))?;
                    remove_claimed_dir(
                        &claimed.path,
                        parent,
                        restore,
                        "shadercache",
                        remove_dir_all_fn,
                    )?;
                }
                "compatdata" => {
                    let lib_str = crate::commands::scope::library_of(&canon_str)
                        .map_err(|error| restore_or_write_uncertain(restore, error))?;
                    let trash_parent = open_trash_dir(Path::new(lib_str), &mut || {})
                        .map_err(|error| restore_or_write_uncertain(restore, error))?;
                    let trash_name = format!("compatdata_{app_id_str}_{now_ms}");
                    let source_parent = bound_parent(pending)
                        .map_err(|error| restore_or_write_uncertain(restore, error))?;
                    renameat2_no_replace(
                        source_parent,
                        &claimed.name,
                        &trash_parent,
                        OsStr::new(&trash_name),
                    )
                    .map_err(|error| {
                        restore_or_write_uncertain(
                            restore,
                            errcode::with_detail(
                                errcode::code_for_io(&error),
                                format!("cannot move to trash: {error}"),
                            ),
                        )
                    })?;
                    // Nach dem erfolgreichen Verschieben existiert der
                    // Claim-Name nicht mehr; ein Rückweg könnte nur noch einen
                    // fremden Papierkorb-Eintrag treffen.
                    restore.disarm();
                    // r-08: ohne verzeichnis-fsync kann der papierkorb-eintrag
                    // nach absturz driftig sichtbar sein; erst das ziel, dann
                    // die quelle. ein sync-fehler meldet die möglich angewandte
                    // mutation statt "nichts passiert"
                    {
                        use std::os::fd::AsRawFd;
                        crate::commands::fd::sync_dir_fd(trash_parent.as_raw_fd()).map_err(
                            |e| {
                                errcode::with_detail(
                                    errcode::WRITE_UNCERTAIN,
                                    format!("trash move target sync: {e}"),
                                )
                            },
                        )?;
                        crate::commands::fd::sync_dir_fd(source_parent.as_raw_fd()).map_err(
                            |e| {
                                errcode::with_detail(
                                    errcode::WRITE_UNCERTAIN,
                                    format!("trash move source sync: {e}"),
                                )
                            },
                        )?;
                    }
                }
                _ => {
                    return Err(restore_or_write_uncertain(
                        restore,
                        errcode::UNSUPPORTED_TARGET.into(),
                    ));
                }
            }
        }
        "trash" => {
            let parent = bound_parent(pending)
                .map_err(|error| restore_or_write_uncertain(restore, error))?;
            remove_claimed_dir(
                &claimed.path,
                parent,
                restore,
                "trash item",
                remove_dir_all_fn,
            )?;
        }
        "compatTool" => {
            let parent = bound_parent(pending)
                .map_err(|error| restore_or_write_uncertain(restore, error))?;
            remove_claimed_dir(
                &claimed.path,
                parent,
                restore,
                "compat tool",
                remove_dir_all_fn,
            )?;
        }
        _ => {
            return Err(restore_or_write_uncertain(
                restore,
                errcode::with_detail(errcode::UNSUPPORTED_TARGET, &pending.target_type),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_delete(
    state: tauri::State<'_, PendingDeleteRegistry>,
    env: tauri::State<'_, EnvironmentState>,
    request: PrepareDeleteRequest,
) -> Result<PendingDeleteInfo, String> {
    // autorisierung über den backend-snapshot (steam-root + libraries +
    // system-compat-dirs), nicht über den plugin-fs-scope: der autorisiert
    // nur $APPCACHE und würde den steam-root nie erreichen.
    // current() nimmt den Environment-Mutex im blocking-pool, nicht auf dem
    // Tokio-Worker.
    let registry = (*state).clone();
    let env = env.inner().clone();
    crate::commands::spawn_blocking_io(move || {
        let snapshot = env.current()?;
        prepare_delete_inner(&registry, &request, &snapshot, || {
            crate::commands::fs_ops::is_steam_running_sync()
        })
    })
    .await
}

#[tauri::command]
pub async fn execute_delete(
    state: tauri::State<'_, PendingDeleteRegistry>,
    env: tauri::State<'_, EnvironmentState>,
    token: String,
) -> Result<DeleteResult, String> {
    let registry = (*state).clone();
    let env = env.inner().clone();
    crate::commands::spawn_blocking_io(move || {
        let snapshot = env.current()?;
        execute_delete_pipeline(&registry, &token, &|p| snapshot.authorizes(p), || {
            crate::commands::fs_ops::is_steam_running_sync()
        })
    })
    .await
}

#[cfg(test)]
#[path = "delete_ops_tests.rs"]
mod tests;
