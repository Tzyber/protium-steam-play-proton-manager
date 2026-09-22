// Kanonische Fehlercodes der Rust-Commands (Spec Welle B, Abschnitt 1.3).
//
// Der Code ist der Vertrag zur Oberflaeche, das Detail ist fuer Diagnose und
// Log. Format: "code" oder "code: detail". Die Fehlerklasse leitet die
// TypeScript-Seite aus dem Code ab; rohe englische Saetze sind kein Vertrag
// mehr.

pub(crate) const INVALID_APPID: &str = "invalid-appid";
pub(crate) const INVALID_URL: &str = "invalid-url";
pub(crate) const UNALLOWED_SCHEME: &str = "unallowed-scheme";
pub(crate) const CREDENTIALS_DISALLOWED: &str = "credentials-disallowed";
pub(crate) const HOST_DISALLOWED: &str = "host-disallowed";
pub(crate) const HANDLER_UNAVAILABLE: &str = "handler-unavailable";
/// Nur in den Nicht-Linux-Stummeln verwendet; auf Linux deshalb ungenutzt.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) const UNSUPPORTED_PLATFORM: &str = "unsupported-platform";

pub(crate) const STEAM_RUNNING: &str = "steam-running";
pub(crate) const STEAM_NOT_FOUND: &str = "steam-not-found";
pub(crate) const INVALID_ACCOUNT: &str = "invalid-account-id";
pub(crate) const BLOCKED_LOCATION: &str = "blocked-location";
pub(crate) const NOT_A_STEAM_CONFIG: &str = "not-a-steam-config";
pub(crate) const UNKNOWN_TOOL: &str = "unknown-tool";
pub(crate) const TOOL_EXISTS: &str = "tool-already-exists";
pub(crate) const SIZE_LIMIT: &str = "size-limit-exceeded";

pub(crate) const NOT_FOUND: &str = "not-found";
pub(crate) const TOKEN_EXPIRED: &str = "token-expired";
pub(crate) const TARGET_CHANGED: &str = "target-changed";
pub(crate) const UNSUPPORTED_TARGET: &str = "unsupported-target";
pub(crate) const NOT_A_DIRECTORY: &str = "not-a-directory";
pub(crate) const SYMLINK_REJECTED: &str = "symlink-rejected";
pub(crate) const INVALID_ID: &str = "invalid-id";

pub(crate) const CANCELLED: &str = "cancelled";
pub(crate) const CHECKSUM_FAILED: &str = "checksum-failed";
pub(crate) const UNVERIFIED_REJECTED: &str = "unverified-rejected";
pub(crate) const DOWNLOAD_ACTIVE: &str = "download-active";
pub(crate) const UNSUPPORTED_ARCH: &str = "unsupported-arch";

pub(crate) const BLOCKED: &str = "blocked";
pub(crate) const UNAVAILABLE: &str = "unavailable";
pub(crate) const UNREADABLE: &str = "unreadable";
pub(crate) const INCOMPLETE: &str = "incomplete";

/// Code mit Detail. Das Detail darf Pfad- oder Kontextanteile enthalten und
/// landet im Log, nicht in der Uebersetzung.
pub(crate) fn with_detail(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

/// Traegt der Text diesen Code (allein oder mit Detail)?
pub(crate) fn has_code(text: &str, code: &str) -> bool {
    text == code || text.starts_with(&format!("{code}: "))
}
