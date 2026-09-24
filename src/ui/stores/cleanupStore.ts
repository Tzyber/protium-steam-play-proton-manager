import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import {
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
  type IncompleteDeletion,
  type SteamOwnedPrefix,
} from "../../core/cleanup";
import { readAppName } from "../../core/localconfig";
import { paths } from "../../core/paths";
import { readAllShortcutAppIds, SHORTCUT_ID_THRESHOLD } from "../../core/shortcuts";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { localizeConsequences } from "../consequences";
import { logError, logEvent } from "../diagnostics";
import { formatKnownBytes } from "../format";
import { formatDetail, formatError } from "../formatError";
import { t } from "../i18n";
import { formatSizeSummary } from "../sizeSummary";
import {
  attachSizes,
  collectInstalledAppIds,
  combineErrors,
  formatTrashErrors,
  hasOrphanUnavailableBase,
  hasUnreadableIncompleteDeletions,
  isCurrentForScan,
} from "./cleanupHelpers";
import { useConfirmStore } from "./confirmStore";
import { useScanStore } from "./scanStore";

/** cache-key für die dauerhaft ignorierten toten library-pfade */
const IGNORED_MISSING_KEY = "cleanup:ignored-missing-libs";

export const MAX_PENDING_DELETES = 32;

export const useCleanupStore = defineStore("cleanup", {
  state: () => ({
    orphans: [] as OrphanEntry[],
    /** spielnamen je orphan-pfad aus steams localconfig (kosmetik; fehlt der
     *  name, zeigt die view die app-id). */
    orphanNames: {} as Record<string, string>,
    /** prefixes von steam-eigenen paketen (proton-builtins, runtimes): nur
     *  gemeldet (zahl + größe), nie als löschkandidaten angeboten. */
    steamOwnedPrefixes: [] as SteamOwnedPrefix[],
    /** liegengebliebene claim-verzeichnisse aus abgebrochenen löschungen.
     *  werden nur gemeldet, nie als löschkandidaten angeboten (INV-2). */
    incompleteDeletions: [] as IncompleteDeletion[],
    /** claim-parent, die nicht gelesen werden konnten. Eine leere Claim-Liste
     *  ist mit diesem Zustand kein vollständiger Scan. */
    incompleteDeletionsUnreadable: [] as string[],
    scanning: false,
    deleting: new Set<string>(),
    error: null as string | null,
    orphanError: null as string | null,
    trashError: null as string | null,
    blockedBySkipped: false,
    pathMissingLibs: [] as string[],
    /** vom nutzer dauerhaft ignorierte, nicht existierende library-pfade.
     *  liegt im cache, damit die rückfrage nicht bei jedem ansichtswechsel
     *  wiederkommt. bewusst als LISTE und nicht als bool: taucht später ein
     *  NEUER toter pfad auf, wird wieder gefragt statt still zu ignorieren. */
    ignoredMissingLibs: [] as string[],
    ignoredLoaded: false,
    shortcutUnreadable: false,
    shortcutUnreadablePaths: [] as string[],
    shortcutUnreadableDetail: null as string | null,
    trash: [] as TrashEntry[],
    trashUnknown: [] as string[],
    trashLibraries: [] as TrashLibraryStatus[],
    trashScanning: false,
    _orphanScanGeneration: 0,
    _trashScanGeneration: 0,
  }),
  getters: {
    compatdataOrphans: (s) => s.orphans.filter((o) => o.type === "compatdata"),
    shadercacheOrphans: (s) => s.orphans.filter((o) => o.type === "shadercache"),
    incompleteDeletionsError: (s) =>
      s.incompleteDeletionsUnreadable.length > 0
        ? t("errors.incompleteDeletionsUnreadable", {
            paths: s.incompleteDeletionsUnreadable.join(", "),
          })
        : null,
    shaderUnavailable: (s) =>
      hasOrphanUnavailableBase(s) || s.incompleteDeletions.some((d) => d.type === "shadercache"),
    prefixUnavailable: (s) =>
      hasOrphanUnavailableBase(s) ||
      s.shortcutUnreadable ||
      s.incompleteDeletions.some((d) => d.type === "compatdata"),
    trashUnavailable: (s) => {
      const legacyError = s.error !== null && s.orphanError === null && s.trashError === null;
      return (
        legacyError ||
        s.trashError !== null ||
        s.trashUnknown.length > 0 ||
        s.trashLibraries.some((library) => library.error !== undefined) ||
        hasUnreadableIncompleteDeletions(s) ||
        s.incompleteDeletions.some((d) => d.type === "trash")
      );
    },
  },
  actions: {
    key(entry: OrphanEntry): string {
      return entry.path;
    },

    syncError() {
      // Der Detailwert kommt als kanonischer Code aus dem Core; ein unbekannter
      // Rohtext faellt weg (V1), die Klassifikation bleibt sichtbar.
      const shortcutDetail = formatDetail(this.shortcutUnreadableDetail ?? undefined);
      const shortcutError = this.shortcutUnreadable
        ? shortcutDetail
          ? t("errors.userdataUnreadableWithDetail", { detail: shortcutDetail })
          : t("errors.shortcutsUnreadable")
        : null;
      this.error = combineErrors([this.orphanError, shortcutError, this.trashError]);
    },

    setOrphanError(message: string | null) {
      this.orphanError = message;
      this.syncError();
    },

    setTrashError(message: string | null) {
      this.trashError = message;
      this.syncError();
    },

    resetForLibraryScan() {
      this._orphanScanGeneration += 1;
      this._trashScanGeneration += 1;
      this.orphans = [];
      this.orphanNames = {};
      this.steamOwnedPrefixes = [];
      this.incompleteDeletions = [];
      this.incompleteDeletionsUnreadable = [];
      this.scanning = false;
      this.orphanError = null;
      this.blockedBySkipped = false;
      this.pathMissingLibs = [];
      this.shortcutUnreadable = false;
      this.shortcutUnreadablePaths = [];
      this.shortcutUnreadableDetail = null;
      this.trash = [];
      this.trashUnknown = [];
      this.trashLibraries = [];
      this.trashScanning = false;
      this.trashError = null;
      this.syncError();
    },

    /** spielnamen für die orphan-liste aus steams localconfig; fehler oder
     *  fehlende einträge → id-fallback in der view. */
    async readOrphanNames(result: ScanResult): Promise<Record<string, string>> {
      if (!result.steamUserId) return {};
      try {
        const text = await tauriPorts.fs.readTextFile(
          paths.localConfigVdf(result.steamRoot, result.steamUserId),
        );
        const names: Record<string, string> = {};
        for (const o of this.orphans) {
          const name = readAppName(text, o.appId);
          if (name) names[o.path] = name;
        }
        return names;
      } catch {
        return {};
      }
    },

    async scanOrphans() {
      const generation = this._orphanScanGeneration + 1;
      this._orphanScanGeneration = generation;
      this.orphans = [];
      this.orphanNames = {};
      this.steamOwnedPrefixes = [];
      this.incompleteDeletions = [];
      this.incompleteDeletionsUnreadable = [];
      this.blockedBySkipped = false;
      this.pathMissingLibs = [];
      this.shortcutUnreadable = false;
      this.shortcutUnreadablePaths = [];
      this.shortcutUnreadableDetail = null;
      this.scanning = false;
      this.orphanError = null;
      this.syncError();

      const scan = useScanStore();
      const sourceScanGeneration = scan.scanGeneration;
      const isCurrent = () =>
        isCurrentForScan({
          generation,
          currentGeneration: this._orphanScanGeneration,
          sourceScanGeneration,
          scan,
        });
      const result = scan.status === "done" || scan.status === "idle" ? scan.result : null;
      if (!result) {
        // gleiches verhalten wie scanTrash: klick vor scan-ende darf nicht
        // lautlos ins leere laufen.
        this.setOrphanError(t("errors.noScanResult"));
        return;
      }

      this.scanning = true;
      this.setOrphanError(null);

      try {
        // Claims zuerst lesen: Orphan-Gates und der Steam-läuft-Gate dürfen
        // liegengebliebene Löschreste nicht aus der Anzeige verdrängen.
        const incompleteDeletions = await findIncompleteDeletions(
          result.libraries,
          result.steamRoot,
          tauriPorts.fs,
        );
        if (!isCurrent()) return;
        this.incompleteDeletions = incompleteDeletions.entries;
        this.incompleteDeletionsUnreadable = incompleteDeletions.unreadable;
        if (incompleteDeletions.unreadable.length) {
          this.setOrphanError(
            t("errors.incompleteDeletionsUnreadable", {
              paths: incompleteDeletions.unreadable.join(", "),
            }),
          );
        }

        const skipped = result.skippedLibraries;
        const blocking = skipped.filter((s) => s.reason !== "path-missing");
        const unsafe = result.cleanupUnsafeLibraries;
        if (!Array.isArray(unsafe)) {
          this.blockedBySkipped = true;
          this.setOrphanError(t("errors.scanContractMissing"));
          return;
        }
        if (blocking.length > 0 || unsafe.length > 0) {
          this.blockedBySkipped = true;
          const blockedPaths = [...new Set([...blocking.map((s) => s.path), ...unsafe])];
          this.setOrphanError(t("errors.scanIncomplete", { paths: blockedPaths.join(", ") }));
          return;
        }
        this.blockedBySkipped = false;

        await this.loadIgnoredMissing(isCurrent);
        if (!isCurrent()) return;
        const missing = skipped.filter((s) => s.reason === "path-missing").map((s) => s.path);
        const unanswered = missing.filter((p) => !this.ignoredMissingLibs.includes(p));
        if (unanswered.length > 0) {
          this.pathMissingLibs = unanswered;
          return;
        }
        this.pathMissingLibs = [];

        const steamRunning = await tauriPorts.system.isProcessRunning("steam");
        if (!isCurrent()) return;
        if (steamRunning) {
          const steamError = t("errors.steamRunningCleanup");
          this.setOrphanError(steamError);
          return;
        }

        const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
        if (!isCurrent()) return;
        if (shortcutResult.status === "unreadable") {
          this.shortcutUnreadable = true;
          this.shortcutUnreadablePaths = shortcutResult.paths;
          this.shortcutUnreadableDetail = shortcutResult.detail ?? null;
        } else {
          this.shortcutUnreadable = false;
          this.shortcutUnreadablePaths = [];
          this.shortcutUnreadableDetail = null;
        }

        const installedAppIds = collectInstalledAppIds(result, shortcutResult);

        const orphans = await findOrphans(
          result.libraries,
          installedAppIds,
          new Set(result.blockedAppIds),
          tauriPorts.fs,
        );
        if (!isCurrent()) return;
        this.orphans = orphans;

        const steamOwnedPrefixes = await findSteamOwnedPrefixes(
          result.libraries,
          new Set(result.blockedAppIds),
          tauriPorts.fs,
        );
        if (!isCurrent()) return;
        this.steamOwnedPrefixes = steamOwnedPrefixes;

        if (this.shortcutUnreadable) {
          // WHY fail-closed: unlesbares shortcuts.vdf → Non-Steam-Shortcuts sind nicht
          // von echten Orphans unterscheidbar. compatdata kann echte Savegames enthalten,
          // deshalb blockieren. shadercache ist regenerierbar und darf bereinigt werden.
          this.orphans = this.orphans.filter((o) => o.type === "shadercache");
          this.syncError();
        }

        for (const o of this.orphans) {
          if (o.appId >= SHORTCUT_ID_THRESHOLD) o.potentialShortcut = true;
        }

        const orphanNames = await this.readOrphanNames(result);
        if (!isCurrent()) return;
        this.orphanNames = orphanNames;

        // größen für beide listen in einem aufruf; ohne orphans, aber mit
        // steam-eigenen prefixes darf nicht vorzeitig abgebrochen werden.
        if (this.orphans.length === 0 && this.steamOwnedPrefixes.length === 0) return;

        const paths = [
          ...this.orphans.map((o) => o.path),
          ...this.steamOwnedPrefixes.map((p) => p.path),
        ];
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        if (!isCurrent()) return;
        attachSizes(this.orphans, sizes);
        attachSizes(this.steamOwnedPrefixes, sizes);
      } catch (e) {
        logError("Orphan-Scan fehlgeschlagen", e);
        if (isCurrent()) this.setOrphanError(formatError(e));
      } finally {
        if (isCurrent()) this.scanning = false;
      }
    },

    async deleteOrphans(entries: OrphanEntry[], remainder = 0) {
      if (entries.length > MAX_PENDING_DELETES) {
        this.setOrphanError(
          t("errors.deleteBatchTooLarge", { n: entries.length, max: MAX_PENDING_DELETES }),
        );
        return;
      }
      if (this.blockedBySkipped) return;

      const scan = useScanStore();
      const generation = this._orphanScanGeneration;
      const sourceScanGeneration = scan.scanGeneration;
      const isCurrent = () =>
        isCurrentForScan({
          generation,
          currentGeneration: this._orphanScanGeneration,
          sourceScanGeneration,
          scan,
        });
      const result = scan.status === "done" || scan.status === "idle" ? scan.result : null;
      if (!result) {
        this.setOrphanError(t("errors.noScanResult"));
        return;
      }

      const unsafe = result.cleanupUnsafeLibraries;
      if (!Array.isArray(unsafe)) {
        this.blockedBySkipped = true;
        this.setOrphanError(t("errors.scanContractMissing"));
        return;
      }
      if (unsafe.length > 0) {
        this.blockedBySkipped = true;
        this.setOrphanError(t("errors.scanIncomplete", { paths: unsafe.join(", ") }));
        return;
      }

      if (await tauriPorts.system.isProcessRunning("steam")) {
        this.setOrphanError(t("errors.steamRunningCleanup"));
        return;
      }

      const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
      const installedAppIds = collectInstalledAppIds(result, shortcutResult);
      const confirm = useConfirmStore();
      const reservation = confirm.reserve();
      if (reservation === null) return;

      const errors: string[] = [];
      // phase 1: alle einträge vorbereiten; der dialog zeigt die folgen und
      // erst der bestätigungs-klick führt executeDelete aus.
      const prepared: {
        token: string;
        key: string;
        type: string;
        descriptions: string[];
        permanentDelete: boolean;
      }[] = [];
      for (const entry of entries) {
        if (!isCurrent()) break;
        if (shortcutResult.status === "unreadable" && entry.type === "compatdata") {
          errors.push(
            t("errors.errorShortcutUnreadable", { type: entry.type, appId: entry.appId }),
          );
          continue;
        }
        if (installedAppIds.has(entry.appId)) {
          errors.push(t("errors.errorNowInstalled", { type: entry.type, appId: entry.appId }));
          continue;
        }

        const k = this.key(entry);
        this.deleting.add(k);
        try {
          const pending = await tauriPorts.system.prepareDelete({
            targetType: "orphan",
            path: entry.path,
            steamRoot: result.steamRoot,
          });
          prepared.push({
            token: pending.token,
            key: k,
            type: entry.type,
            descriptions: localizeConsequences(pending, this.orphanNames[entry.path] ?? null),
            permanentDelete: pending.consequences.some((c) => c.action === "permanentDelete"),
          });
        } catch (e) {
          // deleting hier räumen: sonst bleibt die view nach einem
          // prepare-fehler dauerhaft busy (kein cleanup in onSuccess/onError,
          // die nur keys aus prepared kennen).
          this.deleting.delete(k);
          logEvent("error", `Loeschen vorbereiten fehlgeschlagen (${entry.type}/${entry.appId})`);
          errors.push(`${entry.type}/${entry.appId}: ${formatError(e)}`);
        }
      }
      if (!isCurrent()) {
        for (const p of prepared) this.deleting.delete(p.key);
        confirm.release(reservation);
        return;
      }
      if (errors.length) this.setOrphanError(errors.join("; "));
      if (!prepared.length) {
        confirm.release(reservation);
        return;
      }

      // bei mehr als MAX_PENDING_DELETES einträgen wird bewusst in batches
      // gearbeitet (ein backend-token je batch, eine bestätigung je batch aus
      // INV-6): der dialog nennt grenze und rest statt eines stillen rests.
      const batchInfo =
        remainder > 0
          ? [
              t("cleanup.orphanBatchInfo", {
                max: MAX_PENDING_DELETES,
                rest: remainder,
              }),
            ]
          : [];
      const accepted = confirm.ask(
        {
          title: t("cleanup.deleteConfirmTitle", { n: prepared.length }),
          message: [...batchInfo, ...prepared.flatMap((p) => p.descriptions)].join("\n"),
          // shadercache wird hart gelöscht, compatdata nur verschoben: der
          // knopf benennt die jeweils schwerere wirkung.
          confirmLabel: prepared.some((p) => p.permanentDelete)
            ? t("common.delete")
            : t("cleanup.moveToTrash"),
        },
        {
          onSuccess: async () => {
            // compatdata wird nicht gelöscht, sondern in den papierkorb
            // VERSCHOBEN; ohne refresh danach bliebe die papierkorb-sektion
            // auf dem stand vom öffnen der ansicht.
            let trashedCompatdata = false;
            for (const p of prepared) {
              try {
                await tauriPorts.system.executeDelete(p.token);
                if (isCurrent()) {
                  this.orphans = this.orphans.filter((o) => this.key(o) !== p.key);
                  // shadercache wird hart gelöscht, landet nie im papierkorb
                  if (p.type === "compatdata") trashedCompatdata = true;
                }
              } catch (e) {
                if (isCurrent()) errors.push(`${p.type}/${p.key}: ${formatError(e)}`);
              } finally {
                this.deleting.delete(p.key);
              }
            }
            // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
            // scanOrphans() setzen this.error zurück und würden die löschfehler
            // sonst verschlucken. der rescan gehört hierher, nicht in die view.
            if (!isCurrent()) return;
            if (trashedCompatdata) {
              await this.scanTrash();
              if (!isCurrent()) return;
            }
            const refreshGeneration = this._orphanScanGeneration + 1;
            await this.scanOrphans();
            if (this._orphanScanGeneration === refreshGeneration && errors.length) {
              this.setOrphanError(errors.join("; "));
            }
          },
          onCancel: () => {
            for (const p of prepared) this.deleting.delete(p.key);
          },
          onError: (e) => {
            logError("Loeschen fehlgeschlagen", e);
            for (const p of prepared) this.deleting.delete(p.key);
            if (isCurrent()) {
              errors.push(formatError(e));
              this.setOrphanError(errors.join("; "));
            }
          },
        },
        reservation,
      );
      if (!accepted) {
        for (const p of prepared) this.deleting.delete(p.key);
        confirm.release(reservation);
      }
    },

    async loadIgnoredMissing(isCurrent: () => boolean = () => true) {
      if (this.ignoredLoaded) return;
      try {
        const raw = await tauriPorts.cache.get(IGNORED_MISSING_KEY);
        if (!isCurrent()) return;
        this.ignoredLoaded = true;
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        // defensiv: fremder/alter cache-inhalt darf den cleanup nicht kippen
        if (Array.isArray(parsed)) {
          this.ignoredMissingLibs = parsed.filter((p): p is string => typeof p === "string");
        }
      } catch {
        if (isCurrent()) this.ignoredLoaded = true;
        // Fehlender oder defekter Cache darf keine Einträge ausblenden.
      }
    },

    async persistIgnoredMissing() {
      try {
        await tauriPorts.cache.set(IGNORED_MISSING_KEY, JSON.stringify(this.ignoredMissingLibs));
      } catch {
        // schreibfehler nie fatal: die entscheidung gilt dann nur für diese sitzung
      }
    },

    async dismissPathMissing() {
      this.ignoredLoaded = true;
      this.ignoredMissingLibs = [...new Set([...this.ignoredMissingLibs, ...this.pathMissingLibs])];
      await this.persistIgnoredMissing();
      await this.scanOrphans();
    },

    /** ignorierte pfade wieder berücksichtigen, die rückfrage kommt dann erneut. */
    async unignoreMissingLibs() {
      this.ignoredMissingLibs = [];
      await this.persistIgnoredMissing();
      await this.scanOrphans();
    },

    async scanTrash() {
      const generation = this._trashScanGeneration + 1;
      this._trashScanGeneration = generation;
      this.trash = [];
      this.trashUnknown = [];
      this.trashLibraries = [];
      this.trashScanning = false;
      this.trashError = null;
      this.syncError();

      const scan = useScanStore();
      const sourceScanGeneration = scan.scanGeneration;
      const isCurrent = () =>
        isCurrentForScan({
          generation,
          currentGeneration: this._trashScanGeneration,
          sourceScanGeneration,
          scan,
        });
      const result = scan.status === "done" || scan.status === "idle" ? scan.result : null;
      if (!result) {
        this.setTrashError(t("errors.noScanResult"));
        return;
      }

      this.trashScanning = true;
      this.setTrashError(null);

      try {
        const { entries, unknown, unreadable, libraries } = await findTrashEntries(
          result.libraries,
          tauriPorts.system,
        );
        if (!isCurrent()) return;
        this.trash = entries;
        this.trashUnknown = unknown;
        this.trashLibraries = libraries;

        // ein nicht lesbarer papierkorb darf nicht als "leer" durchgehen
        if (unreadable.length) {
          this.setTrashError(t("cleanup.trashUnreadable", { paths: unreadable.join(", ") }));
        }

        if (entries.length === 0) return;

        const paths = entries.map((e) => e.path);
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        if (!isCurrent()) return;
        attachSizes(this.trash, sizes);
      } catch (e) {
        logError("Papierkorb-Scan fehlgeschlagen", e);
        if (isCurrent()) this.setTrashError(formatError(e));
      } finally {
        if (isCurrent()) this.trashScanning = false;
      }
    },

    /** verarbeitet höchstens MAX_PENDING_DELETES einträge je bestätigung
     *  (ein backend-token je batch); `remainder` ist die zahl der einträge des
     *  snapshots, die dieser durchgang nicht anfasst, und wird im dialog
     *  genannt. */
    async deleteTrashEntries(entries: TrashEntry[], remainder = 0) {
      if (entries.length > MAX_PENDING_DELETES) {
        this.setTrashError(
          t("errors.deleteBatchTooLarge", { n: entries.length, max: MAX_PENDING_DELETES }),
        );
        return;
      }
      const generation = this._trashScanGeneration;
      const scan = useScanStore();
      const sourceScanGeneration = scan.scanGeneration;
      const isCurrent = () =>
        isCurrentForScan({
          generation,
          currentGeneration: this._trashScanGeneration,
          sourceScanGeneration,
          scan,
        });
      const result = scan.status === "done" || scan.status === "idle" ? scan.result : null;
      const steamRoot = result?.steamRoot ?? "";
      const confirm = useConfirmStore();
      const reservation = confirm.reserve();
      if (reservation === null) return;
      if (isCurrent()) this.setTrashError(null);
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
      this.setTrashError(formatTrashErrors(prepareErrors, executeErrors));
      if (!prepared.length) {
        confirm.release(reservation);
        return;
      }

      const partialPrepareMessage =
        prepareErrors.length > 0
          ? t("cleanup.trashPrepareWarning", { n: prepareErrors.length })
          : null;
      // bei mehr als MAX_PENDING_DELETES einträgen wird bewusst in batches
      // gearbeitet (ein backend-token je batch, eine bestätigung je batch aus
      // INV-6): der dialog nennt grenze und rest statt eines stillen rests.
      const batchInfo =
        remainder > 0
          ? [
              t("cleanup.trashBatchInfo", {
                max: MAX_PENDING_DELETES,
                rest: remainder,
              }),
            ]
          : [];
      // Die Summe beschreibt genau die bestätigten Ziele: nur die tatsächlich
      // vorbereiteten Einträge zählen, und unbekannte Größen werden nicht als
      // 0 mitgezählt (Q3/INV-6), sondern als "nicht gemessen"/"teilweise"
      // ausgewiesen.
      const preparedPaths = new Set(prepared.map((p) => p.path));
      const preparedEntries = entries.filter((entry) => preparedPaths.has(entry.path));
      // formatKnownBytes: eine gemessene 0 ist "0 B", nicht "nicht gemessen"
      const sizeText = formatSizeSummary(preparedEntries, formatKnownBytes);
      const accepted = confirm.ask(
        {
          title:
            prepared.length === 1
              ? t("cleanup.trashDeleteConfirmSingle", { n: prepared.length })
              : t("cleanup.trashDeleteConfirmTitle", { n: prepared.length }),
          message: [
            t("cleanup.trashDeleteWarning", { size: sizeText }),
            partialPrepareMessage,
            ...batchInfo,
            ...prepared.flatMap((p) => p.descriptions),
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        },
        {
          onSuccess: async () => {
            for (const p of prepared) {
              try {
                await tauriPorts.system.executeDelete(p.token);
                if (isCurrent()) {
                  this.trash = this.trash.filter((e) => e.path !== p.path);
                }
              } catch (e) {
                if (isCurrent()) executeErrors.push(`${p.name}: ${formatError(e)}`);
              }
            }
            if (isCurrent()) this.setTrashError(formatTrashErrors(prepareErrors, executeErrors));
          },
          onError: (e) => {
            logError("Papierkorb leeren fehlgeschlagen", e);
            if (isCurrent()) {
              executeErrors.push(formatError(e));
              this.setTrashError(formatTrashErrors(prepareErrors, executeErrors));
            }
          },
        },
        reservation,
      );
      if (!accepted) confirm.release(reservation);
    },

    async emptyTrash() {
      const snapshot = this.trash.slice();
      const batch = snapshot.slice(0, MAX_PENDING_DELETES);
      await this.deleteTrashEntries(batch, snapshot.length - batch.length);
    },

    async deleteOrphansAll(entries: OrphanEntry[]) {
      const batch = entries.slice(0, MAX_PENDING_DELETES);
      await this.deleteOrphans(batch, entries.length - batch.length);
    },
  },
});
