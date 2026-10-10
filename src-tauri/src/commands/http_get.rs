// Netzabfragen der Webview (S-02). Ersetzt tauri-plugin-http: dessen Scope
// prüfte nur die Ziel-URL, Proxy, Redirects und Header kamen ungefiltert aus
// der Webview. Hier liegen URL, Header, Redirect-Verbot, Timeout und Größe fest.
use crate::commands::errcode;
use serde::Serialize;
use std::time::Duration;

// Spiegel zu RELEASES_URL (geproton.ts), LATEST_RELEASE_URL (update.ts) und
// PROTONDB_API_BASE (protondb.ts), geprüft in tests/security/github-capability.test.ts.
const GE_RELEASES_URL: &str =
    "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15";
const PROTIUM_LATEST_URL: &str =
    "https://api.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest";
const PROTONDB_SUMMARY_PREFIX: &str = "https://www.protondb.com/api/v1/reports/summaries/";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpGetResponse {
    status: u16,
    text: String,
    etag: Option<String>,
}

pub(super) fn is_allowed_url(url: &str) -> bool {
    url == GE_RELEASES_URL
        || url == PROTIUM_LATEST_URL
        || url
            .strip_prefix(PROTONDB_SUMMARY_PREFIX)
            .and_then(|rest| rest.strip_suffix(".json"))
            .is_some_and(|id| crate::commands::scope::parse_app_id(id).is_ok())
}

async fn fetch(
    url: &str,
    if_none_match: Option<&str>,
    max_body: usize,
    timeout: Duration,
) -> Result<HttpGetResponse, String> {
    let unavailable = |error: reqwest::Error| errcode::with_detail(errcode::UNAVAILABLE, error);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent(concat!("protium/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(unavailable)?;
    let mut request = client.get(url);
    if url.starts_with("https://api.github.com/") {
        request = request.header(reqwest::header::ACCEPT, "application/vnd.github+json");
    }
    if let Some(etag) = if_none_match {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let mut response = request.send().await.map_err(unavailable)?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unavailable)? {
        if body.len() + chunk.len() > max_body {
            return Err(errcode::SIZE_LIMIT.into());
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(body).map_err(|e| errcode::with_detail(errcode::UNREADABLE, e))?;
    Ok(HttpGetResponse { status, text, etag })
}

#[tauri::command]
pub async fn http_get(
    url: String,
    if_none_match: Option<String>,
) -> Result<HttpGetResponse, String> {
    if !is_allowed_url(&url) {
        return Err(errcode::with_detail(errcode::INVALID_URL, url));
    }
    fetch(&url, if_none_match.as_deref(), MAX_BODY_BYTES, TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    #[test]
    fn erlaubt_genau_die_drei_url_formen() {
        assert!(is_allowed_url(GE_RELEASES_URL));
        assert!(is_allowed_url(PROTIUM_LATEST_URL));
        assert!(is_allowed_url(
            "https://www.protondb.com/api/v1/reports/summaries/620.json"
        ));
        for url in [
            "https://www.protondb.com/api/v1/reports/summaries/0.json",
            "https://www.protondb.com/api/v1/reports/summaries/620.json?x=1",
            "https://www.protondb.com/api/v1/reports/summaries/620.json#x",
            "https://www.protondb.com/api/v1/reports/summaries/../620.json",
            "https://www.protondb.com/api/v1/reports/summaries/62a.json",
            "https://www.protondb.com/api/v1/reports/summaries/99999999999.json",
            "https://www.protondb.com/api/v1/reports/summaries/620",
            "http://www.protondb.com/api/v1/reports/summaries/620.json",
            "https://www.protondb.com@evil.example/api/v1/reports/summaries/620.json",
            "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=100",
            "https://api.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest/",
            "https://API.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest",
        ] {
            assert!(!is_allowed_url(url), "{url}");
        }
    }

    /// Antwortet einmal mit `response` und meldet die rohe Anfrage zurück.
    fn serve(response: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let read = stream.read(&mut buf).unwrap_or(0);
                let _ = sender.send(String::from_utf8_lossy(&buf[..read]).into_owned());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{addr}/"), receiver)
    }

    #[tokio::test]
    async fn reicht_status_etag_und_if_none_match_durch() {
        let (url, request) =
            serve("HTTP/1.1 304 Not Modified\r\nETag: W/\"v2\"\r\nContent-Length: 0\r\n\r\n");
        let response = fetch(&url, Some("W/\"v1\""), MAX_BODY_BYTES, TIMEOUT)
            .await
            .unwrap();
        assert_eq!(response.status, 304);
        assert_eq!(response.etag.as_deref(), Some("W/\"v2\""));
        let request = request.recv().unwrap().to_ascii_lowercase();
        assert!(request.contains("if-none-match: w/\"v1\""), "{request}");
        // ohne user-agent lehnt die github-api mit 403 ab
        assert!(request.contains("user-agent: protium/"), "{request}");
    }

    #[tokio::test]
    async fn folgt_keinem_redirect() {
        let (url, _request) = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\n\r\n",
        );
        assert_eq!(
            fetch(&url, None, MAX_BODY_BYTES, TIMEOUT)
                .await
                .unwrap()
                .status,
            302
        );
    }

    #[tokio::test]
    async fn bricht_bei_zu_grossem_body_ab() {
        let (url, _request) = serve("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678");
        let error = fetch(&url, None, 4, TIMEOUT).await.unwrap_err();
        assert!(error.contains(errcode::SIZE_LIMIT), "{error}");
    }

    #[tokio::test]
    async fn bricht_bei_schweigendem_server_nach_dem_timeout_ab() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let accepted = listener.accept();
            std::thread::sleep(Duration::from_secs(5));
            drop(accepted);
        });
        let error = fetch(&url, None, MAX_BODY_BYTES, Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(error.contains(errcode::UNAVAILABLE), "{error}");
    }

    #[tokio::test]
    async fn lehnt_fremde_urls_vor_jedem_request_ab() {
        let error = http_get("https://evil.example/".into(), None)
            .await
            .unwrap_err();
        assert!(error.contains(errcode::INVALID_URL), "{error}");
    }
}
