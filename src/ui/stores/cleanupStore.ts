import { defineStore } from "pinia";
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
  cleanupTurn,
  collectInstalledAppIds,
  combineErrors,
  formatTrashErrors,
  hasOrphanUnavailableBase,
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
    /** fehler des letzten orphan-scans; trägt die löschsperre
     *  (`orphanDeleteBlocked`), anders als löschfehler in `orphanError`. */
    _orphanScanError: null as string | null,
    /** fehler des letzten papierkorb-scans. ein löschversuch fällt darauf
     *  zurück statt auf null, sonst verschwände „nicht lesbar“ nach einem
     *  abgebrochenen dialog (INV-2). */
    _trashScanError: null as string | null,
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
    // Der Detailwert kommt als kanonischer Code aus dem Core; ein unbekannter
    // Rohtext faellt weg (V1), die Klassifikation bleibt sichtbar.
    error: (s) => {
      const shortcutDetail = formatDetail(s.shortcutUnreadableDetail ?? undefined);
      const shortcutError = s.shortcutUnreadable
        ? shortcutDetail
          ? t("errors.userdataUnreadableWithDetail", { detail: shortcutDetail })
          : t("errors.shortcutsUnreadable")
        : null;
      return combineErrors([s.orphanError, shortcutError, s.trashError]);
    },
    shaderUnavailable: (s) =>
      hasOrphanUnavailableBase(s) || s.incompleteDeletions.some((d) => d.type === "shadercache"),
    /** Löschsperre je Orphan-Bereich: nur Scan-Gründe und Löschreste. Ein
     *  Löschfehler des letzten Versuchs steht auch in `orphanError`, sperrt
     *  aber nicht, sonst ginge bis zum nächsten Scan nichts mehr (INV-2). */
    orphanDeleteBlocked: (s) => (type: OrphanEntry["type"]) =>
      hasOrphanUnavailableBase({ ...s, orphanError: s._orphanScanError }) ||
      s.incompleteDeletions.some((d) => d.type === type),
    prefixUnavailable: (s) =>
      hasOrphanUnavailableBase(s) ||
      s.shortcutUnreadable ||
      s.incompleteDeletions.some((d) => d.type === "compatdata"),
    trashUnavailable: (s) =>
      s.trashError !== null ||
      s.trashUnknown.length > 0 ||
      s.trashLibraries.some((library) => library.error !== undefined) ||
      s.incompleteDeletionsUnreadable.length > 0 ||
      s.incompleteDeletions.some((d) => d.type === "trash"),
  },
  actions: {
    setOrphanError(message: string | null) {
      this.orphanError = message;
    },

    setTrashError(message: string | null) {
      this.trashError = message;
    },

    setOrphanScanError(message: string) {
      this._orphanScanError = message;
      this.setOrphanError(message);
    },

    setTrashScanError(message: string) {
      this._trashScanError = message;
      this.setTrashError(message);
    },

    clearOrphanState() {
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
      this._orphanScanError = null;
    },

    clearTrashState() {
      this.trash = [];
      this.trashUnknown = [];
      this.trashLibraries = [];
      this.trashScanning = false;
      this.trashError = null;
      this._trashScanError = null;
    },

    resetForLibraryScan() {
      this._orphanScanGeneration += 1;
      this._trashScanGeneration += 1;
      this.clearOrphanState();
      this.clearTrashState();
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
      this.clearOrphanState();

      const { result, isCurrent } = cleanupTurn(
        useScanStore(),
        generation,
        () => this._orphanScanGeneration,
      );
      if (!result) {
        // gleiches verhalten wie scanTrash: klick vor scan-ende darf nicht
        // lautlos ins leere laufen.
        this.setOrphanScanError(t("errors.noScanResult"));
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
        // keine zweite meldung für unlesbare claims: die ansicht zeigt sie
        // dediziert (incompleteDeletionsError → CleanupView), die sperre
        // tragen `hasOrphanUnavailableBase` (cleanupHelpers.ts) und
        // `trashUnavailable`.

        const skipped = result.skippedLibraries;
        const blocking = skipped.filter((s) => s.reason !== "path-missing");
        const unsafe = result.cleanupUnsafeLibraries;
        if (!Array.isArray(unsafe)) {
          this.blockedBySkipped = true;
          this.setOrphanScanError(t("errors.scanContractMissing"));
          return;
        }
        if (blocking.length > 0 || unsafe.length > 0) {
          this.blockedBySkipped = true;
          const blockedPaths = [...new Set([...blocking.map((s) => s.path), ...unsafe])];
          this.setOrphanScanError(t("errors.scanIncomplete", { paths: blockedPaths.join(", ") }));
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

        const steamRunning = await tauriPorts.system.isSteamRunning();
        if (!isCurrent()) return;
        if (steamRunning) {
          const steamError = t("errors.steamRunningCleanup");
          this.setOrphanScanError(steamError);
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

        // Klassifikation (fail-closed bei unlesbarer shortcuts.vdf, Shortcut-
        // bereich) liegt fachlich bei findOrphans in core/cleanup.
        this.orphans = classifyOrphans(this.orphans, this.shortcutUnreadable);

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
        if (isCurrent()) this.setOrphanScanError(formatError(e));
      } finally {
        if (isCurrent()) this.scanning = false;
      }
    },

    async deleteOrphans(
      entries: OrphanEntry[],
      remainder = 0,
      onConfirmed?: (paths: string[]) => void,
    ) {
      if (entries.length > MAX_PENDING_DELETES) {
        this.setOrphanError(
          combineErrors([
            this._orphanScanError,
            t("errors.deleteBatchTooLarge", { n: entries.length, max: MAX_PENDING_DELETES }),
          ]),
        );
        return;
      }
      if (this.blockedBySkipped || entries.some((e) => this.orphanDeleteBlocked(e.type))) return;

      const { result, isCurrent } = cleanupTurn(
        useScanStore(),
        this._orphanScanGeneration,
        () => this._orphanScanGeneration,
      );
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

      let shortcutResult: ShortcutResult;
      try {
        if (await tauriPorts.system.isSteamRunning()) {
          if (isCurrent()) this.setOrphanError(t("errors.steamRunningCleanup"));
          return;
        }
        shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
      } catch (e) {
        logError("Loeschen vorbereiten fehlgeschlagen", e);
        if (isCurrent()) this.setOrphanError(formatError(e));
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
          errors.push(
            t("errors.errorShortcutUnreadable", { type: entry.type, appId: entry.appId }),
          );
          continue;
        }
        if (installedAppIds.has(entry.appId)) {
          errors.push(t("errors.errorNowInstalled", { type: entry.type, appId: entry.appId }));
          continue;
        }

        this.deleting.add(entry.path);
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
            descriptions: localizeConsequences(pending, this.orphanNames[entry.path] ?? null),
            permanentDelete: pending.consequences.some((c) => c.action === "permanentDelete"),
          });
        } catch (e) {
          // deleting hier räumen: sonst bleibt die view nach einem
          // prepare-fehler dauerhaft busy (kein cleanup in onSuccess/onError,
          // die nur pfade aus prepared kennen).
          this.deleting.delete(entry.path);
          logEvent("error", `Loeschen vorbereiten fehlgeschlagen (${entry.type}/${entry.appId})`);
          errors.push(`${entry.type}/${entry.appId}: ${formatError(e)}`);
        }
      }
      if (!isCurrent()) {
        for (const p of prepared) this.deleting.delete(p.path);
        confirm.release(reservation);
        return;
      }
      // immer setzen: ein neuer versuch ersetzt die fehler des letzten, statt
      // sie aufzustauen. ein scan-fehler kann hier nicht stehen, er sperrt oben.
      this.setOrphanError(errors.join("; ") || null);
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
                  this.orphans = this.orphans.filter((o) => o.path !== p.path);
                  // shadercache wird hart gelöscht, landet nie im papierkorb
                  if (p.type === "compatdata") trashedCompatdata = true;
                }
              } catch (e) {
                if (isCurrent()) errors.push(`${p.type}/${p.path}: ${formatError(e)}`);
              } finally {
                this.deleting.delete(p.path);
              }
            }
            // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
            // scanOrphans() leeren trashError bzw. orphanError und würden die
            // löschfehler sonst verschlucken. der rescan gehört hierher, nicht in die view.
            if (!isCurrent()) return;
            if (trashedCompatdata) {
              await this.scanTrash();
              if (!isCurrent()) return;
            }
            const refreshGeneration = this._orphanScanGeneration + 1;
            await this.scanOrphans();
            if (this._orphanScanGeneration === refreshGeneration && errors.length) {
              // der rescan-fehler bleibt sichtbar (INV-2), der löschtext kommt dazu.
              this.setOrphanError(combineErrors([this.orphanError, errors.join("; ")]));
            }
          },
          onCancel: () => {
            for (const p of prepared) this.deleting.delete(p.path);
          },
          onError: (e) => {
            logError("Loeschen fehlgeschlagen", e);
            for (const p of prepared) this.deleting.delete(p.path);
            if (isCurrent()) {
              errors.push(formatError(e));
              this.setOrphanError(errors.join("; "));
            }
          },
        },
        reservation,
      );
      if (!accepted) {
        for (const p of prepared) this.deleting.delete(p.path);
        confirm.release(reservation);
      }
    },

    async loadIgnoredMissing(isCurrent: () => boolean) {
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
      this.clearTrashState();

      const { result, isCurrent } = cleanupTurn(
        useScanStore(),
        generation,
        () => this._trashScanGeneration,
      );
      if (!result) {
        this.setTrashScanError(t("errors.noScanResult"));
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
          this.setTrashScanError(t("cleanup.trashUnreadable", { paths: unreadable.join(", ") }));
        }

        if (entries.length === 0) return;

        const paths = entries.map((e) => e.path);
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        if (!isCurrent()) return;
        attachSizes(this.trash, sizes);
      } catch (e) {
        logError("Papierkorb-Scan fehlgeschlagen", e);
        if (isCurrent()) this.setTrashScanError(formatError(e));
      } finally {
        if (isCurrent()) this.trashScanning = false;
      }
    },

    /** verarbeitet höchstens MAX_PENDING_DELETES einträge je bestätigung
     *  (ein backend-token je batch); `remainder` ist die zahl der einträge des
     *  snapshots, die dieser durchgang nicht anfasst, und wird im dialog
     *  genannt. */
    async deleteTrashEntries(
      entries: TrashEntry[],
      remainder = 0,
      onConfirmed?: (paths: string[]) => void,
    ) {
      if (entries.length > MAX_PENDING_DELETES) {
        this.setTrashError(
          combineErrors([
            this._trashScanError,
            t("errors.deleteBatchTooLarge", { n: entries.length, max: MAX_PENDING_DELETES }),
          ]),
        );
        return;
      }
      const { result, isCurrent } = cleanupTurn(
        useScanStore(),
        this._trashScanGeneration,
        () => this._trashScanGeneration,
      );
      // fail-closed wie deleteOrphans: ohne scan-snapshot gibt es kein steamRoot,
      // und mit leerem root lief der pfad als irreführender prepare-fehler weiter
      // statt als noScanResult abzubrechen (N-7).
      if (!result) {
        this.setTrashError(t("errors.noScanResult"));
        return;
      }
      const steamRoot = result.steamRoot;
      const confirm = useConfirmStore();
      const reservation = confirm.reserve();
      if (reservation === null) return;
      if (isCurrent()) this.setTrashError(this._trashScanError);
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
      this.setTrashError(
        combineErrors([this._trashScanError, formatTrashErrors(prepareErrors, executeErrors)]),
      );
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
      // formatKnownBytes: eine gemessene 0 ist "0 B", nicht "nicht gemessen".
      // der name ist bewusst nicht `sizeText`: so heißt die format-hilfe in
      // format.ts, hier steht ein fertiger summentext.
      const summaryText = formatSizeSummary(preparedEntries, formatKnownBytes);
      const accepted = confirm.ask(
        {
          title:
            prepared.length === 1
              ? t("cleanup.trashDeleteConfirmSingle", { n: prepared.length })
              : t("cleanup.trashDeleteConfirmTitle", { n: prepared.length }),
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
                  this.trash = this.trash.filter((e) => e.path !== p.path);
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
              const refresh = this._trashScanGeneration + 1;
              await this.scanTrash();
              // ein neuerer lauf hat übernommen: dessen ergebnis stehen lassen.
              if (this._trashScanGeneration !== refresh) return;
            }
            const deleteMessage = formatTrashErrors(prepareErrors, executeErrors);
            if (deleteMessage !== null) {
              // ohne rescan steht der prepare-text schon in trashError,
              // anhängen würde ihn verdoppeln; die basis ist der alte
              // scan-fehler. nach dem rescan ist trashError nur noch der neue
              // lesefehler, der löschtext kommt dazu.
              this.setTrashError(
                combineErrors([deleted ? this.trashError : this._trashScanError, deleteMessage]),
              );
            }
          },
          onError: (e) => {
            logError("Papierkorb leeren fehlgeschlagen", e);
            if (isCurrent()) {
              executeErrors.push(formatError(e));
              this.setTrashError(
                combineErrors([
                  this._trashScanError,
                  formatTrashErrors(prepareErrors, executeErrors),
                ]),
              );
            }
          },
        },
        reservation,
      );
      if (!accepted) confirm.release(reservation);
    },

    async emptyTrash(onConfirmed?: (paths: string[]) => void) {
      const snapshot = this.trash.slice();
      const batch = snapshot.slice(0, MAX_PENDING_DELETES);
      await this.deleteTrashEntries(batch, snapshot.length - batch.length, onConfirmed);
    },

    async deleteOrphansAll(entries: OrphanEntry[]) {
      const batch = entries.slice(0, MAX_PENDING_DELETES);
      await this.deleteOrphans(batch, entries.length - batch.length);
    },
  },
});
