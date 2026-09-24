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
  // Der Anzeigetext liegt in der i18n-Ebene (`errors.codes.steamRunning`);
  // `formatError` übersetzt allein anhand des Codes. Die Meldung trägt deshalb
  // nur den Code, damit im Kern kein Endnutzertext doppelt geführt wird (K-09).
  constructor(detail?: string) {
    super("blocked", "steam-running", "steam-running", detail);
    this.name = "SteamRunningError";
  }
}

type ManifestParseErrorCode = "manifest-missing-appstate" | "manifest-invalid-appid";

export class ManifestParseError extends ProtiumError {
  /** `detail` trägt die diagnostik; die Anzeige kommt aus dem Code über
   *  `errors.codes.manifestMissingAppstate`/`manifestInvalidAppid` (K-09). */
  constructor(code: ManifestParseErrorCode, detail?: string) {
    super(code === "manifest-missing-appstate" ? "unreadable" : "incomplete", code, code, detail);
    this.name = "ManifestParseError";
  }
}
