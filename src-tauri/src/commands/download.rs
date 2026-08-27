use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io;
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
        return Err("download URL must not use percent-encoding".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid download URL: {e}"))?;
    validate_secure_url(&parsed)?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("download URL must not contain query or fragment".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "download URL has no host".to_string())?;
    if !host.eq_ignore_ascii_case("github.com") {
        return Err(format!("download URL host not allowed: {host}"));
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
        return Err("download URL must contain exactly one release asset path".into());
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
        return Err("download URL must contain exactly one release asset path".into());
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
        Err(format!("redirect target host not allowed: {host}"))
    }
}

fn validate_secure_url(parsed: &reqwest::Url) -> Result<(), String> {
    if parsed.scheme() != "https" {
        return Err("only HTTPS URLs allowed".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".into());
    }
    if parsed.port_or_known_default() != Some(443) {
        return Err("HTTPS URL must use the default port".into());
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
        return Err("invalid download id".into());
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
        return Err("another download is already active".into());
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
    is_cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(u64, Option<u64>),
    max_bytes: u64,
) -> Result<DownloadedFile, String> {
    download_stream_in_directory(
        url,
        dest,
        redirect_ok,
        is_cancelled,
        on_progress,
        DownloadStorage {
            max_bytes,
            directory: None,
            #[cfg(test)]
            before_open: None,
        },
    )
    .await
}

pub(super) async fn download_stream_in_directory(
    url: &str,
    dest: &str,
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
    storage: DownloadStorage<'_>,
) -> Result<DownloadedFile, String> {
    let result: Result<DownloadedFile, String> = async {
        let client = build_client(redirect_ok)?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        // content-length-prüfung (server kann lügen, also zählt der streaming-loop
        // zusätzlich die tatsächlich geschriebenen bytes mit)
        if let Some(len) = resp.content_length() {
            if len > storage.max_bytes {
                return Err("content-length exceeds download size limit".into());
            }
        }

        if storage.directory.is_none() {
            if let Some(parent) = Path::new(dest).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
        }
        let std_file = open_anonymous_download_file(
            Path::new(dest),
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
            let chunk = tokio::time::timeout(STALL_TIMEOUT, stream.next())
                .await
                .map_err(|_| "download stalled".to_string())?;
            match chunk {
                None => break,
                Some(chunk) => {
                    if is_cancelled() {
                        return Err("cancelled".into());
                    }
                    let chunk = chunk.map_err(|e| e.to_string())?;

                    downloaded += chunk.len() as u64;
                    if downloaded > storage.max_bytes {
                        return Err("download size limit exceeded".into());
                    }

                    hasher.update(&chunk);
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    on_progress(downloaded, content_length);
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        let hash = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
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
    pub(super) directory: Option<DownloadDirectoryBinding<'a>>,
    #[cfg(test)]
    pub(super) before_open: Option<&'a (dyn Fn() + Send + Sync)>,
}

#[cfg(target_os = "linux")]
fn open_anonymous_download_file(
    path: &Path,
    bound_directory: Option<DownloadDirectoryBinding<'_>>,
    #[cfg(test)] before_open: Option<&(dyn Fn() + Send + Sync)>,
) -> io::Result<fs::File> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    if let Some(binding) = bound_directory {
        let directory = binding.file;
        if !directory.metadata()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bound download directory is not real",
            ));
        }
        if binding.identity != file_identity(directory)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bound download directory identity changed",
            ));
        }
        #[cfg(test)]
        if let Some(before_open) = before_open {
            before_open();
        }
        return open_anonymous_at(directory);
    }

    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "download path has no parent")
    })?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "download directory is not a real directory",
        ));
    }
    let canonical_parent = fs::canonicalize(parent)?;
    let canonical_metadata = fs::metadata(&canonical_parent)?;
    #[cfg(test)]
    if let Some(before_open) = before_open {
        before_open();
    }
    let mut parent_bytes = canonical_parent.as_os_str().as_bytes().to_vec();
    parent_bytes.push(0);
    let dir_raw = unsafe {
        libc::open(
            parent_bytes.as_ptr().cast(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if dir_raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let directory = unsafe { fs::File::from(OwnedFd::from_raw_fd(dir_raw)) };
    if !directory.metadata()?.is_dir()
        || Some(file_identity(&directory)?) != metadata_identity(&canonical_metadata)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "download directory identity changed",
        ));
    }

    open_anonymous_at(&directory)
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
    _path: &Path,
    _bound_directory: Option<DownloadDirectoryBinding<'_>>,
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
            return Err("hash asset exceeds size limit".into());
        }
        body.extend_from_slice(chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_limited_body, download_stream, fetch_sha512_text, register_download,
        select_with_cancel, validate_download_id, validate_download_url, validate_redirect_url,
        CancelRegistry, CancelSignal, DownloadDirectoryBinding, DownloadStorage, Sha512FetchError,
        MAX_DOWNLOAD_BYTES, MAX_HASH_BYTES,
    };
    use crate::commands::path::random_suffix;
    use futures_util::stream;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    #[cfg(target_os = "linux")]
    #[test]
    fn anonymous_download_nutzt_tmpfile_ohne_unlink_naht() {
        let source = include_str!("download.rs");
        assert!(source.contains("libc::O_TMPFILE"));
        assert!(source.contains("libc::openat"));
    }

    #[test]
    fn download_id_ist_begrenzt_und_ascii_sicher() {
        assert!(validate_download_id("GE-Proton10-1").is_ok());
        assert!(validate_download_id("").is_err());
        assert!(validate_download_id("../escape").is_err());
        assert!(validate_download_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn registry_erlaubt_nur_einen_aktiven_download() {
        let registry = CancelRegistry::default();
        assert!(register_download(&registry, "GE-Proton10-1").is_ok());
        assert_eq!(
            register_download(&registry, "GE-Proton10-2").unwrap_err(),
            "another download is already active",
        );
    }

    #[test]
    fn download_url_rejects_http() {
        assert!(validate_download_url(
            "http://github.com/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz"
        )
        .is_err());
        assert!(validate_download_url("HTTP://example.com/file").is_err());
    }

    #[test]
    fn download_url_rejects_credentials() {
        assert!(validate_download_url("https://user:pass@github.com/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com@evil.com/f").is_err());
    }

    #[test]
    fn download_url_rejects_other_domains() {
        assert!(validate_download_url("https://evil.com/payload.tar.gz").is_err());
        assert!(validate_download_url("https://objects.githubusercontent.com.evil.com/f").is_err());
    }

    #[test]
    fn download_url_allows_ge_release_path() {
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz").is_ok());
        assert!(validate_download_url("https://github.com:443/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz").is_ok());
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz?x=1").is_err());
    }

    #[test]
    fn download_url_identity_rejects_query_fragment_encoding_and_extra_segments() {
        let base = "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz";
        for suffix in ["?x=1", "#fragment", "/extra"] {
            assert!(
                validate_download_url(&format!("{base}{suffix}")).is_err(),
                "suffix {suffix:?} muss scheitern"
            );
        }
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton%39-27/GE-Proton9-27.tar.gz").is_err());
    }

    #[test]
    fn download_url_rejects_non_default_port() {
        assert!(validate_download_url(
            "https://github.com:8443/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz"
        )
        .is_err());
    }

    #[test]
    fn download_url_pins_ge_repo_path() {
        // cache-poisoning-kette: jede github.com-url wäre sonst ein download-ziel
        assert!(validate_download_url(
            "https://github.com/attacker/evil/releases/download/1/payload.tar.gz"
        )
        .is_err());
        assert!(validate_download_url(
            "https://github.com/GloriousEggroll/other/releases/download/1/f.tar.gz"
        )
        .is_err());
        assert!(validate_download_url(
            "https://github.com/GloriousEggroll/proton-ge-custom/archive/refs/tags/v1.tar.gz"
        )
        .is_err());
    }

    #[test]
    fn download_url_rejects_cdn_hosts_as_initial_url() {
        // CDN-hosts sind nur redirect-ziele, nie initiale URLs
        assert!(validate_download_url(
            "https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz"
        )
        .is_err());
        assert!(validate_download_url("https://release-assets.githubusercontent.com/github-production-release-asset-2e/f.tar.gz?jwt=abc").is_err());
    }

    #[test]
    fn redirect_url_allows_cdn_hosts() {
        assert!(validate_redirect_url(
            "https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz"
        )
        .is_ok());
        assert!(validate_redirect_url(
            "https://objects.githubusercontent.com:443/github-production-release-asset-2e/f.tar.gz"
        )
        .is_ok());
        assert!(validate_redirect_url(
            "https://release-assets.githubusercontent.com/x?jwt=abc@def"
        )
        .is_ok());
    }

    #[test]
    fn redirect_url_rejects_http_credentials_and_non_default_port() {
        assert!(validate_redirect_url("http://objects.githubusercontent.com/f").is_err());
        assert!(
            validate_redirect_url("https://user:pass@objects.githubusercontent.com/f").is_err()
        );
        assert!(validate_redirect_url("https://objects.githubusercontent.com:8443/f").is_err());
    }

    #[test]
    fn redirect_url_rejects_github_and_others() {
        // github.com als redirect-ziel wäre ein umweg um das pfad-pinning
        assert!(validate_redirect_url(
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz"
        )
        .is_err());
        assert!(validate_redirect_url("https://evil.com/f").is_err());
    }

    #[test]
    fn download_url_rejects_no_host() {
        assert!(validate_download_url("https:///path").is_err());
    }

    // ---- download-stream redirect-policy tests ----

    /// HTTP-stub: kündigt `announce` bytes an, sendet nur `send`.
    /// send < announce simuliert einen netzabbruch (vorzeitiger EOF).
    fn serve_once(announce: usize, send: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf); // request ignorieren
                let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {announce}\r\n\r\n");
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&vec![0xABu8; send]);
                // bei send < announce: stream wird hier gedroppt → client sieht EOF zu früh
            }
        });
        format!("http://{addr}/")
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-dltest-{tag}-{}", std::process::id()));
        p.push("file.bin");
        p
    }

    /// HTTP-stub mit redirects: baut eine kette von antworten auf.
    /// jeder eintrag = (status_code, location, body). der stub akzeptiert
    /// nacheinander verbindungen und serviert die antworten in der vorgegebenen
    /// reihenfolge. die URL wird erst beim bind ermittelt und per closure
    /// an die response-kette übergeben (chicken-egg-problem).
    fn serve_redirect_chain(
        f: impl FnOnce(String) -> Vec<(u16, Option<String>, Option<Vec<u8>>)>,
    ) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}/");
        let chain = f(base.clone());
        std::thread::spawn(move || {
            for (status, location, body) in chain {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf);
                    let reason = if status == 302 { "Found" } else { "OK" };
                    let mut header = format!("HTTP/1.1 {status} {reason}\r\n");
                    if let Some(ref loc) = location {
                        header.push_str(&format!("Location: {}\r\n", loc));
                    }
                    if status == 302 {
                        header.push_str("Connection: close\r\n");
                    }
                    if let Some(ref b) = body {
                        header.push_str(&format!("Content-Length: {}\r\n", b.len()));
                    } else {
                        header.push_str("Content-Length: 0\r\n");
                    }
                    header.push_str("\r\n");
                    let _ = stream.write_all(header.as_bytes());
                    if let Some(ref b) = body {
                        let _ = stream.write_all(b);
                    }
                }
            }
        });
        base
    }

    #[tokio::test]
    async fn erfolg_berechnet_hash_und_behaelt_datei() {
        let dest = tmp("ok");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_ok(), "sollte erfolgreich sein: {res:?}");
        let artifact = res.unwrap();
        assert_eq!(artifact.hash.len(), 128); // sha512 hex = 128 zeichen
        assert!(artifact.file.metadata().unwrap().is_file());
        assert!(!dest.exists(), "erfolgsfall: downloadpfad muss anonym sein");
        drop(artifact);
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn netzabbruch_raeumt_partielle_datei_auf() {
        let dest = tmp("net");
        let url = serve_once(1_000_000, 4096); // 1MB angekündigt, nur 4KB gesendet
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_err(), "vorzeitiger EOF muss fehler sein");
        assert!(!dest.exists(), "partielle datei muss weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn cancel_stoppt_und_raeumt_auf() {
        let dest = tmp("cancel");
        let url = serve_once(32, 32);
        let cancel = AtomicBool::new(true); // sofort gesetzt → bricht beim ersten chunk ab
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert_eq!(res.unwrap_err(), "cancelled");
        assert!(!dest.exists(), "abbruch: keine datei zurücklassen");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn guessed_symlink_bleibt_unberuehrt() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "protium-dltest-symlink-{}-{}",
            std::process::id(),
            random_suffix()
        ));
        let dest = root.join("download.tar.gz");
        let outside = root.join("outside.bin");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"unchanged").unwrap();
        symlink(&outside, &dest).unwrap();

        let url = serve_once(32, 32);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || false,
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(
            res.is_ok(),
            "der guessed-name darf den anonymen download nicht blockieren"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"unchanged");
        assert!(std::fs::symlink_metadata(&dest)
            .unwrap()
            .file_type()
            .is_symlink());
        drop(res);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cache_dir_symlink_wird_fail_closed_abgelehnt() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "protium-dltest-cache-symlink-{}-{}",
            std::process::id(),
            random_suffix()
        ));
        let real = root.join("real");
        let alias = root.join("alias");
        std::fs::create_dir_all(&real).unwrap();
        symlink(&real, &alias).unwrap();
        let dest = alias.join("guessed.tar.gz");
        let url = serve_once(32, 32);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || false,
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_err(), "symlink-cache-dir muss fail-closed bleiben");
        assert!(!real.join("guessed.tar.gz").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn directory_swap_zwischen_identity_capture_und_open_scheitert_vor_tmpfile() {
        let root = std::env::temp_dir().join(format!(
            "protium-dltest-directory-swap-{}-{}",
            std::process::id(),
            random_suffix()
        ));
        let visible = root.join("downloads");
        let moved = root.join("moved");
        let destination = visible.join("download.tar.gz");
        std::fs::create_dir_all(&visible).unwrap();
        std::fs::write(visible.join("original-marker"), b"original").unwrap();

        let hook = || {
            std::fs::rename(&visible, &moved).unwrap();
            std::fs::create_dir(&visible).unwrap();
            std::fs::write(visible.join("replacement-marker"), b"replacement").unwrap();
        };
        let url = serve_once(32, 32);
        let result = super::download_stream_in_directory(
            &url,
            destination.to_str().unwrap(),
            |_| true,
            || false,
            |_, _| {},
            DownloadStorage {
                max_bytes: MAX_DOWNLOAD_BYTES,
                directory: None,
                before_open: Some(&hook),
            },
        )
        .await;

        assert!(
            result
                .as_ref()
                .unwrap_err()
                .contains("download directory identity changed"),
            "directory swap muss vor O_TMPFILE fail-closed abbrechen: {result:?}"
        );
        assert_eq!(
            std::fs::read(moved.join("original-marker")).unwrap(),
            b"original"
        );
        assert_eq!(
            std::fs::read(visible.join("replacement-marker")).unwrap(),
            b"replacement"
        );
        assert!(
            !destination.exists(),
            "fremder sichtbarer pfad darf leer bleiben"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn gebundener_directory_fd_bleibt_bei_sichtbarem_symlink_swap_autoritaet() {
        use std::io::{Read, Seek, SeekFrom};
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "protium-dltest-bound-directory-swap-{}-{}",
            std::process::id(),
            random_suffix()
        ));
        let visible = root.join("downloads");
        let moved = root.join("moved");
        let foreign = root.join("foreign");
        let destination = visible.join("download.tar.gz");
        std::fs::create_dir_all(&visible).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("foreign-marker"), b"untouched").unwrap();
        let directory = std::fs::File::open(&visible).unwrap();
        let identity = super::file_identity(&directory).unwrap();

        let hook = || {
            std::fs::rename(&visible, &moved).unwrap();
            symlink(&foreign, &visible).unwrap();
        };
        let url = serve_once(32, 32);
        let mut artifact = super::download_stream_in_directory(
            &url,
            destination.to_str().unwrap(),
            |_| true,
            || false,
            |_, _| {},
            DownloadStorage {
                max_bytes: MAX_DOWNLOAD_BYTES,
                directory: Some(DownloadDirectoryBinding {
                    file: &directory,
                    identity,
                }),
                before_open: Some(&hook),
            },
        )
        .await
        .expect("gebundener directory-fd muss trotz sichtbarem swap funktionieren");

        artifact.file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        artifact.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, vec![0xAB; 32]);
        assert!(
            !destination.exists(),
            "sichtbarer fremdpfad darf kein ziel erhalten"
        );
        assert_eq!(
            std::fs::read(foreign.join("foreign-marker")).unwrap(),
            b"untouched"
        );
        assert!(std::fs::symlink_metadata(&visible)
            .unwrap()
            .file_type()
            .is_symlink());
        drop(artifact);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn derselbe_download_handle_bleibt_nach_pfad_swap_verfügbar() {
        let root =
            std::env::temp_dir().join(format!("protium-dltest-handle-{}", std::process::id()));
        let dest = root.join("download.tar.gz");
        std::fs::create_dir_all(&root).unwrap();
        let url = serve_once(32, 32);
        let mut artifact = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || false,
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await
        .unwrap();
        assert!(!dest.exists(), "anonymer handle darf keinen pfad behalten");
        std::fs::write(&dest, b"attacker bytes").unwrap();
        use std::io::{Read, Seek, SeekFrom};
        artifact.file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        artifact.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, vec![0xAB; 32]);
        assert_eq!(artifact.hash.len(), 128);
        drop(artifact.file);
        assert_eq!(std::fs::read(&dest).unwrap(), b"attacker bytes");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancel_weckt_blockierten_sha_future_aktiv_auf() {
        let cancel = Arc::new(CancelSignal::new());
        let future = select_with_cancel(
            async { std::future::pending::<Result<(), Sha512FetchError>>().await },
            Arc::clone(&cancel),
        );
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_millis(100), future)
            .await
            .expect("cancel muss die blockierte sha-naht aufwecken")
            .unwrap_err();
        assert_eq!(result, Sha512FetchError::Cancelled);
    }

    // ---- cancel-registry stale-signal tests (Arc + ptr_eq) ----

    #[test]
    fn cancel_registry_ptr_eq_entfernt_nur_eigenes_flag() {
        let registry = CancelRegistry::default();

        // erstes Arc registrieren (simuliert download_file-start)
        let flag1 = Arc::new(CancelSignal::new());
        registry
            .0
            .lock()
            .unwrap()
            .insert("x".into(), Arc::clone(&flag1));

        // ptr_eq muss für eigenes Arc zutreffen
        assert!(
            registry
                .0
                .lock()
                .unwrap()
                .get("x")
                .map(|r| Arc::ptr_eq(r, &flag1))
                .unwrap_or(false),
            "eigenes Arc muss per ptr_eq matchen"
        );

        // cleanup: entfernen weil ptr_eq matched
        {
            let mut map = registry.0.lock().unwrap();
            let keep = map
                .get("x")
                .map(|r| Arc::ptr_eq(r, &flag1))
                .unwrap_or(false);
            if keep {
                map.remove("x");
            }
        }
        assert!(registry.0.lock().unwrap().is_empty());

        // zweiter download: neues Arc (simuliert re-download)
        let flag2 = Arc::new(CancelSignal::new());
        registry
            .0
            .lock()
            .unwrap()
            .insert("x".into(), Arc::clone(&flag2));

        // altes flag1 darf NICHT mit dem neuen eintrag ptr_eq matchen
        let mismatch = registry
            .0
            .lock()
            .unwrap()
            .get("x")
            .map(|r| !Arc::ptr_eq(r, &flag1))
            .unwrap_or(false);
        assert!(mismatch, "altes Arc darf nicht auf neuen eintrag matchen");

        // neues flag muss frisch (false) sein, kein stale cancel
        assert!(
            !flag2.is_cancelled(),
            "neues flag darf nicht vorbelastet sein"
        );
    }

    #[tokio::test]
    async fn cancel_nach_abschluss_startet_zweiten_download_normal() {
        let dest1 = tmp("stale-1");
        let url1 = serve_once(32, 32);
        let cancel = AtomicBool::new(false);

        let res = download_stream(
            &url1,
            dest1.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(res.is_ok(), "erster download muss ok sein: {res:?}");
        let _ = std::fs::remove_dir_all(dest1.parent().unwrap());

        // simulate late cancel (nach abschluss), cancel-flag bleibt false
        // (die registry hätte den eintrag bereits entfernt)

        // zweiter download mit anderer url startet normal
        let dest2 = tmp("stale-2");
        let url2 = serve_once(32, 32);
        let res2 = download_stream(
            &url2,
            dest2.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(
            res2.is_ok(),
            "zweiter download muss normal starten: {res2:?}"
        );
        let _ = std::fs::remove_dir_all(dest2.parent().unwrap());
    }

    // ---- download size-cap und stall-timeout ----

    #[tokio::test]
    async fn content_length_ueber_limit_wird_abgelehnt() {
        let dest = tmp("sizecap-cl");
        // stub kündigt 9999 bytes an → über dem test-limit von 100
        let url = serve_once(9999, 0);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            100, // kleines test-limit
        )
        .await;
        assert!(
            res.is_err(),
            "content-length über limit muss Err liefern: {res:?}"
        );
        assert!(
            res.as_ref().unwrap_err().contains("content-length"),
            "fehler soll content-length nennen: {res:?}"
        );
        assert!(
            !dest.exists(),
            "keine datei bei content-length-überschreitung"
        );
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn bytes_ueber_limit_raeumt_partielle_datei_auf() {
        let dest = tmp("sizecap-bytes");
        // stub kündigt 16 bytes an, sendet 32, ohne content-length-check
        // greift der byte-counter im streaming-loop (limit = 8)
        let url = serve_once(16, 32);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            8, // kleines test-limit
        )
        .await;
        assert!(res.is_err(), "bytes über limit muss Err liefern: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("size limit"),
            "fehler soll size-limit nennen: {res:?}"
        );
        assert!(!dest.exists(), "partielle datei muss weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_erlaubt_folgt_302_und_liefert_inhalt() {
        let dest = tmp("redirect-ok");
        let body = vec![0xAB; 32];
        let url = serve_redirect_chain(|base| {
            vec![
                (302, Some(base.clone()), None),
                (200, None, Some(body.clone())),
            ]
        });
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |u| u.starts_with("http://127.0.0.1:"),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(
            res.is_ok(),
            "redirect zu eigenem stub muss durchlaufen: {res:?}"
        );
        assert_eq!(res.unwrap().hash.len(), 128);
        assert!(!dest.exists(), "redirect-erfolg muss anonym bleiben");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_auf_evil_host_wird_abgelehnt_und_raeumt_auf() {
        let dest = tmp("redirect-evil");
        let url =
            serve_redirect_chain(|_| vec![(302, Some("https://evil.example/x".to_string()), None)]);
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |u| u.starts_with("http://127.0.0.1:"),
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(
            res.is_err(),
            "redirect zu evil-host muss abgelehnt werden: {res:?}"
        );
        assert!(res.as_ref().unwrap_err().contains("redirect"));
        assert!(!dest.exists(), "partielle datei muss nach abbruch weg sein");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_schleife_bricht_nach_max_hops_ab() {
        let dest = tmp("redirect-loop");
        let url = serve_redirect_chain(|base| {
            vec![
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base.clone()), None),
                (302, Some(base), None),
            ]
        });
        let cancel = AtomicBool::new(false);
        let res = download_stream(
            &url,
            dest.to_str().unwrap(),
            |_| true,
            || cancel.load(Ordering::Relaxed),
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await;
        assert!(
            res.is_err(),
            "redirect-schleife muss abgebrochen werden: {res:?}"
        );
        assert!(
            res.as_ref().unwrap_err().contains("redirect"),
            "fehler soll redirect-bezogen sein: {res:?}"
        );
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn fetch_sha512_rejects_unpinned_github_path() {
        let err = fetch_sha512_text(
            "https://github.com/someone/else/releases/download/x.sha512sum",
            Arc::new(CancelSignal::new()),
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("release asset path"),
            "err was: {err}"
        );
    }

    #[tokio::test]
    async fn fetch_sha512_rejects_non_https() {
        let err = fetch_sha512_text(
            "http://github.com/GloriousEggroll/proton-ge-custom/releases/download/x.sha512sum",
            Arc::new(CancelSignal::new()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("only HTTPS"), "err was: {err}");
    }

    #[tokio::test]
    async fn sha512_stream_accepts_body_at_limit_without_content_length() {
        let stream = stream::iter([
            Ok::<Vec<u8>, &'static str>(vec![0xAB; MAX_HASH_BYTES / 2]),
            Ok(vec![0xCD; MAX_HASH_BYTES / 2]),
        ]);
        let body = collect_limited_body(stream, MAX_HASH_BYTES).await.unwrap();
        assert_eq!(body.len(), MAX_HASH_BYTES);
        assert_eq!(body[0], 0xAB);
        assert_eq!(body[MAX_HASH_BYTES - 1], 0xCD);
    }

    #[tokio::test]
    async fn sha512_stream_rejects_chunked_body_over_limit() {
        let stream = stream::iter([
            Ok::<Vec<u8>, &'static str>(vec![0xAB; MAX_HASH_BYTES]),
            Ok(vec![0xCD]),
        ]);
        let err = collect_limited_body(stream, MAX_HASH_BYTES)
            .await
            .unwrap_err();
        assert_eq!(err, "hash asset exceeds size limit");
    }

    #[tokio::test]
    async fn sha512_stream_propagates_stream_errors() {
        let stream = stream::iter([
            Ok::<Vec<u8>, &'static str>(b"partial".to_vec()),
            Err("controlled stream failure"),
        ]);
        let err = collect_limited_body(stream, MAX_HASH_BYTES)
            .await
            .unwrap_err();
        assert_eq!(err, "controlled stream failure");
    }
}
