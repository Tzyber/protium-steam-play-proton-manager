use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::commands::path::{sanitize_path, validate_download_dest};

/// initiale download-URL: https + github.com + pfad-pinning auf das GE-repo.
/// ohne das pinning wäre jede github.com-url ein download-ziel (cache-poisoning
/// → beliebiger payload → extraktion → code-execution). redirect-ziele prüft
/// `validate_redirect_url` — ein github.com-redirect wäre ein offener umweg.
pub(super) fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid download URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only HTTPS URLs allowed for downloads".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".into());
    }
    let host = parsed.host_str().ok_or_else(|| "download URL has no host".to_string())?;
    if host.to_ascii_lowercase() != "github.com" {
        return Err(format!("download URL host not allowed: {host}"));
    }

    // pfad-pinning: GE hostet seine assets selbst; ein anderer github-pfad ist
    // für protium nie legitim (browser_download_url ist immer diese form)
    const GE_PREFIX: [&str; 4] = ["GloriousEggroll", "proton-ge-custom", "releases", "download"];
    let mut comps = parsed.path().split('/').filter(|c| !c.is_empty());
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
    Ok(())
}

/// redirect-ziele: nur die zwei asset-CDN-hosts, host-only (redirect-pfade sind
/// nicht steuerbar). github.com als redirect-ziel ausgeschlossen — sonst wäre
/// das pfad-pinning über einen redirect umgehbar.
pub(super) fn validate_redirect_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid redirect URL: {e}"))?;
    let host = parsed.host_str().ok_or_else(|| "redirect URL has no host".to_string())?;
    let host = host.to_ascii_lowercase();
    if host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com" {
        Ok(())
    } else {
        Err(format!("redirect target host not allowed: {host}"))
    }
}

/// je download-id ein Arc<AtomicBool>. download_file legt ein frisches Arc an
/// und ersetzt ein etwaiges altes. cancel_download setzt das flag im aktuell
/// registrierten Arc. am ende wird der eintrag nur entfernt, wenn noch genau
/// das eigene Arc dort liegt (ptr_eq) — so läuft ein zu spät eintreffender
/// cancel ins leere, statt eine leiche zu erzeugen.
#[derive(Default)]
pub struct CancelRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

/// maximale download-grösse (GE-tarballs ~1 GB, 8 GiB ist reichlich luft).
pub const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// download-kern ohne tauri-typen (cargo-testbar). crash-fest: jeder fehlerausgang
/// (cancel, netzabbruch, schreibfehler) löscht die partielle datei vor return.
/// `max_bytes` steuert das grössenlimit (produktion: MAX_DOWNLOAD_BYTES, tests: kleiner).
pub(super) async fn download_stream(
    url: &str,
    dest: &str,
    redirect_ok: impl Fn(&str) -> bool + Send + Sync + 'static,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
    max_bytes: u64,
) -> Result<String, String> {
    let result: Result<String, String> = async {
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
        let client = reqwest::Client::builder()
            .redirect(policy)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        // content-length-prüfung (server kann lügen, also zählt der streaming-loop
        // zusätzlich die tatsächlich geschriebenen bytes mit)
        if let Some(len) = resp.content_length() {
            if len > max_bytes {
                return Err("content-length exceeds download size limit".into());
            }
        }

        if let Some(parent) = Path::new(dest).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| e.to_string())?;
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
                    if downloaded > max_bytes {
                        return Err("download size limit exceeded".into());
                    }

                    hasher.update(&chunk);
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    on_progress(downloaded, content_length);
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>())
    }
    .await;

    // partielle datei bei fehler weg (vor return)
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

/// markiert einen download zum abbruch; setzt das flag im aktuell registrierten Arc.
#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, CancelRegistry>, download_id: String) {
    if let Ok(map) = state.0.lock() {
        if let Some(flag) = map.get(&download_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: Option<u64>,
}

/// R-4: tauri-wrapper um download_stream — cancel-registry + fortschritt (throttled ~1 MB).
/// validiert URL (domain + https) und dest-pfad vor dem start.
/// dest-validierung per allowlist: nur ziele innerhalb des app-cache-verzeichnisses.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: tauri::State<'_, CancelRegistry>,
    url: String,
    dest: String,
    download_id: String,
) -> Result<String, String> {
    validate_download_url(&url)?;
    sanitize_path(&dest, "download dest")?;

    // allowlist: cache-dir selbst über den tauri path-resolver ermitteln
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    validate_download_dest(&dest, &cache_dir)?;

    // frisches cancel-flag; ersetzt ein etwaiges altes in der registry
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(download_id.clone(), Arc::clone(&cancel_flag));
    }
    let cancel_flag_clone = Arc::clone(&cancel_flag);

    let mut last_emit: u64 = 0;

    let result = download_stream(
        &url,
        &dest,
        |u| validate_redirect_url(u).is_ok(),
        move || cancel_flag_clone.load(std::sync::atomic::Ordering::Relaxed),
        |downloaded, total| {
            let done = total.map(|t| downloaded >= t).unwrap_or(false);
            if downloaded - last_emit >= 1_000_000 || done {
                last_emit = downloaded;
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress { id: download_id.clone(), downloaded, total },
                );
            }
        },
        MAX_DOWNLOAD_BYTES,
    )
    .await;

    // nur aufräumen, wenn noch genau unser eigenes Arc registriert ist
    if let Ok(mut map) = state.0.lock() {
        let keep = map
            .get(&download_id)
            .map(|registered| Arc::ptr_eq(registered, &cancel_flag))
            .unwrap_or(false);
        if keep {
            map.remove(&download_id);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{download_stream, validate_download_url, validate_redirect_url, MAX_DOWNLOAD_BYTES};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn download_url_rejects_http() {
        assert!(validate_download_url("http://objects.githubusercontent.com/file.tar.gz").is_err());
        assert!(validate_download_url("HTTP://example.com/file").is_err());
    }

    #[test]
    fn download_url_rejects_credentials() {
        assert!(validate_download_url("https://user:pass@objects.githubusercontent.com/f").is_err());
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
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz?x=1").is_ok());
    }

    #[test]
    fn download_url_pins_ge_repo_path() {
        // cache-poisoning-kette: jede github.com-url wäre sonst ein download-ziel
        assert!(validate_download_url("https://github.com/attacker/evil/releases/download/1/payload.tar.gz").is_err());
        assert!(validate_download_url("https://github.com/GloriousEggroll/other/releases/download/1/f.tar.gz").is_err());
        assert!(validate_download_url("https://github.com/GloriousEggroll/proton-ge-custom/archive/refs/tags/v1.tar.gz").is_err());
    }

    #[test]
    fn download_url_rejects_cdn_hosts_as_initial_url() {
        // CDN-hosts sind nur redirect-ziele, nie initiale URLs
        assert!(validate_download_url("https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz").is_err());
        assert!(validate_download_url("https://release-assets.githubusercontent.com/github-production-release-asset-2e/f.tar.gz?jwt=abc").is_err());
    }

    #[test]
    fn redirect_url_allows_cdn_hosts() {
        assert!(validate_redirect_url("https://objects.githubusercontent.com/github-production-release-asset-2e/f.tar.gz").is_ok());
        assert!(validate_redirect_url("https://release-assets.githubusercontent.com/x?jwt=abc@def").is_ok());
    }

    #[test]
    fn redirect_url_rejects_github_and_others() {
        // github.com als redirect-ziel wäre ein umweg um das pfad-pinning
        assert!(validate_redirect_url("https://github.com/GloriousEggroll/proton-ge-custom/releases/download/1/f.tar.gz").is_err());
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
                let header =
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {announce}\r\n\r\n");
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
    fn serve_redirect_chain(f: impl FnOnce(String) -> Vec<(u16, Option<String>, Option<Vec<u8>>)>) -> String {
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
        assert_eq!(res.unwrap().len(), 128); // sha512 hex = 128 zeichen
        assert!(dest.exists(), "erfolgsfall: datei muss bleiben");
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

    // ---- cancel-registry stale-flag tests (Arc<AtomicBool> + ptr_eq) ----

    #[test]
    fn cancel_registry_ptr_eq_entfernt_nur_eigenes_flag() {
        use super::CancelRegistry;

        let registry = CancelRegistry::default();

        // erstes Arc registrieren (simuliert download_file-start)
        let flag1 = Arc::new(AtomicBool::new(false));
        registry.0.lock().unwrap().insert("x".into(), Arc::clone(&flag1));

        // ptr_eq muss für eigenes Arc zutreffen
        assert!(
            registry.0.lock().unwrap().get("x")
                .map(|r| Arc::ptr_eq(r, &flag1))
                .unwrap_or(false),
            "eigenes Arc muss per ptr_eq matchen"
        );

        // cleanup: entfernen weil ptr_eq matched
        {
            let mut map = registry.0.lock().unwrap();
            let keep = map.get("x").map(|r| Arc::ptr_eq(r, &flag1)).unwrap_or(false);
            if keep {
                map.remove("x");
            }
        }
        assert!(registry.0.lock().unwrap().is_empty());

        // zweiter download: neues Arc (simuliert re-download)
        let flag2 = Arc::new(AtomicBool::new(false));
        registry.0.lock().unwrap().insert("x".into(), Arc::clone(&flag2));

        // altes flag1 darf NICHT mit dem neuen eintrag ptr_eq matchen
        let mismatch = registry.0.lock().unwrap().get("x")
            .map(|r| !Arc::ptr_eq(r, &flag1))
            .unwrap_or(false);
        assert!(mismatch, "altes Arc darf nicht auf neuen eintrag matchen");

        // neues flag muss frisch (false) sein — kein stale cancel
        assert!(!flag2.load(Ordering::Relaxed), "neues flag darf nicht vorbelastet sein");
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

        // simulate late cancel (nach abschluss) — cancel-flag bleibt false
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
        assert!(res2.is_ok(), "zweiter download muss normal starten: {res2:?}");
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
        assert!(res.is_err(), "content-length über limit muss Err liefern: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("content-length"),
            "fehler soll content-length nennen: {res:?}"
        );
        assert!(!dest.exists(), "keine datei bei content-length-überschreitung");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn bytes_ueber_limit_raeumt_partielle_datei_auf() {
        let dest = tmp("sizecap-bytes");
        // stub kündigt 16 bytes an, sendet 32 — ohne content-length-check
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
        assert!(res.is_ok(), "redirect zu eigenem stub muss durchlaufen: {res:?}");
        assert_eq!(res.unwrap().len(), 128);
        assert!(dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn redirect_auf_evil_host_wird_abgelehnt_und_raeumt_auf() {
        let dest = tmp("redirect-evil");
        let url = serve_redirect_chain(|_| {
            vec![
                (302, Some("https://evil.example/x".to_string()), None),
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
        assert!(res.is_err(), "redirect zu evil-host muss abgelehnt werden: {res:?}");
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
        assert!(res.is_err(), "redirect-schleife muss abgebrochen werden: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("redirect"),
            "fehler soll redirect-bezogen sein: {res:?}"
        );
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }
}
