import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import type { IncompleteDeletion, OrphanUnreadable, SteamOwnedPrefix } from "../../core/cleanup";
import type { TrashEntry, TrashLibraryStatus } from "../../core/trash";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { formatDetail } from "../formatError";
import { t } from "../i18n";
import { cleanupBlockedFlags, combineErrors, hasUnreadableOrphanType } from "./cleanupHelpers";
import { deleteOrphans, readOrphanNames, scanOrphans } from "./cleanupOrphans";
import { deleteTrashEntries, scanTrash } from "./cleanupTrash";

/** cache-key für die dauerhaft ignorierten toten library-pfade */
const IGNORED_MISSING_KEY = "cleanup:ignored-missing-libs";

export const MAX_PENDING_DELETES = 32;

export const useCleanupStore = defineStore("cleanup", {
  state: () => ({
    orphans: [] as OrphanEntry[],
    /** compatdata/shadercache-verzeichnisse, die vorhanden, aber nicht lesbar
     *  waren – typ-genau, weil ein unlesbares compatdata nur die
     *  Prefix-Löschung sperrt und ein unlesbares shadercache nur die
     *  Shader-Löschung. Eine leere Orphan-liste ist damit kein vollständiger
     *  Scan; die Sperre trägt `hasUnreadableOrphanType`. */
    orphanUnreadable: [] as OrphanUnreadable[],
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
    /** Alle Bereichssperren kommen aus `cleanupBlockedFlags`; sonst widersprechen
     *  sich Coverage und Löschdialog. Die Basis wird dort mit
     *  `_orphanScanError` statt mit `orphanError` ausgewertet: `orphanError`
     *  trägt auch den Lösch-/Guard-Text des letzten Versuchs („nicht lesbar,
     *  Anzeige unvollständig: …", Claim-Titel), ein solcher Text ist kein Beleg
     *  für einen unvollständigen Scan und darf die typ-genaue Anzeige nicht
     *  verfälschen. Dasselbe gilt für den Papierkorb: die Scan-Fakten sind
     *  `_orphanScanError` und `_trashScanError`; `trashError` trägt zusätzlich
     *  den Text eines Löschversuchs (P2-3, FR-4). */
    shaderUnavailable: (s) =>
      cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      }).shader,
    prefixUnavailable: (s) =>
      cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      }).prefix,
    /** Anzeige-Sperre des Papierkorbs: hängt am Scan-Fakt `_trashScanError`,
     *  nicht am Löschfehler in `trashError` — ein reiner Löschfehler belegt
     *  keinen unvollständigen Scan. */
    trashUnavailable: (s) =>
      cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      }).trash,
    /** Grund, warum der Papierkorb nicht gelöscht werden darf, oder null. Trägt
     *  den Text bis in die View (Knopf-Titel und Hinweis), damit die Sperre
     *  sichtbar ist statt nur zu wirken (FR-4). */
    trashDeleteBlockedText: (s): string | null =>
      cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      }).trashDelete
        ? t("cleanup.trashDeleteBlocked")
        : null,
    /** Anzeige-Sperre der Coverage: der Scan kann vollständig sein, die
     *  Löschvorschau ist es dann trotzdem nicht (INV-2). */
    coverageBlocked: (s) =>
      cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      }).any,
    /** Löschsperre je Orphan-Bereich: die gemeinsame Basis plus der typ-genaue
     *  Beleg. Bewusst nicht über `shader`/`prefix`: `prefix` trägt zusätzlich den
     *  shortcut-Lesefehler, der die Anzeige sperrt, das Löschen aber nicht. */
    orphanDeleteBlocked: (s) => (type: OrphanEntry["type"]) => {
      const flags = cleanupBlockedFlags({
        ...s,
        orphanScanError: s._orphanScanError,
        trashScanError: s._trashScanError,
      });
      return (
        flags.base ||
        hasUnreadableOrphanType(s, type) ||
        s.incompleteDeletions.some((deletion) => deletion.type === type)
      );
    },
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
      this.orphanUnreadable = [];
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
    readOrphanNames(result: ScanResult): Promise<Record<string, string>> {
      return readOrphanNames(this, result);
    },

    scanOrphans() {
      return scanOrphans(this);
    },

    deleteOrphans(entries: OrphanEntry[], remainder = 0, onConfirmed?: (paths: string[]) => void) {
      return deleteOrphans(this, entries, remainder, onConfirmed);
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

    scanTrash() {
      return scanTrash(this);
    },

    /** verarbeitet höchstens MAX_PENDING_DELETES einträge je bestätigung
     *  (ein backend-token je batch); `remainder` ist die zahl der einträge des
     *  snapshots, die dieser durchgang nicht anfasst, und wird im dialog
     *  genannt. */
    deleteTrashEntries(
      entries: TrashEntry[],
      remainder = 0,
      onConfirmed?: (paths: string[]) => void,
    ) {
      return deleteTrashEntries(this, entries, remainder, onConfirmed);
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
