// Kanonische Fehlersemantik fuer Protium (Glossar G, Roadmap Welle B, B1)

export type ProtiumErrorKind =
  | "unavailable"
  | "unreadable"
  | "incomplete"
  | "not-found"
  | "unknown"
  | "blocked";

export class ProtiumError extends Error {
  readonly kind: ProtiumErrorKind;
  readonly code: string;
  readonly detail?: string;

  constructor(kind: ProtiumErrorKind, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ProtiumError";
    this.kind = kind;
    this.code = code;
    this.detail = detail;
  }
}

export class SteamRunningError extends ProtiumError {
  constructor(detail?: string) {
    super(
      "blocked",
      "steam-running",
      "steam läuft gerade, die änderung würde beim beenden überschrieben. bitte steam erst beenden.",
      detail,
    );
    this.name = "SteamRunningError";
  }
}

export type ManifestParseErrorCode = "manifest-missing-appstate" | "manifest-invalid-appid";

export class ManifestParseError extends ProtiumError {
  constructor(code: ManifestParseErrorCode, message: string, detail?: string) {
    super(
      code === "manifest-missing-appstate" ? "unreadable" : "incomplete",
      code,
      message,
      detail,
    );
    this.name = "ManifestParseError";
  }
}
