import { parseError } from "../core/errtext.js";
import { type Key, t } from "./i18n/index.js";

/** Code zu gepflegtem Text. Codes ohne eigenen Eintrag fallen auf die
 *  Uebersetzung ihrer Fehlerklasse zurueck; Rohtext zeigt die UI nie. */
const CODE_KEYS: Record<string, Key> = {
  "steam-running": "errors.codes.steamRunning",
  "steam-not-found": "errors.codes.steamNotFound",
  "handler-unavailable": "errors.codes.handlerUnavailable",
  "unsupported-platform": "errors.codes.unsupportedPlatform",
  "unsupported-arch": "errors.codes.unsupportedArch",
  "tool-already-exists": "errors.codes.toolAlreadyExists",
  "invalid-appid": "errors.codes.invalidAppId",
  "invalid-id": "errors.codes.invalidId",
  "invalid-account-id": "errors.codes.invalidAccountId",
  "invalid-url": "errors.codes.invalidUrl",
  "unallowed-scheme": "errors.codes.unallowedScheme",
  "credentials-disallowed": "errors.codes.credentialsDisallowed",
  "host-disallowed": "errors.codes.hostDisallowed",
  "blocked-location": "errors.codes.blockedLocation",
  "not-a-steam-config": "errors.codes.notASteamConfig",
  "unknown-tool": "errors.codes.unknownTool",
  "size-limit-exceeded": "errors.codes.sizeLimitExceeded",
  "not-found": "errors.codes.notFound",
  "not-a-directory": "errors.codes.notADirectory",
  "symlink-rejected": "errors.codes.symlinkRejected",
  "token-expired": "errors.codes.tokenExpired",
  "target-changed": "errors.codes.targetChanged",
  "unsupported-target": "errors.codes.unsupportedTarget",
  "not-an-orphan": "errors.codes.notAnOrphan",
  "library-not-listed": "errors.codes.libraryNotListed",
  "not-a-managed-tool": "errors.codes.notAManagedTool",
  "unverified-rejected": "errors.codes.unverifiedRejected",
  cancelled: "errors.codes.cancelled",
  "checksum-failed": "errors.codes.checksumFailed",
  "download-active": "errors.codes.downloadActive",
  "size-invalid": "errors.codes.sizeInvalid",
  "size-missing": "errors.codes.sizeMissing",
  "manifest-missing-appstate": "errors.codes.manifestMissingAppstate",
  "manifest-invalid-appid": "errors.codes.manifestInvalidAppid",
};

const KIND_KEYS: Record<string, Key> = {
  unavailable: "errors.kinds.unavailable",
  unreadable: "errors.kinds.unreadable",
  incomplete: "errors.kinds.incomplete",
  "not-found": "errors.kinds.notFound",
  unknown: "errors.kinds.unknown",
  blocked: "errors.kinds.blocked",
};

/**
 * Wandelt Fehler einheitlich in lokalisierte Strings um (B1 Fehlersemantik).
 * Bekannte Codes bekommen ihren eigenen Text, alles andere die Uebersetzung
 * der Fehlerklasse. Rohe Backend-Strings oder unuebersetzte Ausnahmen zeigt
 * die Oberflaeche nie.
 */
export function formatErrorKind(kind: string): string {
  return t(KIND_KEYS[kind] ?? "errors.kinds.unknown");
}

export function formatError(e: unknown): string {
  const parsed = parseError(e);
  const key = CODE_KEYS[parsed.code] ?? KIND_KEYS[parsed.kind] ?? "errors.kinds.unknown";
  return t(key);
}

/**
 * Detailklammer fuer gespeicherte Rohwerte (Scan-Warnungen): uebersetzt nur,
 * was als kanonischer Code erkennbar ist. Ein unbekannter Rohtext verschwindet
 * aus der Oberflaeche — der klassifizierte Grund bleibt sichtbar, der Rohtext
 * bleibt im lokalen Protokoll.
 */
export function formatDetail(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (parseError(raw).code === "unknown") return undefined;
  return formatError(raw);
}
