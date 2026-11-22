// Orphan-Actions des cleanup-Stores (R-01): aus `cleanupStore.ts` herausgelöst.
// Gleiches Muster wie cleanupTrash.ts: Funktionen mit dem Store als erstem
// Parameter, Aufrufe anderer Actions ausschließlich über `store.`, damit die
// `vi.spyOn`-Spies der Tests greifen.

import {
  classifyOrphans,
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
  type IncompleteDeletion,
  type OrphanUnreadable,
  type SteamOwnedPrefix,
} from "../../core/cleanup";
import {
  cleanupTurn,
  collectInstalledAppIds,
  mergeOrphanUnreadable,
  resolveOrphanBlockReason,
  scanBlockers,
  unansweredPathMissingLibs,
} from "../../core/cleanupGate";
import { readAppNames } from "../../core/localconfig";
import { paths } from "../../core/paths";
import { readAllShortcutAppIds, type ShortcutResult } from "../../core/shortcuts";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { localizeConsequences } from "../consequences";
import { logError, logEvent } from "../diagnostics";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { ports } from "../ports";
import {
  attachSizes,
  batchInfoLines,
  batchTooLargeText,
  combineErrors,
  confirmTitle,
} from "./cleanupHelpers";
import { MAX_PENDING_DELETES } from "./cleanupStore";
import { runDeleteFlow } from "./deleteFlow";
import { useScanStore } from "./scanStore";

/** genau die Store-teile, die diese Actions über `store.` nutzen (kein
 *  `ReturnType<typeof useCleanupStore>`: das erzeugt einen zirkulären Typ). */
interface OrphanStore {
  orphans: OrphanEntry[];
  /** compatdata/shadercache-Verzeichnisse, deren Inhalt nicht gelesen werden
   *  konnte – typ-genau. Eine leere Orphan-Liste ist mit diesem Zustand kein
   *  vollständiger Scan (INV-2). */
  orphanUnreadable: OrphanUnreadable[];
  orphanNames: Record<string, string>;
  steamOwnedPrefixes: SteamOwnedPrefix[];
  incompleteDeletions: IncompleteDeletion[];
  incompleteDeletionsUnreadable: string[];
  blockedBySkipped: boolean;
  pathMissingLibs: string[];
  ignoredMissingLibs: string[];
  shortcutUnreadable: boolean;
  shortcutUnreadablePaths: string[];
  shortcutUnreadableDetail: string | null;
  scanning: boolean;
  deleting: Set<string>;
  orphanError: string | null;
  _orphanScanError: string | null;
  _orphanScanGeneration: number;
  clearOrphanState(): void;
  setOrphanError(message: string | null): void;
  setOrphanScanError(message: string): void;
  orphanDeleteBlocked(type: OrphanEntry["type"]): boolean;
  readOrphanNames(result: ScanResult): Promise<Record<string, string>>;
  loadIgnoredMissing(isCurrent: () => boolean): Promise<void>;
  scanOrphans(): Promise<void>;
  scanTrash(): Promise<void>;
}

/** spielnamen für die orphan-liste aus steams localconfig; fehler oder
 *  fehlende einträge → id-fallback in der view. */
export async function readOrphanNames(
  store: OrphanStore,
  result: ScanResult,
): Promise<Record<string, string>> {
  if (!result.steamUserId || store.orphans.length === 0) return {};
  try {
    const text = await ports.fs.readTextFile(
      paths.localConfigVdf(result.steamRoot, result.steamUserId),
    );
    const byId = readAppNames(
      text,
      store.orphans.map((o) => o.appId),
    );
    const names: Record<string, string> = {};
    for (const o of store.orphans) {
      const name = byId.get(o.appId);
      if (name) names[o.path] = name;
    }
    return names;
  } catch {
    return {};
  }
}

export async function scanOrphans(store: OrphanStore): Promise<void> {
  const generation = store._orphanScanGeneration + 1;
  store._orphanScanGeneration = generation;
  store.clearOrphanState();

  const { result, isCurrent } = cleanupTurn(
    useScanStore(),
    generation,
    () => store._orphanScanGeneration,
  );
  if (!result) {
    // gleiches verhalten wie scanTrash: klick vor scan-ende darf nicht
    // lautlos ins leere laufen.
    store.setOrphanScanError(t("errors.noScanResult"));
    return;
  }

  store.scanning = true;
  store.setOrphanError(null);

  try {
    // Claims zuerst lesen: Orphan-Gates und der Steam-läuft-Gate dürfen
    // liegengebliebene Löschreste nicht aus der Anzeige verdrängen.
    const incompleteDeletions = await findIncompleteDeletions(
      result.libraries,
      result.steamRoot,
      ports.fs,
    );
    if (!isCurrent()) return;
    store.incompleteDeletions = incompleteDeletions.entries;
    store.incompleteDeletionsUnreadable = incompleteDeletions.unreadable;
    // keine zweite meldung für unlesbare claims: die ansicht zeigt sie
    // dediziert (incompleteDeletionsError → CleanupView), die sperre
    // tragen `hasOrphanUnavailableBase` (cleanupHelpers.ts) und
    // `trashUnavailable`.

    const skipped = result.skippedLibraries;
    const blockers = scanBlockers(result);
    if (blockers === null) {
      store.blockedBySkipped = true;
      store.setOrphanScanError(t("errors.scanContractMissing"));
      return;
    }
    if (blockers.length > 0) {
      store.blockedBySkipped = true;
      store.setOrphanScanError(t("errors.scanIncomplete", { paths: blockers.join(", ") }));
      return;
    }
    store.blockedBySkipped = false;

    await store.loadIgnoredMissing(isCurrent);
    if (!isCurrent()) return;
    const unanswered = unansweredPathMissingLibs(skipped, store.ignoredMissingLibs);
    if (unanswered.length > 0) {
      store.pathMissingLibs = unanswered;
      return;
    }
    store.pathMissingLibs = [];

    const steamRunning = await ports.system.isSteamRunning();
    if (!isCurrent()) return;
    if (steamRunning) {
      const steamError = t("errors.steamRunningCleanup");
      store.setOrphanScanError(steamError);
      return;
    }

    const shortcutResult = await readAllShortcutAppIds(ports.fs, result.steamRoot);
    if (!isCurrent()) return;
    if (shortcutResult.status === "unreadable") {
      store.shortcutUnreadable = true;
      store.shortcutUnreadablePaths = shortcutResult.paths;
      store.shortcutUnreadableDetail = shortcutResult.detail ?? null;
    } else {
      store.shortcutUnreadable = false;
      store.shortcutUnreadablePaths = [];
      store.shortcutUnreadableDetail = null;
    }

    const installedAppIds = collectInstalledAppIds(result, shortcutResult);

    const orphanScan = await findOrphans(
      result.libraries,
      installedAppIds,
      new Set(result.blockedAppIds),
      ports.fs,
    );
    if (!isCurrent()) return;
    store.orphans = orphanScan.orphans;

    const steamOwned = await findSteamOwnedPrefixes(
      result.libraries,
      new Set(result.blockedAppIds),
      ports.fs,
    );
    if (!isCurrent()) return;
    store.steamOwnedPrefixes = steamOwned.prefixes;
    // VOR dem frühabbruch bei leerer liste übernehmen: ein unlesbares
    // compatdata/shadercache ist kein „nichts gefunden“ (INV-2), der
    // frühausstieg unten würde den Zustand sonst wieder verwerfen. Beide Scans
    // sehen dieselben compatdata-Orte, deshalb nach `path+type` dedupliziert.
    store.orphanUnreadable = mergeOrphanUnreadable(orphanScan.unreadable, steamOwned.unreadable);

    // Klassifikation (fail-closed bei unlesbarer shortcuts.vdf, Shortcut-
    // bereich) liegt fachlich bei findOrphans in core/cleanup.
    store.orphans = classifyOrphans(store.orphans, store.shortcutUnreadable);

    const orphanNames = await store.readOrphanNames(result);
    if (!isCurrent()) return;
    store.orphanNames = orphanNames;

    // größen für beide listen in einem aufruf; ohne orphans, aber mit
    // steam-eigenen prefixes darf nicht vorzeitig abgebrochen werden.
    if (store.orphans.length === 0 && store.steamOwnedPrefixes.length === 0) return;

    const paths = [
      ...store.orphans.map((o) => o.path),
      ...store.steamOwnedPrefixes.map((p) => p.path),
    ];
    const sizes = await ports.system.batchDirSizes(paths);
    if (!isCurrent()) return;
    attachSizes(store.orphans, sizes);
    attachSizes(store.steamOwnedPrefixes, sizes);
  } catch (e) {
    logError("Orphan-Scan fehlgeschlagen", e);
    if (isCurrent()) store.setOrphanScanError(formatError(e));
  } finally {
    if (isCurrent()) store.scanning = false;
  }
}

export async function deleteOrphans(
  store: OrphanStore,
  entries: OrphanEntry[],
  remainder = 0,
  onConfirmed?: (paths: string[]) => void,
): Promise<void> {
  if (entries.length > MAX_PENDING_DELETES) {
    store.setOrphanError(
      combineErrors([
        store._orphanScanError,
        batchTooLargeText(entries.length, MAX_PENDING_DELETES),
      ]),
    );
    return;
  }
  // Die Sperre darf nicht stumm greifen (Befund 10): ein programmatischer
  // Aufruf soll denselben Grund sehen, den der deaktivierte Knopf zeigt.
  // Vorhandene Meldungen bleiben stehen, statt sie durch eine allgemeinere zu ersetzen.
  const blockedTypes = [...new Set(entries.map((e) => e.type))].filter((type) =>
    store.orphanDeleteBlocked(type),
  );
  if (store.blockedBySkipped || blockedTypes.length > 0) {
    if (store.orphanError === null) {
      const reason = resolveOrphanBlockReason(
        {
          orphanUnreadable: store.orphanUnreadable,
          incompleteDeletionsUnreadable: store.incompleteDeletionsUnreadable,
          incompleteDeletions: store.incompleteDeletions,
          orphanScanError: store._orphanScanError,
        },
        blockedTypes,
      );
      if (reason?.kind === "unreadable-dirs") {
        store.setOrphanError(t("cleanup.unreadableDirs", { paths: reason.paths.join(", ") }));
      } else if (reason?.kind === "claims-unreadable") {
        store.setOrphanError(
          t("errors.incompleteDeletionsUnreadable", { paths: reason.paths.join(", ") }),
        );
      } else if (reason?.kind === "incomplete-deletions") {
        store.setOrphanError(t("cleanup.incompleteDeletionsTitle"));
      } else if (reason?.kind === "scan-error") {
        store.setOrphanError(reason.message);
      }
    }
    return;
  }

  const { result, isCurrent } = cleanupTurn(
    useScanStore(),
    store._orphanScanGeneration,
    () => store._orphanScanGeneration,
  );
  if (!result) {
    store.setOrphanError(t("errors.noScanResult"));
    return;
  }

  const blockers = scanBlockers(result);
  if (blockers === null) {
    store.blockedBySkipped = true;
    store.setOrphanError(t("errors.scanContractMissing"));
    return;
  }
  if (blockers.length > 0) {
    store.blockedBySkipped = true;
    store.setOrphanError(t("errors.scanIncomplete", { paths: blockers.join(", ") }));
    return;
  }

  let shortcutResult: ShortcutResult;
  try {
    if (await ports.system.isSteamRunning()) {
      if (isCurrent()) store.setOrphanError(t("errors.steamRunningCleanup"));
      return;
    }
    shortcutResult = await readAllShortcutAppIds(ports.fs, result.steamRoot);
  } catch (e) {
    logError("Loeschen vorbereiten fehlgeschlagen", e);
    if (isCurrent()) store.setOrphanError(formatError(e));
    return;
  }
  const installedAppIds = collectInstalledAppIds(result, shortcutResult);
  const errors: string[] = [];
  // compatdata wird nicht gelöscht, sondern in den papierkorb VERSCHOBEN; ohne
  // refresh danach bliebe die papierkorb-sektion auf dem stand vom öffnen der ansicht.
  let trashedCompatdata = false;

  await runDeleteFlow({
    items: entries,
    isCurrent,
    prepareItem: async (entry) => {
      if (shortcutResult.status === "unreadable" && entry.type === "compatdata") {
        errors.push(t("errors.errorShortcutUnreadable", { type: entry.type, appId: entry.appId }));
        return null;
      }
      if (installedAppIds.has(entry.appId)) {
        errors.push(t("errors.errorNowInstalled", { type: entry.type, appId: entry.appId }));
        return null;
      }
      store.deleting.add(entry.path);
      try {
        const pending = await ports.system.prepareDelete({
          targetType: "orphan",
          path: entry.path,
          steamRoot: result.steamRoot,
        });
        return {
          token: pending.token,
          path: entry.path,
          type: entry.type,
          descriptions: localizeConsequences(pending, store.orphanNames[entry.path] ?? null),
          permanentDelete: pending.consequences.some((c) => c.action === "permanentDelete"),
        };
      } catch (e) {
        // deleting hier räumen: sonst bleibt die view nach einem
        // prepare-fehler dauerhaft busy (kein cleanup für fehlgeschlagene einträge).
        store.deleting.delete(entry.path);
        throw e;
      }
    },
    onPrepareError: (entry, e) => {
      logEvent("error", `Loeschen vorbereiten fehlgeschlagen (${entry.type}/${entry.appId})`);
      errors.push(`${entry.type}/${entry.appId}: ${formatError(e)}`);
    },
    beforeConfirm: () => {
      // immer setzen: ein neuer versuch ersetzt die fehler des letzten.
      store.setOrphanError(errors.join("; ") || null);
    },
    buildDialog: (prepared) => ({
      title: confirmTitle(
        "cleanup.deleteConfirmSingle",
        "cleanup.deleteConfirmTitle",
        prepared.length,
      ),
      message: [
        ...batchInfoLines("cleanup.orphanBatchInfo", MAX_PENDING_DELETES, remainder),
        ...prepared.flatMap((p) => p.descriptions),
      ].join("\n"),
      // shadercache wird hart gelöscht, compatdata nur verschoben: der
      // knopf benennt die jeweils schwerere wirkung.
      confirmLabel: prepared.some((p) => p.permanentDelete)
        ? t("common.delete")
        : t("cleanup.moveToTrash"),
    }),
    onConfirmed: (prepared) => {
      onConfirmed?.(prepared.map((p) => p.path));
    },
    onExecuted: (p) => {
      store.orphans = store.orphans.filter((o) => o.path !== p.path);
      if (p.type === "compatdata") trashedCompatdata = true;
    },
    onExecuteError: (p, e) => {
      logError(`Löschen fehlgeschlagen (${p.type}/${p.path})`, e);
      if (isCurrent()) errors.push(`${p.type}/${p.path}: ${formatError(e)}`);
    },
    onItemSettled: (p) => {
      store.deleting.delete(p.path);
    },
    afterExecute: async () => {
      // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
      // scanOrphans() leeren trashError bzw. orphanError und würden die
      // löschfehler sonst verschlucken.
      if (trashedCompatdata) {
        await store.scanTrash();
        if (!isCurrent()) return;
      }
      const refreshGeneration = store._orphanScanGeneration + 1;
      await store.scanOrphans();
      if (store._orphanScanGeneration === refreshGeneration && errors.length) {
        // der rescan-fehler bleibt sichtbar (INV-2), der löschtext kommt dazu.
        store.setOrphanError(combineErrors([store.orphanError, errors.join("; ")]));
      }
    },
    onUnexpectedError: (e) => {
      logError("Loeschen fehlgeschlagen", e);
      errors.push(formatError(e));
      store.setOrphanError(errors.join("; "));
    },
    onCleanup: (prepared) => {
      for (const p of prepared) store.deleting.delete(p.path);
    },
  });
}
