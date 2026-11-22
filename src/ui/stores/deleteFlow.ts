// Gemeinsame Lösch-Orchestrierung für Orphan-, Papierkorb- und GE-Tool-Flows (K-15):
// Reservierung am ConfirmStore, sequenzielles Prepare, atomares Token-Cancel bei
// Abbruch/Veraltung, Execute und anschließendes Aufräumen laufen einmal hier.

import { ports } from "../ports";
import { useConfirmStore } from "./confirmStore";

export interface PreparedDeleteToken {
  token: string;
}

export interface ConfirmDialogCopy {
  title: string;
  message: string;
  confirmLabel?: string;
}

export interface DeleteFlowOptions<Item, Prepared extends PreparedDeleteToken> {
  items: readonly Item[];
  isCurrent?: () => boolean;
  onReserve?: () => void;
  prepareItem: (item: Item) => Promise<Prepared | null>;
  onPrepareError?: (item: Item, error: unknown) => void;
  beforeConfirm?: (prepared: readonly Prepared[]) => void;
  buildDialog: (prepared: readonly Prepared[]) => ConfirmDialogCopy;
  onConfirmed?: (prepared: readonly Prepared[]) => void;
  onExecuted?: (item: Prepared) => void;
  /** Wenn gesetzt, laufen batch-ausführungen bei einzelnen fehlern weiter und
   *  melden je eintrag hierhin. Ohne handler bricht der fehler sofort in
   *  `onUnexpectedError` ab (single-item-flow). */
  onExecuteError?: (item: Prepared, error: unknown) => void;
  onItemSettled?: (item: Prepared) => void;
  afterExecute?: () => Promise<void>;
  onUnexpectedError?: (error: unknown) => void;
  onCleanup?: (prepared: readonly Prepared[]) => void;
}

export async function runDeleteFlow<Item, Prepared extends PreparedDeleteToken>(
  options: DeleteFlowOptions<Item, Prepared>,
): Promise<void> {
  const current = options.isCurrent ?? (() => true);
  const confirm = useConfirmStore();
  const reservation = confirm.reserve();
  if (reservation === null) return;
  options.onReserve?.();

  const prepared: Prepared[] = [];
  for (const item of options.items) {
    if (!current()) break;
    try {
      const entry = await options.prepareItem(item);
      if (entry !== null) prepared.push(entry);
    } catch (e) {
      options.onPrepareError?.(item, e);
    }
  }

  let tokensCancelled = false;
  const cancelPrepared = () => {
    if (tokensCancelled) return;
    tokensCancelled = true;
    for (const p of prepared) void ports.system.cancelDelete(p.token).catch(() => {});
  };

  let cleanedUp = false;
  const runCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    options.onCleanup?.(prepared);
  };

  if (!current()) {
    cancelPrepared();
    runCleanup();
    confirm.release(reservation);
    return;
  }

  options.beforeConfirm?.(prepared);
  if (prepared.length === 0) {
    runCleanup();
    confirm.release(reservation);
    return;
  }

  const accepted = confirm.ask(
    options.buildDialog(prepared),
    {
      onSuccess: async () => {
        options.onConfirmed?.(prepared);
        for (const p of prepared) {
          try {
            await ports.system.executeDelete(p.token);
            if (current()) options.onExecuted?.(p);
          } catch (e) {
            if (!options.onExecuteError) throw e;
            options.onExecuteError(p, e);
          } finally {
            options.onItemSettled?.(p);
          }
        }
        if (current()) await options.afterExecute?.();
        runCleanup();
      },
      onCancel: () => {
        cancelPrepared();
        runCleanup();
      },
      onError: (e) => {
        runCleanup();
        if (current()) options.onUnexpectedError?.(e);
      },
    },
    reservation,
  );

  if (!accepted) {
    cancelPrepared();
    runCleanup();
    confirm.release(reservation);
  }
}
