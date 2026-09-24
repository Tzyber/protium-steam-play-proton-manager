use std::collections::HashMap;

use crate::commands::errcode;
use std::fs;
use std::future::Future;
use std::io;
#[cfg(test)]
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use sha2::{Digest, Sha512};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

/// initiale download-URL: https + github.com + pfad-pinning auf das GE-repo.
/// ohne das pinning wäre jede github.com-url ein download-ziel (cache-poisoning
/// → beliebiger payload → extraktion → code-execution). redirect-ziele prüft
/// `validate_redirect_url`, ein github.com-redirect wäre ein offener umweg.
pub(super) fn validate_download_url(url: &str) -> Result<(), String> {
    if url.contains('%') {
        return Err(errcode::INVALID_URL.into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid download URL: {e}"))?;
    validate_secure_url(&parsed)?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(errcode::INVALID_URL.into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "download URL has no host".to_string())?;
    if !host.eq_ignore_ascii_case("github.com") {
        return Err(errcode::with_detail(errcode::HOST_DISALLOWED, host));
    }

    // pfad-pinning: GE hostet seine assets selbst; ein anderer github-pfad ist
    // für protium nie legitim (browser_download_url ist immer diese form)
    const GE_PREFIX: [&str; 4] = [
        "GloriousEggroll",
        "proton-ge-custom",
        "releases",
        "download",
    ];
    let comps: Vec<&str> = parsed.path().split('/').collect();
    if comps.len() != DOWNLOAD_URL_PATH_SEGMENTS || !comps[0].is_empty() || comps[6].is_empty() {
        return Err(errcode::INVALID_URL.into());
    }
    let mut comps = comps.into_iter().skip(1);
    for expected in GE_PREFIX {
        match comps.next() {
            Some(c) if c == expected => {}
            _ => {
                return Err(
                    "download URL outside GloriousEggroll/proton-ge-custom/releases/download"
                        .into(),
                )
            }
        }
    }
    if comps.next().is_none() || comps.next().is_none() || comps.next().is_some() {
        return Err(errcode::INVALID_URL.into());
    }
    Ok(())
}

/// redirect-ziele: nur HTTPS auf den zwei asset-CDN-hosts (redirect-pfade sind
/// nicht steuerbar). github.com als redirect-ziel ausgeschlossen, sonst wäre
/// das pfad-pinning über einen redirect umgehbar.
pub(super) fn validate_redirect_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid redirect URL: {e}"))?;
    validate_secure_url(&parsed)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "redirect URL has no host".to_string())?;
    let host = host.to_ascii_lowercase();
    if host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com" {
        Ok(())
    } else {
        Err(errcode::with_detail(errcode::HOST_DISALLOWED, host))
    }
}

fn validate_secure_url(parsed: &reqwest::Url) -> Result<(), String> {
    if parsed.scheme() != "https" {
        return Err(errcode::UNALLOWED_SCHEME.into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(errcode::CREDENTIALS_DISALLOWED.into());
    }
    if parsed.port_or_known_default() != Some(443) {
        return Err(errcode::INVALID_URL.into());
    }
    Ok(())
}

/// je download-id ein frisches Signal. cancel_download setzt das flag und weckt
/// wartende Futures, damit SHA-Abrufe nicht bis zum Netzwerk-Timeout laufen.
#[derive(Debug)]
pub struct CancelSignal {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelSignal {
    pub(super) fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn cancel(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::Relaxed);
        // Ein Permit bleibt erhalten, falls Cancel zwischen Flag-Prüfung und
        // Registrierung des wartenden SHA-Futures eintrifft.
        self.notify.notify_one();
    }

    pub(super) async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

#[derive(Default)]
pub struct CancelRegistry(pub Mutex<HashMap<String, Arc<CancelSignal>>>);

/// maximale download-grösse (GE-tarballs ~1 GB, 8 GiB ist reichlich luft).
pub const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// pfadsegmentanzahl der release-asset-urls (owner/repo/releases/download/tag/asset).
const DOWNLOAD_URL_PATH_SEGMENTS: usize = 7;
const MAX_DOWNLOAD_ID_BYTES: usize = 128;

pub(super) fn validate_download_id(download_id: &str) -> Result<(), String> {
    if download_id.is_empty()
        || download_id.len() > MAX_DOWNLOAD_ID_BYTES
        || !download_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(errcode::INVALID_ID.into());
    }
    Ok(())
}

pub(super) fn register_download(
    registry: &CancelRegistry,
    download_id: &str,
) -> Result<Arc<CancelSignal>, String> {
    validate_download_id(download_id)?;
    let mut map = registry.0.lock().map_err(|e| e.to_string())?;
    if !map.is_empty() {
        return Err(errcode::DOWNLOAD_ACTIVE.into());
    }
    let cancel_flag = Arc::new(CancelSignal::new());
    map.insert(download_id.to_owned(), Arc::clone(&cancel_flag));
    Ok(cancel_flag)
}

/// einheitlicher client-bau: redirect-policy über callback, download_stream
/// injiziert seine testbare closure, fetch_sha512 die produktiv-allowlist.
/// redirect-ziel-prüfung liegt in validate_redirect_url (nur CDN-hosts,
/// github.com als redirect-ziel ausgeschlossen).
fn build_client(
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
) -> Result<reqwest::Client, String> {
    const MAX_REDIRECTS: usize = 5;

    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        if redirect_ok(attempt.url().as_str()) {
            attempt.follow()
        } else {
            attempt.error("redirect target not allowed")
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(std::time::Duration::from_secs(30))
        // ohne user-agent verweigert githubs edge (fastly) h2-streams
        // ("refused stream before processing any application logic")
        // intermittierend, daher die send-fehler nach retries/cancels
        .user_agent(concat!("protium/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// download-kern ohne tauri-typen (cargo-testbar). crash-fest: jeder fehlerausgang
/// (cancel, netzabbruch, schreibfehler) schließt den anonymen Descriptor vor return.
/// `max_bytes` steuert das grössenlimit (produktion: MAX_DOWNLOAD_BYTES, tests: kleiner).
#[cfg(test)]
pub(super) async fn download_stream(
    url: &str,
    dest: &str,
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
    cancel: &CancelSignal,
    on_progress: impl FnMut(u64, Option<u64>),
    max_bytes: u64,
) -> Result<DownloadedFile, String> {
    let parent = Path::new(dest)
        .parent()
        .ok_or_else(|| "download path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let directory = fs::File::open(parent).map_err(|e| e.to_string())?;
    let identity = file_identity(&directory).map_err(|e| e.to_string())?;
    download_stream_in_directory(
        url,
        redirect_ok,
        cancel,
        on_progress,
        DownloadStorage {
            max_bytes,
            directory: DownloadDirectoryBinding {
                file: &directory,
                identity,
            },
            #[cfg(test)]
            before_open: None,
        },
    )
    .await
}

pub(super) async fn download_stream_in_directory(
    url: &str,
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
    cancel: &CancelSignal,
    mut on_progress: impl FnMut(u64, Option<u64>),
    storage: DownloadStorage<'_>,
) -> Result<DownloadedFile, String> {
    let result: Result<DownloadedFile, String> = async {
        let client = build_client(redirect_ok)?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(errcode::with_detail(errcode::UNAVAILABLE, resp.status()));
        }

        // content-length-prüfung (server kann lügen, also zählt der streaming-loop
        // zusätzlich die tatsächlich geschriebenen bytes mit)
        if let Some(len) = resp.content_length() {
            if len > storage.max_bytes {
                return Err(errcode::SIZE_LIMIT.into());
            }
        }

        let std_file = open_anonymous_download_file(
            storage.directory,
            #[cfg(test)]
            storage.before_open,
        )
        .map_err(|e| e.to_string())?;
        let mut file = tokio::fs::File::from_std(std_file);
        let mut hasher = Sha512::new();
        let content_length = resp.content_length();
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();

        // stall-erkennung: jede next()-poll darf max. 120 s brauchen
        const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

        loop {
            // cancel weckt den body-read auch bei blockiertem stream aktiv auf
            // (select auf das notify-signal statt nur synchroner flag-check)
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(errcode::CANCELLED.to_owned()),
                result = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => {
                    result.map_err(|_| errcode::with_detail(errcode::INCOMPLETE, "download stalled"))?
                }
            };
            match chunk {
                None => break,
                Some(chunk) => {
                    let chunk = chunk.map_err(|e| e.to_string())?;

                    downloaded += chunk.len() as u64;
                    if downloaded > storage.max_bytes {
                        return Err(errcode::SIZE_LIMIT.into());
                    }

                    hasher.update(&chunk);
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    on_progress(downloaded, content_length);
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        let hash = crate::commands::fd::hex_lower(&hasher.finalize());
        Ok(DownloadedFile {
            hash,
            file: file.into_std().await,
        })
    }
    .await;

    result
}

#[derive(Debug)]
pub(super) struct DownloadedFile {
    pub(super) hash: String,
    pub(super) file: fs::File,
}

#[derive(Clone, Copy)]
pub(super) struct DownloadDirectoryBinding<'a> {
    pub(super) file: &'a fs::File,
    pub(super) identity: (u64, u64),
}

pub(super) struct DownloadStorage<'a> {
    pub(super) max_bytes: u64,
    pub(super) directory: DownloadDirectoryBinding<'a>,
    #[cfg(test)]
    pub(super) before_open: Option<&'a (dyn Fn() + Send + Sync)>,
}

#[cfg(target_os = "linux")]
fn open_anonymous_download_file(
    bound_directory: DownloadDirectoryBinding<'_>,
    #[cfg(test)] before_open: Option<&(dyn Fn() + Send + Sync)>,
) -> io::Result<fs::File> {
    let directory = bound_directory.file;
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bound download directory is not real",
        ));
    }
    if bound_directory.identity != file_identity(directory)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bound download directory identity changed",
        ));
    }
    #[cfg(test)]
    if let Some(before_open) = before_open {
        before_open();
    }
    open_anonymous_at(directory)
}

#[cfg(target_os = "linux")]
fn open_anonymous_at(directory: &fs::File) -> io::Result<fs::File> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::io::AsRawFd;
    let anonymous_raw = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
            0o600,
        )
    };
    if anonymous_raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from(OwnedFd::from_raw_fd(anonymous_raw)) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "anonymous download is not a regular file",
        ));
    }
    let _ = file_identity(&file)?;
    Ok(file)
}

#[cfg(not(target_os = "linux"))]
fn open_anonymous_download_file(
    _bound_directory: DownloadDirectoryBinding<'_>,
    #[cfg(test)] _before_open: Option<&(dyn Fn() + Send + Sync)>,
) -> io::Result<fs::File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "anonymous downloads require Linux O_TMPFILE",
    ))
}

#[cfg(unix)]
pub(super) fn file_identity(file: &fs::File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
pub(super) fn file_identity(file: &fs::File) -> io::Result<(u64, u64)> {
    let metadata = file.metadata()?;
    Ok((metadata.len(), 0))
}

#[cfg(unix)]
pub(super) fn metadata_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn metadata_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    Some((metadata.len(), 0))
}

/// markiert einen download zum abbruch; setzt das flag im aktuell registrierten Arc.
#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, CancelRegistry>, download_id: String) {
    if let Ok(map) = state.0.lock() {
        if let Some(flag) = map.get(&download_id) {
            flag.cancel();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Sha512FetchError {
    Http(u16),
    Cancelled,
    Failed(String),
}

pub(super) async fn select_with_cancel<F, T>(
    future: F,
    cancel: Arc<CancelSignal>,
) -> Result<T, Sha512FetchError>
where
    F: Future<Output = Result<T, Sha512FetchError>>,
{
    tokio::select! {
        result = future => result,
        _ = cancel.cancelled() => Err(Sha512FetchError::Cancelled),
    }
}

impl std::fmt::Display for Sha512FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(status) => write!(f, "HTTP {status}"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

pub(super) async fn fetch_sha512_text(
    url: &str,
    cancel: Arc<CancelSignal>,
) -> Result<String, Sha512FetchError> {
    validate_download_url(url).map_err(Sha512FetchError::Failed)?;

    let fut = async {
        let client =
            build_client(|u| validate_redirect_url(u).is_ok()).map_err(Sha512FetchError::Failed)?;
        let mut resp = client.get(url).send().await.map_err(|e| e.to_string());
        if resp.is_err() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            resp = client.get(url).send().await.map_err(|e| e.to_string());
        }
        let resp = resp.map_err(Sha512FetchError::Failed)?;
        if !resp.status().is_success() {
            return Err(Sha512FetchError::Http(resp.status().as_u16()));
        }
        if resp
            .content_length()
            .is_some_and(|len| len > MAX_HASH_BYTES as u64)
        {
            return Err(Sha512FetchError::Failed(
                "hash asset exceeds size limit".into(),
            ));
        }
        let body = collect_limited_body(resp.bytes_stream(), MAX_HASH_BYTES)
            .await
            .map_err(Sha512FetchError::Failed)?;
        String::from_utf8(body)
            .map_err(|e| Sha512FetchError::Failed(format!("hash asset is not UTF-8: {e}")))
    };
    select_with_cancel(
        async {
            tokio::time::timeout(std::time::Duration::from_secs(60), fut)
                .await
                .map_err(|_| Sha512FetchError::Failed("hash fetch timed out".into()))?
        },
        cancel,
    )
    .await
}

pub(super) const MAX_HASH_BYTES: usize = 64 * 1024;

async fn collect_limited_body<S, B, E>(stream: S, max_bytes: usize) -> Result<Vec<u8>, String>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    futures_util::pin_mut!(stream);
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let chunk = chunk.as_ref();
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "hash asset exceeds size limit".to_string())?;
        if next_len > max_bytes {
            return Err(errcode::SIZE_LIMIT.into());
        }
        body.extend_from_slice(chunk);
    }
    Ok(body)
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
