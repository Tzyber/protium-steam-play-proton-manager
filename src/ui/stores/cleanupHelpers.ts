// Reine UI-Helfer des Cleanup-Stores (Größenübernahme, Fehler- und Dialogtexte).
// Alle UI-freien Gate-/Sperrregeln liegen in `src/core/cleanupGate.ts` (INV-5)
// und werden hier für Store- und Test-Aufrufer weitergereicht.

import { ProtiumError } from "../../core/errors";
import { validNonNegativeInteger } from "../../core/guards";
import type { DirectorySize } from "../../core/ports";
import type { Key } from "../i18n";
import { t } from "../i18n";

export {
  cleanupBlockedFlags,
  collectInstalledAppIds,
  hasOrphanUnavailableBase,
  hasUnreadableOrphanType,
  isCurrentForScan,
  mergeOrphanUnreadable,
} from "../../core/cleanupGate";

/** übernimmt ausschließlich bestätigte messwerte. Jeder fehlende, unbekannte
 *  oder ungültige wert ist ein harter fehler, still 0 zu setzen würde einen
 *  unbekannten platzbedarf als gemessen darstellen. */
export function attachSizes(
  entries: { path: string; sizeBytes?: number }[],
  sizes: Record<string, DirectorySize>,
): void {
  const updates: { entry: { path: string; sizeBytes?: number }; sizeBytes?: number }[] = [];
  for (const entry of entries) {
    if (!Object.hasOwn(sizes, entry.path)) {
      throw new ProtiumError(
        "incomplete",
        "size-missing",
        `batchDirSizes: ergebnis für pfad fehlt: ${entry.path}`,
      );
    }
    const size = sizes[entry.path];
    if (!size) {
      throw new ProtiumError(
        "incomplete",
        "size-invalid",
        `batchDirSizes: ungültiges ergebnis für pfad: ${entry.path}`,
      );
    }
    if (size.status === "missing" || size.status === "failed") {
      updates.push({ entry, sizeBytes: undefined });
      continue;
    }
    if (size.status !== "measured") {
      throw new ProtiumError(
        "incomplete",
        "size-invalid",
        `batchDirSizes: ungültiger status für pfad: ${entry.path}`,
      );
    }
    const sizeBytes = validNonNegativeInteger(size.sizeBytes);
    if (sizeBytes === null) {
      throw new ProtiumError(
        "incomplete",
        "size-invalid",
        `batchDirSizes: ungültige größe für pfad: ${entry.path}`,
      );
    }
    updates.push({ entry, sizeBytes });
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

/** batch-zu-groß-text; die fehler-zusammenführung bleibt an der aufrufstelle. */
export function batchTooLargeText(n: number, max: number): string {
  return t("errors.deleteBatchTooLarge", { n, max });
}

/** eine zeile für den batch-hinweis, wenn ein rest bleibt. */
export function batchInfoLines(key: Key, max: number, rest: number): string[] {
  return rest > 0 ? [t(key, { max, rest })] : [];
}

/** titel des bestätigungsdialogs: bei einem eintrag der singular-schlüssel. */
export function confirmTitle(singleKey: Key, multiKey: Key, n: number): string {
  return n === 1 ? t(singleKey, { n }) : t(multiKey, { n });
}

/** Der EINZIGE Übersetzungsort des Papierkorb-Sperrtextes. Die Aufrufer halten
 *  nur den sprachunabhängigen Fakt `trashDeleteBlocked` und übersetzen beim
 *  render; ein Sprachwechsel nimmt den stehenden Sperrgrund damit mit. Der
 *  gespeicherte `trashError` bleibt dagegen ein transienter Fehlertext in der
 *  Sprache seines Schreibzeitpunkts (FR-1). */
export function trashDeleteBlockedText(blocked: boolean): string | null {
  return blocked ? t("cleanup.trashDeleteBlocked") : null;
}

/** Auswahl umschalten: dieselbe Regel für Shader-, Prefix- und Papierkorb-Listen. */
export function toggleInSet(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}
