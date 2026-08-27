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
import {
  readAllShortcutAppIds,
  SHORTCUT_ID_THRESHOLD,
  type ShortcutResult,
} from "../../core/shortcuts";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useConfirmStore } from "./confirmStore";
import { useScanStore } from "./scanStore";

/** cache-key für die dauerhaft ignorierten toten library-pfade */
const IGNORED_MISSING_KEY = "cleanup:ignored-missing-libs";

// Baut den aktuellen Installationsstatus aus Spielen und Shortcuts statt auf einen
// veralteten scan-stand zu vertrauen, der cleanup-race-schutz lebt hier.
function collectInstalledAppIds(result: ScanResult, shortcutResult: ShortcutResult): Set<number> {
  const installedAppIds = new Set(result.games.map((g) => g.appId));
  if (shortcutResult.status === "ok") {
    for (const id of shortcutResult.ids) installedAppIds.add(id);
  }
  return installedAppIds;
}

/** größen an einträge hängen. ein fehlender map-eintrag bedeutet, dass
 *  batchDirSizes den pfad übersprungen hat (NotFound-race). sizeBytes bleibt
 *  dann undefined → UI rendert "…", ein leeres verzeichnis (real 0 byte)
 *  rendert "-" via formatBytes. KEIN default auf 0: die 0 für summen/sort
 *  gehört in die rechner (?? 0 dort), nicht in die anzeige. */
function attachSizes(
  entries: { path: string; sizeBytes?: number }[],
  sizes: Record<string, number>,
): void {
  for (const e of entries) {
    e.sizeBytes = sizes[e.path];
  }
}

function formatTrashErrors(prepareErrors: string[], executeErrors: string[]): string | null {
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
    scanning: false,
    deleting: new Set<string>(),
    error: null as string | null,
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
  }),
  getters: {
    compatdataOrphans: (s) => s.orphans.filter((o) => o.type === "compatdata"),
    shadercacheOrphans: (s) => s.orphans.filter((o) => o.type === "shadercache"),
    steamOwnedTotalBytes: (s) =>
      s.steamOwnedPrefixes.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0),
  },
  actions: {
    key(entry: OrphanEntry): string {
      return entry.path;
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
      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        // gleiches verhalten wie scanTrash: klick vor scan-ende darf nicht
        // lautlos ins leere laufen.
        this.error = t("errors.noScanResult");
        return;
      }

      this.scanning = true;
      this.error = null;

      try {
        const skipped = result.skippedLibraries;
        const blocking = skipped.filter((s) => s.reason !== "path-missing");
        const unsafe = result.cleanupUnsafeLibraries;
        if (!Array.isArray(unsafe)) {
          this.blockedBySkipped = true;
          this.error = t("errors.scanIncomplete", { paths: "cleanupUnsafeLibraries fehlt" });
          return;
        }
        if (blocking.length > 0 || unsafe.length > 0) {
          this.blockedBySkipped = true;
          const blockedPaths = [...new Set([...blocking.map((s) => s.path), ...unsafe])];
          this.error = t("errors.scanIncomplete", {
            paths: blockedPaths.join(", "),
          });
          return;
        }
        this.blockedBySkipped = false;

        await this.loadIgnoredMissing();
        const missing = skipped.filter((s) => s.reason === "path-missing").map((s) => s.path);
        const unanswered = missing.filter((p) => !this.ignoredMissingLibs.includes(p));
        if (unanswered.length > 0) {
          this.pathMissingLibs = unanswered;
          return;
        }
        this.pathMissingLibs = [];

        if (await tauriPorts.system.isProcessRunning("steam")) {
          this.error = t("errors.steamRunningCleanup");
          return;
        }

        const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
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

        this.orphans = await findOrphans(
          result.libraries,
          installedAppIds,
          new Set(result.blockedAppIds),
          tauriPorts.fs,
        );
        this.incompleteDeletions = await findIncompleteDeletions(result.libraries, tauriPorts.fs);
        this.steamOwnedPrefixes = await findSteamOwnedPrefixes(
          result.libraries,
          new Set(result.blockedAppIds),
          tauriPorts.fs,
        );

        if (this.shortcutUnreadable) {
          // WHY fail-closed: unlesbares shortcuts.vdf → Non-Steam-Shortcuts sind nicht
          // von echten Orphans unterscheidbar. compatdata kann echte Savegames enthalten,
          // deshalb blockieren. shadercache ist regenerierbar und darf bereinigt werden.
          this.orphans = this.orphans.filter((o) => o.type === "shadercache");
          this.error = this.shortcutUnreadableDetail
            ? t("errors.userdataUnreadableWithDetail", { detail: this.shortcutUnreadableDetail })
            : t("errors.shortcutsUnreadable");
        }

        for (const o of this.orphans) {
          if (o.appId >= SHORTCUT_ID_THRESHOLD) o.potentialShortcut = true;
        }

        this.orphanNames = await this.readOrphanNames(result);

        // größen für beide listen in einem aufruf; ohne orphans, aber mit
        // steam-eigenen prefixes darf nicht vorzeitig abgebrochen werden.
        if (this.orphans.length === 0 && this.steamOwnedPrefixes.length === 0) return;

        const paths = [
          ...this.orphans.map((o) => o.path),
          ...this.steamOwnedPrefixes.map((p) => p.path),
        ];
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        attachSizes(this.orphans, sizes);
        attachSizes(this.steamOwnedPrefixes, sizes);
      } catch (e) {
        this.error = errMsg(e);
      } finally {
        this.scanning = false;
      }
    },

    async deleteOrphans(entries: OrphanEntry[]) {
      if (this.blockedBySkipped) return;

      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        this.error = t("errors.noScanResult");
        return;
      }

      const unsafe = result.cleanupUnsafeLibraries;
      if (!Array.isArray(unsafe)) {
        this.blockedBySkipped = true;
        this.error = t("errors.scanIncomplete", { paths: "cleanupUnsafeLibraries fehlt" });
        return;
      }
      if (unsafe.length > 0) {
        this.blockedBySkipped = true;
        this.error = t("errors.scanIncomplete", {
          paths: unsafe.join(", "),
        });
        return;
      }

      if (await tauriPorts.system.isProcessRunning("steam")) {
        this.error = t("errors.steamRunningCleanup");
        return;
      }

      const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
      const installedAppIds = collectInstalledAppIds(result, shortcutResult);

      const errors: string[] = [];
      // phase 1: alle einträge vorbereiten; der dialog zeigt die folgen und
      // erst der bestätigungs-klick führt executeDelete aus.
      const prepared: {
        token: string;
        key: string;
        type: string;
        descriptions: string[];
      }[] = [];
      for (const entry of entries) {
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
            descriptions: pending.consequences.map((c) => c.description),
          });
        } catch (e) {
          // deleting hier räumen: sonst bleibt die view nach einem
          // prepare-fehler dauerhaft busy (kein cleanup in onSuccess/onError,
          // die nur keys aus prepared kennen).
          this.deleting.delete(k);
          errors.push(`${entry.type}/${entry.appId}: ${errMsg(e)}`);
        }
      }
      if (errors.length) this.error = errors.join("; ");
      if (!prepared.length) return;

      const confirm = useConfirmStore();
      confirm.ask(
        {
          title: t("cleanup.deleteConfirmTitle", { n: prepared.length }),
          message: prepared.flatMap((p) => p.descriptions).join("\n"),
        },
        {
          onSuccess: async () => {
            // compatdata wird nicht gelöscht, sondern in den papierkorb
            // VERSCHOBEN; ohne refresh danach bliebe die papierkorb-sektion
            // auf dem stand vom öffnen der ansicht.
            let trashedCompatdata = false;
            for (const p of prepared) {
              try {
                const res = await tauriPorts.system.executeDelete(p.token);
                if (res.success) {
                  this.orphans = this.orphans.filter((o) => this.key(o) !== p.key);
                  // shadercache wird hart gelöscht, landet nie im papierkorb
                  if (p.type === "compatdata") trashedCompatdata = true;
                }
              } catch (e) {
                errors.push(`${p.type}/${p.key}: ${errMsg(e)}`);
              } finally {
                this.deleting.delete(p.key);
              }
            }
            // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
            // scanOrphans() setzen this.error zurück und würden die löschfehler
            // sonst verschlucken. der rescan gehört hierher, nicht in die view.
            if (trashedCompatdata) await this.scanTrash();
            await this.scanOrphans();
            if (errors.length) this.error = errors.join("; ");
          },
          onCancel: () => {
            for (const p of prepared) this.deleting.delete(p.key);
          },
          onError: (e) => {
            for (const p of prepared) this.deleting.delete(p.key);
            errors.push(errMsg(e));
            this.error = errors.join("; ");
          },
        },
      );
    },

    async loadIgnoredMissing() {
      if (this.ignoredLoaded) return;
      this.ignoredLoaded = true;
      try {
        const raw = await tauriPorts.cache.get(IGNORED_MISSING_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        // defensiv: fremder/alter cache-inhalt darf den cleanup nicht kippen
        if (Array.isArray(parsed)) {
          this.ignoredMissingLibs = parsed.filter((p): p is string => typeof p === "string");
        }
      } catch {
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
      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        this.error = t("errors.noScanResult");
        return;
      }

      this.trashScanning = true;
      this.error = null;

      try {
        const { entries, unknown, unreadable, libraries } = await findTrashEntries(
          result.libraries,
          tauriPorts.system,
        );
        this.trash = entries;
        this.trashUnknown = unknown;
        this.trashLibraries = libraries;

        // ein nicht lesbarer papierkorb darf nicht als "leer" durchgehen
        if (unreadable.length) {
          this.error = t("cleanup.trashUnreadable", { paths: unreadable.join(", ") });
        }

        if (entries.length === 0) return;

        const paths = entries.map((e) => e.path);
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        attachSizes(this.trash, sizes);
      } catch (e) {
        this.error = errMsg(e);
      } finally {
        this.trashScanning = false;
      }
    },

    async deleteTrashEntries(entries: TrashEntry[]) {
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot ?? "";
      this.error = null;
      const prepareErrors: string[] = [];
      const executeErrors: string[] = [];
      const prepared: {
        token: string;
        path: string;
        name: string;
        descriptions: string[];
      }[] = [];

      for (const entry of entries) {
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
            descriptions: pending.consequences.map((c) => c.description),
          });
        } catch (e) {
          prepareErrors.push(`${entry.name}: ${errMsg(e)}`);
        }
      }

      this.error = formatTrashErrors(prepareErrors, executeErrors);
      if (!prepared.length) return;

      const confirm = useConfirmStore();
      const partialPrepareMessage =
        prepareErrors.length > 0
          ? t("cleanup.trashPrepareWarning", { n: prepareErrors.length })
          : null;
      confirm.ask(
        {
          title:
            prepared.length === 1
              ? t("cleanup.trashDeleteConfirmSingle")
              : t("cleanup.trashDeleteConfirmTitle"),
          message: [partialPrepareMessage, ...prepared.flatMap((p) => p.descriptions)]
            .filter((line): line is string => line !== null)
            .join("\n"),
        },
        {
          onSuccess: async () => {
            for (const p of prepared) {
              try {
                const res = await tauriPorts.system.executeDelete(p.token);
                if (res.success) {
                  this.trash = this.trash.filter((e) => e.path !== p.path);
                }
              } catch (e) {
                executeErrors.push(`${p.name}: ${errMsg(e)}`);
              }
            }
            this.error = formatTrashErrors(prepareErrors, executeErrors);
          },
          onError: (e) => {
            executeErrors.push(errMsg(e));
            this.error = formatTrashErrors(prepareErrors, executeErrors);
          },
        },
      );
    },

    async deleteTrashEntry(entry: TrashEntry) {
      await this.deleteTrashEntries([entry]);
    },

    async emptyTrash() {
      await this.deleteTrashEntries([...this.trash]);
    },
  },
});
