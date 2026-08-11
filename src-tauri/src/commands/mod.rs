// rust-commands (R-1..R-6): das, was die webview nicht kann.

pub(crate) mod cleanup;
pub(crate) mod download;
pub(crate) mod extract;
pub(crate) mod external;
pub(crate) mod fs_ops;
pub(crate) mod path;
pub(crate) mod scope;
pub(crate) mod steam;

/// spawn_blocking + join-handle-fehler → String. die sync-commands laufen
/// bei tauri v2 auf dem main-thread — blockierende IO gehört in den
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
    // gemeinsame fixture-helper der commands-tests: tempdir-fixtures
    // (fixture_dir + prefix-factories orphan/trash/wsg) und touch
    // (marker-datei bauen). genutzt von den cleanup.rs- (orphan/trash)
    // und steam.rs-tests (wsg).
    pub(super) fn fixture_dir(prefix: &str, tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-{prefix}-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    pub(super) fn orphan_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("orphan", tag)
    }

    pub(super) fn trash_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("trash", tag)
    }

    pub(super) fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }

    pub(super) fn touch(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("marker"), b"x").unwrap();
    }
}
