import { invoke } from "@tauri-apps/api/core";
import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { findOrphans } from "../../core/cleanup";
import {
  readAllShortcutAppIds,
  SHORTCUT_ID_THRESHOLD,
  type ShortcutResult,
} from "../../core/shortcuts";
import { findTrashEntries, type TrashEntry, type TrashLibraryStatus } from "../../core/trash";
import type { OrphanEntry, ScanResult } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useScanStore } from "./scanStore";

/** cache-key für die dauerhaft ignorierten toten library-pfade */
const IGNORED_MISSING_KEY = "cleanup:ignored-missing-libs";

// S-05: frischen installed-status bauen (games + shortcuts), statt auf einen
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

export const useCleanupStore = defineStore("cleanup", {
  state: () => ({
    orphans: [] as OrphanEntry[],
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
  },
  actions: {
    key(entry: OrphanEntry): string {
      return `${entry.type}:${entry.appId}`;
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
        if (blocking.length > 0) {
          this.blockedBySkipped = true;
          this.error = t("errors.scanIncomplete", {
            paths: blocking.map((s) => s.path).join(", "),
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

        this.orphans = await findOrphans(result.libraries, installedAppIds, tauriPorts.fs);

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

        if (this.orphans.length === 0) return;

        const paths = this.orphans.map((o) => o.path);
        const sizes = await tauriPorts.system.batchDirSizes(paths);
        attachSizes(this.orphans, sizes);
      } catch (e) {
        this.error = errMsg(e);
      } finally {
        this.scanning = false;
      }
    },

    async deleteOrphans(entries: OrphanEntry[]) {
      if (this.blockedBySkipped) return;
      if (await tauriPorts.system.isProcessRunning("steam")) {
        this.error = t("errors.steamRunningCleanup");
        return;
      }

      const scan = useScanStore();
      const result = scan.result;
      if (!result) {
        this.error = t("errors.noScanResult");
        return;
      }

      const shortcutResult = await readAllShortcutAppIds(tauriPorts.fs, result.steamRoot);
      const installedAppIds = collectInstalledAppIds(result, shortcutResult);

      const errors: string[] = [];
      // compatdata wird nicht gelöscht, sondern in den papierkorb VERSCHOBEN.
      // ohne refresh danach bliebe die papierkorb-sektion auf dem stand vom
      // öffnen der ansicht, der nutzer sieht "leer" und glaubt, die daten seien
      // weg, obwohl sie noch platz belegen.
      let trashedCompatdata = false;
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
          await invoke<string>("remove_orphan_dir", { path: entry.path });
          this.orphans = this.orphans.filter((o) => this.key(o) !== k);
          // shadercache wird hart gelöscht und landet nie im papierkorb
          if (entry.type === "compatdata") trashedCompatdata = true;
        } catch (e) {
          errors.push(`${entry.type}/${entry.appId}: ${errMsg(e)}`);
        } finally {
          this.deleting.delete(k);
        }
      }
      // reihenfolge: erst refreshes, dann fehler setzen. scanTrash() und
      // scanOrphans() setzen this.error zurück und würden die löschfehler
      // sonst verschlucken, der nutzer sähe die einträge noch in der liste,
      // aber nicht warum. der orphan-rescan gehört deshalb HIERHER (nicht in
      // die view): nur so ist die reihenfolge garantiert.
      if (trashedCompatdata) await this.scanTrash();
      await this.scanOrphans();
      if (errors.length) {
        this.error = [this.error, errors.join("; ")].filter(Boolean).join(" | ");
      }
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
        // kein cache, kaputtes json → einfach nichts ignorieren (INV-3)
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

    // busy-state fürs löschen hält die view lokal (eine quelle, kein doppelter
    // store/view-zustand für denselben button).
    async deleteTrashEntry(entry: TrashEntry) {
      try {
        await invoke<string>("remove_trash_entry", { path: entry.path });
        this.trash = this.trash.filter((e) => e.path !== entry.path);
      } catch (e) {
        this.error = `${entry.name}: ${errMsg(e)}`;
      }
    },

    async emptyTrash() {
      const errors: string[] = [];
      for (const entry of [...this.trash]) {
        try {
          await invoke<string>("remove_trash_entry", { path: entry.path });
          this.trash = this.trash.filter((e) => e.path !== entry.path);
        } catch (e) {
          errors.push(`${entry.name}: ${errMsg(e)}`);
        }
      }
      if (errors.length) this.error = errors.join("; ");
    },
  },
});
