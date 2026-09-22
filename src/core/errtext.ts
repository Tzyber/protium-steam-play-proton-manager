import { ProtiumError, type ProtiumErrorKind } from "./errors.js";

/** rust-commands rejecten mit einem rohen string (kein Error-objekt).
 *  `(e as Error).message` wäre dann `undefined` und die echte ursache weg. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
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
  "invalid-account-id": "unknown",
  "unallowed-scheme": "blocked",
  "credentials-disallowed": "blocked",
  "host-disallowed": "blocked",
  "handler-unavailable": "unavailable",
  "unsupported-platform": "unavailable",
  "unsupported-arch": "unavailable",
  "steam-running": "blocked",
  "steam-not-found": "not-found",
  "blocked-location": "blocked",
  "not-a-steam-config": "blocked",
  "unknown-tool": "blocked",
  "tool-already-exists": "blocked",
  "size-limit-exceeded": "incomplete",
  "not-found": "not-found",
  "not-a-directory": "unreadable",
  "symlink-rejected": "blocked",
  "token-expired": "blocked",
  "target-changed": "blocked",
  "unsupported-target": "blocked",
  "not-an-orphan": "blocked",
  "library-not-listed": "blocked",
  "not-a-managed-tool": "blocked",
  "unverified-rejected": "blocked",
  cancelled: "unavailable",
  "checksum-failed": "incomplete",
  "download-active": "unavailable",
  incomplete: "incomplete",
  unreadable: "unreadable",
  unavailable: "unavailable",
  blocked: "blocked",
  unknown: "unknown",
};

/** Format aus Spec 1.3: reiner Code oder "code: detail". */
const CODE_PATTERN = /^([a-z][a-z0-9-]*)(?::\s*([\s\S]*))?$/;

export interface ParsedError {
  kind: ProtiumErrorKind;
  code: string;
  message: string;
  detail?: string;
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
  const match = CODE_PATTERN.exec(raw.trim());
  if (match) {
    const code = match[1] ?? "";
    const kind = CODE_KINDS[code];
    if (kind) {
      const detail = match[2];
      return detail === undefined
        ? { kind, code, message: raw }
        : { kind, code, message: raw, detail };
    }
  }

  return { kind: "unknown", code: "unknown", message: raw };
}
