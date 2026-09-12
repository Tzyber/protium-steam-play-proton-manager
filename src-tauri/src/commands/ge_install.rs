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
use crate::commands::extract::extract_blocking_with_tag;
use crate::commands::path::{is_descendant_of, sanitize_path};

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

/// Die Legacy-Schwelle der GE-Releases: bis einschliesslich 11-3 hiess das
/// x86_64-Asset `GE-Proton<major>-<minor>.tar.gz` ohne Architektur-Suffix.
/// Dieselbe Regel prüft `compat_auth::is_managed_ge_name` für installierte
/// Tool-Namen; beide Stellen müssen dieselbe Grenze sehen.
pub(crate) fn is_legacy_ge_version(major: u64, minor: u64) -> bool {
    major < 11 || (major == 11 && minor <= 3)
}

fn is_legacy_release(tag: &str) -> bool {
    match release_version(tag) {
        Some((major, minor)) => is_legacy_ge_version(major, minor),
        None => false,
    }
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
    let actual = crate::commands::fd::hex_lower(&hasher.finalize());
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

    // crash-reste früherer extraktionen (SIGKILL/Stromausfall zwischen temp
    // und rename): sichtbar melden statt automatisch löschen. eigentum und
    // zustand sind ohne denselben strengebeweis wie bei delete nicht belegt.
    if let Ok(entries) = fs::read_dir(&tools_dir) {
        let leftovers: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.starts_with(".protium-extract-").then_some(name)
            })
            .collect();
        if !leftovers.is_empty() {
            return Err(format!(
                "incomplete extraction leftovers found: {}; remove them manually",
                leftovers.join(", ")
            ));
        }
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

    // Download-Phase
    let stream_hash = match crate::commands::download::download_stream_in_directory(
        download_url,
        |u| validate_redirect_url(u).is_ok(),
        &cancel_flag_clone,
        &mut on_progress,
        DownloadStorage {
            max_bytes: MAX_DOWNLOAD_BYTES,
            directory: DownloadDirectoryBinding {
                file: &downloads_directory,
                identity: expected_downloads_identity,
            },
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
                MAX_DOWNLOAD_BYTES,
                &|p| p == extract_dest || p == extract_root,
                &cancel_for_extract,
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
        // Nur der Testpfad reicht `None` herein (die Produktion übergibt immer
        // `Some(...)` und läuft über `with_authorized_ge_install`). Der Zweig
        // prüft bewusst nur den statischen Scope; im Produktionsbuild ist er
        // nicht existent, damit ihn kein späterer Aufrufer versehentlich nutzt.
        #[cfg(test)]
        None => {
            if !scope_ok(&dest_canon) || !scope_ok(&root_canon_clone) {
                return Err("steam root outside allowed scope".into());
            }
            crate::commands::spawn_blocking_io(extract).await
        }
        #[cfg(not(test))]
        None => Err("ge install without environment authority".into()),
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
#[path = "ge_install_tests.rs"]
mod tests;
