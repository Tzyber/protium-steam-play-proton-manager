// Reine Helfer des Cleanup-Stores: Installationsstand, Größenübernahme,
// Fehlerzusammenfassung und die Basisfrage "gibt es einen Grund, der das
// Cleanup sperrt". Kein Store-Zustand, kein Pinia — damit einzeln prüfbar.

import type { DirectorySize } from "../../core/ports";
import type { ShortcutResult } from "../../core/shortcuts";
import type { ScanResult } from "../../core/types";
import { t } from "../i18n";

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

/** übernimmt ausschließlich bestätigte messwerte. Jeder fehlende, unbekannte
 *  oder ungültige wert ist ein harter fehler — still 0 zu setzen würde einen
 *  unbekannten platzbedarf als gemessen darstellen. */
export function attachSizes(
  entries: { path: string; sizeBytes?: number }[],
  sizes: Record<string, DirectorySize>,
): void {
  const updates: { entry: { path: string; sizeBytes?: number }; sizeBytes?: number }[] = [];
  for (const entry of entries) {
    if (!Object.hasOwn(sizes, entry.path)) {
      throw new Error(`batchDirSizes: ergebnis für pfad fehlt: ${entry.path}`);
    }
    const size = sizes[entry.path];
    if (!size) {
      throw new Error(`batchDirSizes: ungültiges ergebnis für pfad: ${entry.path}`);
    }
    if (size.status === "missing" || size.status === "failed") {
      updates.push({ entry, sizeBytes: undefined });
      continue;
    }
    if (size.status !== "measured") {
      throw new Error(`batchDirSizes: ungültiger status für pfad: ${entry.path}`);
    }
    if (!Number.isSafeInteger(size.sizeBytes) || size.sizeBytes < 0) {
      throw new Error(`batchDirSizes: ungültige größe für pfad: ${entry.path}`);
    }
    updates.push({ entry, sizeBytes: size.sizeBytes });
  }
  for (const update of updates) {
    update.entry.sizeBytes = update.sizeBytes;
  }
}

export function formatTrashErrors(prepareErrors: string[], executeErrors: string[]): string | null {
  const messages: string[] = [];
  if (prepareErrors.length) {
    messages.push(
      t("cleanup.trashPrepareError", {
        n: prepareErrors.length,
        errors: prepareErrors.join("; "),
      }),
    );
  }
  if (executeErrors.length) {
    messages.push(
      t("cleanup.trashExecuteError", {
        n: executeErrors.length,
        errors: executeErrors.join("; "),
      }),
    );
  }
  return messages.join("; ") || null;
}

export function combineErrors(messages: (string | null)[]): string | null {
  const present = messages.filter((message): message is string => message !== null);
  return present.length > 0 ? present.join("; ") : null;
}

export function hasUnreadableIncompleteDeletions(state: {
  incompleteDeletionsUnreadable: string[];
}): boolean {
  return state.incompleteDeletionsUnreadable.length > 0;
}

/** Sperrt das Cleanup aus einem der belegten Gründe? `blockedBySkipped` und
 *  `pathMissingLibs` sind die fail-closed-Fälle aus der Discovery (INV-2). */
export function hasOrphanUnavailableBase(state: {
  error: string | null;
  orphanError: string | null;
  trashError: string | null;
  shortcutUnreadable: boolean;
  blockedBySkipped: boolean;
  pathMissingLibs: string[];
  incompleteDeletionsUnreadable: string[];
}): boolean {
  // ein alter gesamt-fehler ohne die neueren teilfehler zählt weiter als sperre
  const legacyError =
    state.error !== null &&
    state.orphanError === null &&
    state.trashError === null &&
    !state.shortcutUnreadable;
  return (
    legacyError ||
    state.orphanError !== null ||
    state.blockedBySkipped ||
    state.pathMissingLibs.length > 0 ||
    hasUnreadableIncompleteDeletions(state)
  );
}

/** Auswahl umschalten: dieselbe Regel für Shader-, Prefix- und Papierkorb-Listen. */
export function toggleInSet(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}
