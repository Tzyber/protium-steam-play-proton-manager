// Interne Delete-Operationen und Replay-Schutz (Paket 19 / S-06b / S-06c).
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::cleanup::TRASH_DIR_NAME;
use crate::commands::scope::EnvironmentState;
use crate::commands::steam::{inspect_deletion_target, DeleteConsequence, DeletionInspection};

pub const DELETE_TOKEN_TTL_SECS: u64 = 60;

/// renameat2-flag: kein überschreiben des ziels (RENAME_NOREPLACE).
const RENAME_NOREPLACE_FLAG: u32 = 1;
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
    pub success: bool,
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
    getrandom::fill(&mut bytes).map_err(|e| format!("cannot read OS CSPRNG: {e}"))?;
    let mut hex = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    Ok(hex)
}

#[cfg(target_os = "linux")]
fn open_delete_target_handle(path: &Path) -> Result<fs::File, String> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let mut path_bytes = path.as_os_str().as_bytes().to_vec();
    path_bytes.push(0);
    let raw = unsafe {
        libc::open(
            path_bytes.as_ptr().cast(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if raw < 0 {
        return Err(format!(
            "cannot bind delete target directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let handle = fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) });
    if !handle
        .metadata()
        .map_err(|e| format!("cannot stat bound delete target: {e}"))?
        .is_dir()
    {
        return Err("bound delete target is not a directory".into());
    }
    Ok(handle)
}

#[cfg(not(target_os = "linux"))]
fn open_delete_target_handle(_path: &Path) -> Result<fs::File, String> {
    Err("delete target identity binding requires Linux directory descriptors".into())
}

#[cfg(target_os = "linux")]
fn delete_handle_identity(handle: &fs::File) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = handle
        .metadata()
        .map_err(|e| format!("cannot stat bound delete target: {e}"))?;
    if !metadata.is_dir() {
        return Err("bound delete target is not a directory".into());
    }
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(target_os = "linux")]
fn open_delete_child_handle(parent: &fs::File, name: &OsStr) -> Result<fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| "delete target name contains NUL".to_string())?;
    let raw = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if raw < 0 {
        return Err(format!(
            "cannot bind delete target entry: {}",
            std::io::Error::last_os_error()
        ));
    }
    let handle = fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) });
    let _ = delete_handle_identity(&handle)?;
    Ok(handle)
}

#[cfg(not(target_os = "linux"))]
fn open_delete_child_handle(_parent: &fs::File, _name: &OsStr) -> Result<fs::File, String> {
    Err("delete target identity binding requires Linux directory descriptors".into())
}

#[cfg(target_os = "linux")]
fn os_name(name: &OsStr, label: &str) -> Result<std::ffi::CString, String> {
    use std::os::unix::ffi::OsStrExt;

    std::ffi::CString::new(name.as_bytes()).map_err(|_| format!("{label} contains NUL"))
}

#[cfg(target_os = "linux")]
fn renameat2_no_replace(
    source_dir: &fs::File,
    source_name: &OsStr,
    target_dir: &fs::File,
    target_name: &OsStr,
) -> Result<(), std::io::Error> {
    use std::os::fd::AsRawFd;

    let source_name = os_name(source_name, "delete source name")
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let target_name = os_name(target_name, "delete target name")
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
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
fn renameat2_no_replace(
    _source_dir: &fs::File,
    _source_name: &OsStr,
    _target_dir: &fs::File,
    _target_name: &OsStr,
) -> Result<(), String> {
    Err("delete target claim requires Linux directory descriptors".into())
}

#[cfg(target_os = "linux")]
struct ClaimedDeleteTarget {
    path: PathBuf,
    handle: fs::File,
    name: OsString,
}

#[cfg(not(target_os = "linux"))]
struct ClaimedDeleteTarget {
    path: PathBuf,
    handle: fs::File,
    name: OsString,
}

#[cfg(target_os = "linux")]
fn claim_delete_target(pending: &PendingDelete) -> Result<ClaimedDeleteTarget, String> {
    use std::os::fd::AsRawFd;

    let parent = pending
        .parent_handle
        .as_ref()
        .ok_or_else(|| "pending delete has no bound parent directory".to_string())?;
    let source_name = pending
        .target_name
        .as_ref()
        .ok_or_else(|| "pending delete has no bound target name".to_string())?;
    let expected = pending
        .target_handle
        .as_ref()
        .ok_or_else(|| "pending delete has no bound target identity".to_string())?;
    let expected_identity = delete_handle_identity(expected)?;

    for _ in 0..4 {
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
                let handle = open_delete_child_handle(parent, &claim_name)?;
                if delete_handle_identity(&handle)? != expected_identity {
                    return Err(
                        "target changed before mutation; claim restored to its original name"
                            .into(),
                    );
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
            Err(error) => return Err(format!("cannot claim delete target: {error}")),
        }
    }
    Err("cannot allocate unique delete claim name".into())
}

#[cfg(not(target_os = "linux"))]
fn claim_delete_target(_pending: &PendingDelete) -> Result<(), String> {
    Err("delete target claim requires Linux directory descriptors".into())
}

/// Rückweg für einen geclaimten, aber nicht abgeschlossenen Löschvorgang.
///
/// `claim_delete_target` benennt das Ziel vor der Mutation auf einen privaten
/// Namen um. Scheitert die Mutation danach (EACCES, EBUSY, kein Platz im
/// Trash-Ziel, Panik), läge das Verzeichnis sonst dauerhaft unter
/// `.protium-delete-claim-*`: unsichtbar für Steam UND für Protium, weil
/// `findOrphans` auf numerische Namen filtert. Bei compatdata bedeutet
/// unsichtbar = Savegames verloren.
///
/// Der Rückweg ist NOREPLACE — ist am Originalnamen inzwischen etwas Neues
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
    /// (gelöscht oder in den Trash verschoben) — es gibt nichts zurückzuholen.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ClaimRestoreGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = renameat2_no_replace(
            self.parent,
            self.claim_name,
            self.parent,
            self.original_name,
        );
    }
}

pub(super) fn prepare_delete_inner(
    registry: &PendingDeleteRegistry,
    request: &PrepareDeleteRequest,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
) -> Result<PendingDeleteInfo, String> {
    let steam_running = is_steam_running_fn()?;
    if request.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    let inspection = inspect_deletion_target(
        &request.steam_root,
        &request.target_type,
        &request.path,
        scope_ok,
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
        .ok_or_else(|| "delete target has no directory name".to_string())?
        .to_os_string();
    let parent_path = canonical_path
        .parent()
        .ok_or_else(|| "delete target has no parent directory".to_string())?;
    let parent_handle = open_delete_target_handle(parent_path)?;
    let target_handle = open_delete_child_handle(&parent_handle, &target_name)?;
    #[cfg(target_os = "linux")]
    if delete_handle_identity(&target_handle)? != (inspection.dev, inspection.ino) {
        return Err("delete target changed while binding identity".into());
    }

    let token = generate_os_random_128()?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
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

    let mut map = registry
        .0
        .lock()
        .map_err(|e| format!("mutex lock error: {e}"))?;

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
            .ok_or_else(|| "pending deletion registry is unexpectedly empty".to_string())?;
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
    F: FnMut(crate::commands::steam::DeleteReadStage, Option<&mut std::fs::File>),
{
    let steam_running = is_steam_running_fn()?;
    if request.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    let inspection = crate::commands::steam::inspect_deletion_target_with_test_hook(
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
    execute_delete_pipeline_inner(registry, token, scope_ok, is_steam_running_fn, || {})
}

fn execute_delete_pipeline_inner(
    registry: &PendingDeleteRegistry,
    token: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    is_steam_running_fn: impl Fn() -> Result<bool, String>,
    before_claim_fn: impl FnOnce(),
) -> Result<DeleteResult, String> {
    let pending = {
        let mut map = registry
            .0
            .lock()
            .map_err(|e| format!("mutex lock error: {e}"))?;
        map.remove(token)
            .ok_or_else(|| "invalid deletion token".to_string())?
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if now_ms > pending.expires_at {
        return Err("deletion token expired".into());
    }

    let steam_running = is_steam_running_fn()?;
    if pending.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }

    // Die beiden Invarianten hängen nur am pending, nicht am Claim: sie VOR
    // dem Claim ziehen, damit zwischen claim_delete_target und der
    // Guard-Armierung kein fallibler Schritt den Claim stranden lassen kann.
    let claim_parent = pending
        .parent_handle
        .as_ref()
        .ok_or_else(|| "pending delete has no bound parent directory".to_string())?;
    let original_name = pending
        .target_name
        .as_deref()
        .ok_or_else(|| "pending delete has no bound target name".to_string())?;

    // Letzte Zustandsprüfung unmittelbar vor dem Claim: zwischen Token-Ausgabe
    // und hier kann sich alles geändert haben. Steam-Lauf und Zielzustand
    // werden nach der Inspection direkt vor dem Claim ein zweites Mal geprüft
    // — die Inspection (VDF-Parsing) kann dauern, in diesem Fenster darf sich
    // weder Steam noch das Ziel ändern (steam_start_zwischen_den_checks_...,
    // live_aenderung_zwischen_checks_...).
    inspect_pending_target(&pending, scope_ok)?;
    let steam_running = is_steam_running_fn()?;
    if pending.target_type != "trash" && steam_running {
        return Err("steam is running, deletion refused".into());
    }
    inspect_pending_target(&pending, scope_ok)?;
    before_claim_fn();
    let claimed = claim_delete_target(&pending)?;
    let _bound_claim_handle = &claimed.handle;
    let mut restore = ClaimRestoreGuard {
        parent: claim_parent,
        claim_name: &claimed.name,
        original_name,
        armed: true,
    };
    let deleted_path = pending.target_path.clone();

    match pending.target_type.as_str() {
        "orphan" => {
            let canon_str = pending.canonical_path.to_string_lossy();
            let suffix = crate::commands::scope::suffix_after_steamapps(&canon_str)?;
            let (typ, app_id_str) = crate::commands::scope::parse_compat_id(
                suffix
                    .split_once('/')
                    .ok_or_else(|| "invalid suffix structure".to_string())?,
            )?;
            match typ {
                "shadercache" => {
                    fs::remove_dir_all(&claimed.path)
                        .map_err(|e| format!("cannot remove shadercache: {e}"))?;
                }
                "compatdata" => {
                    let lib_str = crate::commands::scope::library_of(&canon_str)?;
                    let trash_dir = Path::new(lib_str).join("steamapps").join(TRASH_DIR_NAME);
                    fs::create_dir_all(&trash_dir)
                        .map_err(|e| format!("cannot create trash dir: {e}"))?;
                    let trash_name = format!("compatdata_{app_id_str}_{now_ms}");
                    let trash_parent = open_delete_target_handle(&trash_dir)?;
                    let source_parent = pending.parent_handle.as_ref().ok_or_else(|| {
                        "pending delete has no bound parent directory".to_string()
                    })?;
                    renameat2_no_replace(
                        source_parent,
                        &claimed.name,
                        &trash_parent,
                        OsStr::new(&trash_name),
                    )
                    .map_err(|e| format!("cannot move to trash: {e}"))?;
                }
                _ => return Err("unsupported orphan type".into()),
            }
        }
        "trash" => {
            fs::remove_dir_all(&claimed.path)
                .map_err(|e| format!("cannot remove trash item: {e}"))?;
        }
        "compatTool" => {
            fs::remove_dir_all(&claimed.path)
                .map_err(|e| format!("cannot remove compat tool: {e}"))?;
        }
        _ => return Err(format!("unknown target type: {}", pending.target_type)),
    }

    // Ab hier ist die Mutation abgeschlossen; der Claim-Name ist weg.
    restore.disarm();

    Ok(DeleteResult {
        success: true,
        deleted_path,
    })
}

fn inspect_pending_target(
    pending: &PendingDelete,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
) -> Result<(), String> {
    let target_handle = pending
        .target_handle
        .as_ref()
        .ok_or_else(|| "pending delete has no bound target identity".to_string())?;
    let steam_root = pending
        .steam_root
        .to_str()
        .ok_or_else(|| "steam root is not valid UTF-8".to_string())?;
    let inspection = crate::commands::steam::inspect_deletion_target(
        steam_root,
        &pending.target_type,
        &pending.target_path,
        scope_ok,
    )?;
    let canonical = pending.canonical_path.to_string_lossy();
    #[cfg(target_os = "linux")]
    if delete_handle_identity(target_handle)? != (inspection.dev, inspection.ino) {
        return Err("target identity changed (bound handle mismatch), deletion refused".into());
    }
    if inspection.dev != pending.dev || inspection.ino != pending.ino {
        return Err("target identity changed (dev/ino mismatch), deletion refused".into());
    }
    if inspection.target_type != pending.target_type
        || inspection.target_path != pending.target_path
        || inspection.canonical_path != canonical
        || inspection.consequences != pending.consequences
    {
        return Err("deletion target state changed, deletion refused".into());
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
    // nur $APPCACHE/$APPCONFIG und würde den steam-root nie erreichen.
    let snapshot = env.current()?;
    let registry = (*state).clone();
    crate::commands::spawn_blocking_io(move || {
        prepare_delete_inner(&registry, &request, &|p| snapshot.authorizes(p), || {
            crate::commands::fs_ops::is_process_running_sync("steam")
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
    let snapshot = env.current()?;
    let registry = (*state).clone();
    crate::commands::spawn_blocking_io(move || {
        execute_delete_pipeline(&registry, &token, &|p| snapshot.authorizes(p), || {
            crate::commands::fs_ops::is_process_running_sync("steam")
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_util::wsg_fixture;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn orphan_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata/999999");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), lf_vdf).unwrap();
        (root, steam)
    }

    fn orphan_request(steam: &std::path::Path) -> PrepareDeleteRequest {
        PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: steam
                .join("steamapps/compatdata/999999")
                .to_str()
                .unwrap()
                .to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        }
    }

    fn execute_confirmed(
        registry: &PendingDeleteRegistry,
        token: &str,
        is_steam_running: impl Fn() -> Result<bool, String>,
    ) -> Result<DeleteResult, String> {
        execute_delete_pipeline(registry, token, &|_| true, is_steam_running)
    }

    fn execute_delete_after_inspection(
        registry: &PendingDeleteRegistry,
        token: &str,
        scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
        is_steam_running_fn: impl Fn() -> Result<bool, String>,
        before_claim_fn: impl FnOnce(),
    ) -> Result<DeleteResult, String> {
        execute_delete_pipeline_inner(
            registry,
            token,
            scope_ok,
            is_steam_running_fn,
            before_claim_fn,
        )
    }

    fn write_shortcuts_fixture(path: &std::path::Path, app_id: u32) {
        let mut bytes = vec![0x00];
        bytes.extend_from_slice(b"shortcuts\0");
        bytes.extend_from_slice(&[0x00]);
        bytes.extend_from_slice(b"0\0");
        bytes.extend_from_slice(&[0x02]);
        bytes.extend_from_slice(b"appid\0");
        bytes.extend_from_slice(&app_id.to_le_bytes());
        bytes.extend_from_slice(&[0x08, 0x08]);
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn token_generierung_ist_128_bit_hex() {
        let token1 = generate_os_random_128().unwrap();
        let token2 = generate_os_random_128().unwrap();
        assert_eq!(token1.len(), 32);
        assert_eq!(token2.len(), 32);
        assert_ne!(token1, token2);
        assert!(token1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokenquelle_bleibt_plattformunabhaengig_und_os_gesichert() {
        let source = include_str!("delete_ops.rs");
        assert!(source.contains("getrandom::fill"));
        assert!(!source.contains(&["/dev/", "urandom"].concat()));
        assert!(!source.contains(&["cfg(", "not(unix))"].concat()));
        assert!(!source.contains(&["as_", "nanos"].concat()));
    }

    #[test]
    fn destruktive_mutation_laueft_nur_ueber_claim() {
        let source = include_str!("delete_ops.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source must precede tests");
        assert!(production.contains("renameat2_no_replace"));
        assert!(!production.contains("fs::rename(&pending.canonical_path"));
        assert!(!production.contains("fs::remove_dir_all(&pending.canonical_path"));
    }

    fn collect_source_files(root: &std::path::Path, files: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect_source_files(&path, files);
            } else if matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("rs" | "ts" | "vue")
            ) {
                files.push((path.clone(), std::fs::read_to_string(path).unwrap()));
            }
        }
    }

    #[test]
    fn dialog_sicherheitsgrenze_bleibt_statisch_geschlossen() {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut source_files = Vec::new();
        collect_source_files(&manifest_dir.join("src"), &mut source_files);
        collect_source_files(&manifest_dir.join("../src"), &mut source_files);

        let forbidden = [
            ["dialog", ":"].concat(),
            ["@tauri-apps/plugin-", "dialog"].concat(),
            ["zen", "ity"].concat(),
            ["k", "dialog"].concat(),
            ["PROTIUM", "_TEST_CONFIRM"].concat(),
        ];
        let capabilities =
            std::fs::read_to_string(manifest_dir.join("capabilities/default.json")).unwrap();
        assert!(!capabilities.contains(&forbidden[0]));
        for (path, content) in &source_files {
            for pattern in forbidden.iter().skip(1) {
                assert!(
                    !content.contains(pattern),
                    "forbidden dialog hook in {}",
                    path.display()
                );
            }
        }

        let rust_plugin = ["tauri", "_plugin_", "dialog"].concat();
        let allowed = [
            manifest_dir.join("src/commands/ge_install.rs"),
            manifest_dir.join("src/lib.rs"),
        ];
        for (path, content) in source_files
            .iter()
            .filter(|(path, _)| path.extension().and_then(|ext| ext.to_str()) == Some("rs"))
        {
            if content.contains(&rust_plugin) {
                assert!(
                    allowed.iter().any(|candidate| candidate == path),
                    "dialog plugin outside delete adapter: {}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn produktionswrapper_bindet_nur_löschpipeline() {
        let source = include_str!("delete_ops.rs");
        let start = source
            .find("pub async fn execute_delete(")
            .expect("tauri execute wrapper must exist");
        let command = &source[start..source.find("#[cfg(test)]").expect("tests follow wrapper")];
        assert!(command.contains("token: String"));
        assert!(command.contains("execute_delete_pipeline"));
        // die bestätigung kommt aus dem webview-dialog des hauptfensters; der
        // wrapper selbst darf nie bejahen oder fenster bauen.
        assert!(!command.contains("Ok(true)"));
        assert!(!command.contains("bool"));
        assert!(!command.contains("invoke"));
        assert!(!command.contains("webview"));
        assert!(!command.contains("confirm"));
        assert!(!command.contains("WebviewWindow"));
    }

    #[test]
    fn prepare_und_execute_happy_path_und_replay_schutz() {
        let root = wsg_fixture("delete-ops-replay");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata/999999");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        let registry = PendingDeleteRegistry::default();
        let req = PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: compatdata.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };

        // 1. Prepare
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        assert_eq!(info.target_type, "orphan");
        assert_eq!(info.consequences.len(), 1);
        assert_eq!(info.consequences[0].action, "trash");

        // 2. Execute 1st time -> Success
        let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false)).unwrap();
        assert!(res.success);
        assert!(!compatdata.exists());

        // 3. Execute 2nd time (Replay) -> Fails with invalid token
        let res_replay = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false));
        assert!(res_replay.is_err());
        assert!(res_replay.unwrap_err().contains("invalid deletion token"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn abgelaufenes_token_wird_abgelehnt() {
        let registry = PendingDeleteRegistry::default();
        let mut map = registry.0.lock().unwrap();
        let expired_pending = PendingDelete {
            created_at: 0,
            expires_at: 1000, // weit in der Vergangenheit
            target_type: "orphan".to_string(),
            target_path: "/tmp/foo".to_string(),
            canonical_path: PathBuf::from("/tmp/foo"),
            steam_root: PathBuf::from("/tmp/steam"),
            dev: 0,
            ino: 0,
            target_handle: None,
            parent_handle: None,
            target_name: None,
            consequences: vec![],
        };
        map.insert("expired123".to_string(), expired_pending);
        drop(map);

        let res = execute_delete_pipeline(&registry, "expired123", &|_| true, || Ok(false));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("expired"));
    }

    #[test]
    fn steam_laeuft_zwischen_prepare_und_execute_blockiert_loeschung() {
        let root = wsg_fixture("delete-ops-steam-running");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata/999999");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        let registry = PendingDeleteRegistry::default();
        let req = PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: compatdata.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        // Steam läuft beim Execute -> Abbruch
        let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(true));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("steam is running"));
        assert!(compatdata.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn registry_groesse_bleibt_auf_32_und_verdrängt_aeltesten() {
        let root = wsg_fixture("delete-ops-limit");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata/999999");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        let registry = PendingDeleteRegistry::default();
        let mut map = registry.0.lock().unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        for i in 0..MAX_PENDING_DELETES {
            let token = format!("token_{i}");
            map.insert(
                token.clone(),
                PendingDelete {
                    created_at: now_ms.saturating_sub(MAX_PENDING_DELETES as u64 - i as u64),
                    expires_at: now_ms + 100_000,
                    target_type: "orphan".to_string(),
                    target_path: compatdata.to_str().unwrap().to_string(),
                    canonical_path: compatdata.clone(),
                    steam_root: steam.clone(),
                    dev: 0,
                    ino: 0,
                    target_handle: None,
                    parent_handle: None,
                    target_name: None,
                    consequences: vec![],
                },
            );
        }
        drop(map);

        let req = PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: compatdata.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        let map = registry.0.lock().unwrap();
        assert_eq!(map.len(), MAX_PENDING_DELETES);
        assert!(!map.contains_key("token_0"));
        assert!(map.contains_key(&info.token));
        let inserted = map.get(&info.token).unwrap();
        assert_eq!(
            inserted.expires_at - inserted.created_at,
            DELETE_TOKEN_TTL_SECS * 1000
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ino_mismatch_oder_symlink_mutation_zwischen_prepare_und_execute_wird_abgelehnt() {
        let root = wsg_fixture("delete-ops-inode");
        let steam = root.join("steam");
        let config_dir = steam.join("config");
        let steamapps = steam.join("steamapps");
        let compatdata = steamapps.join("compatdata/999999");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        let lf_vdf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}",
            steam.display()
        );
        std::fs::write(config_dir.join("libraryfolders.vdf"), &lf_vdf).unwrap();

        let registry = PendingDeleteRegistry::default();
        let req = PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: compatdata.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };

        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        // Ersetze Ordner durch neuen Ordner (neues Inode)
        std::fs::remove_dir_all(&compatdata).unwrap();
        std::fs::create_dir_all(&compatdata).unwrap();

        // Simuliere deterministisch das auf Linux mögliche Inode-Recycling:
        // der neue Pfad bekommt absichtlich dieselbe gespeicherte `(dev, ino)`-
        // Identität. Eine reine Metadatenprüfung dürfte hier nicht löschen.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let replacement = std::fs::metadata(&compatdata).unwrap();
            let mut pending = registry.0.lock().unwrap();
            let entry = pending.get_mut(&info.token).unwrap();
            entry.dev = replacement.dev();
            entry.ino = replacement.ino();
        }

        let res = execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false));
        let error = res.unwrap_err();
        assert!(
            error.contains("identity changed"),
            "unexpected error: {error}"
        );

        // Symlink mutation
        let info2 = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        std::fs::remove_dir_all(&compatdata).unwrap();
        let target_real = root.join("real");
        std::fs::create_dir_all(&target_real).unwrap();
        std::os::unix::fs::symlink(&target_real, &compatdata).unwrap();

        let res2 = execute_delete_pipeline(&registry, &info2.token, &|_| true, || Ok(false));
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("symlink"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replacement_nach_letzter_inspektion_wird_vor_mutation_geclaimt_und_nicht_geloescht() {
        let (root, steam) = orphan_fixture("delete-ops-after-inspection-race");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let target = steam.join("steamapps/compatdata/999999");
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        let result = execute_delete_after_inspection(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            || {
                std::fs::remove_dir_all(&target).unwrap();
                std::fs::create_dir_all(&target).unwrap();
                std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();
            },
        );

        let error = result.unwrap_err();
        assert!(
            error.contains("target changed before mutation"),
            "error: {error}"
        );
        // das replacement wurde geclaimt, aber nicht gelöscht: der
        // claim-restore benennt es unbeschadet auf den originalnamen zurück.
        assert!(target.exists());
        assert!(target.join("replacement-marker").exists());
        assert!(!claim_leftovers(target.parent().unwrap()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn trash_revalidierung_lehnt_verschachteltes_ziel_vor_claim_ab() {
        let root = wsg_fixture("delete-ops-trash-boundary");
        let steam = root.join("steam");
        let trash_dir = steam.join("steamapps/.protium-trash");
        let target = trash_dir.join("compatdata_123_1700000000000");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();

        let registry = PendingDeleteRegistry::default();
        let request = PrepareDeleteRequest {
            target_type: "trash".to_string(),
            path: target.to_string_lossy().into_owned(),
            steam_root: steam.to_string_lossy().into_owned(),
        };
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

        let nested_parent = trash_dir.join("nested");
        let nested_target = nested_parent.join("compatdata_123_1700000000000");
        std::fs::create_dir_all(&nested_parent).unwrap();
        std::fs::rename(&target, &nested_target).unwrap();

        {
            let mut pending = registry.0.lock().unwrap();
            let entry = pending.get_mut(&info.token).unwrap();
            entry.target_path = nested_target.to_string_lossy().into_owned();
            entry.canonical_path = nested_target.clone();
            entry.parent_handle = Some(open_delete_target_handle(&nested_parent).unwrap());
            entry.target_name = Some(nested_target.file_name().unwrap().to_os_string());
            entry.consequences[0].path = nested_target.to_string_lossy().into_owned();
        }

        let claim_called = Arc::new(AtomicBool::new(false));
        let claim_called_for_hook = Arc::clone(&claim_called);
        let result = execute_delete_after_inspection(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            move || {
                claim_called_for_hook.store(true, Ordering::SeqCst);
            },
        );
        let error = result.unwrap_err();
        assert!(error.contains("direct child"), "error: {error}");
        assert!(!claim_called.load(Ordering::SeqCst));
        assert!(nested_target.join("replacement-marker").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neues_gueltiges_manifest_zwischen_prepare_und_execute_blockiert_orphan_delete() {
        let (root, steam) = orphan_fixture("delete-ops-live-manifest-valid");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        std::fs::write(
            steam.join("steamapps/appmanifest_999999.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"999999\"\n}\n",
        )
        .unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(
            result.is_err(),
            "live manifest must block stale orphan delete"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neues_unlesbares_manifest_zwischen_prepare_und_execute_blockiert_fail_closed() {
        let (root, steam) = orphan_fixture("delete-ops-live-manifest-unreadable");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        std::fs::create_dir(steam.join("steamapps/appmanifest_999999.acf")).unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "unreadable manifest must block deletion");
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neues_defektes_manifest_zwischen_prepare_und_execute_blockiert_fail_closed() {
        let (root, steam) = orphan_fixture("delete-ops-live-manifest-broken");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        std::fs::write(
            steam.join("steamapps/appmanifest_999999.acf"),
            "\"AppState\" { \"appid\" \"999999\"",
        )
        .unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "broken manifest must block deletion");
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neues_dateiname_appid_inkonsistentes_manifest_blockiert_fail_closed() {
        let (root, steam) = orphan_fixture("delete-ops-live-manifest-mismatch");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        std::fs::write(
            steam.join("steamapps/appmanifest_999999.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"570\"\n}\n",
        )
        .unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(
            result.is_err(),
            "manifest identity drift must block deletion"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_prepare_erlaubt_non_steam_shortcut_appid() {
        // bit-31-appids (non-steam-shortcuts) sind legitime u32-ids:
        // compatdata/<id> kann sein, darf der orphan-pfad nicht ablehnen.
        let root = wsg_fixture("delete-appid-non-steam");
        let steam = root.join("steam");
        let target = steam.join("steamapps/compatdata/2207218128");
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            steam.join("config/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
                steam.display()
            ),
        )
        .unwrap();
        let request = PrepareDeleteRequest {
            target_type: "orphan".to_string(),
            path: target.to_string_lossy().into_owned(),
            steam_root: steam.to_string_lossy().into_owned(),
        };

        let result = prepare_delete_inner(
            &PendingDeleteRegistry::default(),
            &request,
            &|_| true,
            || Ok(false),
        );
        assert!(
            result.is_ok(),
            "delete darf bit-31-appids nicht ablehnen: {:?}",
            result.err()
        );
        assert!(target.exists()); // prepare löscht noch nicht

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neuer_non_steam_shortcut_zwischen_prepare_und_execute_blockiert_orphan_delete() {
        let (root, steam) = orphan_fixture("delete-ops-live-shortcut");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();

        let shortcuts = steam.join("userdata/123/config");
        std::fs::create_dir_all(&shortcuts).unwrap();
        write_shortcuts_fixture(&shortcuts.join("shortcuts.vdf"), 999999);

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "new shortcut must block orphan deletion");
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn manifest_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
        let (root, steam) = orphan_fixture("delete-ops-manifest-after-openat");
        let target = steam.join("steamapps/compatdata/999999");
        let manifest = steam.join("steamapps/appmanifest_570.acf");
        std::fs::write(&manifest, "\"AppState\" { \"appid\" \"570\" }").unwrap();
        let replacement = manifest.clone();
        let mut hook = move |stage, _: Option<&mut std::fs::File>| {
            if stage == crate::commands::steam::DeleteReadStage::ManifestAfterOpen {
                std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
                std::fs::write(&replacement, "\"AppState\" { \"appid\" \"999999\" }").unwrap();
            }
        };

        let registry = PendingDeleteRegistry::default();
        let info = prepare_delete_inner_with_hook(
            &registry,
            &orphan_request(&steam),
            &|_| true,
            || Ok(false),
            &mut hook,
        )
        .unwrap();

        assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shortcut_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
        let (root, steam) = orphan_fixture("delete-ops-shortcut-after-openat");
        let target = steam.join("steamapps/compatdata/999999");
        let shortcuts = steam.join("userdata/123/config/shortcuts.vdf");
        std::fs::create_dir_all(shortcuts.parent().unwrap()).unwrap();
        write_shortcuts_fixture(&shortcuts, 42);
        let replacement = shortcuts.clone();
        let mut hook = move |stage, _: Option<&mut std::fs::File>| {
            if stage == crate::commands::steam::DeleteReadStage::ShortcutsAfterOpen {
                std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
                write_shortcuts_fixture(&replacement, 999999);
            }
        };

        let registry = PendingDeleteRegistry::default();
        let info = prepare_delete_inner_with_hook(
            &registry,
            &orphan_request(&steam),
            &|_| true,
            || Ok(false),
            &mut hook,
        )
        .unwrap();

        assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neue_gueltige_compat_mapping_aendert_folgen_und_blockiert_delete() {
        let root = wsg_fixture("delete-ops-live-compat-valid");
        let steam = root.join("steam");
        let target = steam.join("compatibilitytools.d/GE-Proton9-27");
        std::fs::create_dir_all(&target).unwrap();
        let registry = PendingDeleteRegistry::default();
        let request = PrepareDeleteRequest {
            target_type: "compatTool".to_string(),
            path: target.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::write(
            steam.join("config/config.vdf"),
            "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }",
        )
        .unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(
            result.is_err(),
            "changed compat consequences must block delete"
        );
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn config_replacement_nach_openat_in_prepare_wird_vor_execute_erkannt() {
        let root = wsg_fixture("delete-ops-config-after-openat");
        let steam = root.join("steam");
        let target = steam.join("compatibilitytools.d/GE-Proton9-27");
        let config = steam.join("config/config.vdf");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"Other\" } } } } } }",
        )
        .unwrap();
        let replacement = config.clone();
        let mut hook = move |stage, _: Option<&mut std::fs::File>| {
            if stage == crate::commands::steam::DeleteReadStage::ConfigAfterOpen {
                std::fs::rename(&replacement, replacement.with_extension("bound")).unwrap();
                std::fs::write(
                    &replacement,
                    "\"InstallConfigStore\" { \"Software\" { \"Valve\" { \"Steam\" { \"CompatToolMapping\" { \"620\" { \"name\" \"GE-Proton9-27\" } } } } } }",
                )
                .unwrap();
            }
        };
        let request = PrepareDeleteRequest {
            target_type: "compatTool".to_string(),
            path: target.to_string_lossy().into_owned(),
            steam_root: steam.to_string_lossy().into_owned(),
        };

        let registry = PendingDeleteRegistry::default();
        let info =
            prepare_delete_inner_with_hook(&registry, &request, &|_| true, || Ok(false), &mut hook)
                .unwrap();

        assert!(execute_confirmed(&registry, &info.token, || Ok(false)).is_err());
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neue_unlesbare_compat_config_blockiert_fail_closed() {
        let root = wsg_fixture("delete-ops-live-compat-unreadable");
        let steam = root.join("steam");
        let target = steam.join("compatibilitytools.d/GE-Proton9-27");
        std::fs::create_dir_all(&target).unwrap();
        let registry = PendingDeleteRegistry::default();
        let request = PrepareDeleteRequest {
            target_type: "compatTool".to_string(),
            path: target.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

        std::fs::create_dir_all(steam.join("config/config.vdf")).unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(
            result.is_err(),
            "unreadable compat config must block delete"
        );
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn neue_defekte_compat_config_blockiert_fail_closed() {
        let root = wsg_fixture("delete-ops-live-compat-broken");
        let steam = root.join("steam");
        let target = steam.join("compatibilitytools.d/GE-Proton9-27");
        std::fs::create_dir_all(&target).unwrap();
        let registry = PendingDeleteRegistry::default();
        let request = PrepareDeleteRequest {
            target_type: "compatTool".to_string(),
            path: target.to_str().unwrap().to_string(),
            steam_root: steam.to_str().unwrap().to_string(),
        };
        let info = prepare_delete_inner(&registry, &request, &|_| true, || Ok(false)).unwrap();

        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::write(steam.join("config/config.vdf"), "\"broken\" {").unwrap();

        let result = execute_confirmed(&registry, &info.token, || Ok(false));
        assert!(result.is_err(), "broken compat config must block delete");
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn steam_start_zwischen_den_checks_blockiert_mutation() {
        let (root, steam) = orphan_fixture("delete-ops-live-steam-race");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        // erster steam-check: läuft nicht; zweiter: läuft — die pipeline
        // prüft zweimal (vor und nach der inspection), der start zwischen
        // den checks muss die mutation blockieren.
        let checks = Arc::new(AtomicUsize::new(0));
        let check_run = Arc::clone(&checks);
        let result = execute_delete_pipeline(&registry, &info.token, &|_| true, move || {
            Ok(check_run.fetch_add(1, Ordering::SeqCst) == 1)
        });
        assert!(
            result.is_err(),
            "steam start between checks must block mutation"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_aenderung_zwischen_checks_wird_unmittelbar_vor_mutation_erkannt() {
        let (root, steam) = orphan_fixture("delete-ops-live-dialog-change");
        let registry = PendingDeleteRegistry::default();
        let req = orphan_request(&steam);
        let info = prepare_delete_inner(&registry, &req, &|_| true, || Ok(false)).unwrap();
        let manifest_path = steam.join("steamapps/appmanifest_999999.acf");
        // die änderung passiert im ersten steam-check (zwischen erster und
        // zweiter inspection): die zweite inspection muss sie sehen.
        let written = Arc::new(AtomicBool::new(false));
        let write_done = Arc::clone(&written);
        let result = execute_delete_pipeline(&registry, &info.token, &|_| true, move || {
            if !write_done.swap(true, Ordering::SeqCst) {
                std::fs::write(
                    &manifest_path,
                    "\"AppState\"\n{\n\t\"appid\"\t\t\"999999\"\n}\n",
                )
                .unwrap();
            }
            Ok(false)
        });
        assert!(
            result.is_err(),
            "live drift between checks must block mutation"
        );
        assert!(steam.join("steamapps/compatdata/999999").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Regression: Scheitert die Mutation NACH dem Claim, muss das Ziel unter
    /// seinem Originalnamen zurückkommen. Fehlerinjektion ohne Rechtetricks
    /// (läuft damit auch als root): `.protium-trash` liegt als reguläre Datei
    /// im Weg, `create_dir_all` scheitert deterministisch.
    #[cfg(target_os = "linux")]
    #[test]
    fn fehlgeschlagene_mutation_stellt_originalnamen_wieder_her() {
        let (root, steam) = orphan_fixture("delete-ops-restore-after-failure");
        let target = steam.join("steamapps/compatdata/999999");
        std::fs::write(target.join("savegame-marker"), b"must survive").unwrap();
        std::fs::write(steam.join("steamapps/.protium-trash"), b"blockiert").unwrap();

        let registry = PendingDeleteRegistry::default();
        let info =
            prepare_delete_inner(&registry, &orphan_request(&steam), &|_| true, || Ok(false))
                .unwrap();

        let error =
            execute_delete_pipeline(&registry, &info.token, &|_| true, || Ok(false)).unwrap_err();
        assert!(error.contains("cannot create trash dir"), "error: {error}");

        assert!(
            target.exists(),
            "Ziel muss unter dem Originalnamen zurück sein"
        );
        assert!(target.join("savegame-marker").exists());
        assert!(
            !claim_leftovers(target.parent().unwrap()),
            "kein .protium-delete-claim-* darf zurückbleiben"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    /// Regression: Wird zwischen letzter Inspektion und Claim ein Replacement
    /// untergeschoben, claimt Protium es und erkennt den Identity-Mismatch.
    /// Der Claim-Restore benennt das Replacement best-effort per NOREPLACE auf
    /// den Originalnamen zurück — fremde Daten bleiben am sichtbaren Ort
    /// statt unter .protium-delete-claim-*.
    #[cfg(target_os = "linux")]
    #[test]
    fn claim_mismatch_benennt_replacement_zurueck() {
        let (root, steam) = orphan_fixture("delete-ops-restore-replacement");
        let target = steam.join("steamapps/compatdata/999999");
        let registry = PendingDeleteRegistry::default();
        let info =
            prepare_delete_inner(&registry, &orphan_request(&steam), &|_| true, || Ok(false))
                .unwrap();

        let error = execute_delete_after_inspection(
            &registry,
            &info.token,
            &|_| true,
            || Ok(false),
            || {
                std::fs::remove_dir_all(&target).unwrap();
                std::fs::create_dir_all(&target).unwrap();
                std::fs::write(target.join("replacement-marker"), b"must survive").unwrap();
            },
        )
        .unwrap_err();

        assert!(
            error.contains("target changed before mutation"),
            "error: {error}"
        );
        assert!(
            target.exists(),
            "Replacement muss am Originalnamen zurück sein"
        );
        assert!(target.join("replacement-marker").exists());
        assert!(
            !claim_leftovers(target.parent().unwrap()),
            "kein .protium-delete-claim-* darf zurückbleiben"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    /// Fall 2: Ist der Originalname beim Restore-Versuch erneut belegt, darf
    /// NOREPLACE nichts überschreiben: das neue Original bleibt unberührt,
    /// der Claim-Rest bleibt liegen und wird später vom Cleanup erkannt.
    #[cfg(target_os = "linux")]
    #[test]
    fn claim_restore_ueberschreibt_neues_original_nicht() {
        let (root, steam) = orphan_fixture("delete-ops-restore-blocked");
        let target = steam.join("steamapps/compatdata/999999");
        let registry = PendingDeleteRegistry::default();
        let info =
            prepare_delete_inner(&registry, &orphan_request(&steam), &|_| true, || Ok(false))
                .unwrap();
        let registry_guard = registry.0.lock().unwrap();
        let pending = registry_guard.get(&info.token).unwrap();
        let claim = claim_delete_target(pending).unwrap();

        // originalnamen erneut belegen, bevor der restore zurückbenennen will
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("new-marker"), b"must survive").unwrap();

        drop(ClaimRestoreGuard {
            parent: pending.parent_handle.as_ref().unwrap(),
            claim_name: claim.name.as_os_str(),
            original_name: pending.target_name.as_deref().unwrap(),
            armed: true,
        });

        assert!(
            target.join("new-marker").exists(),
            "neu entstandener Originalpfad muss unberührt bleiben"
        );
        assert!(
            claim_leftovers(target.parent().unwrap()),
            "claim-rest muss liegen bleiben, wenn der originalname belegt ist"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    fn claim_leftovers(dir: &std::path::Path) -> bool {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.starts_with(".protium-delete-claim-"))
                })
            })
            .unwrap_or(false)
    }
}
