// Rust-Commands für Operationen außerhalb des Webviews.

pub(crate) mod cleanup;
pub(crate) mod delete_ops;
pub(crate) mod download;
pub(crate) mod external;
pub(crate) mod extract;
pub(crate) mod fs_ops;
pub(crate) mod ge_install;
pub(crate) mod path;
pub(crate) mod scope;
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

    pub(super) fn trash_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("trash", tag)
    }

    pub(super) fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }
}
