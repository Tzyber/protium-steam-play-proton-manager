import type { ProtiumErrorKind } from "./errors.js";
import type { SkipReason } from "./types.js";

/** Uebersetzung der Discovery-Gruende in die kanonischen Fehlerklassen (B1).
 *  `unknown` gibt es hier nicht: jeder Grund ist belegt. */
const SKIP_REASON_KINDS: Record<SkipReason, ProtiumErrorKind> = {
  "path-missing": "not-found",
  "scope-failed": "blocked",
  "read-failed": "unreadable",
  unverified: "incomplete",
};

export function skipReasonKind(reason: SkipReason): ProtiumErrorKind {
  return SKIP_REASON_KINDS[reason];
}
