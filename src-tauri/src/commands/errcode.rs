// Kanonische Fehlercodes der Rust-Commands (Spec Welle B, Abschnitt 1.3).
//
// Der Code ist der Vertrag zur Oberflaeche, das Detail ist fuer Diagnose und
// Log. Format: "code" oder "code: detail". Die Fehlerklasse leitet die
// TypeScript-Seite aus dem Code ab; rohe englische Saetze sind kein Vertrag
// mehr.

pub(crate) const INVALID_APPID: &str = "invalid-appid";
/// Ein Eingabewert ist syntaktisch unzulaessig (z. B. unerlaubte Zeichen im
/// gepatchten Wert). Klasse `blocked` wie die uebrigen abgelehnten Eingaben
/// (unallowed-scheme, symlink-rejected), nicht `unknown` wie die invalid-*-
/// Codes: der Wert ist geprueft und bewusst abgelehnt, nicht unklar.
pub(crate) const INVALID_VALUE: &str = "invalid-value";
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
pub(crate) const INVALID_ACCOUNT_ID: &str = "invalid-account-id";
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
/// Live-Ablehnungen der Löschinspektion: das Ziel ist kein verwaister Eintrag.
pub(crate) const NOT_AN_ORPHAN: &str = "not-an-orphan";
/// Die Ziel-Library steht nicht (mehr) in `libraryfolders.vdf`.
pub(crate) const LIBRARY_NOT_LISTED: &str = "library-not-listed";
/// Nur verwaltete GE-Proton-Tools dürfen gelöscht werden.
pub(crate) const NOT_A_MANAGED_TOOL: &str = "not-a-managed-tool";
/// Nach dem Rename ist der Abschluss offen (z. B. Parent-fsync-Fehler): die
/// Änderung kann angewendet sein, darf aber nicht als "nichts passiert"
/// dargestellt werden.
pub(crate) const WRITE_UNCERTAIN: &str = "write-may-have-applied";

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

/// Bildet `error` genau dann auf `SIZE_LIMIT` mit neuem Detail ab, wenn er den
/// Code traegt; sonst unveraendert. Die Aufrufer waehlen ihr eigenes Detail
/// (welche Datei), damit die Log-Zeile unterscheidbar bleibt.
pub(crate) fn remap_size_limit(error: String, detail: impl std::fmt::Display) -> String {
    if has_code(&error, SIZE_LIMIT) {
        with_detail(SIZE_LIMIT, detail)
    } else {
        error
    }
}

/// io-regel fuer belegte abwesenheit: `NotFound` ist `NOT_FOUND` (INV-2: nur das
/// darf still uebersprungen werden), jeder andere io-fehler `UNREADABLE`.
pub(crate) fn code_for_io(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::NotFound {
        NOT_FOUND
    } else {
        UNREADABLE
    }
}

/// Alle Codes dieser Datei. Die Liste ist die Vollstaendigkeitsklammer fuer
/// die Frage "ist das ein bekannter Code?": driftet eine Konstante gegen sie,
/// faellt das im Test `all_codes_spiegelt_jede_code_konstante_der_datei` auf.
pub(crate) const ALL_CODES: [&str; 36] = [
    INVALID_APPID,
    INVALID_VALUE,
    INVALID_URL,
    UNALLOWED_SCHEME,
    CREDENTIALS_DISALLOWED,
    HOST_DISALLOWED,
    HANDLER_UNAVAILABLE,
    UNSUPPORTED_PLATFORM,
    STEAM_RUNNING,
    STEAM_NOT_FOUND,
    INVALID_ACCOUNT_ID,
    BLOCKED_LOCATION,
    NOT_A_STEAM_CONFIG,
    UNKNOWN_TOOL,
    TOOL_EXISTS,
    SIZE_LIMIT,
    NOT_FOUND,
    TOKEN_EXPIRED,
    TARGET_CHANGED,
    UNSUPPORTED_TARGET,
    NOT_A_DIRECTORY,
    SYMLINK_REJECTED,
    INVALID_ID,
    NOT_AN_ORPHAN,
    LIBRARY_NOT_LISTED,
    NOT_A_MANAGED_TOOL,
    WRITE_UNCERTAIN,
    CANCELLED,
    CHECKSUM_FAILED,
    UNVERIFIED_REJECTED,
    DOWNLOAD_ACTIVE,
    UNSUPPORTED_ARCH,
    BLOCKED,
    UNAVAILABLE,
    UNREADABLE,
    INCOMPLETE,
];

/// Beginnt der Text mit einem Code aus `ALL_CODES`?
pub(crate) fn has_known_code(text: &str) -> bool {
    ALL_CODES.iter().any(|code| has_code(text, code))
}

/// Setzt einen Kontext vor einen Fehler, ohne einen bereits gesetzten Code aus
/// dem Leitfeld zu verdraengen: die Klassifikation (Rust wie TypeScript) liest
/// den Code am Anfang. Traegt `error` einen bekannten Code, wandert der
/// Kontext ins Detail, sonst bleibt der Aufbau wie bei `format!("{context}: ...")`.
pub(crate) fn with_context(context: impl std::fmt::Display, error: &str) -> String {
    for code in ALL_CODES {
        if let Some(detail) = error.strip_prefix(&format!("{code}: ")) {
            return with_detail(code, format!("{context}: {detail}"));
        }
        if error == code {
            return with_detail(code, context);
        }
    }
    format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Liest die Code-Konstanten aus dem eigenen Quelltext. Das Muster wird
    /// bewusst nicht im Klartext wiederholt: der TypeScript-Spiegel
    /// (`tests/security/mirrored-constants.test.ts`) liest diese Datei als Text
    /// und hielte einen Beispielcode sonst fuer einen echten Code.
    fn declared_codes(source: &str) -> Vec<&str> {
        source
            .lines()
            .filter_map(|line| {
                let rest = line.strip_prefix("pub(crate) const ")?;
                let (_, value) = rest.split_once(": &str = \"")?;
                value.strip_suffix("\";")
            })
            .collect()
    }

    #[test]
    fn all_codes_spiegelt_jede_code_konstante_der_datei() {
        // Die Liste ist die Vollstaendigkeitsklammer fuer "ist das ein bekannter
        // Code?": jede Konstante muss in ALL_CODES stehen und umgekehrt.
        let source = include_str!("errcode.rs");
        let mut declared = declared_codes(source);
        let mut listed = ALL_CODES.to_vec();
        declared.sort_unstable();
        listed.sort_unstable();
        assert_eq!(declared, listed);
        assert_eq!(ALL_CODES.len(), declared.len());
    }

    #[test]
    fn has_known_code_erkennt_code_allein_und_mit_detail() {
        for code in ALL_CODES {
            assert!(has_known_code(code), "reiner Code {code} nicht erkannt");
            assert!(
                has_known_code(&with_detail(code, "detail")),
                "Code {code} mit Detail nicht erkannt"
            );
        }
        assert!(!has_known_code(""));
        assert!(!has_known_code("unreadable "));
        assert!(!has_known_code("unknown-code: detail"));
    }

    #[test]
    fn has_code_verwechselt_keine_praefix_codes() {
        // Der Trenner ": " verhindert, dass ein laengerer Code als sein eigenes
        // Praefix gelesen wird; ohne ihn wuerde "blocked-location" als "blocked"
        // und "invalid-appid-x" als "invalid-appid" gelten.
        assert!(!has_code("blocked-location: x", BLOCKED));
        assert!(!has_code("invalid-appid-x: y", INVALID_APPID));
        assert!(!has_code("not-found-something", NOT_FOUND));
        assert!(has_code("blocked-location: x", BLOCKED_LOCATION));
    }

    #[test]
    fn with_context_behaelt_einen_bekannten_code_im_leitfeld() {
        let coded = with_detail(UNREADABLE, "cannot read x");
        assert_eq!(
            with_context("label", &coded),
            "unreadable: label: cannot read x"
        );
        assert_eq!(with_context("label", "plain text"), "label: plain text");
    }
}
