import type { ProtiumErrorKind } from "./errors.js";
import { skipReasonKind } from "./skipReason.js";
import type { ScanResult } from "./types.js";

/** Ein Eintrag des Pruefberichts fuer "warum ist das blockiert" (B2). */
interface BlockedReportItem {
  path: string;
  kind: ProtiumErrorKind;
}

/**
 * Sammelt die fail-closed-Gruende des Scans fuer die Anzeige. Eine Quelle fuer
 * Klassifizierung und Dedupe; die View rendert nur noch.
 *
 * `path-missing` fehlt bewusst: dieser Fall hat eine eigene, entlastende
 * Hinweisflaeche (die Bibliothek ist nicht eingebunden, nicht gesperrt).
 */
export function blockedReport(result: ScanResult | null): BlockedReportItem[] {
  if (!result) return [];
  const items: BlockedReportItem[] = [];
  for (const skipped of result.skippedLibraries) {
    if (skipped.reason === "path-missing") continue;
    items.push({ path: skipped.path, kind: skipReasonKind(skipped.reason) });
  }
  for (const path of result.cleanupUnsafeLibraries) {
    items.push({ path, kind: "blocked" });
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}
