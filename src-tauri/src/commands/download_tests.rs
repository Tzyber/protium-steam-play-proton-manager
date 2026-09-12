use super::*;
use crate::commands::path::random_suffix;
use futures_util::stream;
use std::io::{Read, Write};
use std::net::TcpListener;
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
    assert!(
        validate_redirect_url("https://release-assets.githubusercontent.com/x?jwt=abc@def").is_ok()
    );
}

#[test]
fn redirect_url_rejects_http_credentials_and_non_default_port() {
    assert!(validate_redirect_url("http://objects.githubusercontent.com/f").is_err());
    assert!(validate_redirect_url("https://user:pass@objects.githubusercontent.com/f").is_err());
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

/// HTTP-stub: kündigt `announce` bytes an, sendet nie einen body und hält
/// die verbindung offen → der client hängt im body-read.
fn serve_stalled(announce: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf); // request ignorieren
            let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {announce}\r\n\r\n");
            let _ = stream.write_all(header.as_bytes());
            // stream bleibt offen, body kommt nie
            thread::sleep(std::time::Duration::from_secs(30));
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
    let cancel = CancelSignal::new();
    cancel.cancel(); // sofort gesetzt → bricht beim ersten chunk ab
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
async fn falsche_directory_identity_scheitert_vor_tmpfile_und_pfad_bleibt_unsichtbar() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let root = std::env::temp_dir().join(format!(
        "protium-dltest-wrong-identity-{}-{}",
        std::process::id(),
        random_suffix()
    ));
    let visible = root.join("downloads");
    let destination = visible.join("download.tar.gz");
    std::fs::create_dir_all(&visible).unwrap();
    std::fs::write(visible.join("marker"), b"untouched").unwrap();
    let directory = std::fs::File::open(&visible).unwrap();
    let identity = super::file_identity(&directory).unwrap();
    let opened = Arc::new(AtomicBool::new(false));
    let opened_for_hook = Arc::clone(&opened);
    let hook = move || {
        opened_for_hook.store(true, Ordering::Release);
    };

    let url = serve_once(32, 32);
    let cancel = CancelSignal::new();
    let result = super::download_stream_in_directory(
        &url,
        |_| true,
        &cancel,
        |_, _| {},
        DownloadStorage {
            max_bytes: MAX_DOWNLOAD_BYTES,
            directory: DownloadDirectoryBinding {
                file: &directory,
                identity: (identity.0 ^ 1, identity.1),
            },
            before_open: Some(&hook),
        },
    )
    .await;

    assert!(
        result
            .as_ref()
            .unwrap_err()
            .contains("bound download directory identity changed"),
        "falsche binding-identität muss vor O_TMPFILE scheitern: {result:?}"
    );
    assert!(!opened.load(Ordering::Acquire));
    assert!(
        !destination.exists(),
        "sichtbarer zielpfad darf nicht entstehen"
    );
    assert_eq!(std::fs::read(visible.join("marker")).unwrap(), b"untouched");
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
    let cancel = CancelSignal::new();
    let mut artifact = super::download_stream_in_directory(
        &url,
        |_| true,
        &cancel,
        |_, _| {},
        DownloadStorage {
            max_bytes: MAX_DOWNLOAD_BYTES,
            directory: DownloadDirectoryBinding {
                file: &directory,
                identity,
            },
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
    let root = std::env::temp_dir().join(format!("protium-dltest-handle-{}", std::process::id()));
    let dest = root.join("download.tar.gz");
    std::fs::create_dir_all(&root).unwrap();
    let url = serve_once(32, 32);
    let cancel = CancelSignal::new();
    let mut artifact = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
async fn cancel_weckt_blockierten_body_read_aktiv_auf() {
    // server kündigt 64 KiB an, sendet aber nie einen body: ohne aktiven
    // cancel würde der read bis zum 120-s-stall-timeout hängen.
    let dest = tmp("stall-cancel");
    let dest_str = dest.to_string_lossy().into_owned();
    let url = serve_stalled(64 * 1024);
    let cancel = Arc::new(CancelSignal::new());
    let cancel_flag = Arc::clone(&cancel);
    let task = tokio::spawn(async move {
        download_stream(
            &url,
            &dest_str,
            |_| true,
            &cancel_flag,
            |_, _| {},
            MAX_DOWNLOAD_BYTES,
        )
        .await
    });
    // warten, bis der client im body-read hängt, dann cancel setzen
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    cancel.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
        .await
        .expect("cancel muss den blockierten body-read aktiv aufwecken")
        .unwrap();
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(!dest.exists(), "abbruch: keine datei zurücklassen");
    let _ = std::fs::remove_dir_all(dest.parent().unwrap());
}

#[tokio::test]
async fn cancel_nach_abschluss_startet_zweiten_download_normal() {
    let dest1 = tmp("stale-1");
    let url1 = serve_once(32, 32);
    let cancel = CancelSignal::new();

    let res = download_stream(
        &url1,
        dest1.to_str().unwrap(),
        |_| true,
        &cancel,
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
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |u| u.starts_with("http://127.0.0.1:"),
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |u| u.starts_with("http://127.0.0.1:"),
        &cancel,
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
    let cancel = CancelSignal::new();
    let res = download_stream(
        &url,
        dest.to_str().unwrap(),
        |_| true,
        &cancel,
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
