// Pfad-Layout der Steam-Dateien und die VDF-Schlüssel der Compat-Zuordnung
// (FR-1): reine Konstruktoren, keine IO, keine Validierung. Die elf
// Produktionsdateien joinen ihre Steam-Pfade nur noch hier (FR-2).
//
// Nicht hier: `compatdata`, `shadercache` und der Papierkorb-Pfad. Die ersten
// beiden werden ausschließlich als `OsStr` an die gebundene fd-Kette gegeben
// (prefix.rs, compat_auth.rs, delete_usage.rs), den Papierkorb baut
// `delete_ops.rs`; ein PathBuf-Konstruktor ohne Aufrufer wäre toter Code.

use std::path::{Path, PathBuf};

/// `<root>/steamapps`.
pub(super) fn steamapps(root: &Path) -> PathBuf {
    root.join("steamapps")
}

/// `<root>/compatibilitytools.d`.
pub(super) fn compatibilitytools(root: &Path) -> PathBuf {
    root.join("compatibilitytools.d")
}

/// `<root>/config`.
pub(super) fn config_dir(root: &Path) -> PathBuf {
    root.join("config")
}

/// `<root>/config/config.vdf`.
pub(super) fn config_vdf(root: &Path) -> PathBuf {
    config_dir(root).join("config.vdf")
}

/// `<root>/userdata`.
pub(super) fn userdata(root: &Path) -> PathBuf {
    root.join("userdata")
}

/// `<root>/userdata/<account>/config/localconfig.vdf`.
pub(super) fn localconfig_vdf(root: &Path, account: &str) -> PathBuf {
    userdata(root)
        .join(account)
        .join("config")
        .join("localconfig.vdf")
}

/// `<root>/config/libraryfolders.vdf` (die primäre Ablage).
pub(super) fn libraryfolders_vdf(root: &Path) -> PathBuf {
    config_dir(root).join("libraryfolders.vdf")
}

/// `<root>/steamapps/libraryfolders.vdf` (der ältere Fallback).
pub(super) fn steamapps_libraryfolders_vdf(root: &Path) -> PathBuf {
    steamapps(root).join("libraryfolders.vdf")
}

// ---- VDF-Schlüssel der Compat-Zuordnung ----
//
// Beide Steam-Layouts (das klassische `InstallConfigStore`-Dokument und ein
// flaches `Software`-Dokument) tragen dieselben Schlüssel; sie stehen deshalb
// genau einmal hier (FR-4).

pub(crate) const INSTALL_CONFIG_STORE: &str = "InstallConfigStore";
pub(crate) const SOFTWARE: &str = "Software";
pub(crate) const VALVE: &str = "Valve";
pub(crate) const STEAM: &str = "Steam";
pub(crate) const COMPAT_TOOL_MAPPING: &str = "CompatToolMapping";
pub(crate) const NAME: &str = "name";

/// Schlüsselkette der Compat-Zuordnung einer AppID im klassischen Layout.
pub(super) fn compat_tool_mapping_path(app_id: &str) -> Vec<&str> {
    vec![
        INSTALL_CONFIG_STORE,
        SOFTWARE,
        VALVE,
        STEAM,
        COMPAT_TOOL_MAPPING,
        app_id,
    ]
}

#[cfg(test)]
#[path = "steam_layout_tests.rs"]
mod tests;
