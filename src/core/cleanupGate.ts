// Reine Cleanup-Gate- und Sperrlogik ohne UI-/Store-Abhängigkeit (INV-5).
// Prüft Scan-Vertragsintegrität, Blockierpfade, Installationsabgleich und
// bereichsgenaue Sperrgründe für Anzeige und Löschpfad.

import type { IncompleteDeletion, OrphanUnreadable } from "./cleanup.js";
import { blockedReport } from "./cleanupBlocked.js";
import { isString, isValidAppId, requireArrayOf } from "./guards.js";
import type { ShortcutResult } from "./shortcuts.js";
import type { TrashLibraryStatus } from "./trash.js";
import type { OrphanEntry, ScanResult, SkippedLibrary } from "./types.js";

export type OrphanBlockReason =
  | { kind: "unreadable-dirs"; paths: string[] }
  | { kind: "claims-unreadable"; paths: string[] }
  | { kind: "incomplete-deletions" }
  | { kind: "scan-error"; message: string };

/** fail-closed-prüfung des scan-vertrags und die Blockier-Pfade des Snapshots
 *  in einer regel (N5a/5.14): scan- und löschpfad dürfen nicht zwei fassungen
 *  derselben bedingung führen. `null` = vertrag verletzt (etwa ein fehlendes
 *  oder fremdes feld), sonst die pfade, die einen lauf sperren. */
export function scanBlockers(result: ScanResult): string[] | null {
  if (
    requireArrayOf(result.cleanupUnsafeLibraries, isString) === null ||
    requireArrayOf(result.blockedAppIds, isValidAppId) === null
  ) {
    return null;
  }
  return blockedReport(result).map((item) => item.path);
}

/** Liefert alle noch unbeantworteten `path-missing`-Bibliotheken. */
export function unansweredPathMissingLibs(
  skipped: readonly SkippedLibrary[],
  ignoredMissingLibs: readonly string[],
): string[] {
  return skipped
    .filter((s) => s.reason === "path-missing" && !ignoredMissingLibs.includes(s.path))
    .map((s) => s.path);
}

/** Baut den aktuellen Installationsstatus aus Spielen und Shortcuts statt auf
 *  einen veralteten scan-stand zu vertrauen; der cleanup-race-schutz lebt hier. */
export function collectInstalledAppIds(
  result: ScanResult,
  shortcutResult: ShortcutResult,
): Set<number> {
  const installedAppIds = new Set(result.games.map((g) => g.appId));
  if (shortcutResult.status === "ok") {
    for (const id of shortcutResult.ids) installedAppIds.add(id);
  }
  return installedAppIds;
}

/** Sperrt das Cleanup aus einem der belegten Gründe? `blockedBySkipped` und
 *  `pathMissingLibs` sind die fail-closed-Fälle aus der Discovery (INV-2).
 *  Die unlesbaren Orphan-Basisverzeichnisse stehen absichtlich NICHT hier,
 *  sondern in `hasUnreadableOrphanType`: ein unlesbares compatdata ist von
 *  einem unlesbaren shadercache sicher zu trennen, sonst sperrt ein Bereich den
 *  anderen ohne Beleg. */
export function hasOrphanUnavailableBase(state: {
  orphanError: string | null;
  blockedBySkipped: boolean;
  pathMissingLibs: readonly string[];
  incompleteDeletionsUnreadable: readonly string[];
}): boolean {
  return (
    state.orphanError !== null ||
    state.blockedBySkipped ||
    state.pathMissingLibs.length > 0 ||
    state.incompleteDeletionsUnreadable.length > 0
  );
}

/** Sperrt genau dieser Orphan-Bereich wegen eines unlesbaren Basisverzeichnisses?
 *  Typ-genau: `shadercache` prüft shadercache-Pfade, `compatdata` compatdata. */
export function hasUnreadableOrphanType(
  state: { orphanUnreadable: readonly OrphanUnreadable[] },
  type: OrphanEntry["type"],
): boolean {
  return state.orphanUnreadable.some((entry) => entry.type === type);
}

export interface CleanupBlockedFlags {
  base: boolean;
  shader: boolean;
  prefix: boolean;
  trash: boolean;
  trashDelete: boolean;
  any: boolean;
}

/** Die eine Sperrquelle für Coverage und Löschdialog: getrennte Antworten
 *  widersprechen sich bei „unvollständig". `base` gilt bereichsübergreifend,
 *  `shader`/`prefix` sind typ-genau, `trash` hängt am Papierkorb-Scan, `any`
 *  ist die Sperre der Anzeige. `trashDelete` ist die Löschsperre des
 *  Papierkorbs: gleiche Terme wie `trash`, aber ohne `trashUnknown`. Ein
 *  unbekannter Eintrag ist nur nicht angeboten; er belegt keinen
 *  unvollständigen Scan und darf das Löschen der erkannten Einträge nicht
 *  verhindern (FR-4). */
export function cleanupBlockedFlags(facts: {
  orphanScanError: string | null;
  blockedBySkipped: boolean;
  pathMissingLibs: readonly string[];
  incompleteDeletionsUnreadable: readonly string[];
  shortcutUnreadable: boolean;
  orphanUnreadable: readonly OrphanUnreadable[];
  incompleteDeletions: readonly { type: IncompleteDeletion["type"] }[];
  trashScanError: string | null;
  trashUnknown: readonly string[];
  trashLibraries: readonly TrashLibraryStatus[];
}): CleanupBlockedFlags {
  const base = hasOrphanUnavailableBase({
    orphanError: facts.orphanScanError,
    blockedBySkipped: facts.blockedBySkipped,
    pathMissingLibs: facts.pathMissingLibs,
    incompleteDeletionsUnreadable: facts.incompleteDeletionsUnreadable,
  });
  const shader =
    base ||
    hasUnreadableOrphanType(facts, "shadercache") ||
    facts.incompleteDeletions.some((deletion) => deletion.type === "shadercache");
  const prefix =
    base ||
    facts.shortcutUnreadable ||
    hasUnreadableOrphanType(facts, "compatdata") ||
    facts.incompleteDeletions.some((deletion) => deletion.type === "compatdata");
  const hasDeletionRest =
    facts.incompleteDeletionsUnreadable.length > 0 ||
    facts.incompleteDeletions.some((deletion) => deletion.type === "trash");
  const trashLibraryError = facts.trashLibraries.some((library) => library.error !== undefined);
  const trash =
    facts.trashScanError !== null ||
    facts.trashUnknown.length > 0 ||
    trashLibraryError ||
    hasDeletionRest;
  const trashDelete = facts.trashScanError !== null || trashLibraryError || hasDeletionRest;
  return { base, shader, prefix, trash, trashDelete, any: shader || prefix || trash };
}

/** Wählt bei gesperrten Orphan-Bereichen den konkretesten Beleg in fester
 *  Reihenfolge (M1): typ-genaues unlesbares Verzeichnis, unlesbarer Claim-Parent,
 *  liegender Claim-Rest desselben Typs, oder Scan-Fehler. */
export function resolveOrphanBlockReason(
  state: {
    orphanUnreadable: readonly OrphanUnreadable[];
    incompleteDeletionsUnreadable: readonly string[];
    incompleteDeletions: readonly { type: IncompleteDeletion["type"] }[];
    orphanScanError: string | null;
  },
  blockedTypes: readonly OrphanEntry["type"][],
): OrphanBlockReason | null {
  const unreadablePaths = state.orphanUnreadable
    .filter((entry) => blockedTypes.includes(entry.type))
    .map((entry) => entry.path);
  if (unreadablePaths.length > 0) {
    return { kind: "unreadable-dirs", paths: unreadablePaths };
  }
  if (state.incompleteDeletionsUnreadable.length > 0) {
    return { kind: "claims-unreadable", paths: [...state.incompleteDeletionsUnreadable] };
  }
  if (state.incompleteDeletions.some((entry) => blockedTypes.some((type) => type === entry.type))) {
    return { kind: "incomplete-deletions" };
  }
  if (state.orphanScanError !== null) {
    return { kind: "scan-error", message: state.orphanScanError };
  }
  return null;
}

/** Führt die typ-genauen Unlesbar-Listen zweier Scans zusammen und dedupliziert
 *  nach `path+type` (beide Scans sehen dieselben compatdata-Verzeichnisse, ein
 *  Ort darf nur einmal gemeldet werden). Die Reihenfolge des ersten Vorkommens
 *  bleibt erhalten. */
export function mergeOrphanUnreadable(
  ...lists: readonly (readonly OrphanUnreadable[])[]
): OrphanUnreadable[] {
  const merged: OrphanUnreadable[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const entry of list) {
      const key = `${entry.type}:${entry.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/** Generations-guard eines cleanup-Laufs: eigene Generation, Generation des
 *  Library-Scans und ein Scan-Stand, in dem ein Ergebnis gilt. Eine neue eigene
 *  Generation oder ein Library-Rescan macht den Lauf ungültig, seine Antwort
 *  darf nichts mehr eintragen (INV-2); genau deshalb bleibt der Vergleich streng
 *  und wird nicht gelockert. */
export function isCurrentForScan(guard: {
  generation: number;
  currentGeneration: number;
  sourceScanGeneration: number;
  scan: { scanGeneration: number; status: string };
}): boolean {
  return (
    guard.generation === guard.currentGeneration &&
    guard.scan.scanGeneration === guard.sourceScanGeneration &&
    (guard.scan.status === "done" || guard.scan.status === "idle")
  );
}

/** Quell-Generation sofort festhalten, eigene Generation erst in `isCurrent`
 *  lesen. Ein Library-Rescan oder ein neuer eigener Lauf dazwischen macht die
 *  Antwort ungültig (INV-2). Ein laufender Scan liefert kein Ergebnis. */
export function cleanupTurn<T>(
  scan: { status: string; result: T | null; scanGeneration: number },
  generation: number,
  currentGeneration: () => number,
): { result: T | null; isCurrent: () => boolean } {
  const sourceScanGeneration = scan.scanGeneration;
  const result = scan.status === "done" || scan.status === "idle" ? scan.result : null;
  const isCurrent = () =>
    isCurrentForScan({
      generation,
      currentGeneration: currentGeneration(),
      sourceScanGeneration,
      scan,
    });
  return { result, isCurrent };
}
