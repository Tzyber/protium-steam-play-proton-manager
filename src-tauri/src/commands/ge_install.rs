use std::fs;
use std::io::{Read, Seek, SeekFrom};
#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::download::{
    fetch_sha512_text, validate_download_id, validate_download_url, validate_redirect_url,
    CancelRegistry, CancelSignal, DownloadDirectoryBinding, DownloadStorage, Sha512FetchError,
    MAX_DOWNLOAD_BYTES,
};
use crate::commands::extract::{extract_blocking_with_tag, MAX_EXTRACT_BYTES};
use crate::commands::path::{is_descendant_of, random_suffix, sanitize_path};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallGeResult {
    Verified,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TargetArch {
    X86_64,
    Aarch64,
}

impl TargetArch {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
}

pub(super) fn normalize_target_arch(raw: &str) -> Result<TargetArch, String> {
    match raw {
        "x86_64" => Ok(TargetArch::X86_64),
        "aarch64" => Ok(TargetArch::Aarch64),
        _ => Err(format!("unsupported GE target architecture: {raw}")),
    }
}

fn compile_target_arch() -> Result<TargetArch, String> {
    normalize_target_arch(std::env::consts::ARCH)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GeReleaseIdentity {
    pub(super) asset_name: String,
    pub(super) install_name: String,
    pub(super) checksum_asset_name: String,
}

fn release_version(tag: &str) -> Option<(u64, u64)> {
    let rest = tag.strip_prefix("GE-Proton")?;
    let (major, minor) = rest.split_once('-')?;
    if major.is_empty()
        || minor.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || !minor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((major.parse().ok()?, minor.parse().ok()?))
}

fn is_legacy_release(tag: &str) -> bool {
    let (major, minor) = match release_version(tag) {
        Some(version) => version,
        None => return false,
    };
    major < 11 || (major == 11 && minor <= 3)
}

fn exact_release_url(url: &str, release_tag: &str, asset_name: &str) -> Result<(), String> {
    validate_download_url(url)?;
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid release URL: {e}"))?;
    let expected_path =
        format!("/GloriousEggroll/proton-ge-custom/releases/download/{release_tag}/{asset_name}");
    if parsed.path() != expected_path {
        return Err("release URL does not match tag and asset identity".into());
    }
    Ok(())
}

pub(super) fn validate_release_identity(
    target_arch: TargetArch,
    release_tag: &str,
    download_url: &str,
) -> Result<GeReleaseIdentity, String> {
    if release_version(release_tag).is_none() {
        return Err("invalid release tag: expected GE-Proton<major>-<minor>".into());
    }
    let parsed =
        reqwest::Url::parse(download_url).map_err(|e| format!("invalid download URL: {e}"))?;
    let asset_name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .ok_or_else(|| "download URL has no asset name".to_string())?;
    let current_name = format!("{release_tag}-{}.tar.gz", target_arch.as_str());
    let legacy_name = format!("{release_tag}.tar.gz");
    let allowed = asset_name == current_name
        || (target_arch == TargetArch::X86_64
            && is_legacy_release(release_tag)
            && asset_name == legacy_name);
    if !allowed {
        return Err(format!(
            "asset {asset_name} is not authorized for target architecture {}",
            target_arch.as_str()
        ));
    }
    exact_release_url(download_url, release_tag, asset_name)?;
    let install_name = asset_name
        .strip_suffix(".tar.gz")
        .ok_or_else(|| "download asset must end in .tar.gz".to_string())?
        .to_string();
    let identity = GeReleaseIdentity {
        asset_name: asset_name.to_string(),
        install_name: install_name.clone(),
        checksum_asset_name: asset_name.to_string(),
    };
    Ok(identity)
}

fn checksum_url(release_tag: &str, identity: &GeReleaseIdentity) -> String {
    format!(
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/{release_tag}/{}.sha512sum",
        identity.install_name
    )
}

fn is_missing_checksum_asset(error: &Sha512FetchError) -> bool {
    matches!(error, Sha512FetchError::Http(404))
}

fn cancel_before_extract(cancel: &CancelSignal) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    Ok(())
}

fn extract_after_cancel_check<T>(
    cancel: &CancelSignal,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    operation()
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

pub(super) fn parse_sha512_hash(text: &str, expected_asset: &str) -> Result<String, String> {
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let hash = fields.next();
        let asset = fields
            .next()
            .map(|value| value.strip_prefix('*').unwrap_or(value));
        if fields.next().is_some() || asset != Some(expected_asset) {
            continue;
        }
        let Some(hash) = hash else {
            continue;
        };
        if hash.len() == 128 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err(format!(
        "no valid sha512 checksum line for asset {expected_asset}"
    ))
}

/// Verifiziert, dass die Datei auf Disk tatsächlich den erwarteten SHA512 erzeugt
/// (Schutz vor Hash-Swap / TOCTOU).
pub(super) fn verify_file_hash_on_disk(
    file: &mut fs::File,
    expected_hash: &str,
    cancel: &CancelSignal,
) -> Result<(), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("seek downloaded file: {e}"))?;
    let mut hasher = Sha512::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read downloaded file: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("rewind downloaded file: {e}"))?;
    if actual != expected_hash {
        return Err(format!(
            "hash swap detected: disk hash ({actual}) does not match expected ({expected_hash})"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationKind {
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationButtons {
    OkCancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UnverifiedConfirmationRequest {
    title: String,
    message: String,
    kind: ConfirmationKind,
    buttons: ConfirmationButtons,
}

fn unverified_confirmation_request(
    release_tag: &str,
    install_name: &str,
    checksum_url: &str,
) -> UnverifiedConfirmationRequest {
    UnverifiedConfirmationRequest {
        title: "Protium: Installation ohne Prüfsumme bestätigen".to_string(),
        message: format!(
            "Für {release_tag} ({install_name}) wurde das exakt abgeleitete SHA512-Asset mit HTTP 404 nicht gefunden.\n\nURL: {checksum_url}\n\nMöchten Sie die unüberprüfte Installation fortsetzen?"
        ),
        kind: ConfirmationKind::Warning,
        buttons: ConfirmationButtons::OkCancel,
    }
}

fn confirm_unverified_installation(
    release_tag: &str,
    install_name: &str,
    checksum_url: &str,
    show: impl FnOnce(UnverifiedConfirmationRequest) -> Result<bool, String>,
) -> Result<bool, String> {
    show(unverified_confirmation_request(
        release_tag,
        install_name,
        checksum_url,
    ))
}

fn show_native_unverified_confirmation(
    app: &AppHandle,
    request: UnverifiedConfirmationRequest,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    Ok(app
        .dialog()
        .message(&request.message)
        .title(&request.title)
        .kind(match request.kind {
            ConfirmationKind::Warning => MessageDialogKind::Warning,
        })
        .buttons(match request.buttons {
            ConfirmationButtons::OkCancel => MessageDialogButtons::OkCancel,
        })
        .blocking_show())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn install_ge_proton_inner(
    steam_root: &str,
    target_arch: TargetArch,
    release_tag: &str,
    download_url: &str,
    download_id: &str,
    cache_dir: &Path,
    cancel_flag: Arc<CancelSignal>,
    mut on_progress: impl FnMut(u64, Option<u64>),
    mut on_phase: impl FnMut(&str, bool),
    confirm_unverified: impl FnMut(UnverifiedConfirmationRequest) -> Result<bool, String>,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
    environment: Option<crate::commands::scope::EnvironmentState>,
) -> Result<InstallGeResult, String> {
    sanitize_path(steam_root, "steam root")?;
    let identity = validate_release_identity(target_arch, release_tag, download_url)?;
    validate_download_id(download_id)?;

    let root_canon =
        fs::canonicalize(steam_root).map_err(|e| format!("steam root canonicalize: {e}"))?;
    let tools_dir = root_canon.join("compatibilitytools.d");
    if !scope_ok(&tools_dir) || !scope_ok(&root_canon) {
        return Err("steam root outside allowed scope".into());
    }

    let final_target = tools_dir.join(&identity.install_name);
    if final_target.exists() {
        return Err("ToolAlreadyExists: target directory already exists".into());
    }

    fs::create_dir_all(cache_dir).map_err(|e| format!("create app cache dir: {e}"))?;
    let cache_canon =
        fs::canonicalize(cache_dir).map_err(|e| format!("app cache canonicalize: {e}"))?;
    let downloads_dir = cache_canon.join("downloads");
    fs::create_dir_all(&downloads_dir).map_err(|e| format!("create downloads dir: {e}"))?;
    let downloads_dir =
        fs::canonicalize(&downloads_dir).map_err(|e| format!("downloads dir canonicalize: {e}"))?;
    if !is_descendant_of(&downloads_dir, &cache_canon) {
        return Err("downloads dir outside canonical app cache".into());
    }
    let downloads_metadata = fs::symlink_metadata(&downloads_dir)
        .map_err(|e| format!("stat canonical downloads dir: {e}"))?;
    if downloads_metadata.file_type().is_symlink() || !downloads_metadata.is_dir() {
        return Err("canonical downloads path is not a real directory".into());
    }
    let expected_downloads_identity =
        crate::commands::download::metadata_identity(&downloads_metadata)
            .ok_or_else(|| "canonical downloads directory has no identity".to_string())?;
    let download_file_name = format!("{}-{}.tar.gz", download_id, random_suffix());
    let download_path = downloads_dir.join(&download_file_name);
    let download_path_str = download_path.to_string_lossy().to_string();
    #[cfg(target_os = "linux")]
    let downloads_directory = {
        let mut bytes = downloads_dir.as_os_str().as_bytes().to_vec();
        bytes.push(0);
        let raw = unsafe {
            libc::open(
                bytes.as_ptr().cast(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if raw < 0 {
            return Err(format!(
                "open downloads directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) })
    };
    #[cfg(not(target_os = "linux"))]
    let downloads_directory =
        fs::File::open(&downloads_dir).map_err(|e| format!("open downloads directory: {e}"))?;

    let cancel_flag_clone = Arc::clone(&cancel_flag);
    let is_cancelled = move || cancel_flag_clone.is_cancelled();

    // Download-Phase
    let stream_hash = match crate::commands::download::download_stream_in_directory(
        download_url,
        &download_path_str,
        |u| validate_redirect_url(u).is_ok(),
        is_cancelled,
        &mut on_progress,
        DownloadStorage {
            max_bytes: MAX_DOWNLOAD_BYTES,
            directory: Some(DownloadDirectoryBinding {
                file: &downloads_directory,
                identity: expected_downloads_identity,
            }),
            #[cfg(test)]
            before_open: None,
        },
    )
    .await
    {
        Ok(downloaded) => downloaded,
        Err(e) => {
            return Err(e);
        }
    };

    let mut downloaded_file = stream_hash.file;
    let stream_hash = stream_hash.hash;
    cancel_before_extract(&cancel_flag)?;

    on_phase("verifying", false);

    // Die Checksum-URL wird aus der backendvalidierten Release-Identität abgeleitet.
    let checksum_url = checksum_url(release_tag, &identity);
    let result_status = match fetch_sha512_text(&checksum_url, Arc::clone(&cancel_flag)).await {
        Ok(hash_text) => {
            let expected_hash = match parse_sha512_hash(&hash_text, &identity.checksum_asset_name) {
                Ok(hash) => hash,
                Err(error) => {
                    return Err(error);
                }
            };
            if cancel_flag.is_cancelled() {
                return Err("cancelled".into());
            }
            if stream_hash.to_ascii_lowercase() != expected_hash {
                return Err(format!(
                    "SHA512 hash mismatch: stream ({stream_hash}) != expected ({expected_hash})"
                ));
            }

            // Der Voll-Read der 1-2-GB-Datei läuft blocking: spawn_blocking,
            // sonst stallen cancel und phasen-events bis der hash fertig ist.
            let cancel_for_verify = Arc::clone(&cancel_flag);
            let verify = move || {
                let result = verify_file_hash_on_disk(
                    &mut downloaded_file,
                    &expected_hash,
                    &cancel_for_verify,
                );
                Ok((result, downloaded_file))
            };
            downloaded_file = match crate::commands::spawn_blocking_io(verify).await {
                Ok((result, file)) => {
                    result?;
                    file
                }
                Err(error) => return Err(error),
            };
            InstallGeResult::Verified
        }
        Err(error) if is_missing_checksum_asset(&error) => {
            let confirmed = match confirm_unverified_installation(
                release_tag,
                &identity.install_name,
                &checksum_url,
                confirm_unverified,
            ) {
                Ok(confirmed) => confirmed,
                Err(error) => {
                    return Err(format!(
                        "unverified installation confirmation failed: {error}"
                    ));
                }
            };
            if !confirmed {
                return Err("unverified installation rejected".into());
            }
            InstallGeResult::Unverified
        }
        Err(Sha512FetchError::Cancelled) => {
            return Err("cancelled".into());
        }
        Err(error) => {
            return Err(format!("SHA512 checksum fetch failed: {error}"));
        }
    };

    cancel_before_extract(&cancel_flag)?;

    on_phase("extracting", result_status == InstallGeResult::Verified);

    // Extraktions-Phase
    let tools_dir_str = tools_dir.to_string_lossy().to_string();
    let install_name = identity.install_name.clone();
    let dest_canon = tools_dir.clone();
    let root_canon_clone = root_canon.clone();
    let extract_dest = dest_canon.clone();
    let extract_root = root_canon_clone.clone();

    let cancel_for_extract = Arc::clone(&cancel_flag);
    let extract = move || {
        extract_after_cancel_check(&cancel_for_extract, || {
            let result = extract_blocking_with_tag(
                &mut downloaded_file,
                &tools_dir_str,
                Some(&install_name),
                MAX_EXTRACT_BYTES,
                &|p| p == extract_dest || p == extract_root,
            );
            Ok((result, downloaded_file))
        })
    };
    let extract_res = match environment {
        Some(environment) => {
            crate::commands::spawn_blocking_io(move || {
                environment.with_authorized_ge_install(&root_canon_clone, &dest_canon, extract)
            })
            .await
        }
        None => {
            if !scope_ok(&dest_canon) || !scope_ok(&root_canon_clone) {
                return Err("steam root outside allowed scope".into());
            }
            crate::commands::spawn_blocking_io(extract).await
        }
    };

    match extract_res {
        Ok((extract_result, _downloaded_file)) => match extract_result {
            Ok(_) => Ok(result_status),
            Err(error) => Err(format!("extract failed: {error}")),
        },
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn ge_target_arch() -> Result<String, String> {
    Ok(compile_target_arch()?.as_str().to_string())
}

#[derive(Serialize, Clone)]
struct InstallPhasePayload {
    id: String,
    phase: String,
    verified: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_ge_proton(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    environment: tauri::State<'_, crate::commands::scope::EnvironmentState>,
    steam_root: String,
    release_tag: String,
    download_url: String,
    download_id: String,
) -> Result<InstallGeResult, String> {
    let target_arch = compile_target_arch()?;
    let (authorized_root, authorized_tools) =
        environment.authorize_ge_install_paths(&steam_root)?;
    let environment_for_scope = environment.inner().clone();
    let scope_ok = move |path: &Path| {
        environment_for_scope.is_current_ge_install_path(path, &authorized_root, &authorized_tools)
    };
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;

    let cancel_flag = crate::commands::download::register_download(&state, &download_id)?;
    let cancel_flag_clone = Arc::clone(&cancel_flag);
    let app_handle = app.clone();
    let app_handle_phase = app.clone();
    let app_handle_confirmation = app.clone();
    let dl_id = download_id.clone();
    let dl_id_phase = download_id.clone();
    let mut last_emit: u64 = 0;

    let res = install_ge_proton_inner(
        &steam_root,
        target_arch,
        &release_tag,
        &download_url,
        &download_id,
        &cache_dir,
        cancel_flag_clone,
        move |downloaded, total| {
            let done = total.map(|t| downloaded >= t).unwrap_or(false);
            if downloaded - last_emit >= 1_000_000 || done {
                last_emit = downloaded;
                let _ = app_handle.emit(
                    "download-progress",
                    DownloadProgress {
                        id: dl_id.clone(),
                        downloaded,
                        total,
                    },
                );
            }
        },
        move |phase, verified| {
            let _ = app_handle_phase.emit(
                "install-phase",
                InstallPhasePayload {
                    id: dl_id_phase.clone(),
                    phase: phase.to_string(),
                    verified,
                },
            );
        },
        move |request| show_native_unverified_confirmation(&app_handle_confirmation, request),
        &scope_ok,
        Some(environment.inner().clone()),
    )
    .await;

    if let Ok(mut map) = state.0.lock() {
        let keep = map
            .get(&download_id)
            .map(|registered| Arc::ptr_eq(registered, &cancel_flag))
            .unwrap_or(false);
        if keep {
            map.remove(&download_id);
        }
    }

    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn ge_snapshot(root: &Path) -> EnvironmentSnapshot {
        EnvironmentSnapshot::for_test(
            root.to_path_buf(),
            vec![root.to_path_buf()],
            Vec::new(),
            root.join("cache"),
            root.join("config"),
        )
    }

    #[test]
    fn ge_install_direct_ipc_snapshot_authority_is_current_and_exact() {
        let root = std::env::temp_dir().join(format!("test-ge-snapshot-{}", random_suffix()));
        let other = std::env::temp_dir().join(format!("test-ge-other-{}", random_suffix()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();

        let undiscovered = EnvironmentState::default();
        assert!(undiscovered
            .authorize_ge_install_paths(root.to_str().unwrap())
            .is_err());

        let state = EnvironmentState::for_test(ge_snapshot(&root));
        let (authorized_root, tools_dir) = state
            .authorize_ge_install_paths(root.to_str().unwrap())
            .unwrap();
        assert_eq!(authorized_root, root);
        assert_eq!(tools_dir, root.join("compatibilitytools.d"));
        assert!(state.is_current_ge_install_path(&authorized_root, &authorized_root, &tools_dir));
        assert!(state.is_current_ge_install_path(&tools_dir, &authorized_root, &tools_dir));
        assert!(state
            .authorize_ge_install_paths(other.to_str().unwrap())
            .is_err());

        state.replace_for_test(ge_snapshot(&other));
        assert!(state
            .authorize_ge_install_paths(root.to_str().unwrap())
            .is_err());
        assert!(!state.is_current_ge_install_path(&authorized_root, &authorized_root, &tools_dir));
        assert!(state
            .authorize_ge_install_paths(other.to_str().unwrap())
            .is_ok());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn ge_install_snapshot_guard_serializes_replace_and_mutation() {
        let root = std::env::temp_dir().join(format!("test-ge-guard-{}", random_suffix()));
        let other = std::env::temp_dir().join(format!("test-ge-guard-other-{}", random_suffix()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        let state = EnvironmentState::for_test(ge_snapshot(&root));
        let tools_dir = root.join("compatibilitytools.d");
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let mutation_started = Arc::new(AtomicBool::new(false));
        let replacement_done = Arc::new(AtomicBool::new(false));
        let worker_state = state.clone();
        let worker_entered = Arc::clone(&entered);
        let worker_release = Arc::clone(&release);
        let worker_mutation = Arc::clone(&mutation_started);
        let worker_root = root.clone();
        let worker_tools = tools_dir.clone();
        let worker = thread::spawn(move || {
            worker_state.with_authorized_ge_install(&worker_root, &worker_tools, || {
                worker_entered.wait();
                worker_release.wait();
                worker_mutation.store(true, Ordering::Release);
                Ok::<(), String>(())
            })
        });

        entered.wait();
        let replacement_state = state.clone();
        let replacement_root = other.clone();
        let replacement_finished = Arc::clone(&replacement_done);
        let replacement = thread::spawn(move || {
            replacement_state.replace_for_test(ge_snapshot(&replacement_root));
            replacement_finished.store(true, Ordering::Release);
        });
        thread::yield_now();
        assert!(!mutation_started.load(Ordering::Acquire));
        assert!(!replacement_done.load(Ordering::Acquire));
        release.wait();
        worker.join().unwrap().unwrap();
        replacement.join().unwrap();
        assert!(mutation_started.load(Ordering::Acquire));
        assert!(replacement_done.load(Ordering::Acquire));
        assert!(state
            .with_authorized_ge_install(&root, &tools_dir, || -> Result<(), String> {
                panic!("revoked snapshot must not mutate")
            })
            .is_err());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn parse_sha512_hash_extrahiert_128_hex_zeichen() {
        let text = "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  GE-Proton9-27.tar.gz\n";
        let hash = parse_sha512_hash(text, "GE-Proton9-27.tar.gz").unwrap();
        assert_eq!(
            hash,
            "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
        );
    }

    #[test]
    fn parse_sha512_hash_lehnt_ungueltigen_text_ab() {
        assert!(parse_sha512_hash("kein hash hier", "GE-Proton9-27.tar.gz").is_err());
        assert!(parse_sha512_hash("12345 short", "GE-Proton9-27.tar.gz").is_err());
        assert!(parse_sha512_hash("", "GE-Proton9-27.tar.gz").is_err());
    }

    #[test]
    fn parse_sha512_hash_bindet_exakten_assetnamen_und_gnu_starformat() {
        let hash = "a".repeat(128);
        let text = format!("{hash}  other.tar.gz\n{hash} *GE-Proton11-4-x86_64.tar.gz\n");
        assert_eq!(
            parse_sha512_hash(&text, "GE-Proton11-4-x86_64.tar.gz").unwrap(),
            hash
        );
        assert!(parse_sha512_hash(&text, "missing.tar.gz").is_err());
    }

    #[test]
    fn target_arch_normalisierung_ist_injizierbar_und_fail_closed() {
        assert_eq!(normalize_target_arch("x86_64"), Ok(TargetArch::X86_64));
        assert_eq!(normalize_target_arch("aarch64"), Ok(TargetArch::Aarch64));
        assert!(normalize_target_arch("amd64").is_err());
        assert!(normalize_target_arch("arm64").is_err());
        assert!(normalize_target_arch("unknown").is_err());
    }

    #[test]
    fn ge_target_arch_nutzt_die_compile_architektur_ohne_webview_input() {
        let expected = match std::env::consts::ARCH {
            "x86_64" => "x86_64",
            "aarch64" => "aarch64",
            other => panic!("testsystemarchitektur {other:?} ist für GE nicht freigegeben"),
        };
        assert_eq!(ge_target_arch().unwrap(), expected);
    }

    #[test]
    fn release_identity_koppelt_tag_asset_installname_und_checksum_url() {
        let identity = validate_release_identity(
            TargetArch::X86_64,
            "GE-Proton11-4",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz",
        )
        .unwrap();
        assert_eq!(identity.asset_name, "GE-Proton11-4-x86_64.tar.gz");
        assert_eq!(identity.install_name, "GE-Proton11-4-x86_64");
        assert_eq!(identity.checksum_asset_name, "GE-Proton11-4-x86_64.tar.gz");
        assert_eq!(
            checksum_url("GE-Proton11-4", &identity),
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.sha512sum"
        );

        for download in [
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-aarch64.tar.gz",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz?x=1",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz#fragment",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz/extra",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton%31%31-4/GE-Proton11-4-x86_64.tar.gz",
        ] {
            assert!(validate_release_identity(TargetArch::X86_64, "GE-Proton11-4", download).is_err());
        }

        let legacy = validate_release_identity(
            TargetArch::X86_64,
            "GE-Proton11-3",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.tar.gz",
        );
        assert!(legacy.is_ok());
        assert!(validate_release_identity(
            TargetArch::X86_64,
            "GE-Proton11-4",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4.tar.gz",
        )
        .is_err());
    }

    #[test]
    fn verify_file_hash_on_disk_erkennt_abweichungen() {
        let temp_dir = std::env::temp_dir().join(format!("test-verify-hash-{}", random_suffix()));
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test.bin");
        fs::write(&file_path, b"hello world").unwrap();
        let mut file = fs::File::open(&file_path).unwrap();
        let cancel = CancelSignal::new();

        let mut hasher = Sha512::new();
        hasher.update(b"hello world");
        let good_hash = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        assert!(verify_file_hash_on_disk(&mut file, &good_hash, &cancel).is_ok());
        assert!(verify_file_hash_on_disk(&mut file, &"0".repeat(128), &cancel).is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn verify_file_hash_on_disk_bricht_bei_cancel_ab() {
        let temp_dir =
            std::env::temp_dir().join(format!("test-verify-hash-cancel-{}", random_suffix()));
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test.bin");
        fs::write(&file_path, b"hello world").unwrap();
        let mut file = fs::File::open(&file_path).unwrap();
        let cancel = CancelSignal::new();

        let mut hasher = Sha512::new();
        hasher.update(b"hello world");
        let good_hash = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        cancel.cancel();
        let error = verify_file_hash_on_disk(&mut file, &good_hash, &cancel).unwrap_err();
        assert_eq!(error, "cancelled");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn unverified_confirmation_naht_bindet_404_warning_okcancel_und_ablehnung() {
        let mut shown = false;
        let rejected = confirm_unverified_installation(
            "GE-Proton11-3",
            "GE-Proton11-3",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
            |request| {
                shown = true;
                assert_eq!(request.kind, ConfirmationKind::Warning);
                assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
                assert!(request.message.contains("HTTP 404"));
                Ok(false)
            },
        )
        .unwrap();
        assert!(shown);
        assert!(!rejected, "native ablehnung darf nicht fortsetzen");

        let accepted = confirm_unverified_installation(
            "GE-Proton11-3",
            "GE-Proton11-3",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
            |request| {
                assert_eq!(request.kind, ConfirmationKind::Warning);
                assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
                Ok(true)
            },
        )
        .unwrap();
        assert!(
            accepted,
            "native zustimmung muss nur den 404-fall fortsetzen"
        );
    }

    #[test]
    fn nur_http_404_ist_ein_fehlendes_checksum_asset() {
        assert!(is_missing_checksum_asset(&Sha512FetchError::Http(404)));
        assert!(!is_missing_checksum_asset(&Sha512FetchError::Http(403)));
        assert!(!is_missing_checksum_asset(&Sha512FetchError::Failed(
            "timeout".into()
        )));
    }

    #[test]
    fn cancel_nach_sha_vor_extract_raeumt_datei_und_registry_auf() {
        let root =
            std::env::temp_dir().join(format!("test-ge-cancel-boundary-{}", random_suffix()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("download.tar.gz");
        fs::write(&path, b"attacker path").unwrap();
        let registry = CancelRegistry::default();
        let cancel = crate::commands::download::register_download(&registry, "post-sha").unwrap();

        cancel.cancel();
        let result = cancel_before_extract(&cancel);
        assert_eq!(result.unwrap_err(), "cancelled");
        assert!(
            path.exists(),
            "cancel vor extract darf keinen später angelegten pfad löschen"
        );
        assert_eq!(fs::read(&path).unwrap(), b"attacker path");

        let mut map = registry.0.lock().unwrap();
        let same = map
            .get("post-sha")
            .map(|registered| Arc::ptr_eq(registered, &cancel))
            .unwrap_or(false);
        assert!(same);
        map.remove("post-sha");
        assert!(
            map.is_empty(),
            "registry muss nach dem install-wrapper leer sein"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_nach_guard_check_verhindert_extract_mutation() {
        let root = std::env::temp_dir().join(format!("test-ge-cancel-guard-{}", random_suffix()));
        fs::create_dir_all(&root).unwrap();
        let tools = root.join("compatibilitytools.d");
        let state = EnvironmentState::for_test(ge_snapshot(&root));
        let registry = CancelRegistry::default();
        let cancel =
            crate::commands::download::register_download(&registry, "guard-cancel").unwrap();
        let entered_guard = Arc::new(Barrier::new(2));
        let release_closure = Arc::new(Barrier::new(2));
        let worker_entered = Arc::clone(&entered_guard);
        let worker_release = Arc::clone(&release_closure);
        let worker_cancel = Arc::clone(&cancel);
        let worker_state = state.clone();
        let worker_root = root.clone();
        let worker_tools = tools.clone();
        let worker = thread::spawn(move || {
            worker_state.with_authorized_ge_install(&worker_root, &worker_tools, || {
                worker_entered.wait();
                worker_release.wait();
                extract_after_cancel_check(&worker_cancel, || {
                    fs::create_dir_all(&worker_tools).map_err(|e| e.to_string())?;
                    Ok(())
                })
            })
        });

        entered_guard.wait();
        cancel.cancel();
        release_closure.wait();
        let result = worker.join().unwrap();
        assert_eq!(result.unwrap_err(), "cancelled");
        assert!(!tools.exists(), "cancel vor extract darf kein ziel anlegen");

        let mut map = registry.0.lock().unwrap();
        map.remove("guard-cancel");
        assert!(map.is_empty(), "registry muss nach cancel bereinigt werden");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_pipeline_oeffnet_downloadpfad_nicht_erneut() {
        let source = include_str!("ge_install.rs");
        let start = source
            .find("pub(super) async fn install_ge_proton_inner")
            .unwrap();
        let body = &source[start..source.find("#[tauri::command]").unwrap()];
        assert!(!body.contains("File::open(&download_path"));
        assert!(!body.contains("cleanup_download_path"));
        // der disk-hash läuft über denselben owned-handle, nie über einen pfad
        assert!(body.contains("verify_file_hash_on_disk("));
        assert!(body.contains("extract_blocking_with_tag("));
        assert!(body.contains("&mut downloaded_file"));
    }

    #[tokio::test]
    async fn install_ge_proton_validiert_release_tag() {
        let temp_dir = std::env::temp_dir().join(format!("test-ge-tag-{}", random_suffix()));
        fs::create_dir_all(&temp_dir).unwrap();
        let cache_dir = temp_dir.join("cache");

        let res = install_ge_proton_inner(
            temp_dir.to_str().unwrap(),
            TargetArch::X86_64,
            "Proton-9.0",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            "dl-1",
            &cache_dir,
            Arc::new(CancelSignal::new()),
            |_, _| {},
            |_, _| {},
            |_| Ok(true),
            &|_| true,
            None,
        )
        .await;

        assert!(res.is_err(), "non-GE tag muss abgewiesen werden: {res:?}");
        assert!(res.unwrap_err().contains("invalid release tag"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn install_ge_proton_validiert_download_url() {
        let temp_dir = std::env::temp_dir().join(format!("test-ge-url-{}", random_suffix()));
        fs::create_dir_all(&temp_dir).unwrap();
        let cache_dir = temp_dir.join("cache");

        let res = install_ge_proton_inner(
            temp_dir.to_str().unwrap(),
            TargetArch::X86_64,
            "GE-Proton9-27",
            "https://evil.com/GE-Proton9-27.tar.gz",
            "dl-1",
            &cache_dir,
            Arc::new(CancelSignal::new()),
            |_, _| {},
            |_, _| {},
            |_| Ok(true),
            &|_| true,
            None,
        )
        .await;

        assert!(
            res.is_err(),
            "evil download URL muss abgewiesen werden: {res:?}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn install_ge_proton_lehnt_existierendes_ziel_ab() {
        let temp_dir = std::env::temp_dir().join(format!("test-ge-exists-{}", random_suffix()));
        let tools_dir = temp_dir.join("compatibilitytools.d").join("GE-Proton9-27");
        fs::create_dir_all(&tools_dir).unwrap();
        let cache_dir = temp_dir.join("cache");

        let res = install_ge_proton_inner(
            temp_dir.to_str().unwrap(),
            TargetArch::X86_64,
            "GE-Proton9-27",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            "dl-1",
            &cache_dir,
            Arc::new(CancelSignal::new()),
            |_, _| {},
            |_, _| {},
            |_| Ok(true),
            &|_| true,
            None,
        )
        .await;

        assert!(
            res.is_err(),
            "bereits existierendes Ziel muss abgewiesen werden: {res:?}"
        );
        assert!(res.unwrap_err().contains("ToolAlreadyExists"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn install_ge_proton_lehnt_unscoped_steam_root_ab() {
        let temp_dir = std::env::temp_dir().join(format!("test-ge-unscope-{}", random_suffix()));
        fs::create_dir_all(&temp_dir).unwrap();
        let cache_dir = temp_dir.join("cache");

        let res = install_ge_proton_inner(
            temp_dir.to_str().unwrap(),
            TargetArch::X86_64,
            "GE-Proton9-27",
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
            "dl-1",
            &cache_dir,
            Arc::new(CancelSignal::new()),
            |_, _| {},
            |_, _| {},
            |_| Ok(true),
            &|_| false,
            None,
        )
        .await;

        assert!(
            res.is_err(),
            "unscoped steam_root muss abgewiesen werden: {res:?}"
        );
        assert!(res.unwrap_err().contains("outside allowed scope"));

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
