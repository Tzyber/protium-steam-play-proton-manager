// Papierkorb-Actions des cleanup-Stores (R-01): aus `cleanupStore.ts`
// herausgelöst, damit der Store kleiner wird. Die Actions bleiben
// Options-Store-Methoden; hier stehen sie als Funktionen mit dem Store als
// erstem Parameter und rufen einander über `store.` auf, damit die
// `vi.spyOn`-Spies der Tests weiter greifen.

import { tauriPorts } from "../../core/adapters/tauri";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import { localizeConsequences } from "../consequences";
import { logError } from "../diagnostics";
import { formatKnownBytes } from "../format";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { formatSizeSummary } from "../sizeSummary";
import {
  attachSizes,
  batchInfoLines,
  batchTooLargeText,
  cleanupTurn,
  combineErrors,
  confirmTitle,
  formatTrashErrors,
} from "./cleanupHelpers";
import { MAX_PENDING_DELETES } from "./cleanupStore";
import { useConfirmStore } from "./confirmStore";
import { useScanStore } from "./scanStore";

/** genau die Store-teile, die diese beiden Actions über `store.` nutzen.
 *  Bewusst kein `ReturnType<typeof useCleanupStore>`: das erzeugt einen
 *  zirkulären Typ (TS7022), weil cleanupStore diese Datei importiert. */
export interface TrashStore {
  trash: TrashEntry[];
  trashUnknown: string[];
  trashLibraries: TrashLibraryStatus[];
  trashScanning: boolean;
  trashError: string | null;
  _trashScanError: string | null;
  _trashScanGeneration: number;
  clearTrashState(): void;
  setTrashError(message: string | null): void;
  setTrashScanError(message: string): void;
  scanTrash(): Promise<void>;
}

export async function scanTrash(store: TrashStore): Promise<void> {
  const generation = store._trashScanGeneration + 1;
  store._trashScanGeneration = generation;
  store.clearTrashState();

  const { result, isCurrent } = cleanupTurn(
    useScanStore(),
    generation,
    () => store._trashScanGeneration,
  );
  if (!result) {
    store.setTrashScanError(t("errors.noScanResult"));
    return;
  }

  store.trashScanning = true;
  store.setTrashError(null);

  try {
    const { entries, unknown, unreadable, libraries } = await findTrashEntries(
      result.libraries,
      tauriPorts.system,
    );
    if (!isCurrent()) return;
    store.trash = entries;
    store.trashUnknown = unknown;
    store.trashLibraries = libraries;

    // ein nicht lesbarer papierkorb darf nicht als "leer" durchgehen
    if (unreadable.length) {
      store.setTrashScanError(t("cleanup.trashUnreadable", { paths: unreadable.join(", ") }));
    }

    if (entries.length === 0) return;

    const paths = entries.map((e) => e.path);
    const sizes = await tauriPorts.system.batchDirSizes(paths);
    if (!isCurrent()) return;
    attachSizes(store.trash, sizes);
  } catch (e) {
    logError("Papierkorb-Scan fehlgeschlagen", e);
    if (isCurrent()) store.setTrashScanError(formatError(e));
  } finally {
    if (isCurrent()) store.trashScanning = false;
  }
}

/** verarbeitet höchstens MAX_PENDING_DELETES einträge je bestätigung
 *  (ein backend-token je batch); `remainder` ist die zahl der einträge des
 *  snapshots, die dieser durchgang nicht anfasst, und wird im dialog
 *  genannt. */
export async function deleteTrashEntries(
  store: TrashStore,
  entries: TrashEntry[],
  remainder = 0,
  onConfirmed?: (paths: string[]) => void,
): Promise<void> {
  if (entries.length > MAX_PENDING_DELETES) {
    store.setTrashError(
      combineErrors([
        store._trashScanError,
        batchTooLargeText(entries.length, MAX_PENDING_DELETES),
      ]),
    );
    return;
  }
  const { result, isCurrent } = cleanupTurn(
    useScanStore(),
    store._trashScanGeneration,
    () => store._trashScanGeneration,
  );
  // fail-closed wie deleteOrphans: ohne scan-snapshot gibt es kein steamRoot,
  // und mit leerem root lief der pfad als irreführender prepare-fehler weiter
  // statt als noScanResult abzubrechen (N-7).
  if (!result) {
    store.setTrashError(t("errors.noScanResult"));
    return;
  }
  const steamRoot = result.steamRoot;
  const confirm = useConfirmStore();
  const reservation = confirm.reserve();
  if (reservation === null) return;
  if (isCurrent()) store.setTrashError(store._trashScanError);
  const prepareErrors: string[] = [];
  const executeErrors: string[] = [];
  const prepared: {
    token: string;
    path: string;
    name: string;
    descriptions: string[];
  }[] = [];

  for (const entry of entries) {
    if (!isCurrent()) break;
    try {
      const pending = await tauriPorts.system.prepareDelete({
        targetType: "trash",
        path: entry.path,
        steamRoot,
      });
      prepared.push({
        token: pending.token,
        path: entry.path,
        name: entry.name,
        descriptions: localizeConsequences(pending),
      });
    } catch (e) {
      prepareErrors.push(`${entry.name}: ${formatError(e)}`);
    }
  }

  if (!isCurrent()) {
    confirm.release(reservation);
    return;
  }
  store.setTrashError(
    combineErrors([store._trashScanError, formatTrashErrors(prepareErrors, executeErrors)]),
  );
  if (!prepared.length) {
    confirm.release(reservation);
    return;
  }

  const partialPrepareMessage =
    prepareErrors.length > 0 ? t("cleanup.trashPrepareWarning", { n: prepareErrors.length }) : null;
  // bei mehr als MAX_PENDING_DELETES einträgen wird bewusst in batches
  // gearbeitet (ein backend-token je batch, eine bestätigung je batch aus
  // INV-6): der dialog nennt grenze und rest statt eines stillen rests.
  const batchInfo = batchInfoLines("cleanup.trashBatchInfo", MAX_PENDING_DELETES, remainder);
  // Die Summe beschreibt genau die bestätigten Ziele: nur die tatsächlich
  // vorbereiteten Einträge zählen, und unbekannte Größen werden nicht als
  // 0 mitgezählt (Q3/INV-6), sondern als "nicht gemessen"/"teilweise"
  // ausgewiesen.
  const preparedPaths = new Set(prepared.map((p) => p.path));
  const preparedEntries = entries.filter((entry) => preparedPaths.has(entry.path));
  // formatKnownBytes: eine gemessene 0 ist "0 B", nicht "nicht gemessen".
  // der name ist bewusst nicht `sizeText`: so heißt die format-hilfe in
  // format.ts, hier steht ein fertiger summentext.
  const summaryText = formatSizeSummary(preparedEntries, formatKnownBytes);
  const accepted = confirm.ask(
    {
      title: confirmTitle(
        "cleanup.trashDeleteConfirmSingle",
        "cleanup.trashDeleteConfirmTitle",
        prepared.length,
      ),
      message: [
        t("cleanup.trashDeleteWarning", { size: summaryText }),
        partialPrepareMessage,
        ...batchInfo,
        ...prepared.flatMap((p) => p.descriptions),
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
    {
      onSuccess: async () => {
        // wie in deleteOrphans; an prepare gescheiterte standen nicht im dialog.
        onConfirmed?.(prepared.map((p) => p.path));
        let deleted = false;
        for (const p of prepared) {
          try {
            await tauriPorts.system.executeDelete(p.token);
            if (isCurrent()) {
              store.trash = store.trash.filter((e) => e.path !== p.path);
              deleted = true;
            }
          } catch (e) {
            if (isCurrent()) executeErrors.push(`${p.name}: ${formatError(e)}`);
          }
        }
        if (!isCurrent()) return;
        // A-06: der stand je library (einträge im papierkorb) wird nach der
        // mutation neu gelesen; sonst bleibt der zähler von vor dem löschen
        // stehen. scanTrash setzt trashError zurück; ein anschließendes
        // null darf das neue ergebnis nicht löschen. ein löschfehler wird
        // mit dem rescan-fehler zusammengeführt, sonst verdrängt der
        // löschtext die meldung (INV-2).
        if (deleted) {
          const refresh = store._trashScanGeneration + 1;
          await store.scanTrash();
          // ein neuerer lauf hat übernommen: dessen ergebnis stehen lassen.
          if (store._trashScanGeneration !== refresh) return;
        }
        const deleteMessage = formatTrashErrors(prepareErrors, executeErrors);
        if (deleteMessage !== null) {
          // ohne rescan steht der prepare-text schon in trashError,
          // anhängen würde ihn verdoppeln; die basis ist der alte
          // scan-fehler. nach dem rescan ist trashError nur noch der neue
          // lesefehler, der löschtext kommt dazu.
          store.setTrashError(
            combineErrors([deleted ? store.trashError : store._trashScanError, deleteMessage]),
          );
        }
      },
      onError: (e) => {
        logError("Papierkorb leeren fehlgeschlagen", e);
        if (isCurrent()) {
          executeErrors.push(formatError(e));
          store.setTrashError(
            combineErrors([store._trashScanError, formatTrashErrors(prepareErrors, executeErrors)]),
          );
        }
      },
    },
    reservation,
  );
  if (!accepted) confirm.release(reservation);
}
