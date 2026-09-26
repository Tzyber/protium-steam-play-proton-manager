use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::download::{
    fetch_sha512_text, validate_download_id, validate_download_url, validate_redirect_url,
    CancelRegistry, CancelSignal, DownloadDirectoryBinding, DownloadStorage, Sha512FetchError,
    MAX_DOWNLOAD_BYTES,
};
use crate::commands::errcode;
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
        _ => Err(errcode::with_detail(errcode::UNSUPPORTED_ARCH, raw)),
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

/// Aufgelöste Zielorte einer GE-Installation (r-10): kanonischer Steam-Root,
/// Tool-Verzeichnis darunter und validierte Release-Identität.
struct GeInstallTargets {
    root_canon: PathBuf,
    tools_dir: PathBuf,
    identity: GeReleaseIdentity,
}

/// Ausführungskontext der Extraktion (r-18): die Produktion bindet immer die
/// autorisierte Umgebung, nur der Testlauf läuft ohne sie und prüft dann bloß
/// den statischen Scope. Als eigener Typ, damit der leere Zweig gar nicht erst
/// als erreichbarer Produktionsarm existiert.
pub(super) enum ExtractEnvironment {
    Authorized(crate::commands::scope::EnvironmentState),
    #[cfg(test)]
    StaticScopeOnly,
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
    let parsed = reqwest::Url::parse(url).map_err(|error| {
        errcode::with_detail(
            errcode::INVALID_URL,
            format!("invalid release URL: {error}"),
        )
    })?;
    let expected_path =
        format!("/GloriousEggroll/proton-ge-custom/releases/download/{release_tag}/{asset_name}");
    if parsed.path() != expected_path {
        return Err(errcode::INVALID_URL.into());
    }
    Ok(())
}

pub(super) fn validate_release_identity(
    target_arch: TargetArch,
    release_tag: &str,
    download_url: &str,
) -> Result<GeReleaseIdentity, String> {
    if release_version(release_tag).is_none() {
        return Err(errcode::with_detail(errcode::INVALID_ID, "release tag"));
    }
    let parsed = reqwest::Url::parse(download_url).map_err(|error| {
        errcode::with_detail(
            errcode::INVALID_URL,
            format!("invalid download URL: {error}"),
        )
    })?;
    let asset_name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .ok_or_else(|| {
            errcode::with_detail(errcode::INVALID_URL, "download URL has no asset name")
        })?;
    let current_name = format!("{release_tag}-{}.tar.gz", target_arch.as_str());
    let legacy_name = format!("{release_tag}.tar.gz");
    let allowed = asset_name == current_name
        || (target_arch == TargetArch::X86_64
            && is_legacy_release(release_tag)
            && asset_name == legacy_name);
    if !allowed {
        return Err(errcode::with_detail(
            errcode::UNSUPPORTED_ARCH,
            format!(
                "asset {asset_name} is not authorized for target architecture {}",
                target_arch.as_str()
            ),
        ));
    }
    exact_release_url(download_url, release_tag, asset_name)?;
    let install_name = asset_name
        .strip_suffix(".tar.gz")
        .ok_or_else(|| {
            errcode::with_detail(errcode::INVALID_ID, "download asset must end in .tar.gz")
        })?
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
        return Err(errcode::CANCELLED.into());
    }
    Ok(())
}

/// r-13: die cancel-prüfung lebt nur in `cancel_before_extract`; diese Hülle
/// nennt nur den zeitpunkt (vor der extraktion) und reicht das ergebnis durch.
fn extract_after_cancel_check<T>(
    cancel: &CancelSignal,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    cancel_before_extract(cancel)?;
    operation()
}

/// r-09: ein extract-fehler, der bereits einen kanonischen code traegt
/// (cancelled, tool-already-exists, size-limit-exceeded, symlink-rejected,
/// blocked-location), muss unveraendert durchgereicht werden; sonst zeigt die
/// oberflaeche fuer einen abbruch "unavailable". nur echte restfehler werden
/// zu UNAVAILABLE mit detail.
fn extract_error_with_code(error: String) -> String {
    if errcode::has_known_code(&error) {
        error
    } else {
        errcode::with_detail(errcode::UNAVAILABLE, error)
    }
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Länge eines SHA512-Hex-Digests in Zeichen (r-11: 128 war ein Literal).
const SHA512_HEX_LEN: usize = 128;

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
        if hash.len() == SHA512_HEX_LEN && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err(errcode::with_detail(
        errcode::CHECKSUM_FAILED,
        format!("no valid sha512 checksum line for asset {expected_asset}"),
    ))
}

/// Lesepuffer des Diskhash: 64 KiB hält die Syscall-Zahl klein, ohne den
/// Blocking-Task-Speicher zu sprengen (r-11: die Größe war ein Literal).
const HASH_READ_BUF_BYTES: usize = 64 * 1024;

/// Verifiziert, dass die Datei auf Disk tatsächlich den erwarteten SHA512 erzeugt
/// (Schutz vor Hash-Swap / TOCTOU).
pub(super) fn verify_file_hash_on_disk(
    file: &mut fs::File,
    expected_hash: &str,
    cancel: &CancelSignal,
) -> Result<(), String> {
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("seek downloaded file: {error}"),
        )
    })?;
    let mut hasher = Sha512::new();
    let mut buf = [0u8; HASH_READ_BUF_BYTES];
    loop {
        if cancel.is_cancelled() {
            return Err(errcode::CANCELLED.into());
        }
        let n = file.read(&mut buf).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("read downloaded file: {error}"),
            )
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = crate::commands::fd::hex_lower(&hasher.finalize());
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("rewind downloaded file: {error}"),
        )
    })?;
    if actual != expected_hash {
        return Err(errcode::with_detail(
            errcode::CHECKSUM_FAILED,
            format!(
                "hash swap detected: disk hash ({actual}) does not match expected ({expected_hash})"
            ),
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
    environment: ExtractEnvironment,
) -> Result<InstallGeResult, String> {
    let GeInstallTargets {
        root_canon,
        tools_dir,
        identity,
    } = resolve_ge_install_targets(
        steam_root,
        target_arch,
        release_tag,
        download_url,
        download_id,
        scope_ok,
    )?;
    let (downloads_directory, expected_downloads_identity) = open_downloads_directory(cache_dir)?;
    let cancel_flag_clone = Arc::clone(&cancel_flag);

    // Download-Phase
    let stream_hash = crate::commands::download::download_stream_in_directory(
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
    .await?;

    let downloaded_file = stream_hash.file;
    let stream_hash = stream_hash.hash;
    cancel_before_extract(&cancel_flag)?;

    on_phase("verifying", false);

    let (result_status, mut downloaded_file) = verify_downloaded_artifact(
        downloaded_file,
        stream_hash,
        release_tag,
        &identity,
        &cancel_flag,
        confirm_unverified,
    )
    .await?;

    cancel_before_extract(&cancel_flag)?;

    on_phase("extracting", result_status == InstallGeResult::Verified);

    // extraktions-phase (r-18 clone-stand): tools_dir geht in zwei formen in
    // die closure (string als dest_dir, pfad fuer den scope-closure-vergleich),
    // root_canon und install_name je in einer; die originale bleiben fuer die
    // autorisierte umgebung.
    let tools_dir_str = tools_dir.to_string_lossy().to_string();
    let install_name = identity.install_name.clone();
    let extract_dest = tools_dir.clone();
    let extract_root = root_canon.clone();

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
        ExtractEnvironment::Authorized(environment) => {
            crate::commands::spawn_blocking_io(move || {
                environment.with_authorized_ge_install(&root_canon, &tools_dir, extract)
            })
            .await
        }
        // Nur der Testpfad erreicht diesen Arm; der Zweig prüft bewusst nur den
        // statischen Scope. Er existiert im Produktionsbuild nicht (r-18).
        #[cfg(test)]
        ExtractEnvironment::StaticScopeOnly => {
            if !scope_ok(&tools_dir) || !scope_ok(&root_canon) {
                return Err(errcode::BLOCKED_LOCATION.into());
            }
            crate::commands::spawn_blocking_io(extract).await
        }
    };

    match extract_res {
        Ok((extract_result, _downloaded_file)) => match extract_result {
            Ok(_) => Ok(result_status),
            Err(error) => Err(extract_error_with_code(error)),
        },
        Err(error) => Err(error),
    }
}

// Die Phasen von `install_ge_proton_inner`: je ein zusammenhängender Block aus
// demselben Code mit denselben Rückgaben und derselben Fehlerreihenfolge (r-10).

/// Phase „Ziele": validiert Release-Identität und Scope, prüft Crash-Reste und
/// den Zielkonflikt und legt Root und Tool-Verzeichnis fest.
fn resolve_ge_install_targets(
    steam_root: &str,
    target_arch: TargetArch,
    release_tag: &str,
    download_url: &str,
    download_id: &str,
    scope_ok: &(dyn Fn(&Path) -> bool + Send + Sync),
) -> Result<GeInstallTargets, String> {
    sanitize_path(steam_root, "steam root")?;
    let identity = validate_release_identity(target_arch, release_tag, download_url)?;
    validate_download_id(download_id)?;

    let root_canon = fs::canonicalize(steam_root).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("steam root canonicalize: {error}"),
        )
    })?;
    let tools_dir = root_canon.join("compatibilitytools.d");
    if !scope_ok(&tools_dir) || !scope_ok(&root_canon) {
        return Err(errcode::BLOCKED_LOCATION.into());
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
            return Err(errcode::with_detail(
                errcode::INCOMPLETE,
                format!(
                    "incomplete extraction leftovers found: {}; remove them manually",
                    leftovers.join(", ")
                ),
            ));
        }
    }

    let final_target = tools_dir.join(&identity.install_name);
    if final_target.exists() {
        return Err(errcode::with_detail(
            errcode::TOOL_EXISTS,
            "target directory",
        ));
    }

    Ok(GeInstallTargets {
        root_canon,
        tools_dir,
        identity,
    })
}

/// Phase „Download-Verzeichnis": bindet `<cache>/downloads` an die festgehaltene
/// Identität, damit der anonyme Download-Descriptor nicht in einen
/// ausgetauschten Ordner schreibt.
fn open_downloads_directory(cache_dir: &Path) -> Result<(fs::File, (u64, u64)), String> {
    fs::create_dir_all(cache_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("create app cache dir: {error}"),
        )
    })?;
    let cache_canon = fs::canonicalize(cache_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("app cache canonicalize: {error}"),
        )
    })?;
    let downloads_dir = cache_canon.join("downloads");
    fs::create_dir_all(&downloads_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("create downloads dir: {error}"),
        )
    })?;
    let downloads_dir = fs::canonicalize(&downloads_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("downloads dir canonicalize: {error}"),
        )
    })?;
    if !is_descendant_of(&downloads_dir, &cache_canon) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }
    let downloads_metadata = fs::symlink_metadata(&downloads_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("stat canonical downloads dir: {error}"),
        )
    })?;
    if downloads_metadata.file_type().is_symlink() || !downloads_metadata.is_dir() {
        return Err(errcode::NOT_A_DIRECTORY.into());
    }
    let expected_identity = crate::commands::download::metadata_identity(&downloads_metadata)
        .ok_or_else(|| {
            errcode::with_detail(
                errcode::UNAVAILABLE,
                "canonical downloads directory has no identity",
            )
        })?;
    #[cfg(target_os = "linux")]
    let directory = {
        // r-13: dieselbe no-follow-open-kette wie fd::open_absolute_dir statt
        // eines dritten handgeschriebenen libc::open.
        let fd = crate::commands::fd::open_absolute_dir(&downloads_dir).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("open downloads directory: {error}"),
            )
        })?;
        fs::File::from(fd)
    };
    #[cfg(not(target_os = "linux"))]
    let directory = fs::File::open(&downloads_dir).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("open downloads directory: {error}"),
        )
    })?;
    Ok((directory, expected_identity))
}

/// Phase „Verify": holt die Prüfsumme, vergleicht sie mit dem Stream-Hash und
/// liest die Datei zur Kontrolle vollständig von Disk (Hash-Swap/TOCTOU). Gibt
/// den Status und den an den Anfang zurückgesetzten Handle zurück.
async fn verify_downloaded_artifact(
    mut downloaded_file: fs::File,
    stream_hash: String,
    release_tag: &str,
    identity: &GeReleaseIdentity,
    cancel_flag: &Arc<CancelSignal>,
    confirm_unverified: impl FnMut(UnverifiedConfirmationRequest) -> Result<bool, String>,
) -> Result<(InstallGeResult, fs::File), String> {
    // Die Checksum-URL wird aus der backendvalidierten Release-Identität abgeleitet.
    let checksum_url = checksum_url(release_tag, identity);
    let result_status = match fetch_sha512_text(&checksum_url, Arc::clone(cancel_flag)).await {
        Ok(hash_text) => {
            let expected_hash = parse_sha512_hash(&hash_text, &identity.checksum_asset_name)?;
            if cancel_flag.is_cancelled() {
                return Err(errcode::CANCELLED.into());
            }
            if stream_hash.to_ascii_lowercase() != expected_hash {
                return Err(errcode::with_detail(
                    errcode::CHECKSUM_FAILED,
                    format!(
                        "SHA512 hash mismatch: stream ({stream_hash}) != expected ({expected_hash})"
                    ),
                ));
            }

            // Der Voll-Read der 1-2-GB-Datei läuft blocking: spawn_blocking,
            // sonst stallen cancel und phasen-events bis der hash fertig ist.
            let cancel_for_verify = Arc::clone(cancel_flag);
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
            let confirmed = confirm_unverified_installation(
                release_tag,
                &identity.install_name,
                &checksum_url,
                confirm_unverified,
            )
            .map_err(|error| {
                errcode::with_detail(
                    errcode::UNAVAILABLE,
                    format!("unverified installation confirmation failed: {error}"),
                )
            })?;
            if !confirmed {
                return Err(errcode::UNVERIFIED_REJECTED.into());
            }
            InstallGeResult::Unverified
        }
        Err(Sha512FetchError::Cancelled) => {
            return Err(errcode::CANCELLED.into());
        }
        Err(error) => {
            return Err(errcode::with_detail(errcode::CHECKSUM_FAILED, error));
        }
    };
    Ok((result_status, downloaded_file))
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

/// Progress-Events erst nach diesem Byte-Fortschritt: ein Emit pro Chunk
/// würde die IPC fluten (r-11: die Schwelle war ein Literal).
const PROGRESS_EMIT_STEP_BYTES: u64 = 1_000_000;

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
    let cache_dir = app.path().app_cache_dir().map_err(|error| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            format!("cannot resolve app cache dir: {error}"),
        )
    })?;

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
            if downloaded - last_emit >= PROGRESS_EMIT_STEP_BYTES || done {
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
        ExtractEnvironment::Authorized(environment.inner().clone()),
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
