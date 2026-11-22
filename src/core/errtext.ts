import { ProtiumError, type ProtiumErrorKind } from "./errors.js";
import { isRecord } from "./guards.js";

function isCodedError(e: unknown): e is { code: string; detail?: unknown } {
  return !(e instanceof Error) && isRecord(e) && typeof e.code === "string";
}

/** rust-commands rejecten mit einem rohen string (kein Error-objekt).
 *  `(e as Error).message` wäre dann `undefined` und die echte ursache weg. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (isCodedError(e)) {
    return typeof e.detail === "string" && e.detail.length > 0 ? `${e.code}: ${e.detail}` : e.code;
  }
  return String(e);
}

/** Code zu Fehlerklasse (Spec Welle B, Abschnitt 1.1/1.3). Der Code ist der
 *  Vertrag; er kommt aus dem Backend (`src-tauri/src/commands/errcode.rs`)
 *  oder aus einem ProtiumError. Unbekannte Codes bleiben `unknown`, aus dem
 *  Meldungstext wird nichts geraten. */
const CODE_KINDS: Record<string, ProtiumErrorKind> = {
  "invalid-appid": "unknown",
  "invalid-url": "unknown",
  "invalid-id": "unknown",
  "invalid-value": "blocked",
  "invalid-account-id": "unknown",
  "unallowed-scheme": "blocked",
  "credentials-disallowed": "blocked",
  "host-disallowed": "blocked",
  "handler-unavailable": "unavailable",
  "unsupported-platform": "unavailable",
  "unsupported-arch": "unavailable",
  "steam-running": "blocked",
  // P8: ein nicht belegbarer Steam-Status ist weder "läuft" noch "läuft
  // nicht". Er blockiert schreiben/löschen, trägt aber eine eigene klasse.
  "steam-check-unavailable": "unavailable",
  "steam-not-found": "not-found",
  "steam-root-symlink-unsupported": "blocked",
  "blocked-location": "blocked",
  "not-a-steam-config": "blocked",
  "unknown-tool": "blocked",
  "tool-already-exists": "blocked",
  "size-limit-exceeded": "incomplete",
  "too-large-for-trash": "blocked",
  "not-found": "not-found",
  "not-a-directory": "unreadable",
  "symlink-rejected": "blocked",
  "token-expired": "blocked",
  // 5.8: ein unbekanntes oder verdrängtes Lösch-Token ist eine Blockade wie
  // das abgelaufene; invalid-id bleibt unknown (syntaktisch falsche ID).
  "token-unknown": "blocked",
  "target-changed": "blocked",
  "unsupported-target": "blocked",
  "not-an-orphan": "blocked",
  "library-not-listed": "blocked",
  "not-a-managed-tool": "blocked",
  "write-may-have-applied": "incomplete",
  "unverified-rejected": "blocked",
  cancelled: "unavailable",
  "checksum-failed": "incomplete",
  "download-active": "unavailable",
  // nur TS-seitig (manifest.ts, cleanupHelpers.ts), nicht in errcode.rs. vorher
  // fehlten sie hier, dadurch fiel parseError auf "unknown" zurück und die
  // klasse ging als gespeicherter roh-string verloren. die aufnahme macht
  // scan-warnungsdetails sichtbar; gewollt, sonst verlöre das detail seine
  // klassifikation (Q-03).
  "size-invalid": "incomplete",
  "size-missing": "incomplete",
  "manifest-missing-appstate": "unreadable",
  "manifest-invalid-appid": "incomplete",
  incomplete: "incomplete",
  unreadable: "unreadable",
  unavailable: "unavailable",
  blocked: "blocked",
  unknown: "unknown",
};

/** Format aus Spec 1.3: reiner Code oder "code: detail". */
const CODE_PATTERN = /^([a-z][a-z0-9-]*)(?::\s*([\s\S]*))?$/;

interface ParsedError {
  kind: ProtiumErrorKind;
  code: string;
  message: string;
  detail?: string;
}

function classifyCode(code: string, message: string, detail?: string): ParsedError | null {
  // hasOwn, sonst liefert "constructor" den Object-konstruktor aus dem prototyp
  const kind = Object.hasOwn(CODE_KINDS, code) ? CODE_KINDS[code] : undefined;
  if (!kind) return null;
  return detail === undefined ? { kind, code, message } : { kind, code, message, detail };
}

export function parseError(e: unknown): ParsedError {
  if (e instanceof ProtiumError) {
    return {
      kind: e.kind,
      code: e.code,
      message: e.message,
      detail: e.detail,
    };
  }

  const raw = errText(e);
  if (isCodedError(e)) {
    const detail = typeof e.detail === "string" && e.detail.length > 0 ? e.detail : undefined;
    return classifyCode(e.code, raw, detail) ?? { kind: "unknown", code: "unknown", message: raw };
  }

  const match = CODE_PATTERN.exec(raw.trim());
  if (match) {
    const classified = classifyCode(match[1] ?? "", raw, match[2]);
    if (classified) return classified;
  }

  return { kind: "unknown", code: "unknown", message: raw };
}
