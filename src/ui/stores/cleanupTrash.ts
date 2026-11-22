// Papierkorb-Actions des cleanup-Stores (R-01): aus `cleanupStore.ts`
// herausgelöst, damit der Store kleiner wird. Die Actions bleiben
// Options-Store-Methoden; hier stehen sie als Funktionen mit dem Store als
// erstem Parameter und rufen einander über `store.` auf, damit die
// `vi.spyOn`-Spies der Tests weiter greifen.

import { cleanupTurn } from "../../core/cleanupGate";
import { parseError } from "../../core/errtext.js";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import { localizeConsequences } from "../consequences";
import { logError } from "../diagnostics";
import { formatKnownBytes } from "../format";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { ports } from "../ports";
import { formatSizeSummary } from "../sizeSummary";
import {
  attachSizes,
  batchInfoLines,
  batchTooLargeText,
  combineErrors,
  confirmTitle,
  formatTrashErrors,
  trashDeleteBlockedText,
} from "./cleanupHelpers";
import { MAX_PENDING_DELETES } from "./cleanupStore";
import { runDeleteFlow } from "./deleteFlow";
import { useScanStore } from "./scanStore";

/** genau die Store-teile, die diese beiden Actions über `store.` nutzen.
 *  Bewusst kein `ReturnType<typeof useCleanupStore>`: das erzeugt einen
 *  zirkulären Typ (TS7022), weil cleanupStore diese Datei importiert. */
interface TrashStore {
  trash: TrashEntry[];
  trashUnknown: string[];
  trashLibraries: TrashLibraryStatus[];
  trashScanning: boolean;
  trashError: string | null;
  /** true, solange ein Scanfehler oder ein Löschrest das Löschen sperrt
   *  (dieselben Terme wie `cleanupBlockedFlags(...).trashDelete`). Der sichtbare
   *  Grund wird erst beim render übersetzt (FR-1, FR-4). */
  trashDeleteBlocked: boolean;
  _trashScanError: string | null;
  _trashScanGeneration: number;
  clearTrashState(): void;
  setTrashError(message: string | null): void;
  setTrashScanError(message: string): void;
  scanTrash(): Promise<void>;
  /** Nach einem fehlgeschlagenen Execute kann ein Claim-Rest entstanden sein;
   *  der Orphan-Scan macht ihn sichtbar und sperrt den Papierkorb (FR-4). */
  scanOrphans(): Promise<void>;
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
      ports.system,
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
    const sizes = await ports.system.batchDirSizes(paths);
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
  // Position wie deleteOrphans: das 32er-Gate bleibt zuerst, danach die Sperre.
  // Ein Scanfehler oder ein Löschrest macht die Vorschau unvollständig; ein
  // Löschversuch würde nur einen Teil der Ziele sehen (FR-4). Der vorhandene
  // Fehlertext wird dabei nicht überschrieben, sondern ergänzt.
  if (store.trashDeleteBlocked) {
    store.setTrashError(
      combineErrors([store._trashScanError, trashDeleteBlockedText(store.trashDeleteBlocked)]),
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
  const prepareErrors: string[] = [];
  const executeErrors: string[] = [];
  let deleted = false;
  let mayHaveClaimRest = false;

  await runDeleteFlow({
    items: entries,
    isCurrent,
    onReserve: () => {
      if (isCurrent()) store.setTrashError(store._trashScanError);
    },
    prepareItem: async (entry) => {
      const pending = await ports.system.prepareDelete({
        targetType: "trash",
        path: entry.path,
        steamRoot,
      });
      return {
        token: pending.token,
        path: entry.path,
        name: entry.name,
        descriptions: localizeConsequences(pending),
      };
    },
    onPrepareError: (entry, e) => {
      prepareErrors.push(`${entry.name}: ${formatError(e)}`);
    },
    beforeConfirm: () => {
      store.setTrashError(
        combineErrors([store._trashScanError, formatTrashErrors(prepareErrors, executeErrors)]),
      );
    },
    buildDialog: (prepared) => {
      const partialPrepareMessage =
        prepareErrors.length > 0
          ? t("cleanup.trashPrepareWarning", { n: prepareErrors.length })
          : null;
      const batchInfo = batchInfoLines("cleanup.trashBatchInfo", MAX_PENDING_DELETES, remainder);
      const preparedPaths = new Set(prepared.map((p) => p.path));
      const preparedEntries = entries.filter((entry) => preparedPaths.has(entry.path));
      const summaryText = formatSizeSummary(preparedEntries, formatKnownBytes);
      return {
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
      };
    },
    onConfirmed: (prepared) => {
      onConfirmed?.(prepared.map((p) => p.path));
    },
    onExecuted: (p) => {
      store.trash = store.trash.filter((e) => e.path !== p.path);
      deleted = true;
    },
    onExecuteError: (p, e) => {
      logError(`Papierkorb-Eintrag löschen fehlgeschlagen (${p.name})`, e);
      if (parseError(e).code === "write-may-have-applied") mayHaveClaimRest = true;
      if (isCurrent()) executeErrors.push(`${p.name}: ${formatError(e)}`);
    },
    afterExecute: async () => {
      if (mayHaveClaimRest) {
        let steamRunning = true;
        try {
          steamRunning = await ports.system.isSteamRunning();
        } catch (e) {
          logError("Steam-Status nach Papierkorb-Löschung nicht prüfbar", e);
        }
        if (!isCurrent()) return;
        if (!steamRunning) {
          await store.scanOrphans();
          if (!isCurrent()) return;
        }
      }
      if (deleted) {
        const refresh = store._trashScanGeneration + 1;
        await store.scanTrash();
        if (store._trashScanGeneration !== refresh) return;
      }
      const deleteMessage = formatTrashErrors(prepareErrors, executeErrors);
      if (deleteMessage !== null) {
        store.setTrashError(
          combineErrors([deleted ? store.trashError : store._trashScanError, deleteMessage]),
        );
      }
    },
    onUnexpectedError: (e) => {
      logError("Papierkorb leeren fehlgeschlagen", e);
      executeErrors.push(formatError(e));
      store.setTrashError(
        combineErrors([store._trashScanError, formatTrashErrors(prepareErrors, executeErrors)]),
      );
    },
  });
}
