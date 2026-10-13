// Orphan-Actions des cleanup-Stores (R-01): aus `cleanupStore.ts` herausgelöst.
// Gleiches Muster wie cleanupTrash.ts: Funktionen mit dem Store als erstem
// Parameter, Aufrufe anderer Actions ausschließlich über `store.`, damit die
// `vi.spyOn`-Spies der Tests greifen.

import { tauriPorts } from "../../core/adapters/tauri";
import {
  classifyOrphans,
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
  type IncompleteDeletion,
  type SteamOwnedPrefix,
} from "../../core/cleanup";
import { readAppName } from "../../core/localconfig";
import { paths } from "../../core/paths";
import { readAllShortcutAppIds, type ShortcutResult } from "../../core/shortcuts";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { localizeConsequences } from "../consequences";
import { logError, logEvent } from "../diagnostics";
import { formatError } from "../formatError";
import { t } from "../i18n";
import {
  attachSizes,
  batchInfoLines,
  batchTooLargeText,
  cleanupTurn,
  collectInstalledAppIds,
  combineErrors,
  confirmTitle,
} from "./cleanupHelpers";
import { MAX_PENDING_DELETES } from "./cleanupStore";
import { useConfirmStore } from "./confirmStore";
import { useScanStore } from "./scanStore";

/** genau die Store-teile, die diese Actions über `store.` nutzen (kein
 *  `ReturnType<typeof useCleanupStore>`: das erzeugt einen zirkulären Typ). */
export interface OrphanStore {
  orphans: OrphanEntry[];
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
  if (!result.steamUserId) return {};
  try {
    const text = await tauriPorts.fs.readTextFile(
      paths.localConfigVdf(result.steamRoot, result.steamUserId),
    );
    const names: Record<string, string> = {};
    for (const o of store.orphans) {
      const name = readAppName(text, o.appId);
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
      tauriPorts.fs,
    );
    if (!isCurrent()) return;
    store.incompleteDeletions = incompleteDeletions.entries;
    store.incompleteDeletionsUnreadable = incompleteDeletions.unreadable;
    // keine zweite meldung für unlesbare claims: die ansicht zeigt sie
    // dediziert (incompleteDeletionsError → CleanupView), die sperre
    // tragen `hasOrphanUnavailableBase` (cleanupHelpers.ts) und
    // `trashUnavailable`.

    const skipped = result.skippedLibraries;
    const blocking = skipped.filter((s) => s.reason !== "path-missing");
    const unsafe = result.cleanupUnsafeLibraries;
    if (!Array.isArray(unsafe)) {
      store.blockedBySkipped = true;
      store.setOrphanScanError(t("errors.scanContractMissing"));
      return;
    }
    if (blocking.length > 0 || unsafe.length > 0) {
      store.blockedBySkipped = true;
      const blockedPaths = [...new Set([...blocking.map((s) => s.path), ...unsafe])];
      store.setOrphanScanError(t("errors.scanIncomplete", { paths: blockedPaths.join(", ") }));
      return;
    }
    store.blockedBySkipped = false;

    await store.loadIgnoredMissing(isCurrent);
    if (!isCurrent()) return;
    const missing = skipped.filter((s) => s.reason === "path-missing").map((s) => s.path);
    const unanswered = missing.filter((p) => !store.ignoredMissingLibs.includes(p));
    if (unanswered.length > 0) {
      store.pathMissingLibs = unanswered;
      return;
    }
    store.pathMissingLibs = [];

    const steamRunning = await tauriPorts.system.isSteamRunning();
    if (!isCurrent()) return;
    if (steamRunning) {
      const steamError = t("errors.steamRunningCleanup");
      store.setOrphanScanError(steamError);
      return;
    }

    const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
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

    const orphans = await findOrphans(
      result.libraries,
      installedAppIds,
      new Set(result.blockedAppIds),
      tauriPorts.fs,
    );
    if (!isCurrent()) return;
    store.orphans = orphans;

    const steamOwnedPrefixes = await findSteamOwnedPrefixes(
      result.libraries,
      new Set(result.blockedAppIds),
      tauriPorts.fs,
    );
    if (!isCurrent()) return;
    store.steamOwnedPrefixes = steamOwnedPrefixes;

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
    const sizes = await tauriPorts.system.batchDirSizes(paths);
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
  if (store.blockedBySkipped || entries.some((e) => store.orphanDeleteBlocked(e.type))) return;

  const { result, isCurrent } = cleanupTurn(
    useScanStore(),
    store._orphanScanGeneration,
    () => store._orphanScanGeneration,
  );
  if (!result) {
    store.setOrphanError(t("errors.noScanResult"));
    return;
  }

  const unsafe = result.cleanupUnsafeLibraries;
  if (!Array.isArray(unsafe)) {
    store.blockedBySkipped = true;
    store.setOrphanError(t("errors.scanContractMissing"));
    return;
  }
  if (unsafe.length > 0) {
    store.blockedBySkipped = true;
    store.setOrphanError(t("errors.scanIncomplete", { paths: unsafe.join(", ") }));
    return;
  }

  let shortcutResult: ShortcutResult;
  try {
    if (await tauriPorts.system.isSteamRunning()) {
      if (isCurrent()) store.setOrphanError(t("errors.steamRunningCleanup"));
      return;
    }
    shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
  } catch (e) {
    logError("Loeschen vorbereiten fehlgeschlagen", e);
    if (isCurrent()) store.setOrphanError(formatError(e));
    return;
  }
  const installedAppIds = collectInstalledAppIds(result, shortcutResult);
  const confirm = useConfirmStore();
  const reservation = confirm.reserve();
  if (reservation === null) return;

  const errors: string[] = [];
  // phase 1: alle einträge vorbereiten; der dialog zeigt die folgen und
  // erst der bestätigungs-klick führt executeDelete aus.
  const prepared: {
    token: string;
    path: string;
    type: string;
    descriptions: string[];
    permanentDelete: boolean;
  }[] = [];
  for (const entry of entries) {
    if (!isCurrent()) break;
    if (shortcutResult.status === "unreadable" && entry.type === "compatdata") {
      errors.push(t("errors.errorShortcutUnreadable", { type: entry.type, appId: entry.appId }));
      continue;
    }
    if (installedAppIds.has(entry.appId)) {
      errors.push(t("errors.errorNowInstalled", { type: entry.type, appId: entry.appId }));
      continue;
    }

    store.deleting.add(entry.path);
    try {
      const pending = await tauriPorts.system.prepareDelete({
        targetType: "orphan",
        path: entry.path,
        steamRoot: result.steamRoot,
      });
      prepared.push({
        token: pending.token,
        path: entry.path,
        type: entry.type,
        descriptions: localizeConsequences(pending, store.orphanNames[entry.path] ?? null),
        permanentDelete: pending.consequences.some((c) => c.action === "permanentDelete"),
      });
    } catch (e) {
      // deleting hier räumen: sonst bleibt die view nach einem
      // prepare-fehler dauerhaft busy (kein cleanup in onSuccess/onError,
      // die nur pfade aus prepared kennen).
      store.deleting.delete(entry.path);
      logEvent("error", `Loeschen vorbereiten fehlgeschlagen (${entry.type}/${entry.appId})`);
      errors.push(`${entry.type}/${entry.appId}: ${formatError(e)}`);
    }
  }
  if (!isCurrent()) {
    for (const p of prepared) store.deleting.delete(p.path);
    confirm.release(reservation);
    return;
  }
  // immer setzen: ein neuer versuch ersetzt die fehler des letzten, statt
  // sie aufzustauen. ein scan-fehler kann hier nicht stehen, er sperrt oben.
  store.setOrphanError(errors.join("; ") || null);
  if (!prepared.length) {
    confirm.release(reservation);
    return;
  }

  // bei mehr als MAX_PENDING_DELETES einträgen wird bewusst in batches
  // gearbeitet (ein backend-token je batch, eine bestätigung je batch aus
  // INV-6): der dialog nennt grenze und rest statt eines stillen rests.
  const batchInfo = batchInfoLines("cleanup.orphanBatchInfo", MAX_PENDING_DELETES, remainder);
  const accepted = confirm.ask(
    {
      title: confirmTitle(
        "cleanup.deleteConfirmSingle",
        "cleanup.deleteConfirmTitle",
        prepared.length,
      ),
      message: [...batchInfo, ...prepared.flatMap((p) => p.descriptions)].join("\n"),
      // shadercache wird hart gelöscht, compatdata nur verschoben: der
      // knopf benennt die jeweils schwerere wirkung.
      confirmLabel: prepared.some((p) => p.permanentDelete)
        ? t("common.delete")
        : t("cleanup.moveToTrash"),
    },
    {
      onSuccess: async () => {
        // die aufrufende view räumt ihre auswahl erst hier: ask resolved
        // schon beim öffnen, abbrechen muss die auswahl behalten. nur die
        // bestätigten pfade gehen zurück; übersprungene standen nicht im dialog.
        onConfirmed?.(prepared.map((p) => p.path));
        // compatdata wird nicht gelöscht, sondern in den papierkorb
        // VERSCHOBEN; ohne refresh danach bliebe die papierkorb-sektion
        // auf dem stand vom öffnen der ansicht.
        let trashedCompatdata = false;
        for (const p of prepared) {
          try {
            await tauriPorts.system.executeDelete(p.token);
            if (isCurrent()) {
              store.orphans = store.orphans.filter((o) => o.path !== p.path);
              // shadercache wird hart gelöscht, landet nie im papierkorb
              if (p.type === "compatdata") trashedCompatdata = true;
            }
          } catch (e) {
            if (isCurrent()) errors.push(`${p.type}/${p.path}: ${formatError(e)}`);
          } finally {
            store.deleting.delete(p.path);
          }
        }
        // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
        // scanOrphans() leeren trashError bzw. orphanError und würden die
        // löschfehler sonst verschlucken. der rescan gehört hierher, nicht in die view.
        if (!isCurrent()) return;
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
      onCancel: () => {
        for (const p of prepared) store.deleting.delete(p.path);
      },
      onError: (e) => {
        logError("Loeschen fehlgeschlagen", e);
        for (const p of prepared) store.deleting.delete(p.path);
        if (isCurrent()) {
          errors.push(formatError(e));
          store.setOrphanError(errors.join("; "));
        }
      },
    },
    reservation,
  );
  if (!accepted) {
    for (const p of prepared) store.deleting.delete(p.path);
    confirm.release(reservation);
  }
}
