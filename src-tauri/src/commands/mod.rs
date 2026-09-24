// Rust-Commands für Operationen außerhalb des Webviews.
//
// Die Anwendung ist Linux-only; gebaut und geprüft wird ausschließlich
// `target_os = "linux"`. Die `#[cfg(not(target_os = "linux"))]`-Zweige sind
// Fehlerstummel, die fail-closed verweigern statt zu degradieren, und dürfen
// nie als funktionierende Degradation gelesen werden.
//
// Ob diese Zweige auf einem Fremdhost überhaupt vollständig kompilieren, ist
// NICHT belegt: ein `cargo check` für ein Fremdziel wurde nie ausgeführt (er
// erzeugte hier Fremd-Build-Artefakte). Der frühere Kommentar behauptete genau
// das und war damit unbelegt (r-12). Die linux-unabhängigen Importe sind
// deshalb so bedingt, dass Linux-Builds gültig bleiben; weitergehende
// Fremdziel-Pflege ist bewusst nicht zugesagt.

pub(crate) mod cleanup;
pub(crate) mod compat_auth;
pub(crate) mod delete_inspect;
pub(crate) mod delete_ops;
pub(crate) mod diagnostics;
pub(crate) mod download;
pub(crate) mod errcode;
pub(crate) mod external;
pub(crate) mod extract;
pub(crate) mod fd;
pub(crate) mod fs_ops;
pub(crate) mod ge_install;
pub(crate) mod path;
pub(crate) mod prefix;
pub(crate) mod scope;
pub(crate) mod shortcuts_bin;
pub(crate) mod steam;
pub(crate) mod vdf_patch;

/// spawn_blocking + join-handle-fehler → String. die sync-commands laufen
/// bei tauri v2 auf dem main-thread, blockierende IO gehört in den
/// blocking-pool (batch C1).
pub(crate) async fn spawn_blocking_io<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod test_util {
    // gemeinsame fixture-helper der command-tests: tempdir-fixtures für
    // state-, trash- und write-gate-tests.
    pub(super) fn fixture_dir(prefix: &str, tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-{prefix}-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    pub(super) fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }

    /// Legt ein minimales App-Manifest an; compat_auth- und Write-Gate-Tests
    /// brauchen denselben Nachweis einer installierten Steam-App.
    pub(super) fn write_appmanifest(steamapps: &std::path::Path, app_id: u32) {
        std::fs::create_dir_all(steamapps).unwrap();
        std::fs::write(
            steamapps.join(format!("appmanifest_{app_id}.acf")),
            format!("\"AppState\" {{ \"appid\" \"{app_id}\" }}"),
        )
        .unwrap();
    }

    /// Schneidet den Produktionsteil einer Quelldatei ab, die sich per
    /// `include_str!` selbst einliest.
    ///
    /// Grenze ist ausschließlich die Moduldeklaration `#[cfg(test)]` direkt vor
    /// `mod tests {`. Ein nacktes `split("#[cfg(test)]")` wäre still falsch:
    /// `download.rs` trägt einen `#[cfg(test)]`-Import und einen
    /// `#[cfg(test)]`-Testseam VOR dem Produktionscode, `steam.rs` mehrere
    /// `#[cfg(test)]`-Blöcke. Ein zu früher Schnitt macht den geprüften Text
    /// kürzer und den Test damit grün, ohne dass er noch etwas prüft. Deshalb
    /// gilt: kein Treffer = Panik.
    pub(super) fn production_source(source: &str) -> &str {
        // Seit die Testmodule ausgelagert sind, endet der Produktionsteil an
        // `#[cfg(test)]` vor `mod tests;` (Verweis auf die Testdatei) ODER vor
        // einem eingebetteten `mod tests {`. Beide Formen sind gültig; ein
        // fehlender Marker bleibt ein harter Fehler, damit ein still zu kurz
        // geschnittener Text nicht als grüner Test durchgeht.
        let module = source.find("\n#[cfg(test)]\n#[path =");
        let inline = source.find("\n#[cfg(test)]\nmod tests {");
        let end = match (module, inline) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            // kein Testmodul im Text: der ganze text ist produktionscode. Die
            // aufrufer prüfen ausschließlich verbote, ein zu kurzer text wäre
            // still grün, deshalb bleibt der leere fall ein harter fehler.
            (None, None) => panic!("source has no `#[cfg(test)]` test module"),
        };
        &source[..end]
    }
}
